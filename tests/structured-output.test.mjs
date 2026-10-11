import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson, validateOutputContract, validateStructuredValue } from '../src/domain/structured.ts';
import { canonicalStart } from '../src/domain/requests.ts';

test('extrae un único JSON estricto y rechaza prose', () => {
  assert.deepEqual(parseStrictJson('{"findings":[]}'), { findings: [] });
  assert.throws(() => parseStrictJson('antes {"findings":[]}'), error => error.error?.code === 'STRUCTURED_OUTPUT_INVALID');
  assert.throws(() => parseStrictJson('{"findings":[]} después'), error => error.error?.code === 'STRUCTURED_OUTPUT_INVALID');
});

test('valida contrato, límites y refs remotos', () => {
  const valid = validateOutputContract({
    output_schema: { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'], additionalProperties: false },
    gates: [{ name: 'tests', command: ['node', '--test'], timeout_seconds: 120, expected_exit_codes: [0] }],
  });
  assert.equal(valid.mode, 'strict-json');
  assert.throws(() => validateOutputContract({ output_schema: { $ref: 'https://example.test/schema' }, gates: [] }), error => error.error?.code === 'INVALID_REQUEST');
  assert.throws(() => validateOutputContract({ output_schema: {}, gates: [{ name: 'bad', command: [], timeout_seconds: 1, expected_exit_codes: [0] }] }), error => error.error?.code === 'INVALID_REQUEST');
});

test('valida payload contra schema y permite refs locales', () => {
  const schema = {
    $defs: { finding: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false } },
    type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { $ref: '#/$defs/finding' } } }, additionalProperties: false,
  };
  assert.equal(validateStructuredValue({ findings: [{ message: 'ok' }] }, schema), true);
  assert.equal(validateStructuredValue({ findings: [{ message: 1 }] }, schema), false);
});

test('canoniza el contrato al admitir y hace determinista su hash', () => {
  const request = { requestId: 'structured-1', actor: { kind: 'human' }, intent: { agent: 'worker', task: ' tarea ', cwd: process.cwd(), outputContract: { output_schema: { type: 'object' }, gates: [] } } };
  const first = canonicalStart(request);
  const second = canonicalStart(structuredClone(request));
  assert.deepEqual(first.normalized, second.normalized);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(first.normalized.intent.outputContract.mode, 'strict-json');
  assert.throws(() => canonicalStart({ ...request, requestId: 'structured-2', intent: { ...request.intent, outputContract: { output_schema: { $ref: 'https://example.test/schema' }, gates: [] } } }), /contrato|refs/i);
});
