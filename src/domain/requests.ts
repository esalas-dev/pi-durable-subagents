import { createHash } from "node:crypto";
import * as path from "node:path";
import { DomainError } from "./errors.ts";
import type { JobCompletion } from "./jobs.ts";
import { validateOutputContract } from "./structured.ts";

export type Actor = { kind: "human" | "model" | "extension" | "system"; id?: string };
export type ParentAuthority = Readonly<{ sessionId: string; isActive(): boolean }>;
export type StartIntent = { agent: string; task: string; cwd: string; outputContract?: unknown };
export type StartRequest = { requestId: string; actor: Actor; intent: StartIntent };
export type Clock = () => number;
export type CreateId = () => string;
export type AdmissionReceipt = { jobId: string; status: "queued"; agent: string };
export type ConsumeRequest = { requestId: string; actor: Actor; consumer: string };
export type ConsumeReceipt = { jobId: string; requestId: string; consumedAt: number; consumedBy: string; count: number; result: JobCompletion };
export type ReviewReceipt = { jobId: string; requestId: string; status: "approved" | "rejected"; decidedAt: number; decidedBy?: string; decidedByActor?: Actor; reason?: string };
export type ControlAction = "pause" | "resume" | "cancel" | "retry";
export type ControlAdmission = { requireActiveConfirmation: boolean; activeCancellationConfirmed: boolean };
export type ControlRequest = { requestId: string; action: ControlAction; actor: Actor; reason?: string };
export type RetryRequest = Omit<ControlRequest, "action"> & { action: "retry" };
export type ControlEvent = { action: ControlAction; requestId: string; actor: Actor; requestedAt: number; appliedAt?: number; previousStatus: string; nextStatus: string; result?: string; error?: string };
export type ControlReceipt = { jobId: string; requestId: string; action: ControlAction; previousStatus: string; status: string; replayed: boolean; appliedAt?: number; error?: string };
export type RetryReceipt = ControlReceipt & { retryJobId?: string; retryOf?: string; attemptNumber?: number };
export type ControlPolicy = (job: { createdBy?: Actor }, request: ControlRequest) => boolean;
export type RequestOperation = "start" | "consume" | "review" | "control" | (string & {});
export type RequestRecord = { requestId: string; operation: RequestOperation; actor: Actor; canonicalVersion: 1; payloadHash: string; admittedAt: number; response: AdmissionReceipt; parentSessionId?: string; receipt?: import("@earendil-works/chord").JsonValue };
export type MigrationApproval = { requestId: string; actor: Actor & { kind: "human" }; dbPath: string; sourceHash: string; approvedAt: number };
export type ResolveInput = (intent: StartIntent) => Promise<import("./jobs.ts").ResolvedJobInput>;

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const object = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as object).sort()) object[key] = jsonValue((value as Record<string, unknown>)[key]);
    return object;
  }
  throw new DomainError("INVALID_REQUEST", "La solicitud contiene un valor no serializable.");
}

export function assertControlRequest(request: ControlRequest): void {
  if (!request || typeof request !== "object" || typeof request.requestId !== "string" || !request.requestId
    || !request.actor || typeof request.actor !== "object" || !["human", "model", "extension", "system"].includes(request.actor.kind)
    || !["pause", "resume", "cancel", "retry"].includes(request.action)
    || (request.reason !== undefined && (typeof request.reason !== "string" || request.reason.length > 2048))) throw new DomainError("INVALID_REQUEST");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value));
}

export function canonicalStart(request: StartRequest): { normalized: StartRequest; payloadHash: string; key: string } {
  if (!request || typeof request !== "object" || typeof request.requestId !== "string" || !request.requestId
    || !request.actor || typeof request.actor !== "object" || !["human", "model", "extension", "system"].includes(request.actor.kind)
    || !request.intent || typeof request.intent !== "object" || typeof request.intent.agent !== "string"
    || typeof request.intent.task !== "string" || !request.intent.task.trim() || typeof request.intent.cwd !== "string"
    || !path.isAbsolute(request.intent.cwd)) throw new DomainError("INVALID_REQUEST");
  const actor: Actor = { kind: request.actor.kind, ...(request.actor.id === undefined ? {} : { id: request.actor.id }) };
  const outputContract = request.intent.outputContract === undefined ? undefined : validateOutputContract(request.intent.outputContract);
  const normalized: StartRequest = {
    requestId: request.requestId,
    actor,
    intent: { agent: request.intent.agent, task: request.intent.task.trim(), cwd: path.resolve(request.intent.cwd), ...(outputContract === undefined ? {} : { outputContract }) },
  };
  const payload = canonicalJson({ version: 1, operation: "start", actor: normalized.actor, intent: normalized.intent });
  return {
    normalized,
    payloadHash: createHash("sha256").update(payload).digest("hex"),
    key: createHash("sha256").update(normalized.requestId).digest("hex"),
  };
}
