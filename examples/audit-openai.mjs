import { createStreamAuditor } from 'ai-stream-auditor';

const auditor = createStreamAuditor('openai-responses');

// Feed decoded SDK events as they arrive. The auditor does not parse SSE bytes.
for (const event of [
  { type: 'response.created', sequence_number: 0 },
  { type: 'response.completed', sequence_number: 1, response: { status: 'completed' } },
]) {
  auditor.push(event);
}

const report = auditor.finish({ cause: 'iterator_end' });
console.log(report);
