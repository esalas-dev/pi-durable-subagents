import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Clock } from "../domain/requests.ts";
import type { GateRecord, GateSpec, StreamCapture } from "../domain/structured.ts";
import type { JobRecord } from "../domain/jobs.ts";

const MAX_CAPTURE_BYTES = 1024 * 1024;
function capture(chunks: Buffer[], totalBytes: number, hash: ReturnType<typeof createHash>): StreamCapture {
  const text = Buffer.concat(chunks).toString("utf8");
  return { text, totalBytes, sha256: hash.digest("hex"), truncated: totalBytes > Buffer.byteLength(text) };
}
const emptyCapture = (): StreamCapture => ({ text: "", totalBytes: 0, sha256: createHash("sha256").update("").digest("hex"), truncated: false });
export function initialGateRecords(job: JobRecord, gates: readonly GateSpec[]): GateRecord[] {
  return gates.map((gate, index) => ({ ...gate, requestId: `pi-agents:${job.id}:gate:${index}`, status: "pending", stdout: emptyCapture(), stderr: emptyCapture() }));
}
function runGate(job: JobRecord, gate: GateSpec, index: number, clock: Clock, onStart?: (record: GateRecord) => Promise<void>): Promise<GateRecord> {
  const requestId = `pi-agents:${job.id}:gate:${index}`;
  const startedAt = clock();
  return (async () => {
    await onStart?.({ ...gate, requestId, status: "running", startedAt, stdout: emptyCapture(), stderr: emptyCapture() });
    return await new Promise(resolve => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let totalOut = 0; let totalErr = 0;
    const out: Buffer[] = []; const err: Buffer[] = [];
    const outHash = createHash("sha256"); const errHash = createHash("sha256");
    const child = spawn(gate.command[0], gate.command.slice(1), { cwd: job.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunks: Buffer[], hash: ReturnType<typeof createHash>, value: Buffer, current: number, which: "out" | "err") => {
      hash.update(value); const next = current + value.byteLength;
      if (which === "out") totalOut = next; else totalErr = next;
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - Buffer.byteLength(Buffer.concat(chunks)));
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
    };
    child.stdout.on("data", value => append(out, outHash, Buffer.from(value), totalOut, "out"));
    child.stderr.on("data", value => append(err, errHash, Buffer.from(value), totalErr, "err"));
    const finish = (status: GateRecord["status"], exitCode?: number, signal?: string) => {
      if (settled) return; settled = true; if (timeout) clearTimeout(timeout);
      const finishedAt = clock();
      resolve({ ...gate, requestId, status, startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt), ...(exitCode === undefined ? {} : { exitCode }), ...(signal ? { signal } : {}), stdout: capture(out, totalOut, outHash), stderr: capture(err, totalErr, errHash) });
    };
    child.once("error", error => { const message = Buffer.from(error instanceof Error ? error.message : String(error)); append(err, errHash, message, totalErr, "err"); finish("failed"); });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (signal) return finish("interrupted", code === null ? undefined : code, signal);
      finish(code !== null && gate.expectedExitCodes.includes(code) ? "passed" : "failed", code === null ? undefined : code);
    });
    timeout = setTimeout(() => { if (!settled) { child.kill("SIGTERM"); setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 100); finish("timed_out"); } }, gate.timeoutSeconds * 1000);
  });
  })();
}

export async function runGates(job: JobRecord, gates: readonly GateSpec[], clock: Clock, onState?: (record: GateRecord) => Promise<void>): Promise<GateRecord[]> {
  const records: GateRecord[] = [];
  for (const [index, gate] of gates.entries()) {
    const record = await runGate(job, gate, index, clock, onState);
    records.push(record);
    await onState?.(record);
    if (record.status !== "passed") break;
  }
  return records;
}
