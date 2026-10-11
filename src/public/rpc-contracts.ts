import type { JobQueryView, JobStatusPublic, ReviewState } from "../domain/jobs.ts";
import { runtimeErrorCodes, type ErrorCode } from "../domain/errors.ts";

export type RpcOperation = "ping" | "status" | "list" | "wait" | "result" | "spawn" | "control" | "review";
export type RpcParams = {
  ping: {}; status: { id: string }; list: { statuses?: JobStatusPublic[]; agent?: string; createdBefore?: number; createdAfter?: number; pendingReview?: boolean; limit?: number; cursor?: string };
  wait: { id: string; until?: JobStatusPublic | "terminal"; timeoutSeconds?: number };
  result: { id: string; operation: "peek" | "consume" }; spawn: { agent: string; task: string; outputContract?: Record<string, unknown> };
  control: { id: string; action: "pause" | "resume" | "cancel" | "retry"; reason?: string }; review: Record<string, unknown>;
};
export type RpcRequest<O extends RpcOperation = RpcOperation> = { protocolVersion: 1; requestId: string; correlationId: string; callerId: string; params: RpcParams[O] } & (O extends "ping" ? { sessionId?: string } : { sessionId: string });
export type RpcJobDto = { id: string; status: JobStatusPublic; agent: string; model: { provider: string; modelId: string }; createdAt: number; updatedAt: number; startedAt?: number; finishedAt?: number; queuePosition?: number; durationMs?: number; hasResult: boolean; reviewStatus: ReviewState; gatePhase?: string; gateCurrent?: string; gatePassed?: number; gateTotal?: number; technicalOutcome?: string; consumption: { count: number; firstConsumedAt?: number; lastConsumedAt?: number } };
export type RpcDiscovery = { protocolVersion: 1; sessionId: string; implementationVersion: string; operations: RpcOperation[]; capabilities: { query: boolean; wait: boolean; result: boolean; spawn: boolean; control: boolean; rpcReview: false; activePause: false; activeCancel: { requiresHumanConfirmation: true; available: boolean } }; limits: { maxListPage: 100; maxWaitSeconds: 300; maxResultBytes: 65536; recentEventWindow: 1000; queryTimeoutMs: 5000; mutationTimeoutMs: 30000; maxIdBytes: 256; maxCorrelationLength: 128 } };
export type RpcData = { ping: RpcDiscovery; status: RpcJobDto; wait: RpcJobDto; list: { items: RpcJobDto[]; nextCursor?: string }; spawn: { jobId: string; status: "queued"; agent: string }; control: { jobId: string; requestId: string; action: RpcParams["control"]["action"]; previousStatus: JobStatusPublic; status: JobStatusPublic; replayed: boolean; appliedAt: number; retryJobId?: string; retryOf?: string; attemptNumber?: number }; result: { job: RpcJobDto; result: { text: string; totalBytes: number; sha256: string; truncated: boolean; durationMs: number; model: { provider: string; modelId: string }; status: "completed" | "failed" | "interrupted"; structuredResult?: { value: unknown; validatedAt: number; schemaHash: string }; technicalOutcome?: string } }; review: never };
export type RpcErrorCode = Exclude<ErrorCode, "CONTROL_CONFLICT" | "ACTIVE_CANCEL_CONFIRMATION_REQUIRED"> | "PROTOCOL_UNSUPPORTED" | "SESSION_MISMATCH" | "CAPABILITY_UNAVAILABLE" | "RPC_SHUTTING_DOWN" | "RPC_REVIEW_FORBIDDEN" | "RPC_TIMEOUT";
export type RpcError = { code: RpcErrorCode; message: string; retryable: boolean; details: {} };
export type RpcResponse<O extends RpcOperation = RpcOperation> = { protocolVersion: 1; requestId: string; correlationId: string; sessionId: string } & ({ success: true; data: RpcData[O] } | { success: false; error: RpcError });
export class RpcValidationError extends Error { readonly code: RpcErrorCode; constructor(code: RpcErrorCode = "INVALID_REQUEST") { super("La solicitud RPC no es válida."); this.name = "RpcValidationError"; this.code = code; } }

const operations: RpcOperation[] = ["ping", "status", "list", "wait", "result", "spawn", "control", "review"];
const statuses = new Set<JobStatusPublic>(["queued", "paused", "running", "cancelling", "completed", "failed", "interrupted", "cancelled"]);
const publicRpcErrorCodes = ["PROTOCOL_UNSUPPORTED", "SESSION_MISMATCH", "CAPABILITY_UNAVAILABLE", "RPC_SHUTTING_DOWN", "RPC_REVIEW_FORBIDDEN", "RPC_TIMEOUT"] as const;
const errorCodes = new Set<string>([...runtimeErrorCodes.filter(code => code !== "CONTROL_CONFLICT"), ...publicRpcErrorCodes]);
const transportErrorCodes = new Set<string>(["INVALID_REQUEST", "PROTOCOL_UNSUPPORTED", "SESSION_MISMATCH", "RPC_SHUTTING_DOWN", "RPC_TIMEOUT"]);
const responseErrorCodes = new Set<string>([...transportErrorCodes, "RPC_REVIEW_FORBIDDEN"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code: RpcErrorCode = "INVALID_REQUEST"): never => { throw new RpcValidationError(code); };

function jsonGraph(value: unknown, active = new WeakSet<object>(), allowUndefined = true): boolean {
  if (value === undefined) return allowUndefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || typeof value === "function" || typeof value === "bigint") return false;
  if (active.has(value)) return false;
  active.add(value);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) { active.delete(value); return false; }
  } else if (proto !== Object.prototype && proto !== null) { active.delete(value); return false; }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") { active.delete(value); return false; }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !jsonGraph(descriptor.value, active, Array.isArray(value) ? false : true)) { active.delete(value); return false; }
  }
  active.delete(value);
  return true;
}
function plain(value: unknown): value is Record<string, unknown> { return jsonGraph(value) && !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function string(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes; }
function limitedId(value: unknown): value is string { return string(value, 256); }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function requiredKeys(value: Record<string, unknown>, required: string[]) { return required.every(key => own(value, key)); }
function validStatus(value: unknown): value is JobStatusPublic { return typeof value === "string" && statuses.has(value as JobStatusPublic); }
function validNonNegativeNumber(value: unknown): value is number { return number(value) && value >= 0; }
function validOptionalTimestamp(value: unknown): boolean { return value === undefined || validNonNegativeNumber(value); }
function validModel(value: unknown): boolean {
  if (!plain(value) || !requiredKeys(value, ["provider", "modelId"])) return false;
  return string(value.provider) && string(value.modelId);
}
function validConsumption(value: unknown): boolean {
  if (!plain(value) || !requiredKeys(value, ["count"]) || !Number.isInteger(value.count) || (value.count as number) < 0) return false;
  return validOptionalTimestamp(value.firstConsumedAt) && validOptionalTimestamp(value.lastConsumedAt);
}
function validReviewStatus(value: unknown): boolean {
  return typeof value === "string" && ["not_required", "pending", "approved", "rejected"].includes(value);
}
function validJob(value: unknown): value is RpcJobDto {
  if (!plain(value) || !requiredKeys(value, ["id", "status", "agent", "model", "createdAt", "updatedAt", "hasResult", "reviewStatus", "consumption"])) return false;
  if (!string(value.id) || !validStatus(value.status) || !string(value.agent)) return false;
  if (!validModel(value.model) || !validNonNegativeNumber(value.createdAt) || !validNonNegativeNumber(value.updatedAt)) return false;
  if (!validOptionalTimestamp(value.startedAt) || !validOptionalTimestamp(value.finishedAt)) return false;
  if (value.queuePosition !== undefined && (!Number.isInteger(value.queuePosition) || (value.queuePosition as number) < 0)) return false;
  if (value.durationMs !== undefined && !validNonNegativeNumber(value.durationMs)) return false;
  if (value.gatePhase !== undefined && !["pending", "running", "passed", "failed", "interrupted", "timed_out"].includes(value.gatePhase as string)) return false;
  if (value.gateCurrent !== undefined && !string(value.gateCurrent)) return false;
  if (value.gatePassed !== undefined && (!Number.isInteger(value.gatePassed) || (value.gatePassed as number) < 0)) return false;
  if (value.gateTotal !== undefined && (!Number.isInteger(value.gateTotal) || (value.gateTotal as number) < 0)) return false;
  if (value.technicalOutcome !== undefined && !["agent_failed", "output_invalid", "gates_passed", "gate_failed", "gate_interrupted"].includes(value.technicalOutcome as string)) return false;
  return typeof value.hasResult === "boolean" && validReviewStatus(value.reviewStatus) && validConsumption(value.consumption);
}
function paramsFor(operation: RpcOperation, value: unknown): boolean {
  if (!plain(value)) return false;
  const p = value;
  if (operation === "ping") return Object.keys(p).length === 0;
  if (operation === "status") return keys(p, ["id"]) && requiredKeys(p, ["id"]) && string(p.id);
  if (operation === "spawn") return keys(p, ["agent", "task", "outputContract"]) && requiredKeys(p, ["agent", "task"]) && string(p.agent) && string(p.task, Number.MAX_SAFE_INTEGER) && (p.outputContract === undefined || plain(p.outputContract));
  if (operation === "result") return keys(p, ["id", "operation"]) && requiredKeys(p, ["id", "operation"]) && string(p.id) && (p.operation === "peek" || p.operation === "consume");
  if (operation === "control") return keys(p, ["id", "action", "reason"]) && requiredKeys(p, ["id", "action"]) && string(p.id) && typeof p.action === "string" && ["pause", "resume", "cancel", "retry"].includes(p.action) && (p.reason === undefined || (typeof p.reason === "string" && p.reason.length <= 2048));
  if (operation === "wait") return keys(p, ["id", "until", "timeoutSeconds"]) && requiredKeys(p, ["id"]) && string(p.id) && (p.until === undefined || p.until === "terminal" || validStatus(p.until)) && (p.timeoutSeconds === undefined || (number(p.timeoutSeconds) && p.timeoutSeconds >= 0 && p.timeoutSeconds <= 300));
  if (operation === "list") return keys(p, ["statuses", "agent", "createdBefore", "createdAfter", "pendingReview", "limit", "cursor"]) && (p.statuses === undefined || (Array.isArray(p.statuses) && p.statuses.length > 0 && p.statuses.every(validStatus))) && (p.agent === undefined || string(p.agent)) && (p.createdBefore === undefined || (number(p.createdBefore) && p.createdBefore >= 0)) && (p.createdAfter === undefined || (number(p.createdAfter) && p.createdAfter >= 0)) && (p.createdBefore === undefined || p.createdAfter === undefined || (p.createdAfter as number) <= (p.createdBefore as number)) && (p.pendingReview === undefined || typeof p.pendingReview === "boolean") && (p.limit === undefined || (Number.isInteger(p.limit) && (p.limit as number) >= 1 && (p.limit as number) <= 100)) && (p.cursor === undefined || string(p.cursor));
  return operation === "review" && Object.keys(p).length === 0;
}

export function parseRpcRequest<O extends RpcOperation>(operation: O, input: unknown): RpcRequest<O> {
  if (!operations.includes(operation) || !plain(input)) fail();
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== 1) fail("PROTOCOL_UNSUPPORTED");
  if (!keys(value, ["protocolVersion", "requestId", "correlationId", "callerId", "sessionId", "params"]) || !requiredKeys(value, ["protocolVersion", "requestId", "correlationId", "callerId", "params"]) || !limitedId(value.requestId) || !isSafeCorrelation(value.correlationId) || !limitedId(value.callerId) || (value.sessionId !== undefined && !limitedId(value.sessionId)) || (operation !== "ping" && !limitedId(value.sessionId)) || !paramsFor(operation, value.params)) fail();
  return value as RpcRequest<O>;
}
const discoveryLimits = { maxListPage: 100, maxWaitSeconds: 300, maxResultBytes: 65536, recentEventWindow: 1000, queryTimeoutMs: 5000, mutationTimeoutMs: 30000, maxIdBytes: 256, maxCorrelationLength: 128 };
function validCapabilities(value: unknown): boolean {
  if (!plain(value) || typeof value.query !== "boolean" || typeof value.wait !== "boolean" || typeof value.result !== "boolean" || typeof value.spawn !== "boolean" || typeof value.control !== "boolean") return false;
  if (value.rpcReview !== false || value.activePause !== false || !plain(value.activeCancel)) return false;
  return value.activeCancel.requiresHumanConfirmation === true && typeof value.activeCancel.available === "boolean";
}
function validDiscovery(value: unknown): value is RpcDiscovery {
  if (!plain(value) || !requiredKeys(value, ["protocolVersion", "sessionId", "implementationVersion", "operations", "capabilities", "limits"])) return false;
  if (value.protocolVersion !== 1 || !limitedId(value.sessionId) || !string(value.implementationVersion)) return false;
  if (!Array.isArray(value.operations) || value.operations.length !== operations.length || !value.operations.every(op => typeof op === "string" && operations.includes(op as RpcOperation))) return false;
  if (!validCapabilities(value.capabilities) || !plain(value.limits)) return false;
  const limits = value.limits as Record<string, unknown>;
  return Object.entries(discoveryLimits).every(([key, expected]) => limits[key] === expected);
}
function validListData(value: unknown): boolean {
  return plain(value) && requiredKeys(value, ["items"]) && Array.isArray(value.items) && value.items.every(validJob) && (value.nextCursor === undefined || string(value.nextCursor));
}
function validSpawnData(value: unknown): boolean {
  return plain(value) && requiredKeys(value, ["jobId", "status", "agent"]) && string(value.jobId) && value.status === "queued" && string(value.agent);
}
function validControlData(value: unknown): boolean {
  if (!plain(value) || !requiredKeys(value, ["jobId", "requestId", "action", "previousStatus", "status", "replayed", "appliedAt"])) return false;
  if (!string(value.jobId) || !limitedId(value.requestId) || typeof value.action !== "string") return false;
  if (!["pause", "resume", "cancel", "retry"].includes(value.action) || !validStatus(value.previousStatus) || !validStatus(value.status)) return false;
  if (typeof value.replayed !== "boolean" || !validNonNegativeNumber(value.appliedAt)) return false;
  if (value.retryJobId !== undefined && !string(value.retryJobId)) return false;
  if (value.retryOf !== undefined && !string(value.retryOf)) return false;
  return value.attemptNumber === undefined || (Number.isInteger(value.attemptNumber) && (value.attemptNumber as number) >= 0);
}
function validResultData(value: unknown): boolean {
  if (!plain(value) || !requiredKeys(value, ["job", "result"]) || !validJob(value.job) || !plain(value.result)) return false;
  const result = value.result;
  if (!requiredKeys(result, ["text", "totalBytes", "sha256", "truncated", "durationMs", "model", "status"])) return false;
  if (typeof result.text !== "string" || !Number.isInteger(result.totalBytes) || (result.totalBytes as number) < 0) return false;
  if (!string(result.sha256) || typeof result.truncated !== "boolean" || !validNonNegativeNumber(result.durationMs) || !validModel(result.model)) return false;
  if (result.structuredResult !== undefined && (!plain(result.structuredResult) || !requiredKeys(result.structuredResult, ["value", "validatedAt", "schemaHash"]) || !jsonGraph(result.structuredResult.value) || !validNonNegativeNumber(result.structuredResult.validatedAt) || !string(result.structuredResult.schemaHash))) return false;
  if (result.technicalOutcome !== undefined && !["agent_failed", "output_invalid", "gates_passed", "gate_failed", "gate_interrupted"].includes(result.technicalOutcome as string)) return false;
  return typeof result.status === "string" && ["completed", "failed", "interrupted"].includes(result.status);
}
function validData(operation: RpcOperation, value: unknown): boolean {
  if (operation === "ping") return validDiscovery(value);
  if (operation === "status" || operation === "wait") return validJob(value);
  if (operation === "list") return validListData(value);
  if (operation === "spawn") return validSpawnData(value);
  if (operation === "control") return validControlData(value);
  if (operation === "result") return validResultData(value);
  return false;
}
function validErrorShape(value: unknown): value is RpcError {
  if (!plain(value) || !requiredKeys(value, ["code", "message", "retryable", "details"])) return false;
  return typeof value.code === "string" && errorCodes.has(value.code) && string(value.message) && typeof value.retryable === "boolean" && plain(value.details) && Object.keys(value.details).length === 0;
}
function validErrorForOperation(operation: RpcOperation, value: unknown): value is RpcError {
  if (!validErrorShape(value)) return false;
  if (operation !== "review") return true;
  return responseErrorCodes.has(value.code);
}
function validReviewFailure(value: unknown): boolean {
  return validErrorShape(value) && responseErrorCodes.has(value.code);
}
export function parseRpcResponse<O extends RpcOperation>(operation: O, input: unknown): RpcResponse<O> {
  if (!operations.includes(operation) || !plain(input)) fail();
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== 1) fail("PROTOCOL_UNSUPPORTED");
  if (!requiredKeys(value, ["protocolVersion", "requestId", "correlationId", "sessionId", "success"]) || !limitedId(value.requestId) || !isSafeCorrelation(value.correlationId) || !limitedId(value.sessionId) || typeof value.success !== "boolean") fail();
  const error = value.error;
  const validFailure = validErrorForOperation(operation, error) && (operation !== "review" || validReviewFailure(error));
  if (value.success === true) {
    if (operation === "review" || !own(value, "data") || own(value, "error") || !validData(operation, value.data)) fail(operation === "review" ? "RPC_REVIEW_FORBIDDEN" : "INVALID_REQUEST");
  } else if (own(value, "data") || !validFailure || (operation === "review" && (error as RpcError).code !== "RPC_REVIEW_FORBIDDEN" && !responseErrorCodes.has((error as RpcError).code))) {
    fail();
  }
  return value as RpcResponse<O>;
}
export function isSafeCorrelation(input: unknown): input is string { return typeof input === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(input); }
export function hasOversizedIds(input: unknown): boolean { return !!input && typeof input === "object" && ["requestId", "callerId", "sessionId"].some(key => { const d = Object.getOwnPropertyDescriptor(input, key); return !!d && "value" in d && typeof d.value === "string" && Buffer.byteLength(d.value) > 256; }); }
export function requestChannel(operation: RpcOperation): string { return `pi-durable-subagents:rpc:${operation}`; }
export function replyChannel(operation: RpcOperation, correlationId: string): string { return `pi-durable-subagents:rpc:${operation}:reply:${correlationId}`; }
export { eventChannel } from "./job-events.ts";
export function projectJob(view: JobQueryView): RpcJobDto { const result: RpcJobDto = { id: view.id, status: (view.status as string) === "provisioning" ? "running" : view.status, agent: view.agent.name, model: { provider: view.model.provider, modelId: view.model.modelId }, createdAt: view.createdAt, updatedAt: view.updatedAt, hasResult: view.hasResult, reviewStatus: view.reviewStatus, consumption: { count: view.consumption.count } }; for (const key of ["startedAt", "finishedAt", "queuePosition", "durationMs", "gatePhase", "gateCurrent", "gatePassed", "gateTotal", "technicalOutcome"] as const) if (view[key] !== undefined) result[key] = view[key] as never; if (view.consumption.firstConsumedAt !== undefined) result.consumption.firstConsumedAt = view.consumption.firstConsumedAt; if (view.consumption.lastConsumedAt !== undefined) result.consumption.lastConsumedAt = view.consumption.lastConsumedAt; return result; }
