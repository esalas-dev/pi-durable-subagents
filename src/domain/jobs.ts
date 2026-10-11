import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Actor } from "./requests.ts";
import type { GateRecord, GateStatus, OutputContract, StructuredResult, TechnicalOutcome } from "./structured.ts";
import { DomainError } from "./errors.ts";

export type JobStatus = "queued" | "paused" | "provisioning" | "running" | "cancelling" | "completed" | "failed" | "interrupted" | "cancelled";
export type JobStatusPublic = Exclude<JobStatus, "provisioning">;
export type ReviewState = "not_required" | "pending" | "approved" | "rejected";
export type ConsumptionState = { firstConsumedAt?: number; lastConsumedAt?: number; count: number; lastConsumer?: string; requestIds: string[] };
export type JobFilter = {
  statuses?: JobStatusPublic[]; agent?: string; createdBefore?: number; createdAfter?: number;
  pendingReview?: boolean; limit?: number; cursor?: string;
};
export type WaitOptions = { until?: JobStatusPublic | "terminal"; timeoutSeconds?: number; signal?: AbortSignal };
export type ResultAccess = { mode: "human" | "tool"; operation: "peek" | "consume"; actor: Actor; requestId?: string };
export type ReviewDecision = { requestId: string; status: Exclude<ReviewState, "not_required" | "pending">; actor: Actor & { kind: "human" }; reason?: string };
export type ParentReviewDecision = { requestId: string; status: Exclude<ReviewState, "not_required" | "pending">; reason?: string };
export type JobListView = {
  id: string; status: JobStatusPublic; internalStatus?: JobStatus; agent: JobAgentSnapshot; model: JobModel;
  thinkingLevel: ModelThinkingLevel; cwd: string; createdAt: number; startedAt?: number; updatedAt: number;
  finishedAt?: number; queuePosition?: number; durationMs?: number; hasResult: boolean; reviewStatus: ReviewState;
  gatePhase?: GateStatus; gateCurrent?: string; gatePassed?: number; gateTotal?: number; technicalOutcome?: TechnicalOutcome;
  consumption: Readonly<ConsumptionState>; task?: string;
};
export type JobQueryView = JobListView & { task?: string; resultMeta?: Omit<JobResult, "finalResponse"> };
export type WaitResult = JobQueryView;
export type JobAgentSnapshot = { name: string; description: string; systemPrompt: string; source: "personal" | "project"; filePath: string; tools: string[] };
export type JobModel = { provider: string; modelId: string };
export type JobResult = { finalResponse: string; durationMs: number; model: JobModel; status: "completed" | "failed" | "interrupted"; error?: string };
export type JobCompletion = JobResult & { structuredResult?: StructuredResult; gates?: GateRecord[]; technicalOutcome?: TechnicalOutcome };
export type ResolvedJobInput = { task: string; cwd: string; agent: JobAgentSnapshot; model: JobModel; thinkingLevel: ModelThinkingLevel; outputContract?: OutputContract };
export type JobView = { job: Readonly<JobRecord>; queuePosition?: number };
export type ResultView = JobView & { result?: Readonly<JobCompletion> };
export type JobControl = { pending: "cancel"; requestedAt: number; requestedBy: Actor; requestId: string };
export type JobRecord = {
  id: string; status: JobStatus; task: string; cwd: string; createdAt: number; updatedAt: number; startedAt?: number; finishedAt?: number;
  agent: JobAgentSnapshot; model: JobModel; thinkingLevel: ModelThinkingLevel; conversationId?: number; submissionId?: number;
  result?: JobResult; resultMeta?: Omit<JobResult, "finalResponse">; outputContract?: OutputContract; structuredResult?: StructuredResult; gates?: GateRecord[]; technicalOutcome?: TechnicalOutcome; createdBy?: Actor; parentSessionId?: string; notified: boolean;
  control?: JobControl; retryOf?: string; attemptNumber?: number; rootAttemptId?: string; queueOrdinal?: number; controlHistory?: import("./requests.ts").ControlEvent[];
};

const terminal = new Set<JobStatus>(["completed", "failed", "interrupted", "cancelled"]);
const tools = new Set(["read", "write", "edit", "bash"]);
const finite = (value: number) => Number.isFinite(value) && value >= 0;
const publicStatuses = new Set<JobStatusPublic>(["queued", "paused", "running", "cancelling", "completed", "failed", "interrupted", "cancelled"]);
const reviewStates = new Set<ReviewState>(["not_required", "pending", "approved", "rejected"]);

export function assertJobFilter(filter: JobFilter): void {
  if (!filter || typeof filter !== "object") throw new DomainError("INVALID_FILTER");
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 100)) throw new DomainError("INVALID_FILTER");
  if (filter.statuses !== undefined && (!Array.isArray(filter.statuses) || filter.statuses.length === 0 || filter.statuses.some(status => !publicStatuses.has(status)))) throw new DomainError("INVALID_FILTER");
  if (filter.agent !== undefined && (typeof filter.agent !== "string" || !filter.agent)) throw new DomainError("INVALID_FILTER");
  if (filter.createdAfter !== undefined && !finite(filter.createdAfter)) throw new DomainError("INVALID_FILTER");
  if (filter.createdBefore !== undefined && !finite(filter.createdBefore)) throw new DomainError("INVALID_FILTER");
  if (filter.createdAfter !== undefined && filter.createdBefore !== undefined && filter.createdAfter > filter.createdBefore) throw new DomainError("INVALID_FILTER");
  if (filter.pendingReview !== undefined && typeof filter.pendingReview !== "boolean") throw new DomainError("INVALID_FILTER");
  if (filter.cursor !== undefined && (typeof filter.cursor !== "string" || !filter.cursor)) throw new DomainError("INVALID_FILTER");
}

export function assertWaitOptions(options: WaitOptions = {}): WaitOptions {
  if (!options || typeof options !== "object") throw new DomainError("INVALID_FILTER");
  if (options.until !== undefined && options.until !== "terminal" && !publicStatuses.has(options.until)) throw new DomainError("INVALID_FILTER");
  if (options.timeoutSeconds !== undefined && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0 || options.timeoutSeconds > 300)) throw new DomainError("INVALID_FILTER");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new DomainError("INVALID_FILTER");
  return { ...(options.until === undefined ? {} : { until: options.until }), ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }), ...(options.signal === undefined ? {} : { signal: options.signal }) };
}

export function createReviewState(status: ReviewState): { status: ReviewState } {
  if (!reviewStates.has(status)) throw new DomainError("STORAGE_INCONSISTENT");
  return { status };
}

export function createEmptyConsumption(): ConsumptionState {
  return { count: 0, requestIds: [] };
}

export function publicStatus(job: Pick<JobRecord, "status">): JobStatusPublic {
  return job.status === "provisioning" ? "running" : job.status;
}

export function assertJob(job: JobRecord): void {
  if (!job || typeof job.id !== "string" || typeof job.task !== "string" || !job.task.trim() || !pathAbsolute(job.cwd)
    || !finite(job.createdAt) || !finite(job.updatedAt) || !job.agent || !Array.isArray(job.agent.tools)
    || job.agent.tools.some(tool => !tools.has(tool)) || !job.model?.provider || !job.model?.modelId
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(job.thinkingLevel)
    || typeof job.notified !== "boolean") throw new DomainError("STORAGE_INCONSISTENT");
  if ((job.status === "provisioning" || job.status === "cancelling") && job.conversationId === undefined) throw new DomainError("STORAGE_INCONSISTENT");
  if (job.status === "running" && (job.conversationId === undefined || job.submissionId === undefined)) throw new DomainError("STORAGE_INCONSISTENT");
  if (terminal.has(job.status) && !job.result) throw new DomainError("STORAGE_INCONSISTENT");
}

function pathAbsolute(value: string): boolean { return typeof value === "string" && value.startsWith("/"); }

export function assertResult(result: JobResult): void {
  if (!result || typeof result.finalResponse !== "string" || !finite(result.durationMs) || !result.model?.provider || !result.model?.modelId
    || !["completed", "failed", "interrupted"].includes(result.status)) throw new DomainError("STORAGE_INCONSISTENT");
}

export function transition(job: JobRecord, next: JobStatus, at: number): JobRecord {
  assertJob(job);
  if (!finite(at) || terminal.has(job.status)) throw new DomainError("STORAGE_INCONSISTENT");
  const valid = (job.status === "queued" && (next === "provisioning" || next === "paused" || next === "cancelled"))
    || (job.status === "paused" && (next === "queued" || next === "cancelled"))
    || (job.status === "provisioning" && (next === "running" || next === "cancelling"))
    || (job.status === "running" && (next === "completed" || next === "cancelling"))
    || (job.status === "cancelling" && next === "cancelled")
    || (!terminal.has(job.status) && next === "failed");
  if (!valid) throw new DomainError("STORAGE_INCONSISTENT");
  const changed = structuredClone(job);
  changed.status = next; changed.updatedAt = at;
  return changed;
}
