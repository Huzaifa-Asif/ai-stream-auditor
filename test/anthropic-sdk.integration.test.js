import assert from 'node:assert/strict';
import test from 'node:test';

import { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
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

function failingReadable(events, error) {
  let fail;
  const readable = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      fail = () => controller.error(error);
    },
  });
  return { readable, fail: () => fail() };
}

async function auditSdkStream(StreamClass, events) {
  const stream = StreamClass.fromReadableStream(readableEvents(events));
  const auditor = createStreamAuditor('anthropic-messages');
  for await (const event of stream) auditor.push(event);
  await stream.done();
  return { report: auditor.finish(), receivedMessages: stream.receivedMessages.length };
}

const truncatedCases = [
  {
    name: 'after message_start',
    events: () => [messageStart()],
  },
  {
    name: 'during partial text',
    events: () => [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    ],
  },
  {
    name: 'during partial tool input',
    events: () => [
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_test', name: 'lookup', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    ],
  },
];

for (const [streamName, StreamClass] of [
  ['MessageStream', MessageStream],
  ['BetaMessageStream', BetaMessageStream],
]) {
  for (const scenario of truncatedCases) {
    test(`detects ${streamName} EOF ${scenario.name} despite done() resolving`, async () => {
      const { report, receivedMessages } = await auditSdkStream(StreamClass, scenario.events());

      assert.equal(receivedMessages, 0);
      assert.equal(report.protocolComplete, false);
      assert.equal(report.successful, false);
      assert.equal(report.outcome, 'transport_closed');
      assert.ok(report.diagnostics.some(({ code }) => code === 'missing_terminal'));
    });
  }

  test(`accepts a complete ${streamName} lifecycle`, async () => {
    const { report, receivedMessages } = await auditSdkStream(StreamClass, [
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

  test(`records ${streamName} error between iterator reads as transport_error`, async () => {
    const transportError = new Error(`${streamName} controlled transport failure`);
    const { readable, fail } = failingReadable([messageStart()], transportError);
    const stream = StreamClass.fromReadableStream(readable);
    const iterator = stream[Symbol.asyncIterator]();
    const auditor = createStreamAuditor('anthropic-messages');

    const first = await iterator.next();
    assert.equal(first.done, false);
    auditor.push(first.value);

    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const next = await iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    assert.ok(next.error === transportError || next.value?.done === true);

    const doneError = await stream.done().then(
      () => undefined,
      (error) => error,
    );
    assert.equal(doneError?.constructor.name, 'AnthropicError');
    assert.equal(doneError?.cause, transportError);

    const report = auditor.finish({ cause: 'transport_error' });
    assert.equal(report.protocolComplete, false);
    assert.equal(report.successful, false);
    assert.equal(report.outcome, 'error');
    assert.equal(report.finishCause, 'transport_error');
    assert.ok(report.diagnostics.some(({ code }) => code === 'missing_terminal'));
  });
}
