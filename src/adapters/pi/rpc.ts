import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { JobsService } from "../../application/jobs.ts";
import type { Outcome } from "../../domain/errors.ts";
import type { JobQueryView, ResultView } from "../../domain/jobs.ts";
import type { ResolveInput } from "../../domain/requests.ts";
import type { PiSessionState } from "./lifecycle.ts";
import {
  hasOversizedIds, isSafeCorrelation, parseRpcRequest, projectJob, replyChannel, requestChannel,
  RpcValidationError, type RpcData, type RpcDiscovery, type RpcError, type RpcErrorCode,
  type RpcOperation, type RpcRequest, type RpcResponse,
} from "../../public/rpc-contracts.ts";
import type { EventBusLike, TimerApi } from "../../public/job-events.ts";

const packageInfo = createRequire(import.meta.url)("../../../package.json") as { version: string };
const operations: RpcOperation[] = ["ping", "status", "list", "wait", "result", "spawn", "control", "review"];
const maxResultBytes = 65536;
const limits: RpcDiscovery["limits"] = { maxListPage: 100, maxWaitSeconds: 300, maxResultBytes, recentEventWindow: 1000, queryTimeoutMs: 5000, mutationTimeoutMs: 30000, maxIdBytes: 256, maxCorrelationLength: 128 };
const genericMessage = "La operación RPC no pudo completarse.";
const allowedErrors = new Set<RpcErrorCode>([
  "JOB_NOT_FOUND", "INVALID_REQUEST", "AGENT_NOT_FOUND", "UNSUPPORTED_TOOLS", "MODEL_UNAVAILABLE", "REQUEST_ID_CONFLICT", "RUNTIME_CLOSING", "MIGRATION_REQUIRED", "MIGRATION_DECLINED", "BACKUP_FAILED", "STORAGE_VERSION_UNSUPPORTED", "STORAGE_INCONSISTENT", "STORAGE_BUSY", "STORAGE_ERROR", "INVALID_FILTER", "WAIT_TIMEOUT", "WAIT_ABORTED", "RESULT_NOT_READY", "RESULT_REVIEW_REQUIRED", "RESULT_REJECTED", "PAUSE_ACTIVE_UNSUPPORTED", "CONTROL_INVALID_STATE", "CONTROL_NOT_AUTHORIZED", "RETRY_NOT_ALLOWED", "PROTOCOL_UNSUPPORTED", "SESSION_MISMATCH", "CAPABILITY_UNAVAILABLE", "RPC_SHUTTING_DOWN", "RPC_REVIEW_FORBIDDEN", "RPC_TIMEOUT",
]);

type RpcServerOptions = {
  bus: EventBusLike;
  state: PiSessionState;
  resolve: ResolveInput;
  confirmActiveCancellation: (id: string) => Promise<boolean>;
  timers?: TimerApi;
};
type Attempt = {
  operation: RpcOperation;
  request: RpcRequest;
  timer?: ReturnType<TimerApi["setTimeout"]> | number;
  abort: AbortController;
  responded: boolean;
};

function responseError(code: RpcErrorCode, retryable = false): RpcError {
  return { code, message: genericMessage, retryable, details: {} };
}
function safeCode(code: unknown): RpcErrorCode {
  if (code === "CONTROL_CONFLICT") return "REQUEST_ID_CONFLICT";
  if (code === "ACTIVE_CANCEL_CONFIRMATION_REQUIRED") return "CAPABILITY_UNAVAILABLE";
  return typeof code === "string" && allowedErrors.has(code as RpcErrorCode) ? code as RpcErrorCode : "STORAGE_ERROR";
}
function errorCode(outcome: Outcome<unknown>): RpcErrorCode {
  return outcome.success ? "INVALID_REQUEST" : safeCode(outcome.error.code);
}
function makeErrorResponse(operation: RpcOperation, requestId: string, correlationId: string, sessionId: string, code: RpcErrorCode): RpcResponse {
  return { protocolVersion: 1, requestId, correlationId, sessionId, success: false, error: responseError(code, code === "RPC_TIMEOUT" || code === "STORAGE_BUSY") } as RpcResponse;
}
function isActiveCancelUi(state: PiSessionState): boolean {
  return state.context.mode === "tui" && state.context.hasUI;
}
function current(state: PiSessionState): boolean {
  try {
    return state.generation.isActive() && state.generation.sessionId === state.sessionId
      && state.context.sessionManager.getSessionId() === state.sessionId;
  } catch { return false; }
}
function timeoutFor(operation: RpcOperation, request: RpcRequest): number {
  if (operation === "wait") return ((request as RpcRequest<"wait">).params.timeoutSeconds ?? 300) * 1000 + 100;
  if (operation === "spawn" || operation === "control" || (operation === "result" && (request as RpcRequest<"result">).params.operation === "consume")) return 30000;
  return 5000;
}
function jobData(view: JobQueryView): RpcData["status"] { return projectJob(view); }

function fitResultResponse(request: RpcRequest<"result">, sessionId: string, data: RpcData["result"]): RpcResponse<"result"> {
  const fullText = data.result.text;
  const totalBytes = Buffer.byteLength(fullText, "utf8");
  const sha256 = createHash("sha256").update(fullText, "utf8").digest("hex");
  const build = (text: string): RpcResponse<"result"> => ({
    protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId, success: true,
    data: { ...data, result: { ...data.result, text, totalBytes, sha256, truncated: text !== fullText } },
  });
  let response = build(fullText);
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= maxResultBytes) return response;
  const prefixEnd = (end: number) => end > 0 && end < fullText.length
    && fullText.charCodeAt(end - 1) >= 0xd800 && fullText.charCodeAt(end - 1) <= 0xdbff
    && fullText.charCodeAt(end) >= 0xdc00 && fullText.charCodeAt(end) <= 0xdfff ? end - 1 : end;
  let low = 0;
  let high = fullText.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = build(fullText.slice(0, prefixEnd(mid)));
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxResultBytes) low = mid;
    else high = mid - 1;
  }
  response = build(fullText.slice(0, prefixEnd(low)));
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > maxResultBytes) return makeErrorResponse("result", request.requestId, request.correlationId, sessionId, "INVALID_REQUEST") as RpcResponse<"result">;
  return response;
}

export function serializeResultReply(request: RpcRequest<"result">, sessionId: string, data: RpcData["result"]): RpcResponse<"result"> {
  return fitResultResponse(request, sessionId, data);
}

async function resultData(jobs: JobsService, request: RpcRequest<"result">): Promise<Outcome<RpcData["result"]>> {
  const access = await jobs.getResult(request.params.id, {
    mode: "tool", operation: request.params.operation,
    actor: { kind: "extension", id: request.callerId },
    ...(request.params.operation === "consume" ? { requestId: request.requestId } : {}),
  });
  if (!access.success) return access;
  if (!access.value.result) return { success: false, error: { code: "RESULT_NOT_READY", message: genericMessage, retryable: false, details: {} } };
  const job = await jobs.getJob(request.params.id, { includeTask: false });
  if (!job.success) return job;
  const result = access.value.result;
  return { success: true, value: {
    job: projectJob(job.value),
    result: { text: result.finalResponse, totalBytes: Buffer.byteLength(result.finalResponse, "utf8"), sha256: createHash("sha256").update(result.finalResponse, "utf8").digest("hex"), truncated: false, durationMs: result.durationMs, model: result.model, status: result.status, ...(result.structuredResult ? { structuredResult: result.structuredResult } : {}), ...(result.technicalOutcome ? { technicalOutcome: result.technicalOutcome } : {}) },
  } };
}

async function perform(operation: RpcOperation, request: RpcRequest, options: RpcServerOptions, attempt: Attempt): Promise<RpcResponse> {
  const { state } = options;
  if (operation === "review") return makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, "RPC_REVIEW_FORBIDDEN");
  if (operation === "ping") return { protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId: state.sessionId, success: true, data: discovery(state) } as RpcResponse;

  const params = request.params as RpcRequest["params"];
  const jobs = state.runtime.jobs;
  if (operation === "status") {
    const outcome = await jobs.getJob((params as RpcRequest<"status">["params"]).id, { includeTask: false });
    return outcome.success ? { protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId: state.sessionId, success: true, data: jobData(outcome.value) } as RpcResponse : makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(outcome));
  }
  if (operation === "list") {
    const filter = params as RpcRequest<"list">["params"];
    const outcome = await jobs.listJobs(filter);
    return outcome.success ? { protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId: state.sessionId, success: true, data: { items: outcome.value.items.map(projectJob), ...(outcome.value.nextCursor ? { nextCursor: outcome.value.nextCursor } : {}) } } as RpcResponse : makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(outcome));
  }
  if (operation === "wait") {
    const wait = params as RpcRequest<"wait">["params"];
    const signal = AbortSignal.any([attempt.abort.signal, state.generation.signal]);
    const outcome = await jobs.waitForJob(wait.id, { ...(wait.until === undefined ? {} : { until: wait.until }), ...(wait.timeoutSeconds === undefined ? {} : { timeoutSeconds: wait.timeoutSeconds }), signal });
    return outcome.success ? { protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId: state.sessionId, success: true, data: jobData(outcome.value) } as RpcResponse : makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(outcome));
  }
  if (operation === "result") {
    const outcome = await resultData(jobs, request as RpcRequest<"result">);
    return outcome.success ? serializeResultReply(request as RpcRequest<"result">, state.sessionId, outcome.value) : makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(outcome));
  }
  if (operation === "spawn") {
    const spawn = params as RpcRequest<"spawn">["params"];
    const resolve = async (intent: Parameters<ResolveInput>[0]) => {
      if (attempt.responded || !current(state)) throw new Error("RPC request expired");
      const input = await options.resolve(intent);
      if (attempt.responded || !current(state)) throw new Error("RPC request expired");
      return input;
    };
    const outcome = await jobs.start({ requestId: request.requestId, actor: { kind: "extension", id: request.callerId }, intent: { agent: spawn.agent, task: spawn.task, cwd: state.context.cwd, ...(spawn.outputContract === undefined ? {} : { outputContract: spawn.outputContract }) } }, resolve);
    return outcome.success ? { protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId: state.sessionId, success: true, data: outcome.value } as RpcResponse : makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(outcome));
  }
  const control = params as RpcRequest<"control">["params"];
  const actor = { kind: "extension" as const, id: request.callerId };
  const command = { requestId: request.requestId, action: control.action, actor, ...(control.reason === undefined ? {} : { reason: control.reason }) };
  const outcome = control.action === "retry"
    ? await jobs.retry(control.id, { ...command, action: "retry" })
    : await jobs.control(control.id, command, control.action === "cancel" ? { requireActiveConfirmation: true, activeCancellationConfirmed: false } : undefined);
  if (!outcome.success && outcome.error.code === "ACTIVE_CANCEL_CONFIRMATION_REQUIRED" && control.action === "cancel") {
    if (!isActiveCancelUi(state)) return makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, "CAPABILITY_UNAVAILABLE");
    let confirmed = false;
    try { confirmed = await options.confirmActiveCancellation(control.id); } catch { confirmed = false; }
    if (!confirmed) return makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, "CAPABILITY_UNAVAILABLE");
    if (attempt.responded || !current(state)) return makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, "RPC_TIMEOUT");
    const confirmedOutcome = await jobs.control(control.id, command, { requireActiveConfirmation: true, activeCancellationConfirmed: true });
    if (!confirmedOutcome.success) return makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(confirmedOutcome));
    return controlResponse(request, state.sessionId, confirmedOutcome.value);
  }
  return outcome.success ? controlResponse(request, state.sessionId, outcome.value) : makeErrorResponse(operation, request.requestId, request.correlationId, state.sessionId, errorCode(outcome));
}

function publicControlStatus(status: string): RpcData["control"]["previousStatus"] {
  return (status === "provisioning" ? "running" : status) as RpcData["control"]["previousStatus"];
}

function controlResponse(request: RpcRequest, sessionId: string, receipt: { jobId: string; requestId: string; action: string; previousStatus: string; status: string; replayed: boolean; appliedAt?: number; retryJobId?: string; retryOf?: string; attemptNumber?: number }): RpcResponse {
  const data: RpcData["control"] = {
    jobId: receipt.jobId, requestId: receipt.requestId, action: receipt.action as RpcData["control"]["action"],
    previousStatus: publicControlStatus(receipt.previousStatus), status: publicControlStatus(receipt.status),
    replayed: receipt.replayed, appliedAt: receipt.appliedAt ?? Date.now(),
    ...(receipt.retryJobId ? { retryJobId: receipt.retryJobId } : {}), ...(receipt.retryOf ? { retryOf: receipt.retryOf } : {}),
    ...(receipt.attemptNumber === undefined ? {} : { attemptNumber: receipt.attemptNumber }),
  };
  return { protocolVersion: 1, requestId: request.requestId, correlationId: request.correlationId, sessionId, success: true, data } as RpcResponse;
}

function discovery(state: PiSessionState): RpcDiscovery {
  return {
    protocolVersion: 1, sessionId: state.sessionId, implementationVersion: packageInfo.version, operations: [...operations],
    capabilities: { query: true, wait: true, result: true, spawn: true, control: true, rpcReview: false, activePause: false, activeCancel: { requiresHumanConfirmation: true, available: isActiveCancelUi(state) && current(state) } },
    limits: { ...limits },
  };
}

export function registerRpcServer(options: RpcServerOptions): { seal(): void; close(): Promise<void>; discovery(): RpcDiscovery } {
  const timers = options.timers ?? { setTimeout, clearTimeout };
  const active = new Map<string, Attempt>();
  const subscriptions: (() => void)[] = [];
  let sealed = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const forget = (key: string, attempt: Attempt) => {
    if (attempt.timer !== undefined) timers.clearTimeout(attempt.timer as ReturnType<typeof setTimeout>);
    attempt.timer = undefined;
    if (active.get(key) === attempt) active.delete(key);
  };
  const send = (operation: RpcOperation, requestId: string, correlationId: string, response: RpcResponse, attempt?: Attempt) => {
    if (closed || (attempt?.responded ?? false)) return;
    if (attempt && !current(options.state)) { attempt.responded = true; forget(correlationId, attempt); return; }
    if (attempt) { attempt.responded = true; forget(correlationId, attempt); }
    try { options.bus.emit(replyChannel(operation, correlationId), response); } catch { /* delivery failure is local to the bus */ }
  };
  const validHeader = (input: unknown): { requestId: string; correlationId: string } | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const requestId = Object.getOwnPropertyDescriptor(input, "requestId");
    const correlationId = Object.getOwnPropertyDescriptor(input, "correlationId");
    if (!requestId || !("value" in requestId) || !correlationId || !("value" in correlationId)) return undefined;
    if (typeof requestId.value !== "string" || requestId.value.length === 0 || Buffer.byteLength(requestId.value) > 256 || !isSafeCorrelation(correlationId.value)) return undefined;
    return { requestId: requestId.value, correlationId: correlationId.value };
  };
  const onRequest = (operation: RpcOperation) => (input: unknown) => {
    if (closed) return;
    let header: { requestId: string; correlationId: string } | undefined;
    try {
      if (hasOversizedIds(input)) return;
      header = validHeader(input);
    } catch { return; }
    if (!header) return;
    if (active.has(header.correlationId)) return;
    if (sealed) {
      const response = makeErrorResponse(operation, header.requestId, header.correlationId, options.state.sessionId, "RPC_SHUTTING_DOWN");
      try { options.bus.emit(replyChannel(operation, header.correlationId), response); } catch { /* ignored */ }
      return;
    }
    let request: RpcRequest;
    try { request = parseRpcRequest(operation, input); }
    catch (error) {
      if (closed || (!current(options.state) && !sealed)) return;
      const code = error instanceof RpcValidationError ? safeCode(error.code) : "INVALID_REQUEST";
      const response = makeErrorResponse(operation, header.requestId, header.correlationId, options.state.sessionId, code);
      try { options.bus.emit(replyChannel(operation, header.correlationId), response); } catch { /* ignored */ }
      return;
    }
    if (!current(options.state)) return;
    if (request.sessionId !== undefined && request.sessionId !== options.state.sessionId) {
      const response = makeErrorResponse(operation, request.requestId, request.correlationId, options.state.sessionId, "SESSION_MISMATCH");
      try { options.bus.emit(replyChannel(operation, request.correlationId), response); } catch { /* ignored */ }
      return;
    }
    const attempt: Attempt = { operation, request, abort: new AbortController(), responded: false };
    active.set(request.correlationId, attempt);
    attempt.timer = timers.setTimeout(() => {
      send(operation, request.requestId, request.correlationId, makeErrorResponse(operation, request.requestId, request.correlationId, options.state.sessionId, "RPC_TIMEOUT"), attempt);
      attempt.abort.abort();
    }, timeoutFor(operation, request));
    void perform(operation, request, options, attempt).then(response => {
      if (attempt.responded || closed || !current(options.state)) return;
      send(operation, request.requestId, request.correlationId, response, attempt);
    }).catch(() => {
      if (attempt.responded || closed || !current(options.state)) return;
      send(operation, request.requestId, request.correlationId, makeErrorResponse(operation, request.requestId, request.correlationId, options.state.sessionId, "STORAGE_ERROR"), attempt);
    });
  };

  for (const operation of operations) subscriptions.push(options.bus.on(requestChannel(operation), onRequest(operation)));

  return {
    seal() {
      sealed = true;
      for (const [key, attempt] of active) {
        if (attempt.timer !== undefined) timers.clearTimeout(attempt.timer as ReturnType<typeof setTimeout>);
        attempt.timer = undefined;
        attempt.responded = true;
        attempt.abort.abort();
        active.delete(key);
      }
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const unsubscribe of subscriptions.splice(0)) { try { unsubscribe(); } catch {} }
      for (const [key, attempt] of active) {
        if (attempt.timer !== undefined) timers.clearTimeout(attempt.timer as ReturnType<typeof setTimeout>);
        attempt.timer = undefined;
        attempt.responded = true;
        attempt.abort.abort();
        active.delete(key);
      }
      closePromise = Promise.resolve();
      return closePromise;
    },
    discovery() { return discovery(options.state); },
  };
}
