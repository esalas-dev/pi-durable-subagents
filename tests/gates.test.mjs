import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates } from '../src/infrastructure/gates.ts';

const job = { id: 'job-gate', cwd: process.cwd() };
const gate = (command, expectedExitCodes = [0]) => ({ name: 'check', command, timeoutSeconds: 5, expectedExitCodes, shell: false });

test('ejecuta gates como argv sin shell y captura hashes acotados', async () => {
  const records = await runGates(job, [gate([process.execPath, '-e', 'process.stdout.write("ok")'])], () => Date.now());
  assert.equal(records[0].status, 'passed');
  assert.equal(records[0].stdout.text, 'ok');
  assert.equal(records[0].stdout.truncated, false);
  assert.equal(records[0].stdout.sha256.length, 64);
});

test('distingue gate fallido y no ejecuta gates posteriores', async () => {
  const records = await runGates(job, [
    gate([process.execPath, '-e', 'process.stderr.write("bad"); process.exit(3)'], [0]),
    gate([process.execPath, '-e', 'process.exit(0)']),
  ], () => Date.now());
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].exitCode, 3);
  assert.equal(records.length, 1);
});
