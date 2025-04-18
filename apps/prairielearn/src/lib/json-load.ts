import * as fs from 'fs/promises';

import { Ajv } from 'ajv';
import jju from 'jju';

// We use a single global instance so that schemas aren't recompiled every time they're used
// https://github.com/ajv-validator/ajv/issues/2132
const ajv = new Ajv();

/**
 * Asynchronously reads the specified JSON file.
 *
 * @param jsonFilename The name of the file to read
 * @returns The parsed JSON
 */
export async function readJSON(jsonFilename: string): Promise<any> {
  const data = await fs.readFile(jsonFilename, { encoding: 'utf8' });
  try {
    return jju.parse(data, { mode: 'json' });
  } catch (e) {
    throw new Error(
      `Error in JSON file format: ${jsonFilename} (line ${e.row}, column ${e.column})\n${e.name}: ${e.message}`,
    );
  }
}

/**
 * Validates an object with the specified JSON schema.
 *
 * @param json The object to validate
 * @param schema The schema used to validate the object
 */
export function validateJSON(json: object, schema: object) {
  const validate = ajv.compile(schema);
  const valid = validate(json);

  if (!valid) {
    throw new Error(
      `JSON validation error: ${ajv.errorsText(validate.errors)}\nError details:\n${JSON.stringify(
        validate.errors,
        null,
        2,
      )}`,
    );
  }
}

/**
 * Reads and validates some type of `info.json` file.
 *
 * @param jsonFilename The name of the file to read
 * @param schema The name of the schema file
 * @returns The parsed and validated JSON
 */
export async function readInfoJSON(jsonFilename: string, schema: object): Promise<any> {
  const json = await readJSON(jsonFilename);

  if (!schema) return json;

  try {
    validateJSON(json, schema);
    return json;
  } catch (e) {
    throw new Error(`Error validating file '${jsonFilename}' against schema: ${e}`);
  }
}
