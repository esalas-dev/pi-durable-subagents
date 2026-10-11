import { canonicalStart, type AdmissionReceipt, type ParentAuthority, type ResolveInput, type StartRequest } from "../domain/requests.ts";
import type { ResolvedJobInput } from "../domain/jobs.ts";
import { DomainError, failure, type Outcome } from "../domain/errors.ts";
import { canonicalJson } from "../domain/requests.ts";
import type { JobRepository } from "../infrastructure/durable/repository.ts";

export type StartService = {
  start(request: StartRequest, resolve: ResolveInput, parent?: ParentAuthority): Promise<Outcome<AdmissionReceipt>>;
  seal(): void;
};

function matches(request: ReturnType<typeof canonicalStart>["normalized"], input: ResolvedJobInput): boolean {
  return input.task === request.intent.task && input.cwd === request.intent.cwd && input.agent.name === request.intent.agent
    && canonicalJson(input.outputContract ?? null) === canonicalJson(request.intent.outputContract ?? null);
}

export function createStartService(repository: JobRepository, wake: () => void, report: (error: unknown) => void): StartService {
  let sealed = false;
  let inFlight = 0;
  const waitForWake = () => { try { wake(); } catch (error) { report(error); } };
  return {
    async start(request, resolve, parent) {
      if (sealed) return failure(new DomainError("RUNTIME_CLOSING"));
      if (parent && request.actor.kind !== "model") return failure(new DomainError("INVALID_REQUEST"));
      let canonical;
      try { canonical = canonicalStart(request); } catch (error) { return failure(error); }
      let existing;
      try { existing = await repository.receipt(canonical.normalized.requestId, parent); } catch (error) { return failure(error); }
      if (existing) {
        if (existing.payloadHash !== canonical.payloadHash || existing.actor.kind !== canonical.normalized.actor.kind || existing.actor.id !== canonical.normalized.actor.id || existing.operation !== "start") return failure(new DomainError("REQUEST_ID_CONFLICT"));
        return { success: true, value: existing.response };
      }
      inFlight++;
      try {
        if (sealed) return failure(new DomainError("RUNTIME_CLOSING"));
        const input = await resolve(canonical.normalized.intent);
        if (!matches(canonical.normalized, input)) return failure(new DomainError("INVALID_REQUEST", "La configuración resuelta no coincide con la intención admitida."));
        if (sealed) return failure(new DomainError("RUNTIME_CLOSING"));
        const receipt = await repository.admit({ ...canonical.normalized, payloadHash: canonical.payloadHash }, input as Omit<ResolvedJobInput, never>, parent);
        waitForWake();
        return { success: true, value: receipt };
      } catch (error) { return failure(error); }
      finally { inFlight--; }
    },
    seal() { sealed = true; repository.sealParent(); },
  };
}
