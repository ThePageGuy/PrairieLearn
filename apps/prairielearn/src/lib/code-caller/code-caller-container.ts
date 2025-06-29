import * as os from 'node:os';
import * as path from 'node:path';

import { ECRClient } from '@aws-sdk/client-ecr';
import debugfn from 'debug';
import Docker, { type Container } from 'dockerode';
import { execa } from 'execa';
import fs from 'fs-extra';
import MemoryStream from 'memorystream';
import * as tmp from 'tmp-promise';
import { v4 as uuidv4 } from 'uuid';

import * as bindMount from '@prairielearn/bind-mount';
import { setupDockerAuth } from '@prairielearn/docker-utils';
import { logger } from '@prairielearn/logger';
import { instrumented } from '@prairielearn/opentelemetry';

import { makeAwsClientConfig } from '../aws.js';
import { config } from '../config.js';
import { deferredPromise } from '../deferred.js';

import {
  type CallType,
  type CodeCaller,
  type CodeCallerResult,
  FunctionMissingError,
  type PrepareForCourseOptions,
} from './code-caller-shared.js';

const CREATED = Symbol('CREATED');
const WAITING = Symbol('WAITING');
const IN_CALL = Symbol('IN_CALL');
const EXITING = Symbol('EXITING');
const EXITED = Symbol('EXITED');

type CallerState =
  | typeof CREATED
  | typeof WAITING
  | typeof IN_CALL
  | typeof EXITING
  | typeof EXITED;

interface CodeCallerContainerOptions {
  questionTimeoutMilliseconds: number;
  pingTimeoutMilliseconds: number;
}

const MOUNT_DIRECTORY_PREFIX = 'prairielearn-worker-';

const debug = debugfn('prairielearn:code-caller-container');
const docker = new Docker();

let executorImageTag = 'latest';
async function updateExecutorImageTag() {
  if (config.workerExecutorImageTag) {
    // Give precedence to any value provided by config.
    executorImageTag = config.workerExecutorImageTag;
    return;
  }

  const env = process.env.NODE_ENV || 'development';
  if (env === 'development') {
    // In local dev mode, always use `latest` tag, as there isn't guaranteed
    // to be a version tagged with the current commit hash.
    executorImageTag = 'latest';
    return;
  }

  executorImageTag = (await execa('git', ['rev-parse', 'HEAD'])).stdout.trim();
}

function getExecutorImageName(): string {
  if (config.workerExecutorImageRepository) {
    // Give precedence to any value provided by config. Note that we do not
    // prepend `cacheImageRegistry` here - we assume that the user has included
    // a registry in the repository name if they want to use a custom registry.
    return `${config.workerExecutorImageRepository}:${executorImageTag}`;
  }

  const imageName = `prairielearn/executor:${executorImageTag}`;
  const { cacheImageRegistry } = config;
  if (cacheImageRegistry) {
    return `${cacheImageRegistry}/${imageName}`;
  }
  return imageName;
}

/**
 * Ensures that the required Docker image is present on this machine.
 */
async function ensureImage() {
  const imageName = getExecutorImageName();
  const image = docker.getImage(imageName);
  try {
    logger.info(`Checking for executor image ${imageName}`);
    await image.inspect();
    logger.info(`Executor image ${imageName} found`);
  } catch (e) {
    if (e.statusCode === 404) {
      logger.info('Image not found, pulling from registry');
      const start = performance.now();
      const ecr = new ECRClient(makeAwsClientConfig());
      const dockerAuth = config.cacheImageRegistry ? await setupDockerAuth(ecr) : null;
      const stream = await docker.createImage(dockerAuth, { fromImage: imageName });
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(
          stream,
          (err) => {
            const elapsed = Math.round((performance.now() - start) / 1000);
            if (err) {
              logger.error(`Error pulling image after ${elapsed} seconds`, err);
              reject(err);
            } else {
              logger.info(`Executor image loaded successfully in ${elapsed} seconds`);
              resolve(null);
            }
          },
          (output) => {
            logger.info('Docker output', output);
          },
        );
      });
    } else {
      throw e;
    }
  }
}

export class CodeCallerContainer implements CodeCaller {
  state: CallerState;
  uuid: string;
  container: Container | null;
  callback: ((err: Error | null, data?: any, output?: string) => void) | null;
  timeoutID: NodeJS.Timeout | null;
  callCount: number;
  hasBindMount: boolean;
  options: { questionTimeoutMilliseconds: number; pingTimeoutMilliseconds: number };
  stdinStream: MemoryStream | null;
  stdoutStream: MemoryStream | null;
  stderrStream: MemoryStream | null;
  outputStdout: string[];
  outputStderr: string[];
  outputBoth: string;
  lastCallData: any;
  coursePath: string | null;
  forbiddenModules: string[];
  hostDirectory: tmp.DirectoryResult | null;

  /**
   * Creating a new {@link CodeCallerContainer} instance requires some async work,
   * so we use this static method to create a new instance since a constructor
   * cannot be async.
   */
  static async create(options: CodeCallerContainerOptions): Promise<CodeCallerContainer> {
    const codeCaller = new CodeCallerContainer(options);
    await codeCaller.ensureChild();
    return codeCaller;
  }

  private constructor(options: CodeCallerContainerOptions) {
    this.state = CREATED;
    this.uuid = uuidv4();

    this.debug('enter constructor()');

    this.container = null;
    this.callback = null;
    this.timeoutID = null;
    this.callCount = 0;
    this.hasBindMount = false;

    this.options = options;

    // These will accumulate output from the container.
    this.outputStdout = [];
    this.outputStderr = [];
    this.outputBoth = '';

    // for error logging
    this.lastCallData = null;

    this.coursePath = null;
    this.forbiddenModules = [];

    this._checkState();

    this.debug(`exit constructor(), state: ${String(this.state)}, uuid: ${this.uuid}`);
  }

  getCoursePath() {
    return this.coursePath;
  }

  /**
   * Wrapper around `debug` that automatically includes UUID and the caller state.
   */
  debug(message: string) {
    const paddedState = this.state.toString().padEnd(15);
    debug(`[${this.uuid} ${paddedState}] ${message}`);
  }

  async createBindMount(directory: string, mountpoint: string) {
    this.debug(`creating bind mount for ${directory} at ${mountpoint}`);
    await instrumented('createBindMount', async (span) => {
      span.setAttribute('mountpoint', mountpoint);
      span.setAttribute('directory', directory);
      await bindMount.mount(directory, mountpoint);
      this.hasBindMount = true;
    });
    this.debug(`created bind mount for ${directory} at ${mountpoint}`);
  }

  /**
   * Wrapper around `removeBindMount` that includes instance-specific logs.
   *
   */
  async removeBindMountIfNeeded(mountpoint: string) {
    if (!this.hasBindMount) return;

    this.debug(`removing bind mount at ${mountpoint}`);
    await instrumented('removeBindMount', async (span) => {
      span.setAttribute('mountpoint', mountpoint);
      await bindMount.umount(mountpoint);
      this.hasBindMount = false;
    });
    this.debug(`removed bind mount at ${mountpoint}`);
  }

  /**
   * Allows this caller to prepare for execution of code from a particular
   * course.
   */
  async prepareForCourse({ coursePath, forbiddenModules }: PrepareForCourseOptions) {
    this.forbiddenModules = forbiddenModules;

    if (this.coursePath && this.coursePath === coursePath) {
      // Same course as before; we can reuse the existing setup
      return;
    }

    if (!this.hostDirectory) {
      throw new Error('No hostDirectory set');
    }

    this.coursePath = coursePath;

    await this.removeBindMountIfNeeded(this.hostDirectory.path);
    await this.createBindMount(coursePath, this.hostDirectory.path);
  }

  async call(
    type: CallType,
    directory: string | null,
    file: string | null,
    fcn: string,
    args: any[],
  ): Promise<CodeCallerResult> {
    this.debug(`enter call(${type}, ${directory}, ${file}, ${fcn})`);
    this.callCount += 1;

    // Reset this so that we don't include old data if the checks below fail.
    this.lastCallData = null;

    if (!this._checkState([WAITING])) {
      throw new Error('invalid CodeCallerContainer state');
    }

    if (!this._checkReadyForCall(fcn)) {
      throw new Error('not ready for call');
    }

    const callData = { type, directory, file, fcn, args, forbidden_modules: this.forbiddenModules };
    const callDataString = JSON.stringify(callData);

    // Reset output accumulators.
    this.outputStdout = [];
    this.outputStderr = [];
    this.outputBoth = '';

    const deferred = deferredPromise<CodeCallerResult>();
    this.callback = (err, result, output) => {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve({ result, output: output ?? '' });
      }
    };

    // Starting Python processes is cheap, but starting a new Docker container is
    // relatively expensive. We'll add 5 seconds to whatever the question timeout
    // is and use that as the timeout for the Docker container to minimize the
    // likelihood of the container being killed when user code times out. This
    // should still ensure the container is killed when it's truly unresponsive.
    const containerTimeout =
      type === 'ping'
        ? this.options.pingTimeoutMilliseconds
        : this.options.questionTimeoutMilliseconds;
    this.timeoutID = setTimeout(this._handleTimeout.bind(this), containerTimeout + 5000);

    this.lastCallData = callData;

    this.stdinStream?.write(callDataString);
    this.stdinStream?.write('\n');

    this.state = IN_CALL;
    this._checkState();
    this.debug('exit call()');

    return deferred.promise;
  }

  async restart() {
    this.debug('enter restart()');
    if (!this._checkState([CREATED, WAITING, EXITING, EXITED])) {
      throw new Error('Unexpected CodeCallerContainer state');
    }

    if (this.callCount === 0) {
      // If there weren't any calls since the last time this code caller
      // was restarted, we can slightly optimize things by skipping the
      // restart. This is safe, as no user-provided code will have been
      // loaded into the Python interpreter.
      this.debug('exit restart() - skipping since no calls recorded since last restart');
      return true;
    } else if (this.state === CREATED) {
      // no need to restart if we don't have a worker
      this.debug('exit restart()');
      return true;
    } else if (this.state === WAITING) {
      const { result } = await this.call('restart', null, null, 'restart', []);
      this.forbiddenModules = [];
      this.coursePath = null;
      this.callCount = 0;
      if (result !== 'success') throw new Error(`Error while restarting: ${result}`);
      this.debug('exit restart()');
      return true;
    } else if (this.state === EXITING || this.state === EXITED) {
      this.debug('exit restart()');
      return false;
    } else {
      throw new Error(`Invalid CodeCallerContainer state: ${String(this.state)}`);
    }
  }

  done() {
    this.debug('enter done()');
    this._checkState([CREATED, WAITING, EXITING, EXITED]);

    if (this.state === CREATED) {
      this.state = EXITED;
    } else if (this.state === WAITING) {
      this._cleanup();
      this.state = EXITING;
    }
    this._checkState();
    this.debug('exit done()');
  }

  private async ensureChild() {
    this.debug('enter ensureChild()');
    this._checkState();

    if (this.container) {
      this.debug('exit ensureChild() - existing container');
      return;
    }

    this.hostDirectory = await tmp.dir({ unsafeCleanup: true, prefix: MOUNT_DIRECTORY_PREFIX });
    await ensureImage();
    await this._createAndAttachContainer(this.hostDirectory.path);

    // Transition to the WAITING state before pinging the container, as we
    // need to be in that state in order to make a call.
    this.state = WAITING;

    await this.call('ping', null, null, 'ping', []);

    this._checkState();
    this.debug('exit ensureChild()');
  }

  /**
   * Creates a container and attaches its stdin/stdout/stderr to streams
   * we can write to and read from.
   */
  async _createAndAttachContainer(hostDirectory: string) {
    this.debug('enter _createAndAttachContainer');
    this.debug('_createAndAttachContainer(): creating container');
    let bindMount = `${hostDirectory}:/course:ro`;
    if (process.platform === 'linux') {
      // See https://docs.docker.com/storage/bind-mounts/#configure-bind-propagation
      // `bind-propagation-slave` is what allows the container to see the bind mount
      // we made on the host.
      //
      // We only apply this on Linux platforms, as it is unnecessary and actually
      // causes problems when running on macOS.
      bindMount += ',slave';
    }
    this.container = await docker.createContainer({
      name: `prairielearn.worker.${this.uuid}`,
      Image: getExecutorImageName(),
      OpenStdin: true,
      // This will close stdin once we disconnect, which will let
      // the worker know that they should die. Once the worker dies,
      // `AutoRemove: true` below will ensure the worker container
      // is removed.
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [bindMount],
        AutoRemove: true,
        // Prevent forkbombs
        PidsLimit: 64,
        // We use stdout to communicate from the container to the host, so the logs
        // would rapidly fill up the host's disk space if we didn't disable logging.
        LogConfig: {
          Type: 'none',
          Config: {},
        },
      },
      Env: [
        // Proxy the `DEBUG` environment variable to the container so we can
        // turn on debug logging for it
        `DEBUG=${process.env.DEBUG}`,
        // Inform the container of its timeouts; these get picked up by
        // `executor.js` and passed on to the PythonCodeCaller constructor.
        `QUESTION_TIMEOUT_MILLISECONDS=${this.options.questionTimeoutMilliseconds}`,
        `PING_TIMEOUT_MILLISECONDS=${this.options.pingTimeoutMilliseconds}`,
      ],
    });
    this.debug('_createAndAttachContainer(): created container');

    const stream = await this.container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
    this.stdinStream = new MemoryStream();
    this.stdoutStream = new MemoryStream();
    this.stderrStream = new MemoryStream();
    this.stdinStream.pipe(stream);
    this.container.modem.demuxStream(stream, this.stdoutStream, this.stderrStream);
    this.stdoutStream.setEncoding('utf8');
    this.stderrStream.setEncoding('utf8');
    this.stdoutStream.on('data', (data) => this._handleStdout(data));
    this.stderrStream.on('data', (data) => this._handleStderr(data));

    this.debug('_createAndAttachContainer(): starting container');
    await this.container.start();
    this.debug('_createAndAttachContainer(): container started');

    // This will passively (non-blocking) wait for the container to exit or be killed, while allowing other code to keep executing
    this.container
      .wait()
      .then((status) => this._handleContainerExit(null, status))
      .catch((err) => this._handleContainerExit(err));
    this.debug('exit _createAndAttachContainer');
  }

  _handleStdout(data: string) {
    this.debug('enter _handleStdout()');
    this.outputStdout.push(data);
    if (data.indexOf('\n') >= 0) {
      this._callIsFinished();
    }
    this.debug('exit _handleStdout()');
  }

  _handleStderr(data: string) {
    this.debug('enter _handleStderr()');
    this.outputStderr.push(data);
    this.debug('exit _handleStderr()');
  }

  _handleTimeout() {
    this.debug('enter _timeout()');
    this._checkState([IN_CALL]);
    this.timeoutID = null;
    this._cleanup();
    this.state = EXITING;
    this._callCallback(new Error('timeout exceeded, killing CodeCallerContainer container'));
    this.debug('exit _timeout()');
  }

  _clearTimeout() {
    this.debug('enter _clearTimeout()');
    clearTimeout(this.timeoutID ?? undefined);
    this.timeoutID = null;
    this.debug('exit _clearTimeout()');
  }

  /**
   * Can be called asynchronously at any time if the container exits.
   *
   * @param err An error that occurred while waiting for the container to exit.
   * @param code The status code that the container exited with
   */
  async _handleContainerExit(err: Error | null | undefined, code?: number) {
    this.debug('enter _handleContainerExit()');
    this._checkState([WAITING, IN_CALL, EXITING]);
    if (this.state === WAITING) {
      this._logError(
        `CodeCallerContainer container exited while in state = WAITING, code = ${JSON.stringify(
          code,
        )}, err = ${err}`,
      );
      this.container = null;
      this.state = EXITED;
    } else if (this.state === IN_CALL) {
      this._clearTimeout();
      this.container = null;
      this.state = EXITED;
      this._callCallback(
        new Error(
          `CodeCallerContainer container exited unexpectedly, code = ${JSON.stringify(
            code,
          )}, err = ${err}`,
        ),
      );
    } else if (this.state === EXITING) {
      // no error, this is the good case
      this.container = null;
      this.state = EXITED;
    }
    this.debug('exit _handleContainerExit()');
  }

  _callCallback(err: (Error & { data?: any }) | null, data?: any, output?: string) {
    this.debug('enter _callCallback()');
    if (err) err.data = this._errorData();
    const c = this.callback;
    this.callback = null;
    c?.(err, data, output);
    this.debug('exit _callCallback()');
  }

  _callIsFinished() {
    this.debug('enter _callIsFinished()');
    if (!this._checkState([IN_CALL])) return;
    this._clearTimeout();
    let data: {
      error?: string;
      errorData?: { outputBoth: string };
      functionMissing?: boolean;
      data: any;
      output: string;
    } | null = null;
    let err: Error | null = null;
    try {
      data = JSON.parse(this.outputStdout.join(''));
      if (data && data.error) {
        err = new Error(data.error);
        if (data.errorData && data.errorData.outputBoth) {
          this.outputBoth = data.errorData.outputBoth;
        }
      }
    } catch (e) {
      err = new Error('Error decoding CodeCallerContainer JSON: ' + e.message);
    }
    this.state = WAITING;
    if (err) {
      this._callCallback(err);
    } else {
      if (data?.functionMissing) {
        this._callCallback(new FunctionMissingError('Function not found in module'));
      } else {
        this._callCallback(null, data?.data, data?.output || '');
      }
    }

    // This is potentially quite a large object. Drop our reference to it to
    // allow this memory to be quickly garbage collected.
    this.lastCallData = null;

    this.debug('exit _callIsFinished()');
  }

  /**
   * Will prepare this worker to be completely disposed of. This will kill
   * the Docker container, clear the timeout, unmount the mounted directory
   * if needed, and finally remove the mounted directory.
   *
   * This function SHOULD NOT THROW as we're not guaranteed that anyone will be
   * able to catch the error. This makes a best-effort attempt to clean up all
   * the resources used by this caller, but it'll simply ignore any errors it
   * encounters.
   */
  async _cleanup() {
    this.debug('enter _cleanup()');
    if (this.timeoutID) {
      this._clearTimeout();
    }
    if (this.container) {
      try {
        await this.container.kill();
      } catch (e) {
        logger.error(`Error killing Docker container ${this.container.id}`, e);
      }
    }
    // Note that we can't safely do any of this until the container is actually dead
    if (this.hostDirectory) {
      try {
        await this.removeBindMountIfNeeded(this.hostDirectory.path);
      } catch (e) {
        logger.error('Error unmounting host directory', e);
      }
      try {
        await this.hostDirectory.cleanup();
      } catch (e) {
        logger.error(`Error removing host directory ${this.hostDirectory.path}`, e);
      }
    }
    this.debug('exit _cleanup()');
  }

  _errorData() {
    const errForStack = new Error();
    return {
      state: this.state,
      containerIsNull: this.container == null,
      callbackIsNull: this.callback == null,
      timeoutIDIsNull: this.timeoutID == null,
      outputBoth: this.outputBoth,
      stack: errForStack.stack,
      lastCallData: this.lastCallData,
    };
  }

  /**
   * @param msg The message to log
   */
  _logError(msg: string): boolean {
    this.debug('enter _logError()');
    const errData = this._errorData();
    logger.error(msg, errData);
    this.debug('exit _logError()');
    return false;
  }

  /**
   * Checks if the caller is ready for a call to call().
   */
  _checkReadyForCall(fcn: string): boolean {
    if (!this.container) {
      return this._logError(
        `Not ready for call, container is not created (state: ${String(this.state)})`,
      );
    }
    if (fcn !== 'ping' && fcn !== 'restart') {
      // 'ping' and 'restart' are fake functions that don't need a course path
      if (!this.coursePath) {
        return this._logError(
          `Not ready for call, course was not set (state: ${String(this.state)})`,
        );
      }
    }
    return true;
  }

  /**
   * Checks that the caller is in a good state.
   */
  _checkState(allowedStates?: CallerState[]) {
    if (allowedStates && !allowedStates.includes(this.state)) {
      const allowedStatesList = allowedStates.map(String).join(', ');
      return this._logError(
        `Expected CodeCallerContainer to be in states [${allowedStatesList}] but actually have state ${String(
          this.state,
        )}`,
      );
    }

    let containerNull: boolean, callbackNull: boolean, timeoutIDNull: boolean;
    if (this.state === CREATED) {
      containerNull = true;
      callbackNull = true;
      timeoutIDNull = true;
    } else if (this.state === WAITING) {
      containerNull = false;
      callbackNull = true;
      timeoutIDNull = true;
    } else if (this.state === IN_CALL) {
      containerNull = false;
      callbackNull = false;
      timeoutIDNull = false;
    } else if (this.state === EXITING) {
      containerNull = false;
      callbackNull = true;
      timeoutIDNull = true;
    } else if (this.state === EXITED) {
      containerNull = true;
      callbackNull = true;
      timeoutIDNull = true;
    } else {
      return this._logError(`Invalid CodeCallerContainer state: ${String(this.state)}`);
    }

    if (containerNull != null) {
      if (containerNull && this.container != null) {
        return this._logError(
          `CodeCallerContainer state ${String(this.state)}: container should be null`,
        );
      }
      if (!containerNull && this.container == null) {
        return this._logError(
          `CodeCallerContainer state ${String(this.state)}: container should not be null`,
        );
      }
    }
    if (callbackNull != null) {
      if (callbackNull && this.callback != null) {
        return this._logError(
          `CodeCallerContainer state ${String(this.state)}: callback should be null`,
        );
      }
      if (!callbackNull && this.callback == null) {
        return this._logError(
          `CodeCallerContainer state ${String(this.state)}: callback should not be null`,
        );
      }
    }
    if (timeoutIDNull != null) {
      if (timeoutIDNull && this.timeoutID != null) {
        return this._logError(
          `CodeCallerContainer state ${String(this.state)}: timeoutID should be null`,
        );
      }
      if (!timeoutIDNull && this.timeoutID == null) {
        return this._logError(
          `CodeCallerContainer state ${String(this.state)}: timeoutID should not be null`,
        );
      }
    }

    return true;
  }
}

/**
 * If PrairieLearn dies unexpectedly, we may leave around temporary directories
 * that should have been removed. This function will perform a best-effort
 * attempt to clean them up, but will allow execution to continue if something
 * fails. It'll check for any directories in the OS tmp directory that match the
 * pattern of our tmp directory names, try to unmount them, and then remove the
 * directories.
 *
 * This function is run on startup in the `init()` function below.
 */
async function cleanupMountDirectories() {
  try {
    const tmpDir = os.tmpdir();
    // Enumerate all directories in the OS tmp directory and remove
    // any old ones
    const dirs = await fs.readdir(tmpDir);
    const outDirs = dirs.filter((d) => d.indexOf(MOUNT_DIRECTORY_PREFIX) === 0);
    await Promise.all(
      outDirs.map(async (dir) => {
        const absolutePath = path.join(tmpDir, dir);

        try {
          debug(`removing bind mount at ${absolutePath}`);
          await bindMount.umount(absolutePath);
        } catch {
          // Ignore this, it was hopefully unmounted successfully before
        }

        try {
          await fs.rmdir(absolutePath);
        } catch (e) {
          logger.error(`Failed to remove temporary directory ${absolutePath}`);
          logger.error(e);
        }
      }),
    );
  } catch (e) {
    logger.error(e);
  }
}

export async function init() {
  await cleanupMountDirectories();
  await updateExecutorImageTag();
  if (config.ensureExecutorImageAtStartup) {
    await ensureImage();
  }
}
