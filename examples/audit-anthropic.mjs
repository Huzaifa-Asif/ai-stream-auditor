import { createStreamAuditor } from 'ai-stream-auditor';

const events = [
  { type: 'message_start', message: { stop_reason: null } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];

const auditor = createStreamAuditor('anthropic-messages');
for (const event of events) auditor.push(event);

const report = auditor.finish();
console.log(JSON.stringify({
  protocolComplete: report.protocolComplete,
  successful: report.successful,
  outcome: report.outcome,
}));
