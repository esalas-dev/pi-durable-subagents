import { createHash } from "node:crypto";
import { DomainError } from "./errors.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type GateSpec = { name: string; command: string[]; timeoutSeconds: number; expectedExitCodes: number[]; shell?: false };
export type OutputContract = { schema: JsonValue; schemaHash: string; mode: "strict-json"; maxCorrectionTurns: 1; gates: GateSpec[] };
export type StructuredResult = { value: JsonValue; validatedAt: number; schemaHash: string };
export type GateStatus = "pending" | "running" | "passed" | "failed" | "interrupted" | "timed_out";
export type StreamCapture = { text: string; totalBytes: number; sha256: string; truncated: boolean };
export type GateRecord = GateSpec & { requestId: string; status: GateStatus; startedAt?: number; finishedAt?: number; durationMs?: number; exitCode?: number; signal?: string; stdout: StreamCapture; stderr: StreamCapture };
export type TechnicalOutcome = "agent_failed" | "output_invalid" | "gates_passed" | "gate_failed" | "gate_interrupted";

type SchemaObject = Record<string, JsonValue>;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_GATES = 8;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const supportedKeywords = new Set(["$schema", "$id", "$defs", "$ref", "type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minProperties", "maxProperties", "allOf", "anyOf", "oneOf", "not", "description", "title", "default"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function invalid(message = "El contrato estructurado no es válido."): never { throw new DomainError("INVALID_REQUEST", message); }
function outputInvalid(message = "La salida estructurada no es válida."): never { throw new DomainError("STRUCTURED_OUTPUT_INVALID", message); }
function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function schemaObject(value: JsonValue): SchemaObject | undefined { return plain(value) ? value as SchemaObject : undefined; }
function json(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => json(item, depth + 1));
  if (!plain(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && json(item, depth + 1));
}
function jsonBytes(value: JsonValue): number { return Buffer.byteLength(JSON.stringify(value) ?? ""); }
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as SchemaObject;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function schemaDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map(item => schemaDepth(item, depth + 1)));
  return Math.max(depth, ...Object.values(value as Record<string, unknown>).map(item => schemaDepth(item, depth + 1)));
}
function pointer(root: JsonValue, ref: string): JsonValue | undefined {
  if (!ref.startsWith("#/") && ref !== "#") return undefined;
  if (ref === "#") return root;
  let current: JsonValue | undefined = root;
  for (const part of ref.slice(2).split("/").map(value => value.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) current = /^\d+$/.test(part) ? current[Number(part)] : undefined;
    else if (current && typeof current === "object") current = (current as SchemaObject)[part];
    else return undefined;
  }
  return current;
}
function inspectSchema(schema: JsonValue, root = schema, depth = 0, seen = new Set<JsonValue>()): void {
  if (depth > MAX_SCHEMA_DEPTH || !json(schema, depth)) invalid("El schema excede los límites de JSON.");
  if (typeof schema === "boolean") return;
  const node = schemaObject(schema);
  if (!node || seen.has(schema)) invalid("El schema contiene una forma no soportada o referencias cíclicas.");
  seen.add(schema);
  for (const key of Object.keys(node)) {
    if (!supportedKeywords.has(key)) invalid(`Keyword de JSON Schema no soportada: ${key}`);
    const value = node[key];
    if (key === "$ref") {
      if (typeof value !== "string" || (!value.startsWith("#/") && value !== "#") || !pointer(root, value)) invalid("Solo se admiten refs locales resolubles.");
    } else if (key === "properties" || key === "$defs") {
      const children = schemaObject(value);
      if (!children) invalid(`El campo ${key} no es válido.`);
      for (const child of Object.values(children)) inspectSchema(child, root, depth + 1, seen);
    } else if (["items", "not"].includes(key)) inspectSchema(value, root, depth + 1, seen);
    else if (["allOf", "anyOf", "oneOf"].includes(key)) {
      if (!Array.isArray(value) || value.length === 0) invalid(`El campo ${key} no es válido.`);
      for (const child of value) inspectSchema(child, root, depth + 1, seen);
    }
  }
  seen.delete(schema);
}
function validateGate(value: unknown): GateSpec {
  if (!plain(value)) invalid("La configuración del gate no es válida.");
  const name = value.name; const command = value.command; const timeout = value.timeout_seconds ?? value.timeoutSeconds; const exitCodes = value.expected_exit_codes ?? value.expectedExitCodes;
  const validTimeout = typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 1 && timeout <= 1800;
  const validExitCodes = Array.isArray(exitCodes) && exitCodes.length > 0 && exitCodes.every(code => typeof code === "number" && Number.isInteger(code) && code >= -255 && code <= 255);
  if (!Object.keys(value).every(key => ["name", "command", "timeout_seconds", "timeoutSeconds", "expected_exit_codes", "expectedExitCodes", "shell"].includes(key)) || typeof name !== "string" || name.length === 0 || Buffer.byteLength(name) > 256 || !Array.isArray(command) || command.length < 1 || command.length > MAX_ARGS || command.some(arg => typeof arg !== "string" || Buffer.byteLength(arg) > MAX_ARG_BYTES) || (value.shell !== undefined && value.shell !== false) || !validTimeout || !validExitCodes) invalid("La configuración del gate no es válida.");
  return { name, command: [...command] as string[], timeoutSeconds: timeout as number, expectedExitCodes: [...exitCodes as number[]], shell: false };
}

export function validateOutputContract(input: unknown): OutputContract {
  if (!plain(input)) invalid();
  const schema = (input.output_schema ?? input.outputSchema ?? input.schema) as unknown;
  const gates = input.gates;
  if (!json(schema) || jsonBytes(schema) > MAX_SCHEMA_BYTES || schemaDepth(schema) > MAX_SCHEMA_DEPTH) invalid("El schema excede sus límites.");
  inspectSchema(schema);
  if (!Array.isArray(gates) || gates.length > MAX_GATES) invalid("La lista de gates no es válida.");
  const normalizedGates = gates.map(validateGate);
  const names = new Set<string>();
  for (const gate of normalizedGates) { if (names.has(gate.name)) invalid("Los nombres de gate deben ser únicos."); names.add(gate.name); }
  const schemaHash = createHash("sha256").update(canonical(schema)).digest("hex");
  return { schema, schemaHash, mode: "strict-json", maxCorrectionTurns: 1, gates: normalizedGates };
}

export function parseStrictJson(text: string): JsonValue {
  if (typeof text !== "string" || !text.trim()) outputInvalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { outputInvalid(); }
  if (!json(value) || text.trim() !== JSON.stringify(value)) outputInvalid("La respuesta debe contener únicamente un documento JSON.");
  return value;
}

function matches(value: JsonValue, schema: JsonValue, root: JsonValue, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (schema === true) return true;
  if (schema === false || typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const node = schema as SchemaObject;
  if (typeof node.$ref === "string") { const target = pointer(root, node.$ref); return target !== undefined && matches(value, target, root, depth + 1); }
  if (Array.isArray(node.allOf) && !node.allOf.every(item => matches(value, item, root, depth + 1))) return false;
  if (Array.isArray(node.anyOf) && !node.anyOf.some(item => matches(value, item, root, depth + 1))) return false;
  if (Array.isArray(node.oneOf) && node.oneOf.filter(item => matches(value, item, root, depth + 1)).length !== 1) return false;
  if (node.not !== undefined && matches(value, node.not, root, depth + 1)) return false;
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some(type => type === "null" && value === null || type === "array" && Array.isArray(value) || type === "object" && plain(value) || type === "string" && typeof value === "string" || type === "boolean" && typeof value === "boolean" || type === "number" && typeof value === "number" || type === "integer" && typeof value === "number" && Number.isInteger(value))) return false;
  }
  if (Array.isArray(node.enum) && !node.enum.some(item => canonical(item) === canonical(value))) return false;
  if (node.const !== undefined && canonical(node.const) !== canonical(value)) return false;
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength || typeof node.maxLength === "number" && value.length > node.maxLength) return false;
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum || typeof node.maximum === "number" && value > node.maximum || typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum || typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems || typeof node.maxItems === "number" && value.length > node.maxItems) return false;
    if (node.items !== undefined && !value.every(item => matches(item, node.items as JsonValue, root, depth + 1))) return false;
  }
  if (plain(value)) {
    const properties = schemaObject(node.properties) ?? {};
    if (Array.isArray(node.required) && node.required.some(key => typeof key !== "string" || !own(value, key))) return false;
    if (typeof node.minProperties === "number" && Object.keys(value).length < node.minProperties || typeof node.maxProperties === "number" && Object.keys(value).length > node.maxProperties) return false;
    for (const [key, child] of Object.entries(value)) {
      if (own(properties, key) && !matches(child, properties[key], root, depth + 1)) return false;
      if (!own(properties, key) && node.additionalProperties === false) return false;
      if (!own(properties, key) && node.additionalProperties && !matches(child, node.additionalProperties as JsonValue, root, depth + 1)) return false;
    }
  }
  return true;
}

export function validateStructuredValue(value: unknown, schema: unknown): value is JsonValue {
  if (!json(value) || !json(schema) || schemaDepth(schema) > MAX_SCHEMA_DEPTH) return false;
  return matches(value, schema, schema);
}
