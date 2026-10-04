import assert from 'node:assert/strict';
import test from 'node:test';
import { auditStream } from '../src/index.js';

const created = () => ({ type: 'response.created' });
const completed = () => ({ type: 'response.completed', response: { status: 'completed' } });
const unknown = () => ({ type: 'future.event' });
const item = (type, output_index = 0) => ({ type: `response.output_item.${type}`, output_index });
const part = (type, output_index = 0) => ({ type: `response.content_part.${type}`, output_index, content_index: 0 });
const delta = (output_index = 0) => ({ type: 'response.output_text.delta', output_index, content_index: 0, delta: 'test' });

function assertInvalid(report) {
  assert.equal(report.protocolComplete, true);
  assert.equal(report.successful, false);
  assert.equal(report.outcome, 'invalid');
}

test('retains structural error state after diagnostics fill with warnings', () => {
  const report = auditStream([created(), unknown(), null, completed()], 'openai-responses', { maxDiagnostics: 1 });
  assertInvalid(report);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].severity, 'warning');
  assert.equal(report.droppedDiagnostics, 1);
});

test('retains open-unit errors after diagnostics fill with warnings', () => {
  const report = auditStream([created(), unknown(), item('added'), completed()], 'openai-responses', { maxDiagnostics: 1 });
  assertInvalid(report);
  assert.equal(report.droppedDiagnostics, 1);
});

test('retains missing Anthropic stop reason after diagnostic truncation', () => {
  const report = auditStream([{ type: 'message_start' }, unknown(), { type: 'message_stop' }], 'anthropic-messages', { maxDiagnostics: 1 });
  assertInvalid(report);
  assert.equal(report.droppedDiagnostics, 1);
});

test('retains post-terminal provider error with the default diagnostic limit', () => {
  const report = auditStream([created(), ...Array.from({ length: 1000 }, unknown), completed(), { type: 'error', message: 'test failure' }], 'openai-responses');
  assertInvalid(report);
  assert.equal(report.diagnostics.length, 1000);
  assert.equal(report.droppedDiagnostics, 2);
});

test('retains Anthropic delta-after-done error after diagnostic truncation', () => {
  const report = auditStream([
    { type: 'message_start' }, unknown(),
    { type: 'content_block_start', index: 0 },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'test' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ], 'anthropic-messages', { maxDiagnostics: 1 });
  assertInvalid(report);
  assert.equal(report.droppedDiagnostics, 1);
});

test('warning overflow alone does not invalidate a complete stream', () => {
  const report = auditStream([created(), unknown(), unknown(), completed()], 'openai-responses', { maxDiagnostics: 1 });
  assert.equal(report.successful, true);
  assert.equal(report.droppedDiagnostics, 1);
});

test('rejects content parts whose output item never opened', () => {
  assertInvalid(auditStream([created(), part('added'), delta(), part('done'), completed()], 'openai-responses'));
});

test('rejects content activity after the parent output item completes', () => {
  assertInvalid(auditStream([created(), item('added'), part('added'), item('done'), delta(), part('done'), completed()], 'openai-responses'));
});

test('rejects a content stop after the parent output item completes', () => {
  assertInvalid(auditStream([created(), item('added'), part('added'), item('done'), part('done'), completed()], 'openai-responses'));
});

test('accepts independently interleaved content under open output items', () => {
  const report = auditStream([created(), item('added', 0), item('added', 1), part('added', 0), part('added', 1), delta(1), delta(0), part('done', 1), item('done', 1), part('done', 0), item('done', 0), completed()], 'openai-responses');
  assert.equal(report.successful, true);
  assert.deepEqual(report.diagnostics, []);
});
