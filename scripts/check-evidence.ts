// Validate the release evidence under docs/release-evidence. Every receipt, a
// *.json file directly in the directory, must match exactly one schema in its
// schemas/ subdirectory through that schema's x-fileNamePattern, carry the
// schema version the schema requires, validate against the schema, and name
// only existing receipts in the fields the schema marks with x-evidenceFile.
// Every schema must match at least one receipt.
//
// The schemas are JSON Schema 2020-12 documents limited to the keywords this
// script implements; a schema using any other keyword fails the check, so this
// script and a full validator accept the same receipts. Offline: nothing is
// fetched. `mise run check:evidence` runs it as part of `lint`.
//
// Usage: deno run --allow-read scripts/check-evidence.ts [directory]

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const draft = "https://json-schema.org/draft/2020-12/schema";
const versionKeys = ["schemaVersion", "schema_version"];
const typeNames = new Set([
  "null",
  "boolean",
  "integer",
  "number",
  "string",
  "array",
  "object",
]);
const keywords = new Set([
  "$schema",
  "$comment",
  "title",
  "description",
  "$defs",
  "$ref",
  "type",
  "enum",
  "const",
  "pattern",
  "minLength",
  "minimum",
  "minItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "x-fileNamePattern",
  "x-evidenceFile",
]);

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function member(path: string, name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;
}

function describe(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function equal(a: Json, b: Json): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, index) => equal(item, b[index]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return a === b;
}

function hasType(value: Json, name: string): boolean {
  switch (name) {
    case "null":
      return value === null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
  }
  return false;
}

function validRegExp(pattern: Json): boolean {
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/** Problems with the schema itself: unsupported keywords or malformed values. */
function schemaProblems(
  schema: Json,
  path: string,
  root: JsonObject,
): string[] {
  if (typeof schema === "boolean") return [];
  if (!isObject(schema)) return [`${path}: a schema is an object or a boolean`];
  const problems: string[] = [];
  const atRoot = schema === root;
  const sub = (value: Json, at: string) =>
    problems.push(...schemaProblems(value, at, root));
  for (const [keyword, value] of Object.entries(schema)) {
    const at = member(path, keyword);
    if (!keywords.has(keyword)) {
      problems.push(`${at}: unsupported keyword`);
      continue;
    }
    switch (keyword) {
      case "$schema":
        if (!atRoot || value !== draft) {
          problems.push(`${at}: only the root names ${draft}`);
        }
        break;
      case "$comment":
      case "title":
      case "description":
        if (typeof value !== "string") problems.push(`${at}: not a string`);
        break;
      case "$defs":
        if (!atRoot || !isObject(value)) {
          problems.push(`${at}: an object of schemas at the root only`);
        } else {
          for (const [name, item] of Object.entries(value)) {
            sub(item, member(at, name));
          }
        }
        break;
      case "$ref": {
        const name = typeof value === "string"
          ? /^#\/\$defs\/([^/]+)$/.exec(value)?.[1]
          : undefined;
        if (
          name === undefined || !isObject(root.$defs) ||
          !Object.hasOwn(root.$defs, name)
        ) problems.push(`${at}: not a #/$defs/<name> of this schema`);
        break;
      }
      case "type": {
        const names = Array.isArray(value) ? value : [value];
        if (
          names.length === 0 ||
          !names.every((name) =>
            typeof name === "string" && typeNames.has(name)
          )
        ) problems.push(`${at}: not a JSON type name or a list of them`);
        break;
      }
      case "enum":
        if (!Array.isArray(value) || value.length === 0) {
          problems.push(`${at}: not a non-empty list`);
        }
        break;
      case "const":
        break;
      case "pattern":
        if (!validRegExp(value)) {
          problems.push(`${at}: not a regular expression`);
        }
        break;
      case "x-fileNamePattern":
        if (
          !atRoot || !validRegExp(value) || !String(value).startsWith("^") ||
          !String(value).endsWith("$")
        ) problems.push(`${at}: an anchored regular expression at the root`);
        break;
      case "minLength":
      case "minItems":
        if (!Number.isInteger(value) || (value as number) < 0) {
          problems.push(`${at}: not a non-negative integer`);
        }
        break;
      case "minimum":
        if (typeof value !== "number") problems.push(`${at}: not a number`);
        break;
      case "items":
      case "additionalProperties":
        sub(value, at);
        break;
      case "properties":
        if (!isObject(value)) {
          problems.push(`${at}: not an object of schemas`);
        } else {
          for (const [name, item] of Object.entries(value)) {
            sub(item, member(at, name));
          }
        }
        break;
      case "required":
        if (
          !Array.isArray(value) ||
          !value.every((name) => typeof name === "string") ||
          new Set(value).size !== value.length
        ) problems.push(`${at}: not a list of distinct names`);
        break;
      case "x-evidenceFile":
        if (value !== true) problems.push(`${at}: only true is meaningful`);
        break;
    }
  }
  if (atRoot) {
    if (schema.$schema !== draft) {
      problems.push(`${path}: $schema must be ${draft}`);
    }
    if (typeof schema["x-fileNamePattern"] !== "string") {
      problems.push(`${path}: missing x-fileNamePattern`);
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    const version = versionKeys.filter((key) => required.includes(key));
    const properties = isObject(schema.properties) ? schema.properties : {};
    const declared = version.length === 1 ? properties[version[0]] : undefined;
    // One version (const) or the versions a changed producer still accepts
    // (enum), so committed receipts never need rewriting.
    const versions = !isObject(declared)
      ? []
      : declared.const !== undefined
      ? [declared.const]
      : Array.isArray(declared.enum)
      ? declared.enum
      : [];
    if (versions.length === 0 || !versions.every(Number.isInteger)) {
      problems.push(
        `${path}: must require one of ${
          versionKeys.join(", ")
        } with an integer const or enum`,
      );
    }
  }
  return problems;
}

type Context = { root: JsonObject; receipts: Set<string>; problems: string[] };

function validate(
  value: Json,
  schema: Json,
  path: string,
  context: Context,
): void {
  if (schema === true) return;
  if (schema === false || !isObject(schema)) {
    context.problems.push(`${path}: not allowed here`);
    return;
  }
  const problem = (message: string) =>
    context.problems.push(`${path}: ${message}`);
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.slice("#/$defs/".length);
    validate(value, (context.root.$defs as JsonObject)[name], path, context);
  }
  if (schema.type !== undefined) {
    const names = (Array.isArray(schema.type) ? schema.type : [schema.type])
      .map(String);
    if (!names.some((name) => hasType(value, name))) {
      problem(`expected ${names.join(" or ")}, found ${describe(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !equal(value, schema.const)) {
    problem(`expected ${JSON.stringify(schema.const)}`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((option) => equal(value, option))
  ) {
    problem(`expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    ) problem(`${JSON.stringify(value)} does not match ${schema.pattern}`);
    if (
      typeof schema.minLength === "number" &&
      [...value].length < schema.minLength
    ) problem(`shorter than ${schema.minLength} characters`);
    if (schema["x-evidenceFile"] === true && !context.receipts.has(value)) {
      problem(`${JSON.stringify(value)} is not a receipt in the directory`);
    }
  }
  if (
    typeof value === "number" && typeof schema.minimum === "number" &&
    value < schema.minimum
  ) problem(`less than ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problem(`fewer than ${schema.minItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) =>
        validate(item, schema.items as Json, `${path}[${index}]`, context)
      );
    }
  }
  if (isObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required.map(String)) {
      if (!Object.hasOwn(value, name)) problem(`missing ${name}`);
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        validate(item, properties[name], member(path, name), context);
      } else if (schema.additionalProperties === false) {
        problem(`unexpected property ${JSON.stringify(name)}`);
      } else if (schema.additionalProperties !== undefined) {
        validate(
          item,
          schema.additionalProperties,
          member(path, name),
          context,
        );
      }
    }
  }
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function jsonFiles(directory: string, suffix: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(suffix)) names.push(entry.name);
  }
  return names.sort();
}

if (import.meta.main) {
  if (Deno.args.length > 1) {
    console.error("usage: check-evidence.ts [directory]");
    Deno.exit(2);
  }
  const directory = Deno.args[0] ?? "docs/release-evidence";
  const failures: string[] = [];

  const schemas = new Map<string, JsonObject>();
  for (const name of await jsonFiles(`${directory}/schemas`, ".schema.json")) {
    let schema: Json;
    try {
      schema = await readJson(`${directory}/schemas/${name}`);
    } catch (error) {
      failures.push(`schemas/${name}: ${error}`);
      continue;
    }
    if (!isObject(schema)) {
      failures.push(`schemas/${name}: not a JSON object`);
      continue;
    }
    const problems = schemaProblems(schema, `schemas/${name}`, schema);
    if (problems.length > 0) {
      failures.push(...problems);
    } else {
      schemas.set(name, schema);
    }
  }

  const receipts = new Set(await jsonFiles(directory, ".json"));
  const used = new Set<string>();
  for (const name of receipts) {
    const matching = [...schemas].filter(([, schema]) =>
      new RegExp(String(schema["x-fileNamePattern"]), "u").test(name)
    );
    if (matching.length !== 1) {
      failures.push(
        `${name}: matches ${
          matching.length === 0
            ? "no schema"
            : matching.map(([schemaName]) => schemaName).join(" and ")
        }`,
      );
      continue;
    }
    const [schemaName, schema] = matching[0];
    used.add(schemaName);
    let receipt: Json;
    try {
      receipt = await readJson(`${directory}/${name}`);
    } catch (error) {
      failures.push(`${name}: ${error}`);
      continue;
    }
    const context: Context = { root: schema, receipts, problems: [] };
    validate(receipt, schema, name, context);
    if (context.problems.length > 0) {
      failures.push(...context.problems);
      console.log(`FAIL ${name} (${schemaName})`);
      continue;
    }
    const version = versionKeys.find((key) =>
      isObject(receipt) && Object.hasOwn(receipt, key)
    )!;
    console.log(
      `PASS ${name} (${schemaName}, ${version} ${
        (receipt as JsonObject)[version]
      })`,
    );
  }
  for (const name of schemas.keys()) {
    if (!used.has(name)) failures.push(`schemas/${name}: matches no receipt`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`${failures.length} problems in ${directory}`);
    Deno.exit(1);
  }
  console.log(
    `${receipts.size} receipts valid against ${schemas.size} schemas in ${directory}`,
  );
}
