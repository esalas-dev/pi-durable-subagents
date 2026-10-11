import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Session, Tx } from "@earendil-works/pi-durable";
import type { ConsumptionState, JobCompletion, JobRecord, JobResult, ResultAccess, ResultView, ReviewState } from "../../domain/jobs.ts";
import { assertJob, assertResult, publicStatus } from "../../domain/jobs.ts";
import type { AdmissionReceipt, Clock, ControlAdmission, ParentAuthority, CreateId, ConsumeReceipt, ConsumeRequest, ControlReceipt, ControlRequest, RequestRecord, RetryReceipt, RetryRequest, ReviewReceipt, StartRequest } from "../../domain/requests.ts";
import { assertControlRequest, canonicalJson } from "../../domain/requests.ts";
import { DomainError } from "../../domain/errors.ts";
import { JobConsumptionDocFamily, JobControlDocFamily, JobDocFamily, JobResultDocFamily, JobReviewDocFamily, JobsIndexDoc, RequestLedgerDocFamily, StorageMetaDoc, type JobsIndex, type JobReviewDocument } from "./documents.ts";
import { appendEvent } from "./outbox.ts";
import type { JobEventV1 } from "../../public/job-events.ts";

export type CreateConversation = (tx: Tx, job: JobRecord) => Promise<number>;
export type JobRepository = {
  seal(): void;
  get(id: string): Promise<JobRecord | undefined>;
  index(): Promise<JobsIndex | undefined>;
  review(id: string): Promise<JobReviewDocument | undefined>;
  consumption(id: string): Promise<ConsumptionState | undefined>;
  decideReview(id: string, decision: { requestId: string; status: "approved" | "rejected"; actor: { kind: "human" | "model"; id?: string }; reason?: string }, at: number, parent?: ParentAuthority): Promise<ReviewReceipt>;
  applyControl(id: string, request: ControlRequest, at: number, admission?: ControlAdmission): Promise<ControlReceipt>;
  retry(id: string, request: RetryRequest, at: number, parent?: ParentAuthority): Promise<RetryReceipt>;
  consume(id: string, request: ConsumeRequest, at: number): Promise<ConsumeReceipt>;
  readAuthorizedResult(id: string, access: ResultAccess): Promise<ResultView>;
  result(id: string): Promise<JobCompletion | undefined>;
  queuedPosition(id: string): Promise<number | undefined>;
  active(): Promise<JobRecord[]>;
  unnotified(): Promise<JobRecord[]>;
  markNotified(id: string): Promise<void>;
  finish(id: string, result: JobCompletion, at: number): Promise<void>;
  setGates(id: string, gates: import("../../domain/structured.ts").GateRecord[], at: number): Promise<void>;
  finishCancelled(id: string, detail: string, at: number): Promise<void>;
  markRunning(id: string, submissionId: number, at: number): Promise<void>;
  create(job: JobRecord, result?: JobResult): Promise<void>;
  claimNext(maxConcurrency: number, createConversation: CreateConversation): Promise<JobRecord | undefined>;
  receipt(requestId: string, parent?: ParentAuthority): Promise<RequestRecord | undefined>;
  sealParent(): void;
  drainParent(): Promise<void>;
  admit(request: StartRequest & { payloadHash: string }, input: Omit<JobRecord, "id" | "status" | "createdAt" | "updatedAt" | "notified">, parent?: ParentAuthority): Promise<AdmissionReceipt>;
};

const activeStatuses = new Set(["provisioning", "running", "cancelling"]);
const terminalStatuses = new Set(["completed", "failed", "interrupted", "cancelled"]);
const resultStatuses = new Set(["completed", "failed", "interrupted"]);

function initialReviewStatus(job: Pick<JobRecord, "createdBy">): "pending" | "not_required" {
  return job.createdBy?.kind === "model" || job.createdBy?.kind === "extension" ? "pending" : "not_required";
}
function summary(job: JobRecord, hasResult = Boolean(job.result), reviewStatus: ReviewState = initialReviewStatus(job)) {
  return { id: job.id, status: job.status, agent: job.agent.name, createdAt: job.createdAt, updatedAt: job.updatedAt, hasResult, notified: job.notified, reviewStatus };
}

function storedJob(job: JobRecord): JobRecord {
  const copy = structuredClone(job);
  delete copy.result;
  return copy;
}

function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

export function createJobRepository(session: Session, context: Context, clock: Clock, createId: CreateId, sessionId: string, parentAuthority?: ParentAuthority): JobRepository {
  let sealed = false;
  const commit = <T>(writes: (tx: Tx) => Promise<T>, commitContext: Context = context): Promise<T> => {
    if (sealed) throw new DomainError("RUNTIME_CLOSING");
    return session.commit(writes, commitContext);
  };
  let parentSealed = false;
  let parentInFlight = 0;
  let drainWait: Promise<void> | undefined;
  let drainResolve: (() => void) | undefined;
  const parentToken = (parent?: ParentAuthority): ParentAuthority | undefined => {
    if (parent === undefined) return undefined;
    if (!parentAuthority || parent !== parentAuthority || typeof parent.isActive !== "function" || typeof parent.sessionId !== "string" || !parent.sessionId || !parent.isActive()) throw new DomainError("INVALID_REQUEST");
    if (parentSealed) throw new DomainError("RUNTIME_CLOSING");
    return parent;
  };
  const beginParent = (parent?: ParentAuthority) => {
    const token = parentToken(parent);
    if (token) parentInFlight++;
    return token;
  };
  const endParent = (token?: ParentAuthority) => {
    if (token && --parentInFlight === 0 && drainResolve) {
      const resolve = drainResolve; drainResolve = undefined; drainWait = undefined; resolve();
    }
  };
  const assertParentJob = async (token: ParentAuthority, jobId: string) => {
    const job = await session.snapshot(JobDocFamily, jobId, context) as JobRecord | undefined;
    if (!job || job.parentSessionId !== token.sessionId) throw new DomainError("INVALID_REQUEST");
  };
  const readIndex = async () => await session.snapshot(JobsIndexDoc, context);
  const emitEvent = (tx: Tx, job: JobRecord, type: Parameters<typeof appendEvent>[1]["type"], at: number, extra: Partial<JobEventV1["data"]> = {}) => appendEvent(tx, { sessionId, jobId: job.id, type, occurredAt: at, data: { status: publicStatus(job), agent: job.agent.name, hasResult: Boolean(job.resultMeta), ...extra } });
  const readJob = async (id: string) => await session.snapshot(JobDocFamily, id, context) as JobRecord | undefined;
  const writeIndexFor = async (tx: Tx, job: JobRecord, remove = false, hasResult?: boolean) => {
    const index = await tx.doc(JobsIndexDoc);
    if (remove) {
      delete index.summaries[job.id];
      index.order = index.order.filter((id: string) => id !== job.id);
      return;
    }
    index.summaries[job.id] = summary(job, hasResult ?? index.summaries[job.id]?.hasResult ?? Boolean(job.result), index.summaries[job.id]?.reviewStatus ?? initialReviewStatus(job));
    if (!index.order.includes(job.id) && job.status === "queued") index.order.push(job.id);
    if (job.status !== "queued") index.order = index.order.filter((id: string) => id !== job.id);
  };
  const commitJob = async (tx: Tx, job: JobRecord, result?: JobResult) => {
    const stored = await tx.doc(JobDocFamily, job.id, storedJob(job));
    Object.assign(stored, storedJob(job));
    if (result) {
      const body = await tx.doc(JobResultDocFamily, job.id, result);
      Object.assign(body, structuredClone(result));
    }
    await writeIndexFor(tx, job, false, Boolean(result));
  };
  return {
    seal() { sealed = true; },
    async receipt(requestId, parent) {
      const token = beginParent(parent);
      try {
        const key = createHash("sha256").update(requestId).digest("hex");
        const cell = await session.snapshot(RequestLedgerDocFamily, key, context) as { record: RequestRecord | null } | undefined;
        if (!cell?.record) return undefined;
        if (token) {
          if (cell.record.parentSessionId && cell.record.parentSessionId !== token.sessionId) throw new DomainError("INVALID_REQUEST");
          if (cell.record.parentSessionId) await assertParentJob(token, cell.record.response.jobId);
          if (!token.isActive()) throw new DomainError("INVALID_REQUEST");
        }
        return structuredClone(cell.record);
      } finally { endParent(token); }
    },
    async admit(request, input, parent) {
      const token = beginParent(parent);
      try {
      const key = createHash("sha256").update(request.requestId).digest("hex");
      let receipt: AdmissionReceipt | undefined;
      await commit(async tx => {
        const cell = await tx.doc(RequestLedgerDocFamily, key, null);
        const existing = cell.record as RequestRecord | null;
        if (token && (request.actor.kind !== "model" || !token.isActive())) throw new DomainError("INVALID_REQUEST");
        if (existing) {
          if (existing.requestId !== request.requestId || existing.operation !== "start" || existing.actor.kind !== request.actor.kind || existing.actor.id !== request.actor.id || existing.payloadHash !== request.payloadHash) throw new DomainError("REQUEST_ID_CONFLICT");
          if (token && existing.parentSessionId !== token.sessionId) throw new DomainError("INVALID_REQUEST");
          if (token && existing.parentSessionId) await assertParentJob(token, existing.response.jobId);
          if (token && !token.isActive()) throw new DomainError("INVALID_REQUEST");
          receipt = plain(existing.response);
          return;
        }
        const id = createId();
        const now = clock();
        if (token && !token.isActive()) throw new DomainError("INVALID_REQUEST");
        const cleanInput = structuredClone(input);
        delete cleanInput.parentSessionId;
        const job: JobRecord = { ...cleanInput, ...(token ? { parentSessionId: token.sessionId } : {}), createdBy: structuredClone(request.actor), id, status: "queued", createdAt: now, updatedAt: now, notified: false };
        assertJob(job);
        const admitted: RequestRecord = { requestId: request.requestId, operation: "start", actor: structuredClone(request.actor), canonicalVersion: 1, payloadHash: request.payloadHash, admittedAt: now, response: { jobId: id, status: "queued", agent: job.agent.name }, ...(token ? { parentSessionId: token.sessionId } : {}) };
        cell.record = admitted;
        await commitJob(tx, job);
        await emitEvent(tx, job, "job.queued", now);
        const review = await tx.doc(JobReviewDocFamily, id, { status: initialReviewStatus(job) });
        review.status = initialReviewStatus(job);
        receipt = structuredClone(admitted.response);
      }, context);
      if (!receipt) throw new DomainError("STORAGE_ERROR");
      return receipt;
      } finally { endParent(token); }
    },
    async get(id) { return structuredClone(await readJob(id)); },
    sealParent() { parentSealed = true; },
    drainParent() {
      if (parentInFlight === 0) return Promise.resolve();
      if (!drainWait) drainWait = new Promise(resolve => { drainResolve = resolve; });
      return drainWait;
    },
    async index() { return structuredClone(await readIndex()); },
    async review(id) {
      return structuredClone(await session.snapshot(JobReviewDocFamily, id, context) as JobReviewDocument | undefined);
    },
    async consumption(id) {
      return structuredClone(await session.snapshot(JobConsumptionDocFamily, id, context) as ConsumptionState | undefined);
    },
    async decideReview(id, decision, at, parent) {
      const token = beginParent(parent);
      try {
        let receipt: ReviewReceipt | undefined;
        await commit(async tx => {
          const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord | undefined;
          if (!job) throw new DomainError("JOB_NOT_FOUND");
          const review = await tx.doc(JobReviewDocFamily, id, { status: "not_required" });
          const parental = Boolean(token);
          if (token) {
            if (decision.actor.kind !== "model" || decision.actor.id !== `parent:${token.sessionId}` || job.parentSessionId !== token.sessionId || !token.isActive()) throw new DomainError("INVALID_REQUEST");
            if (!([ "completed", "failed", "interrupted"] as string[]).includes(job.status)) throw new DomainError("RESULT_NOT_READY");
            const currentIndex = await tx.doc(JobsIndexDoc);
            if (!currentIndex.summaries[id]?.hasResult) throw new DomainError("RESULT_NOT_READY");
            const body = await tx.doc(JobResultDocFamily, id, null as unknown as JsonValue) as JobResult | undefined;
            if (!body || typeof body.finalResponse !== "string") throw new DomainError("RESULT_NOT_READY");
            if (review.decidedByActor?.kind !== "model" || review.decidedByActor.id !== `parent:${token.sessionId}`) {
              if (review.decidedAt !== undefined || review.status === "approved" || review.status === "rejected") throw new DomainError("INVALID_REQUEST");
            }
          } else if (decision.actor.kind !== "human") throw new DomainError("INVALID_REQUEST");
          if (decision.reason !== undefined && (typeof decision.reason !== "string" || decision.reason.length > 2048)) throw new DomainError("INVALID_REQUEST");
          const payloadHash = createHash("sha256").update(canonicalJson({ version: 1, operation: "review", jobId: id, status: decision.status, actor: decision.actor, ...(decision.reason === undefined ? {} : { reason: decision.reason }) })).digest("hex");
          const key = createHash("sha256").update(decision.requestId).digest("hex");
          const cell = await tx.doc(RequestLedgerDocFamily, key, null);
          const existing = cell.record as RequestRecord | null;
          if (existing) {
            if (existing.requestId !== decision.requestId || existing.operation !== "review" || existing.payloadHash !== payloadHash) throw new DomainError("REQUEST_ID_CONFLICT");
            receipt = plain(existing.receipt) as ReviewReceipt;
            return;
          }
          const previousReviewStatus = review.status;
          const humanTakeover = !parental && review.decidedByActor?.kind === "model";
          const sameParent = parental && review.decidedByActor?.kind === "model" && review.decidedByActor.id === decision.actor.id;
          const sameStatus = sameParent && review.status === decision.status;
          const effectiveAt = sameStatus && review.decidedAt !== undefined ? review.decidedAt : at;
          const effectiveStatus = sameParent && (review.status === decision.status) ? review.status : decision.status;
          const effectiveReason = sameStatus ? review.reason : decision.reason;
          review.status = effectiveStatus; review.decidedAt = effectiveAt; review.decidedBy = decision.actor.id; review.reason = effectiveReason;
          review.decidedByActor = structuredClone(decision.actor);
          const index = await tx.doc(JobsIndexDoc);
          if (index.summaries[id]) index.summaries[id].reviewStatus = effectiveStatus;
          const decided: ReviewReceipt = { jobId: id, requestId: decision.requestId, status: effectiveStatus, decidedAt: effectiveAt, ...(decision.actor.id === undefined ? {} : { decidedBy: decision.actor.id }), decidedByActor: structuredClone(decision.actor), ...(effectiveReason === undefined ? {} : { reason: effectiveReason }) };
          const record: RequestRecord = { requestId: decision.requestId, operation: "review", actor: structuredClone(decision.actor), canonicalVersion: 1, payloadHash, admittedAt: at, response: { jobId: id, status: "queued", agent: job.agent.name }, receipt: decided as unknown as JsonValue };
          cell.record = record;
          if (previousReviewStatus !== effectiveStatus || humanTakeover) await emitEvent(tx, job, "job.reviewed", at, { reviewStatus: effectiveStatus, hasResult: Boolean(index.summaries[id]?.hasResult) });
          receipt = decided;
        }, context);
        if (!receipt) throw new DomainError("STORAGE_ERROR");
        return receipt;
      } finally { endParent(token); }
    },
    async applyControl(id, request, at, admission) {
      assertControlRequest(request);
      let receipt: ControlReceipt | undefined;
      await commit(async tx => {
        const rawJob = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord | undefined;
        const job = rawJob ? plain(rawJob) : undefined;
        if (!job) throw new DomainError("JOB_NOT_FOUND");
        const payloadHash = createHash("sha256").update(canonicalJson({ version: 1, operation: "control", jobId: id, action: request.action, actor: request.actor, ...(request.reason === undefined ? {} : { reason: request.reason }) })).digest("hex");
        const key = createHash("sha256").update(request.requestId).digest("hex");
        const cell = await tx.doc(RequestLedgerDocFamily, key, null);
        const existing = cell.record as RequestRecord | null;
        if (existing) {
          if (existing.requestId !== request.requestId || existing.operation !== "control" || existing.payloadHash !== payloadHash) throw new DomainError("CONTROL_CONFLICT");
          receipt = { ...(plain(existing.receipt) as ControlReceipt), replayed: true };
          return;
        }
        if (request.action === "retry") throw new DomainError("RETRY_NOT_ALLOWED");
        if (request.action === "cancel" && admission?.requireActiveConfirmation && activeStatuses.has(job.status) && !admission.activeCancellationConfirmed) throw new DomainError("ACTIVE_CANCEL_CONFIRMATION_REQUIRED");
        const index = await tx.doc(JobsIndexDoc);
        const previousStatus = job.status;
        let result: JobResult | undefined;
        if (request.action === "pause") {
          if (job.status === "provisioning" || job.status === "running" || job.status === "cancelling") throw new DomainError("PAUSE_ACTIVE_UNSUPPORTED");
          if (job.status !== "queued") throw new DomainError("CONTROL_INVALID_STATE");
          job.queueOrdinal = index.order.indexOf(id) + 1;
          job.status = "paused";
          index.order = index.order.filter(candidate => candidate !== id);
        } else if (request.action === "resume") {
          if (job.status !== "paused") throw new DomainError("CONTROL_INVALID_STATE");
          job.status = "queued";
          job.queueOrdinal = index.order.length + 1;
          if (!index.order.includes(id)) index.order.push(id);
        } else {
          if (terminalStatuses.has(job.status) || job.status === "cancelling") throw new DomainError("CONTROL_INVALID_STATE");
          if (job.status === "queued" || job.status === "paused") {
            job.status = "cancelled";
            index.order = index.order.filter(candidate => candidate !== id);
            job.finishedAt = at; job.resultMeta = { durationMs: 0, model: structuredClone(job.model), status: "interrupted", error: "cancelled before execution" };
            result = { finalResponse: "", durationMs: 0, model: structuredClone(job.model), status: "interrupted", error: "cancelled before execution" };
          } else {
            job.status = "cancelling";
            job.control = { pending: "cancel", requestedAt: at, requestedBy: structuredClone(request.actor), requestId: request.requestId };
          }
        }
        job.updatedAt = at;
        const event = { action: request.action, requestId: request.requestId, actor: structuredClone(request.actor), requestedAt: at, appliedAt: at, previousStatus, nextStatus: job.status };
        job.controlHistory = [...(job.controlHistory ?? []), event].slice(-32);
        const history = await tx.doc(JobControlDocFamily, id, { events: [] }); history.events = [...(history.events ?? []), event].slice(-128);
        const stored = await tx.doc(JobDocFamily, id, null as unknown as JsonValue); Object.assign(stored, storedJob(job));
        if (result) { const body = await tx.doc(JobResultDocFamily, id, result); Object.assign(body, structuredClone(result)); }
        index.summaries[id] = summary(job, Boolean(result) || Boolean(index.summaries[id]?.hasResult), index.summaries[id]?.reviewStatus ?? initialReviewStatus(job));
        if (job.status !== "queued") index.order = index.order.filter(candidate => candidate !== id);
        const decided: ControlReceipt = { jobId: id, requestId: request.requestId, action: request.action, previousStatus, status: job.status, replayed: false, appliedAt: at };
        const record: RequestRecord = { requestId: request.requestId, operation: "control", actor: structuredClone(request.actor), canonicalVersion: 1, payloadHash, admittedAt: at, response: { jobId: id, status: "queued", agent: job.agent.name }, receipt: decided as unknown as JsonValue };
        cell.record = record;
        const type = request.action === "pause" ? "job.paused" : request.action === "resume" ? "job.resumed" : (previousStatus === "queued" || previousStatus === "paused") ? "job.cancelled" : "job.cancel-requested";
        await emitEvent(tx, job, type, at);
        receipt = decided;
      }, context);
      if (!receipt) throw new DomainError("STORAGE_ERROR");
      return receipt;
    },
    async retry(id, request, at, parent) {
      const token = beginParent(parent);
      try {
      assertControlRequest(request);
      let receipt: RetryReceipt | undefined;
      await commit(async tx => {
        const rawOriginal = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord | undefined;
        const original = rawOriginal ? plain(rawOriginal) : undefined;
        if (!original) throw new DomainError("JOB_NOT_FOUND");
        if (token && (original.parentSessionId !== token.sessionId || request.actor.kind !== "model" || !token.isActive())) throw new DomainError("INVALID_REQUEST");
        const payloadHash = createHash("sha256").update(canonicalJson({ version: 1, operation: "retry", jobId: id, actor: request.actor, ...(request.reason === undefined ? {} : { reason: request.reason }) })).digest("hex");
        const key = createHash("sha256").update(request.requestId).digest("hex");
        const cell = await tx.doc(RequestLedgerDocFamily, key, null);
        const existing = cell.record as RequestRecord | null;
        if (existing) {
          if (existing.requestId !== request.requestId || existing.operation !== "retry" || existing.payloadHash !== payloadHash) throw new DomainError("CONTROL_CONFLICT");
          if (token && (existing.parentSessionId !== token.sessionId || !token.isActive())) throw new DomainError("INVALID_REQUEST");
          if (token) {
            const target = await tx.doc(JobDocFamily, existing.response.jobId, null as unknown as JsonValue) as JobRecord | undefined;
            if (!target || target.parentSessionId !== token.sessionId) throw new DomainError("INVALID_REQUEST");
          }
          receipt = { ...(plain(existing.receipt) as RetryReceipt), replayed: true };
          return;
        }
        if (!terminalStatuses.has(original.status)) throw new DomainError("RETRY_NOT_ALLOWED");
        if (token && !token.isActive()) throw new DomainError("INVALID_REQUEST");
        const retryJob: JobRecord = {
          id: createId(), status: "queued", task: original.task, cwd: original.cwd,
          agent: plain(original.agent), model: plain(original.model), thinkingLevel: original.thinkingLevel,
          ...(original.outputContract ? { outputContract: plain(original.outputContract) } : {}),
          createdAt: at, updatedAt: at, createdBy: plain(request.actor), ...(token ? { parentSessionId: token.sessionId } : {}), notified: false,
          retryOf: original.id, rootAttemptId: original.rootAttemptId ?? original.id, attemptNumber: (original.attemptNumber ?? 1) + 1,
        };
        const next: RetryReceipt = { jobId: retryJob.id, requestId: request.requestId, action: "retry", previousStatus: original.status, status: "queued", replayed: false, appliedAt: at, retryJobId: retryJob.id, retryOf: original.id, attemptNumber: retryJob.attemptNumber };
        await commitJob(tx, retryJob);
        await emitEvent(tx, retryJob, "job.queued", at, { retryOf: original.id });
        const history = await tx.doc(JobControlDocFamily, id, { events: [] });
        history.events = [...(history.events ?? []), { action: "retry" as const, requestId: request.requestId, actor: plain(request.actor), requestedAt: at, appliedAt: at, previousStatus: original.status, nextStatus: original.status, result: retryJob.id }].slice(-128);
        const review = await tx.doc(JobReviewDocFamily, retryJob.id, { status: initialReviewStatus(retryJob) });
        review.status = initialReviewStatus(retryJob);
        cell.record = { requestId: request.requestId, operation: "retry", actor: plain(request.actor), canonicalVersion: 1, payloadHash, admittedAt: at, response: { jobId: retryJob.id, status: "queued", agent: retryJob.agent.name }, ...(token ? { parentSessionId: token.sessionId } : {}), receipt: next as unknown as JsonValue };
        receipt = next;
      }, context);
      if (!receipt) throw new DomainError("STORAGE_ERROR");
      return receipt;
      } finally { endParent(token); }
    },
    async consume(id, request, at) {
      let receipt: ConsumeReceipt | undefined;
      await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord | undefined;
        if (!job) throw new DomainError("JOB_NOT_FOUND");
        const payloadHash = createHash("sha256").update(canonicalJson({ version: 1, operation: "consume", jobId: id, actor: request.actor, consumer: request.consumer })).digest("hex");
        const key = createHash("sha256").update(request.requestId).digest("hex");
        const cell = await tx.doc(RequestLedgerDocFamily, key, null);
        const existing = cell.record as RequestRecord | null;
        if (existing && (existing.requestId !== request.requestId || existing.operation !== "consume" || existing.payloadHash !== payloadHash)) throw new DomainError("REQUEST_ID_CONFLICT");
        const index = await tx.doc(JobsIndexDoc);
        if (!index.summaries[id]?.hasResult || !resultStatuses.has(job.status)) throw new DomainError("RESULT_NOT_READY");
        const review = await tx.doc(JobReviewDocFamily, id, { status: "not_required" });
        if (review.status === "pending") throw new DomainError("RESULT_REVIEW_REQUIRED");
        if (review.status === "rejected") throw new DomainError("RESULT_REJECTED");
        const body = await tx.doc(JobResultDocFamily, id, null as unknown as JsonValue) as JobCompletion | undefined;
        if (!body || typeof body.finalResponse !== "string") throw new DomainError("RESULT_NOT_READY");
        if (existing) {
          receipt = plain(existing.receipt) as ConsumeReceipt;
          return;
        }
        const consumption = await tx.doc(JobConsumptionDocFamily, id, { count: 0, requestIds: [] });
        consumption.count += 1; consumption.firstConsumedAt ??= at; consumption.lastConsumedAt = at; consumption.lastConsumer = request.consumer;
        consumption.requestIds = [...consumption.requestIds.filter(candidate => candidate !== request.requestId), request.requestId].slice(-32);
        const consumed: ConsumeReceipt = { jobId: id, requestId: request.requestId, consumedAt: at, consumedBy: request.consumer, count: consumption.count, result: plain(body) };
        const record: RequestRecord = { requestId: request.requestId, operation: "consume", actor: structuredClone(request.actor), canonicalVersion: 1, payloadHash, admittedAt: at, response: { jobId: id, status: "queued", agent: job.agent.name }, receipt: consumed as unknown as JsonValue };
        cell.record = record;
        await emitEvent(tx, job, "job.consumed", at, { consumptionCount: consumption.count, hasResult: true });
        receipt = consumed;
      }, context);
      if (!receipt) throw new DomainError("STORAGE_ERROR");
      return receipt;
    },
    async readAuthorizedResult(id, access) {
      return await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord | undefined;
        if (!job) throw new DomainError("JOB_NOT_FOUND");
        const index = await tx.doc(JobsIndexDoc);
        if (!index.summaries[id]?.hasResult || !["completed", "failed", "interrupted"].includes(job.status)) throw new DomainError("RESULT_NOT_READY");
        const review = await tx.doc(JobReviewDocFamily, id, { status: "not_required" });
        if (access.mode === "tool" && review.status === "pending") throw new DomainError("RESULT_REVIEW_REQUIRED");
        if (access.mode === "tool" && review.status === "rejected") throw new DomainError("RESULT_REJECTED");
        const result = await tx.doc(JobResultDocFamily, id, null as unknown as JsonValue) as JobCompletion | undefined;
        if (!result || typeof result.finalResponse !== "string") throw new DomainError("RESULT_NOT_READY");
        const position = index.order.indexOf(id);
        return { job: plain(job), queuePosition: position < 0 ? undefined : position + 1, result: plain(result) };
      }, context);
    },
    async result(id) {
      const job = await readJob(id);
      if (!job) return undefined;
      const index = await readIndex();
      if (!index?.summaries[id]?.hasResult) return undefined;
      const result = await session.snapshot(JobResultDocFamily, id, context) as JobCompletion | undefined;
      return structuredClone(result);
    },
    async queuedPosition(id) {
      const index = await readIndex();
      const position = index?.order.indexOf(id) ?? -1;
      return position < 0 ? undefined : position + 1;
    },
    async active() {
      const index = await readIndex();
      if (!index) return [];
      const jobs = await Promise.all(Object.values(index.summaries).filter(item => activeStatuses.has(item.status)).map(item => readJob(item.id)));
      return jobs.filter((job): job is JobRecord => Boolean(job)).map(job => structuredClone(job));
    },
    async unnotified() {
      const index = await readIndex();
      if (!index) return [];
      const jobs = await Promise.all(Object.values(index.summaries).filter(item => terminalStatuses.has(item.status) && !item.notified).map(item => readJob(item.id)));
      return jobs.filter((job): job is JobRecord => Boolean(job)).map(job => structuredClone(job));
    },
    async markNotified(id) {
      await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue);
        if (!job || !job.id) return;
        if (!job.notified) { job.notified = true; job.updatedAt = clock(); }
        await writeIndexFor(tx, job);
      }, context);
    },
    async setGates(id, gates, at) {
      await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord | undefined;
        if (!job || terminalStatuses.has(job.status)) return;
        job.gates = structuredClone(gates); job.updatedAt = at;
        await writeIndexFor(tx, job);
      }, context);
    },
    async finishCancelled(id, detail, at) {
      const result: JobResult = { finalResponse: "", durationMs: 0, model: { provider: "unknown", modelId: "unknown" }, status: "interrupted", error: detail };
      await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue);
        if (!job || job.status !== "cancelling") return;
        result.model = plain(job.model);
        job.status = "cancelled"; job.resultMeta = { durationMs: result.durationMs, model: structuredClone(result.model), status: result.status, error: detail };
        job.finishedAt = at; job.updatedAt = at; delete job.control;
        const body = await tx.doc(JobResultDocFamily, id, result); Object.assign(body, structuredClone(result));
        await writeIndexFor(tx, job, false, true);
        await emitEvent(tx, job, "job.cancelled", at);
      }, context);
    },
    async finish(id, result, at) {
      assertResult(result);
      await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue);
        if (!job || terminalStatuses.has(job.status)) return;
        job.status = result.status; job.resultMeta = { durationMs: result.durationMs, model: structuredClone(result.model), status: result.status, ...(result.error === undefined ? {} : { error: result.error }) };
        if (result.structuredResult) job.structuredResult = structuredClone(result.structuredResult);
        if (result.gates) job.gates = structuredClone(result.gates);
        if (result.technicalOutcome) job.technicalOutcome = result.technicalOutcome;
        job.finishedAt = at; job.updatedAt = at;
        const body = await tx.doc(JobResultDocFamily, id, result); Object.assign(body, structuredClone(result));
        await writeIndexFor(tx, job, false, true);
        await emitEvent(tx, job, `job.${result.status}`, at);
      }, context);
    },
    async markRunning(id, submissionId, at) {
      await commit(async tx => {
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue);
        if (!job || job.status !== "provisioning") return;
        job.status = "running"; job.submissionId = submissionId; job.startedAt ??= at; job.updatedAt = at;
        await writeIndexFor(tx, job);
        await emitEvent(tx, job, "job.started", at);
      }, context);
    },
    async create(job, result) {
      assertJob(job);
      if (job.status !== "queued") throw new DomainError("STORAGE_INCONSISTENT");
      await commit(async tx => {
        const existing = await tx.doc(JobDocFamily, job.id, { id: job.id } as unknown as JsonValue) as JobRecord;
        if (existing.status !== undefined) throw new DomainError("STORAGE_INCONSISTENT");
        await commitJob(tx, job, result);
        await emitEvent(tx, job, "job.queued", job.createdAt);
      }, context);
    },
    async claimNext(maxConcurrency, createConversation) {
      let claimed: JobRecord | undefined;
      await commit(async tx => {
        const index = await tx.doc(JobsIndexDoc);
        const active = Object.values(index.summaries).filter(item => activeStatuses.has(item.status)).length;
        if (active >= maxConcurrency) return;
        const id = index.order.find(candidate => index.summaries[candidate]?.status === "queued");
        if (!id) return;
        const job = await tx.doc(JobDocFamily, id, null as unknown as JsonValue) as JobRecord;
        if (!job || job.status !== "queued") return;
        job.status = "provisioning"; job.updatedAt = clock();
        job.conversationId = await createConversation(tx, job);
        await writeIndexFor(tx, job);
        await emitEvent(tx, job, "job.provisioning", job.updatedAt);
        claimed = plain(job);
      }, context);
      return claimed;
    },
  };
}

export { StorageMetaDoc };
