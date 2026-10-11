import { Buffer } from 'node:buffer';
import type { JobRepository } from '../infrastructure/durable/repository.ts';
import type { JobReviewDocument } from '../infrastructure/durable/documents.ts';
import { assertJobFilter, assertWaitOptions, createEmptyConsumption, publicStatus, type ConsumptionState, type JobFilter, type JobListView, type JobQueryView } from '../domain/jobs.ts';
import { DomainError, failure, type Outcome } from '../domain/errors.ts';

const encodeCursor = (value: { createdAt: number; id: string }): string => Buffer.from(JSON.stringify({ v: 1, ...value }), 'utf8').toString('base64url');
function decodeCursor(value: string | undefined): { createdAt: number; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; createdAt?: number; id?: string };
    const createdAt = parsed.createdAt;
    if (parsed.v !== 1 || typeof createdAt !== 'number' || !Number.isFinite(createdAt) || typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch { throw new DomainError('INVALID_FILTER'); }
}

function reviewStatus(review: JobReviewDocument | undefined): JobListView['reviewStatus'] {
  return review?.status ?? 'not_required';
}
function consumptionState(value: ConsumptionState | undefined): ConsumptionState {
  return value ? structuredClone(value) : createEmptyConsumption();
}
function duration(job: { createdAt: number; startedAt?: number; finishedAt?: number }): number | undefined {
  if (job.finishedAt === undefined) return undefined;
  return Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt));
}

export type QueryService = {
  getJob(id: string, options?: { includeTask?: boolean }): Promise<Outcome<JobQueryView>>;
  listJobs(filter: JobFilter): Promise<Outcome<{ items: readonly JobListView[]; nextCursor?: string }>>;
};

export function createQueryService(repository: JobRepository): QueryService {
  const makeView = async (job: NonNullable<Awaited<ReturnType<JobRepository['get']>>>, summary: { hasResult: boolean; reviewStatus?: JobListView['reviewStatus'] }, includeTask: boolean): Promise<JobListView> => {
    const [review, consumption, queuePosition] = await Promise.all([
      repository.review(job.id),
      repository.consumption(job.id),
      repository.queuedPosition(job.id),
    ]);
    const view: JobListView = {
      id: job.id,
      status: publicStatus(job),
      ...(job.status === 'provisioning' ? { internalStatus: job.status } : {}),
      agent: structuredClone(job.agent),
      model: structuredClone(job.model),
      thinkingLevel: job.thinkingLevel,
      cwd: job.cwd,
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      updatedAt: job.updatedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(queuePosition === undefined ? {} : { queuePosition }),
      ...(duration(job) === undefined ? {} : { durationMs: duration(job) }),
      ...(job.gates?.length ? {
        gatePhase: job.gates.find(gate => gate.status === "running")?.status ?? job.gates.find(gate => gate.status === "pending")?.status ?? job.gates.at(-1)?.status,
        ...(job.gates.find(gate => gate.status === "running") ? { gateCurrent: job.gates.find(gate => gate.status === "running")?.name } : {}),
        gatePassed: job.gates.filter(gate => gate.status === "passed").length,
        gateTotal: job.gates.length,
      } : {}),
      ...(job.technicalOutcome === undefined ? {} : { technicalOutcome: job.technicalOutcome }),
      hasResult: summary.hasResult,
      reviewStatus: reviewStatus(review ?? (summary.reviewStatus ? { status: summary.reviewStatus } : undefined)),
      consumption: consumptionState(consumption),
      ...(includeTask ? { task: job.task } : {}),
      ...(job.resultMeta === undefined ? {} : { resultMeta: structuredClone(job.resultMeta) }),
    };
    return view;
  };

  return {
    async getJob(id, options = {}) {
      try {
        if (typeof id !== 'string' || !id) throw new DomainError('INVALID_FILTER');
        const job = await repository.get(id);
        if (!job) throw new DomainError('JOB_NOT_FOUND');
        const index = await repository.index();
        const summary = index?.summaries[id];
        if (!summary) throw new DomainError('JOB_NOT_FOUND');
        return { success: true, value: await makeView(job, summary, options.includeTask !== false) as JobQueryView };
      } catch (error) { return failure(error); }
    },
    async listJobs(filter) {
      try {
        assertJobFilter(filter);
        const cursor = decodeCursor(filter.cursor);
        const index = await repository.index();
        const summaries = Object.values(index?.summaries ?? {})
          .filter(item => filter.statuses === undefined || filter.statuses.includes(publicStatus(item)))
          .filter(item => filter.agent === undefined || item.agent === filter.agent)
          .filter(item => filter.createdAfter === undefined || item.createdAt >= filter.createdAfter)
          .filter(item => filter.createdBefore === undefined || item.createdAt <= filter.createdBefore)
          .filter(item => !filter.pendingReview || item.reviewStatus === 'pending')
          .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
          .filter(item => cursor === undefined || item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id));
        const limit = filter.limit ?? 20;
        const selected = summaries.slice(0, limit);
        const items: JobListView[] = [];
        for (const summary of selected) {
          const job = await repository.get(summary.id);
          if (job) items.push(await makeView(job, summary, false));
        }
        const last = selected.at(-1);
        const nextCursor = summaries.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined;
        if (filter.pendingReview && items.some(item => item.reviewStatus !== 'pending')) {
          const filtered = items.filter(item => item.reviewStatus === 'pending');
          return { success: true, value: { items: filtered, ...(nextCursor ? { nextCursor } : {}) } };
        }
        return { success: true, value: { items, ...(nextCursor ? { nextCursor } : {}) } };
      } catch (error) { return failure(error); }
    },
  };
}
