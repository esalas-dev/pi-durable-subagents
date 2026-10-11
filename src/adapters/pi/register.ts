import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createPiLifecycle, type PiSessionState, type LifecycleBindings } from "./lifecycle.ts";
import { openSessionRuntime } from "../../runtime/session.ts";
import { parsePiAgentsCommand, CommandSyntaxError } from "../../command.ts";
import type { JobRecord, JobResult } from "../../domain/jobs.ts";
import type { StartRequest } from "../../domain/requests.ts";
import { resolveInput } from "./resolve.ts";
import { formatControl, formatList, formatResult, formatReview, formatStatus, formatWait, briefSummary, truncateToolResult } from "./display.ts";
import { discoverAgents } from "../../agents.ts";
import { createOutboxEmitter } from "../../runtime/outbox-emitter.ts";
import { registerRpcServer } from "./rpc.ts";
import { createSubagentsWidget } from "./subagents-widget.ts";

const NOTICE = "pi-agents-notice"; const OUTPUT = "pi-agents-output";
const display = (value: unknown): value is { title: string; text: string; level: "info" | "success" | "error"; jobId?: string } => Boolean(value && typeof value === "object" && typeof (value as any).title === "string" && typeof (value as any).text === "string");
const toolReply = (outcome: any, text: (value: any) => string) => outcome.success ? { content: [{ type: "text", text: text(outcome.value) }] } : { content: [{ type: "text", text: outcome.error.message }], details: outcome.error, isError: true };
const boundedText = (value: string) => { const full = truncateToolResult(value); const prefix = `totalBytes=${full.totalBytes} sha256=${full.sha256} truncated=`; const body = truncateToolResult(value, Math.max(0, 64 * 1024 - Buffer.byteLength(prefix) - 20)); return `${prefix}${body.truncated}\n${body.text}`; };
export function formatToolResultResponse(value: any) {
  const full = typeof value?.result?.finalResponse === "string" ? value.result.finalResponse : "";
  const metadata = truncateToolResult(full);
  return {
    content: [{ type: "text", text: boundedText(full) }],
    details: { jobId: value?.job?.id, status: value?.job?.status, result: { totalBytes: metadata.totalBytes, sha256: metadata.sha256, truncated: metadata.truncated, ...(value?.result?.structuredResult ? { structuredResult: value.result.structuredResult } : {}), ...(value?.result?.technicalOutcome ? { technicalOutcome: value.result.technicalOutcome } : {}), ...(value?.result?.gates ? { gates: value.result.gates } : {}) } },
  };
}

export function canConfirmMigration(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean { return ctx.mode === "tui" && ctx.hasUI; }
export function canMountSubagentsWidget(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean { return ctx.mode === "tui" && ctx.hasUI; }

export function registerPiAgents(pi: ExtensionAPI, bindings: LifecycleBindings): void {
  let state: PiSessionState | undefined; let agents: ReturnType<typeof discoverAgents>["agents"] = [];
  const report = (error: unknown) => { try { pi.appendEntry(OUTPUT, { title: "subagents", text: error instanceof Error ? error.message : String(error), level: "error" }); } catch {} };
  const completion = (ctx: ExtensionContext) => agents = discoverAgents({ cwd: ctx.cwd, agentDir: bindings.getAgentDir(), projectTrusted: ctx.isProjectTrusted() }).agents;
  const currentState = (current: PiSessionState) => state === current && current.generation.isActive() && current.context.sessionManager.getSessionId() === current.sessionId;
  const notify = async (job: JobRecord, result: JobResult, current: PiSessionState) => {
    if (!currentState(current)) return;
    const summary = briefSummary(result, job.status); pi.appendEntry(NOTICE, { title: `${job.status === "completed" ? "Subagente completado" : "Subagente finalizado"} · ${job.id}`, text: `${job.agent.name}: ${summary}`, level: job.status === "completed" ? "success" : "error", jobId: job.id });
    if (!currentState(current)) return;
    current.context.ui.notify(`${job.id}: ${summary}`, job.status === "completed" ? "info" : "error");
    if (!currentState(current)) return;
    await current.runtime.jobs.markNotified(job.id);
  };
  const openRuntime = bindings.openRuntime ?? openSessionRuntime;
  const lifecycle = createPiLifecycle(pi, { ...bindings, openRuntime: async options => openRuntime({ ...options, onSettled: async (job, result) => {
    await options.onSettled?.(job, result);
    const current = state;
    if (current?.sessionId === options.sessionId && options.isParentActive?.()) await notify(job, result, current);
  } }) }, { onOpen: async current => {
    state = current; completion(current.context);
    try {
      const pending = await current.runtime.jobs.unnotified();
      if (pending.success && current.generation.isActive()) for (const job of pending.value) {
        const view = await current.runtime.jobs.result(job.id);
        if (!currentState(current)) break;
        if (view.success && view.value.result) await notify(job, view.value.result, current);
      }
      if (!currentState(current)) return async () => {};
      const rpc = registerRpcServer({
        bus: pi.events,
        state: current,
        resolve: intent => resolveInput(current.context, current.models, intent, bindings),
        confirmActiveCancellation: async id => {
          if (state !== current || !current.generation.isActive() || !canConfirmMigration(current.context)) return false;
          const accepted = await current.context.ui.confirm("Cancelar trabajo activo", `¿Cancelar ${id}?`);
          return accepted && state === current && current.generation.isActive();
        },
      });
      const emitter = createOutboxEmitter({
        outbox: current.runtime.outbox, bus: pi.events,
        isActive: () => state === current && current.generation.isActive(), clock: Date.now,
        subscribeWake: listener => current.runtime.subscribeOutboxWake(listener), report,
      });
      let widget: ReturnType<typeof createSubagentsWidget> | undefined;
      try {
        pi.events.emit("pi-durable-subagents:ready", rpc.discovery());
        emitter.start();
        if (canMountSubagentsWidget(current.context)) {
          widget = (bindings.createWidget ?? createSubagentsWidget)({ jobs: current.runtime.jobs, ui: current.context.ui, watchJobActivity: current.runtime.watchJobActivity?.bind(current.runtime) });
          widget.start();
        }
      } catch (error) {
        rpc.seal();
        try { await widget?.close(); }
        finally { try { await rpc.close(); } finally { await emitter.stop(); } }
        throw error;
      }
      let disposed = false;
      return async () => {
        if (disposed) return;
        disposed = true;
        if (state === current) state = undefined;
        rpc.seal();
        try { await widget?.close(); }
        finally { try { await rpc.close(); } finally { await emitter.stop(); } }
      };
    } catch (error) { if (state === current) state = undefined; throw error; }
  } });
  const ensure = (ctx: ExtensionContext) => lifecycle.ensure(ctx);
  const start = async (ctx: ExtensionContext, agent: string, task: string, requestId: string, actor: StartRequest["actor"], outputContract?: unknown) => { const current = await ensure(ctx); const request = { requestId, actor, intent: { agent, task, cwd: ctx.cwd, ...(outputContract === undefined ? {} : { outputContract }) } }; return actor.kind === "model" && current.runtime.parent ? current.runtime.parent.start(request, intent => resolveInput(ctx, current.models, intent, bindings)) : current.runtime.jobs.start(request, intent => resolveInput(ctx, current.models, intent, bindings)); };
  const render = (entry: unknown, theme: any) => { if (!display(entry)) return undefined; const color = entry.level === "error" ? "error" : entry.level === "success" ? "success" : "accent"; return bindings.text(`${theme.fg(color, theme.bold(entry.title))}\n${entry.text}`) as Component; };
  pi.registerEntryRenderer(NOTICE, (entry: any, _options: any, theme: any) => render(entry.data, theme)); pi.registerEntryRenderer(OUTPUT, (entry: any, _options: any, theme: any) => render(entry.data, theme));
  const Type = bindings.Type as any;
  const textType = () => Type.String();
  const anyType = () => Type.Any?.() ?? textType();
  const registerQueryTool = (tool: any) => pi.registerTool(tool);
  pi.registerTool(({ name: "pi_agents", label: "Pi Agents", description: "Inicia un agente durable en segundo plano.", parameters: Type.Object({ agent: textType(), task: textType(), output_contract: Type.Optional?.(anyType()) ?? anyType() }), async execute(toolCallId: string, params: { agent: string; task: string; output_contract?: unknown }, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) { const outcome = await start(ctx, params.agent, params.task, `tool:${toolCallId}`, { kind: "model", id: toolCallId }, params.output_contract); if (!outcome.success) return { content: [{ type: "text", text: outcome.error.message }], details: outcome.error, isError: true }; return { content: [{ type: "text", text: `Trabajo ${outcome.value.jobId} encolado para ${outcome.value.agent}.` }], details: outcome.value }; } } as any));
  registerQueryTool(({ name: "pi_agents_status", label: "Pi Agents status", description: "Consulta el estado durable de un trabajo.", parameters: Type.Object({ id: textType() }), async execute(_toolCallId: string, params: { id: string }, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) { const current = await ensure(ctx); return toolReply(await current.runtime.jobs.getJob(params.id, { includeTask: false }), formatWait); } } as any));
  registerQueryTool(({ name: "pi_agents_list", label: "Pi Agents list", description: "Lista trabajos de la sesión.", parameters: Type.Object({ statuses: Type.Optional?.(Type.Array?.(textType()) ?? textType()) ?? textType(), agent: Type.Optional?.(textType()) ?? textType(), limit: Type.Optional?.(Type.Number?.() ?? textType()) ?? textType(), cursor: Type.Optional?.(textType()) ?? textType(), pending_review: Type.Optional?.(Type.Boolean?.() ?? textType()) ?? textType() }), async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) { const current = await ensure(ctx); return toolReply(await current.runtime.jobs.listJobs({ statuses: params.statuses, agent: params.agent, limit: params.limit, cursor: params.cursor, pendingReview: params.pending_review }), formatList); } } as any));
  registerQueryTool(({ name: "pi_agents_wait", label: "Pi Agents wait", description: "Espera sin cancelar el trabajo.", parameters: Type.Object({ id: textType(), until: textType(), timeout_seconds: textType() }), async execute(_toolCallId: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) { const current = await ensure(ctx); const waitSignal = signal ? AbortSignal.any([signal, current.generation.signal]) : current.generation.signal; return toolReply(await current.runtime.jobs.waitForJob(params.id, { until: params.until === "" ? undefined : params.until, timeoutSeconds: params.timeout_seconds === "" ? undefined : typeof params.timeout_seconds === "string" ? Number(params.timeout_seconds) : params.timeout_seconds, signal: waitSignal }), formatWait); } } as any));
  registerQueryTool(({ name: "pi_agents_result", label: "Pi Agents result", description: "Recupera un resultado autorizado.", parameters: Type.Object({ id: textType(), consume: textType(), request_id: textType() }), async execute(toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) { const current = await ensure(ctx); if (params.consume && !params.request_id) return { content: [{ type: "text", text: "consume requiere request_id." }], isError: true }; const outcome = await current.runtime.jobs.getResult(params.id, { mode: "tool", operation: params.consume ? "consume" : "peek", actor: { kind: "model", id: toolCallId }, ...(params.request_id ? { requestId: params.request_id } : {}) }); if (!outcome.success) return toolReply(outcome, value => value); return formatToolResultResponse(outcome.value); } } as any));
  registerQueryTool(({ name: "pi_agents_control", label: "Pi Agents control", description: "Controla un trabajo durable con autorización del actor.", parameters: Type.Object({ id: textType(), action: textType(), request_id: textType(), reason: textType() }), async execute(toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
    if (!params.request_id) return { content: [{ type: "text", text: "control requiere request_id." }], isError: true };
    const current = await ensure(ctx); const status = await current.runtime.jobs.status(params.id);
    if (!status.success) return toolReply(status, value => value);
    let activeCancellationConfirmed = params.action !== "cancel";
    if (params.action === "cancel") {
      if (!canConfirmMigration(ctx)) return { content: [{ type: "text", text: "La cancelación requiere la TUI con UI activa." }], isError: true };
      if (!await ctx.ui.confirm("Cancelar trabajo", `¿Cancelar ${params.id}?`)) return { content: [{ type: "text", text: "Cancelación no autorizada." }], isError: true };
      activeCancellationConfirmed = true;
    }
    const request = { requestId: params.request_id, action: params.action, actor: { kind: "model", id: toolCallId }, ...(params.reason === undefined ? {} : { reason: params.reason }) } as any;
    const admission = { requireActiveConfirmation: true, activeCancellationConfirmed };
    const outcome = params.action === "retry" && current.runtime.parent ? await current.runtime.parent.retry(params.id, request) : params.action === "retry" ? await current.runtime.jobs.retry(params.id, request) : await current.runtime.jobs.control(params.id, request, admission);
    return toolReply(outcome, formatControl);
  } } as any));
  registerQueryTool(({ name: "pi_agents_review", label: "Pi Agents review", description: "Decide una revisión parental durable.", parameters: Type.Object({ id: textType(), status: textType(), request_id: textType(), reason: Type.Optional?.(textType()) ?? textType() }), async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
    const keys = params && typeof params === "object" ? Object.keys(params) : [];
    if (!params || keys.some(key => !["id", "status", "request_id", "reason"].includes(key)) || typeof params.id !== "string" || !params.id || typeof params.status !== "string" || !["approved", "rejected"].includes(params.status) || typeof params.request_id !== "string" || !params.request_id || (params.reason !== undefined && (typeof params.reason !== "string" || params.reason.length > 2048))) return { content: [{ type: "text", text: "Solicitud de revisión inválida." }], isError: true };
    const current = await ensure(ctx); if (!current.runtime.parent) return { content: [{ type: "text", text: "No hay contexto parental nativo." }], isError: true };
    return toolReply(await current.runtime.parent.decideReview(params.id, { requestId: params.request_id, status: params.status, ...(params.reason === undefined ? {} : { reason: params.reason }) }), formatReview);
  } } as any));
  pi.registerCommand("subagents", { description: "Inicia o consulta un subagente durable", handler: async (args, ctx) => {
    try {
      const command = parsePiAgentsCommand(args); const current = await ensure(ctx); const requestId = `command:${ctx.sessionManager.getSessionId()}:${Date.now()}`;
      if (command.action === "start") { const outcome = await start(ctx, command.agent, command.task, requestId, { kind: "human" }); if (!outcome.success) throw new Error(outcome.error.message); pi.appendEntry(OUTPUT, { title: `Subagente encolado · ${outcome.value.jobId}`, text: `${outcome.value.agent}`, level: "info", jobId: outcome.value.jobId }); return; }
      if (command.action === "status" || command.action === "result") { const view = command.action === "status" ? await current.runtime.jobs.status(command.id) : await current.runtime.jobs.getResult(command.id, { mode: "human", operation: "peek", actor: { kind: "human", id: "tui" } }); if (!view.success) throw new Error(view.error.message); pi.appendEntry(OUTPUT, { title: `${command.action === "status" ? "Estado" : "Resultado"} · ${command.id}`, text: command.action === "status" ? formatStatus(view.value) : formatResult(view.value), level: "info", jobId: command.id }); return; }
      if (command.action === "list") { const page = await current.runtime.jobs.listJobs({ statuses: command.statuses as any, limit: command.limit, cursor: command.cursor, pendingReview: command.pendingReview }); if (!page.success) throw new Error(page.error.message); pi.appendEntry(OUTPUT, { title: "Trabajos", text: formatList(page.value), level: "info" }); return; }
      if (command.action === "wait") { const waited = await current.runtime.jobs.waitForJob(command.id, { until: command.until as any, timeoutSeconds: command.timeoutSeconds }); if (!waited.success) throw new Error(waited.error.message); pi.appendEntry(OUTPUT, { title: `Espera · ${command.id}`, text: formatWait(waited.value), level: "info", jobId: command.id }); return; }
      if (["cancel", "pause", "resume", "retry"].includes(command.action)) {
        const status = await current.runtime.jobs.status(command.id); if (!status.success) throw new Error(status.error.message);
        let activeCancellationConfirmed = command.action !== "cancel";
        if (command.action === "cancel") {
          if (!canConfirmMigration(ctx)) throw new Error("La cancelación requiere la TUI con UI activa.");
          if (!command.yes && !await ctx.ui.confirm("Cancelar trabajo", `¿Cancelar ${command.id}?`)) throw new Error("Cancelación no autorizada.");
          activeCancellationConfirmed = true;
        }
        const request = { requestId, action: command.action, actor: { kind: "human", id: "tui" }, ...(command.reason === undefined ? {} : { reason: command.reason }) } as any;
        const admission = { requireActiveConfirmation: true, activeCancellationConfirmed };
        const outcome = command.action === "retry" ? await current.runtime.jobs.retry(command.id, request) : await current.runtime.jobs.control(command.id, request, admission);
        if (!outcome.success) throw new Error(outcome.error.message); pi.appendEntry(OUTPUT, { title: `Control · ${command.id}`, text: formatControl(outcome.value), level: "info", jobId: command.id }); return;
      }
      if (!canConfirmMigration(ctx)) throw new Error("La revisión requiere la TUI con UI activa.");
      const review = await current.runtime.jobs.decideReview(command.id, { requestId, status: command.action === "approve" ? "approved" : "rejected", actor: { kind: "human", id: "tui" }, ...(command.reason === undefined ? {} : { reason: command.reason }) });
      if (!review.success) throw new Error(review.error.message); pi.appendEntry(OUTPUT, { title: "Revisión", text: formatReview(review.value), level: "info", jobId: command.id });
    } catch (error) { const message = error instanceof CommandSyntaxError || error instanceof Error ? error.message : String(error); ctx.ui.notify(message, "error"); report(message); }
  } });
}
