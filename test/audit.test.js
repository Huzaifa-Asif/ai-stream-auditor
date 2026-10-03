import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamAuditError, auditStream, createStreamAuditor } from '../src/index.js';

const openAIComplete = () => [
  { type: 'response.created', sequence_number: 0 },
  { type: 'response.output_item.added', sequence_number: 1, output_index: 0 },
  { type: 'response.content_part.added', sequence_number: 2, output_index: 0, content_index: 0 },
  { type: 'response.output_text.delta', sequence_number: 3, output_index: 0, content_index: 0, delta: 'hello' },
  { type: 'response.output_text.done', sequence_number: 4, output_index: 0, content_index: 0, text: 'hello' },
  { type: 'response.content_part.done', sequence_number: 5, output_index: 0, content_index: 0 },
  { type: 'response.output_item.done', sequence_number: 6, output_index: 0 },
  { type: 'response.completed', sequence_number: 7, response: { status: 'completed' } },
];

const anthropicComplete = () => [
  { type: 'message_start', message: { stop_reason: null } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];

test('accepts a complete OpenAI Responses lifecycle', () => {
  const report = auditStream(openAIComplete(), 'openai-responses');
  assert.equal(report.protocolComplete, true);
  assert.equal(report.successful, true);
  assert.equal(report.outcome, 'completed');
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.eventTypes['response.output_text.delta'], 1);
});

test('accepts a complete Anthropic Messages lifecycle', () => {
  const report = auditStream(anthropicComplete(), 'anthropic-messages');
  assert.equal(report.protocolComplete, true);
  assert.equal(report.successful, true);
  assert.equal(report.stopReason, 'end_turn');
  assert.deepEqual(report.diagnostics, []);
});

test('detects a removed terminal event as transport closure', () => {
  const events = openAIComplete().slice(0, -1);
  const report = auditStream(events, 'openai-responses');
  assert.equal(report.protocolComplete, false);
  assert.equal(report.outcome, 'transport_closed');
  assert.ok(report.diagnostics.some(({ code }) => code === 'missing_terminal'));
});

test('distinguishes cancellation and timeout without inventing a provider terminal', () => {
  const events = openAIComplete().slice(0, -1);
  const cancelled = auditStream(events, 'openai-responses', { cause: 'cancelled' });
  const timeout = auditStream(events, 'openai-responses', { cause: 'timeout' });
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(timeout.outcome, 'timeout');
  assert.equal(cancelled.protocolComplete, false);
});

test('detects duplicate terminals and post-terminal events', () => {
  const events = [...openAIComplete(), { type: 'response.completed', sequence_number: 8, response: { status: 'completed' } }];
  const report = auditStream(events, 'openai-responses');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'event_after_terminal'));
  assert.ok(report.diagnostics.some(({ code }) => code === 'duplicate_terminal'));
});

test('detects reordered block end and delta-after-done mutations', () => {
  const events = anthropicComplete();
  [events[2], events[3]] = [events[3], events[2]];
  const report = auditStream(events, 'anthropic-messages');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'delta_after_done'));
});

test('detects unclosed blocks at terminal', () => {
  const events = anthropicComplete().filter(({ type }) => type !== 'content_block_stop');
  const report = auditStream(events, 'anthropic-messages');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'open_unit_at_terminal'));
});

test('classifies Anthropic max_tokens as complete protocol but incomplete result', () => {
  const events = anthropicComplete();
  events[4] = { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
  const report = auditStream(events, 'anthropic-messages');
  assert.equal(report.protocolComplete, true);
  assert.equal(report.successful, false);
  assert.equal(report.outcome, 'incomplete');
});

test('classifies Anthropic tool use and refusal separately', () => {
  const tool = anthropicComplete();
  tool[4] = { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
  assert.equal(auditStream(tool, 'anthropic-messages').outcome, 'tool_use');

  const refusal = anthropicComplete();
  refusal[4] = { type: 'message_delta', delta: { stop_reason: 'refusal' } };
  const report = auditStream(refusal, 'anthropic-messages');
  assert.equal(report.outcome, 'refusal');
  assert.equal(report.successful, false);
});

test('classifies explicit provider error events', () => {
  const openai = auditStream([
    { type: 'response.created' },
    { type: 'error', message: 'overloaded' },
  ], 'openai-responses');
  const anthropic = auditStream([
    { type: 'message_start' },
    { type: 'error', error: { type: 'overloaded_error' } },
  ], 'anthropic-messages');
  assert.equal(openai.outcome, 'error');
  assert.equal(anthropic.outcome, 'error');
});

test('detects terminal status contradiction', () => {
  const events = openAIComplete();
  events.at(-1).response.status = 'incomplete';
  const report = auditStream(events, 'openai-responses');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'terminal_status_mismatch'));
});

test('reports unknown future events without rejecting an otherwise valid stream', () => {
  const events = openAIComplete();
  events.splice(1, 0, { type: 'response.future_signal', sequence_number: 1 });
  for (let index = 2; index < events.length; index += 1) events[index].sequence_number = index;
  const report = auditStream(events, 'openai-responses');
  assert.equal(report.successful, true);
  assert.ok(report.diagnostics.some(({ code, severity }) => code === 'unknown_event' && severity === 'warning'));
});

test('detects non-increasing OpenAI sequence numbers', () => {
  const events = openAIComplete();
  events[3].sequence_number = events[2].sequence_number;
  const report = auditStream(events, 'openai-responses');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'non_increasing_sequence'));
});

test('bounds events, open units, and diagnostic storage', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({ type: 'content_block_delta', index }));
  const report = auditStream(events, 'anthropic-messages', { maxEvents: 5, maxOpenUnits: 2, maxDiagnostics: 2 });
  assert.equal(report.outcome, 'invalid');
  assert.equal(report.eventCount, 10);
  assert.equal(report.diagnostics.length, 2);
  assert.ok(report.droppedDiagnostics > 0);
});

test('supports incremental push without retaining raw event payloads', () => {
  const auditor = createStreamAuditor('anthropic-messages');
  for (const event of anthropicComplete()) auditor.push(event);
  const report = auditor.finish();
  assert.equal(report.successful, true);
  assert.equal('events' in report, false);
  assert.throws(() => auditor.push({ type: 'ping' }), (error) => error instanceof StreamAuditError && error.code === 'already_finished');
});

test('rejects invalid configuration and malformed events', () => {
  assert.throws(() => createStreamAuditor('other'), StreamAuditError);
  assert.throws(() => createStreamAuditor('openai-responses', { maxEvents: 0 }), StreamAuditError);
  const report = auditStream([null, {}, { type: 'response.completed', response: { status: 'completed' } }], 'openai-responses');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'invalid_event'));
});

test('detects lifecycle events before the provider start event', () => {
  const report = auditStream([
    { type: 'content_block_start', index: 0 },
    { type: 'message_start' },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ], 'anthropic-messages');
  assert.equal(report.outcome, 'invalid');
  assert.ok(report.diagnostics.some(({ code }) => code === 'event_before_start'));
});

test('cut-at-k audit never calls a truncated valid stream successful', () => {
  for (const source of [
    ['openai-responses', openAIComplete()],
    ['anthropic-messages', anthropicComplete()],
  ]) {
    const [dialect, events] = source;
    for (let cut = 0; cut < events.length; cut += 1) {
      const report = auditStream(events.slice(0, cut), dialect);
      assert.equal(report.successful, false, `${dialect} cut ${cut}`);
    }
  }
});
