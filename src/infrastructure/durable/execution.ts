import type { Context } from "@earendil-works/chord";
import { AssistantEntry, configure, type ConversationId, type Harness, type SubmissionId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Clock } from "../../domain/requests.ts";
import type { JobCompletion, JobModel, JobRecord, JobResult } from "../../domain/jobs.ts";
import { parseStrictJson, validateStructuredValue } from "../../domain/structured.ts";

export type DurableExecution = { create(tx: Tx, job: JobRecord): Promise<number>; submit(job: JobRecord): Promise<number>; wait(job: JobRecord): Promise<JobCompletion>; abort(job: JobRecord): Promise<"aborted" | "already_terminal" | "uncertain"> };
function assistantText(entry: unknown): { text: string; model?: JobModel } {
  const first = (entry as { model?: Array<{ role?: string; provider?: string; model?: string; content?: Array<{ type?: string; text?: string }> }> } | undefined)?.model?.[0];
  if (first?.role !== "assistant") return { text: "" };
  return { text: (first.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join(""), ...(first.provider && first.model ? { model: { provider: first.provider, modelId: first.model } } : {}) };
}
export function createExecution(harness: Harness, context: Context, tools: ReadonlyMap<string, ToolRegistration>, clock: Clock, waitContext: Context = context): DurableExecution {
  return {
    async create(tx, job) {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const selected = job.agent.tools.map(name => tools.get(name)).filter((tool): tool is ToolRegistration => Boolean(tool));
      await configure(tx, conversation.id, { model: job.model, thinkingLevel: job.thinkingLevel, extensions: [CodingTools], tools: selected, instructions: job.agent.systemPrompt, cwd: job.cwd });
      return conversation.id;
    },
    async submit(job) {
      if (job.conversationId === undefined) throw new Error("La conversación durable no existe.");
      const conversation = await harness.conversation(job.conversationId as ConversationId, context);
      if (!conversation) throw new Error("La conversación durable no existe.");
      const submission = await conversation.submit({ type: "input", content: job.task, requestId: `pi-agents:${job.id}` }, context);
      return submission.id;
    },
    async abort(job) {
      if (job.conversationId === undefined) return "uncertain";
      const conversation = await harness.conversation(job.conversationId as ConversationId, context);
      if (!conversation) return "uncertain";
      try {
        await conversation.abort(context);
        return "aborted";
      } catch {
        if (job.submissionId === undefined) return "uncertain";
        const result = await harness.abortSubmission(job.submissionId as SubmissionId, context, job.conversationId as ConversationId);
        if (result === "aborted") return "aborted";
        if (result === "settled") return "already_terminal";
        return "uncertain";
      }
    },
    async wait(job) {
      if (job.submissionId === undefined || job.conversationId === undefined) throw new Error("La ejecución durable carece de identificadores.");
      const read = async (submissionId: number): Promise<JobCompletion> => {
        waitContext.abortSignal?.throwIfAborted();
        const submission = await harness.submission(submissionId as SubmissionId, waitContext);
        waitContext.abortSignal?.throwIfAborted();
        if (!submission) throw new Error("La solicitud durable no existe.");
        const settled = await submission.wait(waitContext);
        waitContext.abortSignal?.throwIfAborted();
        const finishedAt = clock();
        if (settled.status === "done" && settled.type === "input") {
          const conversation = await harness.conversation(job.conversationId as ConversationId, waitContext);
          waitContext.abortSignal?.throwIfAborted();
          if (!conversation) throw new Error("La conversación durable no existe.");
          const page = await conversation.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, waitContext);
          waitContext.abortSignal?.throwIfAborted();
          const entry = page.items[0]; const extracted = assistantText(AssistantEntry.is(entry) ? entry : undefined);
          return { finalResponse: extracted.text, durationMs: Math.max(0, finishedAt - (job.startedAt ?? job.createdAt)), model: extracted.model ?? job.model, status: "completed" };
        }
        const detail = "detail" in settled && settled.detail !== undefined ? `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}` : "";
        return { finalResponse: "", durationMs: Math.max(0, finishedAt - (job.startedAt ?? job.createdAt)), model: job.model, status: "failed", error: `${"reason" in settled ? settled.reason : "unanswered"}${detail}` };
      };
      const first = await read(job.submissionId);
      const contract = job.outputContract;
      if (!contract || first.status !== "completed") return first;
      const validate = (result: JobResult): JobCompletion => {
        const value = parseStrictJson(result.finalResponse);
        if (!validateStructuredValue(value, contract.schema)) throw new Error("STRUCTURED_OUTPUT_INVALID");
        return { ...result, structuredResult: { value, validatedAt: clock(), schemaHash: contract.schemaHash } };
      };
      try { return validate(first); } catch {
        try {
          const conversation = await harness.conversation(job.conversationId as ConversationId, waitContext);
          if (!conversation) throw new Error("La conversación durable no existe.");
          const correction = await conversation.submit({ type: "input", content: "La salida no cumple el contrato. Responde únicamente con un documento JSON válido, sin texto adicional.", requestId: `pi-agents:${job.id}:structured-correction:1` }, waitContext);
          const second = await read(correction.id);
          if (second.status !== "completed") return { ...second, technicalOutcome: "output_invalid", error: "STRUCTURED_OUTPUT_INVALID" };
          try { return validate(second); } catch { return { ...second, status: "failed", error: "STRUCTURED_OUTPUT_INVALID", technicalOutcome: "output_invalid" }; }
        } catch { return { ...first, status: "failed", error: "STRUCTURED_OUTPUT_INVALID", technicalOutcome: "output_invalid" }; }
      }
    },
  };
}
