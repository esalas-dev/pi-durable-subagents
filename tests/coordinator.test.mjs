import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStoreFixture } from './helpers/store.mjs';
import { createCoordinator } from '../src/runtime/coordinator.ts';
import { createExecution } from '../src/infrastructure/durable/execution.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';

const input = (id, status = 'queued') => ({ id, status, task: id, cwd: process.cwd(), createdAt: 1, updatedAt: 1, agent: { name: 'agent', description: '', systemPrompt: '', source: 'personal', filePath: '/tmp/a', tools: [] }, model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off', notified: false, ...(status === 'provisioning' ? { conversationId: 1 } : {}) });
const result = job => ({ finalResponse: `done:${job.id}`, durationMs: 1, model: job.model, status: 'completed' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

 test('wake reentrante respeta slots y no duplica monitores', async () => {
  const f = await makeStoreFixture(); const gate = deferred(); let creates = 0; let waits = 0; const execution = { create: async () => ++creates, submit: async job => job.id === 'one' ? 1 : 2, wait: async job => { waits++; if (job.id === 'one') await gate.promise; return result(job); } };
  try {
    await f.repository.create(input('one')); await f.repository.create(input('two'));
    const settled = []; const c = createCoordinator({ repository: f.repository, execution, maxConcurrency: 1, clock: () => 2, onSettled: async job => settled.push(job.id), report: () => {} });
    c.wake(); c.wake(); await new Promise(r => setTimeout(r, 20));
    assert.equal(creates, 1); assert.equal((await f.repository.active()).length, 1); assert.equal(await f.repository.queuedPosition('two'), 1); assert.equal(waits, 1);
    gate.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled.filter(id => id === 'one').length, 1); c.stop();
  } finally { await f.close(); }
});

test('ejecuta gates tras validar y persiste el outcome técnico', async () => {
  const f = await makeStoreFixture();
  const contract = { schema: { type: 'object' }, schemaHash: 'hash', mode: 'strict-json', maxCorrectionTurns: 1, gates: [{ name: 'ok', command: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5, expectedExitCodes: [0], shell: false }] };
  try {
    await f.seedJob({ ...input('gated', 'provisioning'), outputContract: contract }); await f.repository.markRunning('gated', 1, 1);
    const c = createCoordinator({ repository: f.repository, execution: { wait: async job => ({ ...result(job), structuredResult: { value: {}, validatedAt: 1, schemaHash: 'hash' } }) }, maxConcurrency: 1, clock: () => 2, report: () => {} });
    await c.recover();
    for (let attempt = 0; attempt < 100 && (await f.repository.get('gated')).status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    await c.drain();
    const stored = await f.repository.get('gated');
    assert.equal(stored.status, 'completed'); assert.equal(stored.technicalOutcome, 'gates_passed'); assert.equal(stored.gates[0].status, 'passed'); c.stop();
  } finally { await f.close(); }
});

test('reconciliación de gate running no lo relanza y lo marca interrupted', async () => {
  const f = await makeStoreFixture();
  const contract = { schema: { type: 'object' }, schemaHash: 'hash', mode: 'strict-json', maxCorrectionTurns: 1, gates: [{ name: 'never-replay', command: [process.execPath, '-e', 'process.exit(99)'], timeoutSeconds: 5, expectedExitCodes: [0], shell: false }] };
  const gate = { ...contract.gates[0], requestId: 'pi-agents:recover-gate:gate:0', status: 'running', startedAt: 1, stdout: { text: '', totalBytes: 0, sha256: 'x', truncated: false }, stderr: { text: '', totalBytes: 0, sha256: 'x', truncated: false } };
  try {
    await f.seedJob({ ...input('recover-gate', 'provisioning'), outputContract: contract, gates: [gate] }); await f.repository.markRunning('recover-gate', 1, 1);
    const c = createCoordinator({ repository: f.repository, execution: { wait: async job => ({ ...result(job), structuredResult: { value: {}, validatedAt: 1, schemaHash: 'hash' } }) }, maxConcurrency: 1, clock: () => 2, report: error => { throw error; } });
    await c.recover();
    for (let attempt = 0; attempt < 100 && (await f.repository.get('recover-gate')).status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    await c.drain();
    const stored = await f.repository.get('recover-gate');
    assert.equal(stored.status, 'interrupted'); assert.equal(stored.technicalOutcome, 'gate_interrupted'); assert.equal(stored.gates[0].status, 'interrupted'); c.stop();
  } finally { await f.close(); }
});

test('recover provisioning reenvía la solicitud durable y running espera resultado', async () => {
  const f = await makeStoreFixture(); let submissions = 0; const execution = { create: async () => 1, submit: async job => { submissions++; return job.id === 'prov' ? 55 : 56; }, wait: async job => result(job) };
  try {
    await f.seedJob(input('prov', 'provisioning')); await f.seedJob({ ...input('run', 'provisioning'), conversationId: 2 }); await f.repository.markRunning('run', 56, 1);
    const c = createCoordinator({ repository: f.repository, execution, maxConcurrency: 2, clock: () => 2, report: () => {} }); await c.recover(); await c.drain();
    assert.equal(submissions, 1); assert.equal((await f.repository.get('prov')).status, 'completed'); assert.equal((await f.repository.get('run')).status, 'completed'); c.stop();
  } finally { await f.close(); }
});

test('el driver durable crea, envía y extrae la respuesta del host real', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-agents-execution-')); const models = createModels(); const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage([fauxText('respuesta real')])]); models.setProvider(faux.provider); let harness;
  try {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'execution.sqlite')), { models, registry: createRegistry(), now: () => 1 }, context); const execution = createExecution(harness, context, new Map(), () => 2); const job = input('real');
    const conversationId = await harness.commit(tx => execution.create(tx, job), context); const admitted = { ...job, conversationId }; const submissionId = await execution.submit(admitted);
    const originalConversation = harness.conversation.bind(harness);
    harness.conversation = async (...args) => { const conversation = await originalConversation(...args); if (conversation) conversation.commit = () => { throw new Error('La extracción debe ser read-only'); }; return conversation; };
    const result = await execution.wait({ ...admitted, submissionId, status: 'running', startedAt: 1 });
    assert.equal(result.status, 'completed'); assert.equal(result.finalResponse, 'respuesta real');
  } finally { await harness?.close(context); await rm(directory, { recursive: true, force: true }); }
});

test('cancelar observación SDK real no cancela el trabajo durable ni espera al proveedor', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-observer-cancel-'));
  const models = createModels();
  const faux = fauxProvider();
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const release = () => response.resolve(fauxAssistantMessage([fauxText('observer')]));
  t.signal.addEventListener('abort', release, { once: true });
  faux.setResponses([async () => { started.resolve(); return response.promise; }]);
  models.setProvider(faux.provider);
  const observation = withCancel(context);
  let harness, observing;
  try {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'observer.sqlite')), { models, registry: createRegistry() }, context);
    const execution = createExecution(harness, context, new Map(), () => 2, observation.context);
    const job = input('observe');
    const conversationId = await harness.commit(tx => execution.create(tx, job), context);
    const submissionId = await execution.submit({ ...job, conversationId });
    let settled = false;
    observing = execution.wait({ ...job, conversationId, submissionId }).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await started.promise;
    observation.cancel();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal((await observing).name, 'AbortError');
    assert.equal((await (await harness.submission(submissionId, context)).status(context)).status, 'placed');
  } finally {
    release();
    await observing;
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test('el driver habilita CodingTools y respeta la selección de herramientas del perfil', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-agents-tools-'));
  const registry = createRegistry(); registry.install(CodingTools);
  let harness;
  try {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'tools.sqlite')), { models: createModels(), registry, settings: { extensions: [CodingTools] } }, context);
    const execution = createExecution(harness, context, new Map(CodingTools.tools.map(tool => [tool.name, tool])), () => 2);
    for (const selected of [['read', 'write', 'edit', 'bash'], ['read', 'bash'], []]) {
      const job = input('tools'); job.agent.tools = selected;
      const id = await harness.commit(tx => execution.create(tx, job), context);
      const conversation = await harness.conversation(id, context);
      const agent = await conversation.agent(context);
      assert.deepEqual(agent.extensions.map(extension => extension.name), [CodingTools.name]);
      assert.deepEqual(agent.tools.map(tool => tool.name), selected);
    }
  } finally { await harness?.close(context); await rm(directory, { recursive: true, force: true }); }
});

for (const phase of ['finish', 'markNotified']) {
  test(`stop/drain espera ${phase} admitido sin esperar nuevos resultados`, { timeout: 10000 }, async () => {
    const f = await makeStoreFixture();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const finished = Promise.withResolvers();
    const originalFinish = f.repository.finish.bind(f.repository);
    let c;
    try {
      await f.seedJob(input('drain', 'provisioning'));
      await f.repository.markRunning('drain', 1, 1);
      if (phase === 'finish') f.repository.finish = async (...args) => {
        entered.resolve();
        await release.promise;
        await originalFinish(...args);
        finished.resolve();
      };
      c = createCoordinator({ repository: f.repository, execution: { wait: async job => result(job) }, maxConcurrency: 1, clock: () => 2,
        onSettled: async job => {
          if (phase !== 'markNotified') return;
          entered.resolve();
          await release.promise;
          await f.repository.markNotified(job.id);
          finished.resolve();
        }, report: error => finished.reject(error) });
      await c.recover();
      await entered.promise;
      c.stop();
      let drained = false;
      const drain = c.drain().then(() => { drained = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(drained, false);
      release.resolve();
      await drain;
      assert.equal((await f.repository.get('drain')).status, 'completed');
      if (phase === 'markNotified') assert.equal((await f.repository.get('drain')).notified, true);
    } finally {
      c?.stop();
      release.resolve();
      await finished.promise;
      await c?.drain();
      await f.close();
    }
  });
}

test('stop evita finish/notificación de un modelo que responde tarde', { timeout: 10000 }, async () => {
  const f = await makeStoreFixture();
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  let notifications = 0, c;
  try {
    await f.seedJob(input('late', 'provisioning'));
    await f.repository.markRunning('late', 1, 1);
    c = createCoordinator({ repository: f.repository, execution: { wait: async job => { entered.resolve(); await response.promise; return result(job); } }, maxConcurrency: 1, clock: () => 2, onSettled: async () => { notifications++; }, report: error => { throw error; } });
    await c.recover();
    await entered.promise;
    c.stop();
    await c.drain();
    response.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.repository.get('late')).status, 'running');
    assert.equal(notifications, 0);
  } finally { response.resolve(); c?.stop(); await c?.drain(); await f.close(); }
});

test('stop drena claim iniciado y no envía el job reclamado después de la retirada', { timeout: 10000 }, async () => {
  const f = await makeStoreFixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const originalClaim = f.repository.claimNext.bind(f.repository);
  let submissions = 0, c;
  try {
    await f.repository.create(input('claim'));
    f.repository.claimNext = async (...args) => { entered.resolve(); await release.promise; return originalClaim(...args); };
    c = createCoordinator({ repository: f.repository, execution: { create: async () => 1, submit: async () => { submissions++; return 1; }, wait: async job => result(job) }, maxConcurrency: 1, clock: () => 2, report: () => {} });
    c.wake();
    await entered.promise;
    c.stop();
    let drained = false;
    const drain = c.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    release.resolve();
    await drain;
    assert.equal((await f.repository.get('claim')).status, 'provisioning');
    assert.equal(submissions, 0);
  } finally { release.resolve(); c?.stop(); await c?.drain(); await f.close(); }
});

for (const phase of ['submit', 'markRunning']) {
  test(`stop drena ${phase} admitido sin iniciar otro tramo del job`, { timeout: 10000 }, async () => {
    const f = await makeStoreFixture();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const originalRunning = f.repository.markRunning.bind(f.repository);
    let c;
    try {
      await f.repository.create(input('submission'));
      if (phase === 'markRunning') f.repository.markRunning = async (...args) => { entered.resolve(); await release.promise; return originalRunning(...args); };
      c = createCoordinator({ repository: f.repository, execution: { create: async () => 1, submit: async () => { if (phase === 'submit') { entered.resolve(); await release.promise; } return 1; }, wait: async () => { throw new Error('late monitor'); } }, maxConcurrency: 1, clock: () => 2, report: () => {} });
      c.wake();
      await entered.promise;
      c.stop();
      let drained = false;
      const drain = c.drain().then(() => { drained = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(drained, false);
      release.resolve();
      await drain;
      assert.equal((await f.repository.get('submission')).status, phase === 'submit' ? 'provisioning' : 'running');
    } finally { release.resolve(); c?.stop(); await c?.drain(); await f.close(); }
  });
}

test('drain incluye finishCancelled iniciado por reconcileControls directo', { timeout: 10000 }, async () => {
  const f = await makeStoreFixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const originalFinish = f.repository.finishCancelled.bind(f.repository);
  const errors = [];
  let c, reconciliation;
  try {
    await f.seedJob(input('cancel', 'provisioning'));
    await f.repository.applyControl('cancel', { requestId: 'cancel:fixture', action: 'cancel', actor: { kind: 'human', id: 'tui' } }, 2);
    f.repository.finishCancelled = async (...args) => { entered.resolve(); await release.promise; try { return await originalFinish(...args); } catch (error) { errors.push(error); throw error; } };
    c = createCoordinator({ repository: f.repository, execution: { abort: async () => 'aborted' }, maxConcurrency: 1, clock: () => 2, report: () => {} });
    reconciliation = c.reconcileControls();
    await entered.promise;
    c.stop();
    let drained = false;
    const drain = c.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    release.resolve();
    await drain;
    assert.deepEqual(errors, []);
    assert.equal((await f.repository.get('cancel')).status, 'cancelled');
  } finally { release.resolve(); c?.stop(); await reconciliation; await c?.drain(); await f.close(); }
});

test('stop durante submit no marca running después de la frontera de cierre', async () => {
  const f = await makeStoreFixture(); const gate = deferred(); let submitCalls = 0;
  const execution = { create: async () => 1, submit: async () => { submitCalls++; return gate.promise; }, wait: async job => result(job) };
  try {
    await f.seedJob(input('pending', 'provisioning'));
    const c = createCoordinator({ repository: f.repository, execution, maxConcurrency: 1, clock: () => 2, report: () => {} });
    await c.recover();
    for (let i = 0; i < 100 && !submitCalls; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(submitCalls, 1);
    c.stop(); gate.resolve(55); await c.drain();
    assert.equal((await f.repository.get('pending')).status, 'provisioning');
  } finally { await f.close(); }
});

test('stop durante wait no finaliza ni notifica un job de una generación sellada', async () => {
  const f = await makeStoreFixture(); const gate = deferred(); let settled = 0;
  const execution = { create: async () => 1, submit: async () => 1, wait: async () => gate.promise };
  try {
    await f.seedJob(input('running', 'provisioning')); await f.repository.markRunning('running', 1, 2);
    const c = createCoordinator({ repository: f.repository, execution, maxConcurrency: 1, clock: () => 3, onSettled: async () => { settled++; }, report: () => {} });
    await c.recover();
    c.stop(); gate.resolve(result(input('running', 'running'))); await c.drain();
    assert.equal((await f.repository.get('running')).status, 'running');
    assert.equal(settled, 0);
  } finally { await f.close(); }
});

test('wake reconcilia controles durables antes de buscar trabajo', async () => {
  const f = await makeStoreFixture(); let cancelled = false;
  const job = { ...input('cancelling-job', 'provisioning'), status: 'cancelling', control: { pending: 'cancel' } };
  try {
    await f.seedJob(job);
    const c = createCoordinator({ repository: { ...f.repository, active: async () => cancelled ? [] : [job], claimNext: async () => null, finishCancelled: async id => { assert.equal(id, job.id); cancelled = true; } }, execution: { abort: async value => { assert.equal(value.id, job.id); return 'aborted'; } }, maxConcurrency: 1, clock: () => 2, report: () => {} });
    c.wake(); await c.drain(); assert.equal(cancelled, true); c.stop();
  } finally { await f.close(); }
});

test('fallo de creación revierte claim sin perder el job', async () => {
  const f = await makeStoreFixture(); const errors = []; const execution = { create: async () => { throw new Error('config'); }, submit: async () => 1, wait: async job => result(job) };
  try {
    await f.repository.create(input('bad')); const c = createCoordinator({ repository: f.repository, execution, maxConcurrency: 1, clock: () => 2, report: error => errors.push(error) }); c.wake(); await c.drain();
    assert.equal((await f.repository.get('bad')).status, 'queued'); assert.equal((await f.repository.queuedPosition('bad')), 1); assert.equal(errors.length, 1); c.stop();
  } finally { await f.close(); }
});
