import assert from 'node:assert/strict';
import test from 'node:test';

import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';

import { createStreamAuditor } from '../src/index.js';

function messageStart() {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
}

function readableEvents(events) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}

async function auditSdkStream(events) {
  const stream = MessageStream.fromReadableStream(readableEvents(events));
  const auditor = createStreamAuditor('anthropic-messages');
  for await (const event of stream) auditor.push(event);
  await stream.done();
  return { report: auditor.finish(), receivedMessages: stream.receivedMessages.length };
}

test('detects Anthropic SDK EOF after message_start despite done() resolving', async () => {
  const { report, receivedMessages } = await auditSdkStream([messageStart()]);

  assert.equal(receivedMessages, 0);
  assert.equal(report.protocolComplete, false);
  assert.equal(report.successful, false);
  assert.equal(report.outcome, 'transport_closed');
  assert.ok(report.diagnostics.some(({ code }) => code === 'missing_terminal'));
});

test('accepts an Anthropic SDK stream containing message_stop', async () => {
  const { report, receivedMessages } = await auditSdkStream([
    messageStart(),
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]);

  assert.equal(receivedMessages, 1);
  assert.equal(report.protocolComplete, true);
  assert.equal(report.successful, true);
  assert.equal(report.outcome, 'completed');
});
