import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { discoverAgents, SUPPORTED_TOOLS, unsupportedTools, type AgentDefinition } from "../../agents.ts";
import type { JobAgentSnapshot, ResolvedJobInput } from "../../domain/jobs.ts";
import type { StartIntent } from "../../domain/requests.ts";
import { validateOutputContract } from "../../domain/structured.ts";
import type { createSubagentsWidget } from "./subagents-widget.ts";

export type PiBindings = {
  getAgentDir: () => string;
  createModels: (options?: any) => Promise<ModelRuntime>;
  resolveModel: (options: { cliModel: string; modelRuntime: ModelRuntime }) => { model?: { provider: string; id: string }; thinkingLevel?: ModelThinkingLevel; error?: string };
  text: (content: string) => unknown;
  Type: unknown;
  version: string;
  createWidget?: typeof createSubagentsWidget;
};

function selected(ctx: ExtensionContext, bindings: PiBindings, name: string): AgentDefinition {
  const found = discoverAgents({ cwd: ctx.cwd, agentDir: bindings.getAgentDir(), projectTrusted: ctx.isProjectTrusted() }).agents.find(agent => agent.name === name);
  if (!found) throw new Error(`Agente desconocido: ${name}.`);
  const unsupported = unsupportedTools(found);
  if (unsupported.length) throw new Error(`El agente ${name} solicita herramientas no soportadas: ${unsupported.join(", ")}. Admite: ${SUPPORTED_TOOLS.join(", ")}.`);
  return found;
}

export async function resolveInput(ctx: ExtensionContext, models: ModelRuntime, intent: StartIntent, bindings: PiBindings): Promise<ResolvedJobInput> {
  if (!intent.task.trim()) throw new Error("La tarea no puede estar vacía.");
  for (const providerId of new Set(ctx.modelRegistry.getAll().map(model => model.provider))) { const provider = ctx.modelRegistry.getProvider(providerId); if (provider) models.registerNativeProvider(provider); }
  const agent = selected(ctx, bindings, intent.agent); let model = ctx.model; let thinking = ctx.thinkingLevel as ModelThinkingLevel | undefined;
  if (agent.model) {
    const resolved = bindings.resolveModel({ cliModel: agent.model, modelRuntime: models }); if (!resolved.model) throw new Error(resolved.error ?? `No se pudo resolver ${agent.model}.`); model = resolved.model as typeof model; thinking = resolved.thinkingLevel ?? thinking;
  } else if (model && !models.getModel(model.provider, model.id)) throw new Error(`El modelo actual ${model.provider}/${model.id} no está disponible.`);
  if (!model) throw new Error("No hay un modelo seleccionado para el subagente.");
  const snapshot: JobAgentSnapshot = { name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, source: agent.source, filePath: agent.filePath, tools: agent.tools ?? [...SUPPORTED_TOOLS] };
  const outputContract = intent.outputContract === undefined ? undefined : validateOutputContract(intent.outputContract);
  return { task: intent.task, cwd: intent.cwd, agent: snapshot, model: { provider: model.provider, modelId: model.id }, thinkingLevel: thinking ?? "off", ...(outputContract === undefined ? {} : { outputContract }) };
}
