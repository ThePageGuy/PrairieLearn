import path from 'path';

import express from 'express';
import fs from 'fs-extra';
import getPort from 'get-port';
import fetch from 'node-fetch';
import tmp from 'tmp-promise';
import { afterEach, assert, describe, it } from 'vitest';

import {
  type CompiledAssetsOptions,
  build,
  close,
  compiledScriptPath,
  compiledStylesheetPath,
  handler,
  init,
} from './index.js';

async function testProject(options: CompiledAssetsOptions) {
  await tmp.withDir(
    async (dir) => {
      // macOS does weird things with symlinks in its tmp directories. Resolve
      // the real path so that our asset-building machinery doesn't get confused.
      const tmpDir = await fs.realpath(dir.path);

      const scriptsRoot = path.join(tmpDir, 'assets', 'scripts');
      await fs.ensureDir(scriptsRoot);

      const stylesRoot = path.join(tmpDir, 'assets', 'stylesheets');
      await fs.ensureDir(stylesRoot);

      const jsScriptPath = path.join(scriptsRoot, 'foo.js');
      await fs.writeFile(jsScriptPath, 'console.log("foo")');

      const tsScriptPath = path.join(scriptsRoot, 'bar.ts');
      await fs.writeFile(tsScriptPath, 'interface Foo {};\n\nconsole.log("bar")');

      const stylesPath = path.join(stylesRoot, 'baz.css');
      await fs.writeFile(stylesPath, 'body { color: red; }');

      if (!options.dev) {
        await build(path.join(tmpDir, 'assets'), path.join(tmpDir, 'public', 'build'));
      }

      await init({
        sourceDirectory: path.join(tmpDir, 'assets'),
        buildDirectory: path.join(tmpDir, 'public', 'build'),
        publicPath: '/build',
        ...options,
      });

      const port = await getPort();
      const app = express();
      app.use('/build', handler());
      const server = app.listen(port);

      try {
        const jsRes = await fetch(`http://localhost:${port}${compiledScriptPath('foo.js')}`);
        assert.isTrue(jsRes.ok);
        assert.match(await jsRes.text(), /console\.log\("foo"\)/);

        const cssRes = await fetch(`http://localhost:${port}${compiledStylesheetPath('baz.css')}`);
        assert.isTrue(cssRes.ok);
        const cssText = await cssRes.text();
        assert.match(cssText, /body\s*\{/);
        assert.match(cssText, /color:\s*red/);

        assert.throws(
          () => compiledScriptPath('nonexistent.js'),
          'Unknown scripts asset: nonexistent.js',
        );
        assert.throws(
          () => compiledStylesheetPath('nonexistent.css'),
          'Unknown stylesheets asset: nonexistent.css',
        );
      } finally {
        server.close();
      }
    },
    {
      unsafeCleanup: true,
    },
  );
}

describe('compiled-assets', () => {
  afterEach(async () => close());

  it('works in dev mode', async () => {
    await testProject({ dev: true });
  });

  it('works in prod mode', async () => {
    await testProject({ dev: false });
  });
});
