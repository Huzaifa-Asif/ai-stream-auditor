# ai-stream-auditor

Audit decoded OpenAI Responses and Anthropic Messages event lifecycles for truncated, contradictory, or silently failed streams.

`ai-stream-auditor` is a zero-dependency diagnostic state machine. Feed it the event objects your provider SDK already decoded. It reports whether the provider protocol reached a terminal event, whether that terminal represents a successful result, and exactly where lifecycle invariants broke.

It does **not** open network connections, parse SSE bytes, retry requests, accumulate generated text, or replace a provider SDK.

## Why this exists

An async iterator ending is not proof that a model response completed. A transport can close, a consumer can cancel, an SDK can mishandle a mid-stream error, or a proxy can synthesize an end marker. Provider protocols also distinguish a clean terminal event from outcomes such as token exhaustion, refusal, and failure.

The package's checks are based on the providers' documented event flows and motivated by concrete integration failures:

- [OpenAI streaming Responses guide](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI Node issue #2046: mid-stream errors silently swallowed during iteration](https://github.com/openai/openai-node/issues/2046)
- [Anthropic streaming Messages documentation](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic TypeScript SDK issue #1264: `done()` resolves after EOF without `message_stop`](https://github.com/anthropics/anthropic-sdk-typescript/issues/1264)
- [AxonHub issue #2092: synthetic end marker hides incomplete Responses stream](https://github.com/looplj/axonhub/issues/2092)

This project is independent and is not an official OpenAI or Anthropic package.

## Install

```sh
npm install ai-stream-auditor
```

Requires Node.js 18 or newer. ESM, CommonJS, and TypeScript declarations are included.

## Quick start

```js
import { createStreamAuditor } from 'ai-stream-auditor';

const auditor = createStreamAuditor('openai-responses');

try {
  for await (const event of stream) {
    auditor.push(event);
    // Process the event normally; the auditor does not retain its payload.
  }
  const report = auditor.finish({ cause: 'iterator_end' });
  if (!report.successful) console.error(report);
} catch (error) {
  const report = auditor.finish({ cause: 'transport_error' });
  console.error(report, error);
}
```

For Anthropic:

```js
const auditor = createStreamAuditor('anthropic-messages');
for await (const event of stream) auditor.push(event);
const report = auditor.finish();
```

The integration suite feeds credential-free synthetic streams through the
official Anthropic TypeScript SDK and then through this auditor. It covers both
`MessageStream` and `BetaMessageStream`, with EOF after `message_start`, during
partial text, and during partial tool input. Every truncated case is reported
as `transport_closed` even when the SDK's `done()` promise resolves, while a
stream containing `message_stop` remains successful. This guards the exact
EOF boundary and EOF cases from the suggested regression matrix described in
[Anthropic SDK issue #1264](https://github.com/anthropics/anthropic-sdk-typescript/issues/1264).

The same integration boundary covers a transport failure between iterator
reads, where current SDK helpers can report iterator completion while
`done()` rejects with an `AnthropicError` whose cause is the original error.
For both helpers the suite verifies the cause is preserved and the auditor
reports `outcome: 'error'` with
`finishCause: 'transport_error'`, matching
[Anthropic SDK issue #1247](https://github.com/anthropics/anthropic-sdk-typescript/issues/1247).

## The three questions in every report

```ts
{
  protocolComplete: boolean; // Was a provider terminal event observed?
  successful: boolean;       // Was it structurally valid and semantically successful?
  outcome: 'completed' | 'tool_use' | 'paused' | 'incomplete' |
    'refusal' | 'error' | 'cancelled' | 'timeout' |
    'transport_closed' | 'invalid';
}
```

Examples:

| Situation | `protocolComplete` | `successful` | `outcome` |
| --- | --- | --- | --- |
| OpenAI `response.completed`, valid lifecycle | `true` | `true` | `completed` |
| Anthropic `message_stop`, `stop_reason: max_tokens` | `true` | `false` | `incomplete` |
| Anthropic `message_stop`, `stop_reason: tool_use` | `true` | `true` | `tool_use` |
| Provider `error` event | `true` | `false` | `error` |
| Iterator ends without terminal | `false` | `false` | `transport_closed` |
| Caller cancellation without terminal | `false` | `false` | `cancelled` |
| Completion event with an open content unit | `true` | `false` | `invalid` |

Protocol completion and application success are intentionally separate. A cleanly encoded incomplete or refused response is complete at the transport protocol level but is not reported as successful.

## API

### `createStreamAuditor(dialect, options?)`

Creates a bounded state machine. Supported dialects:

- `openai-responses`
- `anthropic-messages`

Options:

| Option | Default | Purpose |
| --- | ---: | --- |
| `maxEvents` | 100,000 | Bounds event processing |
| `maxOpenUnits` | 10,000 | Bounds simultaneously open output items/content parts/blocks |
| `maxDiagnostics` | 1,000 | Bounds retained diagnostic records |

### `auditor.push(event)`

Push one already-decoded provider event. Events are inspected synchronously and are not retained. Only type counts, bounded lifecycle keys, terminal metadata, and bounded diagnostics remain.

Calling `push` after `finish` throws `StreamAuditError`.

### `auditor.finish({ cause? })`

Finalizes and returns a frozen report. `cause` defaults to `iterator_end` and can be:

- `iterator_end`
- `cancelled`
- `timeout`
- `transport_error`

Use the actual consumer/transport cause; the auditor cannot infer why an iterator stopped.

The report also includes `stopReason`, `terminalEvent`, `eventCount`, event-type counts, diagnostics, the number of dropped diagnostics, and the finish cause.

### `auditStream(events, dialect, options?)`

Audits a synchronous iterable, useful for fixtures, stored diagnostic logs, and mutation tests:

```js
const report = auditStream(recordedEvents, 'anthropic-messages');
```

This function deliberately accepts only synchronous iterables. Use `createStreamAuditor` for live async streams so your application controls transport errors and cancellation.

## Checks performed

### Both dialects

- Missing, duplicate, and post-terminal events
- Provider events before the documented start event
- Open content units at terminal
- Duplicate starts/stops and deltas without an open unit
- Hard event, open-unit, and diagnostic bounds
- Unknown event types, reported as warnings for forward compatibility

### OpenAI Responses

- `response.created` lifecycle start
- Output-item and content-part added/done pairing
- Content-part starts, deltas, and stops require their output item to remain open
- Delta events targeting an open item or content part
- Non-increasing `sequence_number` values when present
- `response.completed`, `response.failed`, `response.incomplete`, `response.cancelled`, and `error` terminals
- Terminal event name versus `response.status` contradictions

### Anthropic Messages

- `message_start` / `message_stop`
- `content_block_start` / `content_block_delta` / `content_block_stop` by block index
- Stop reason captured from `message_delta`
- `max_tokens` and `model_context_window_exceeded` as incomplete
- `tool_use`, `pause_turn`, and `refusal` as distinct outcomes
- `error` as a terminal failure
- `ping` events accepted anywhere before terminal

## Diagnostics

Each diagnostic includes:

```ts
{
  severity: 'error' | 'warning';
  code: string;
  index: number;       // zero-based event position
  eventType?: string;
  // code-specific details such as unit, expected, or actual
}
```

Warnings do not make an otherwise valid stream unsuccessful. Today, unknown future event types are warnings. Structural errors make a nominal completion `invalid`.

## Testing truncation and middleware

A useful regression test is cut-at-k: take a valid fixture and audit every prefix before its terminal event. No prefix should be successful.

```js
for (let cut = 0; cut < validEvents.length; cut += 1) {
  const report = auditStream(validEvents.slice(0, cut), 'openai-responses');
  assert.equal(report.successful, false);
}
```

Also mutate fixtures by removing a terminal, moving a block stop before its delta, duplicating completion, inserting a provider error, and finishing with cancellation. These cases are included in this package's test suite.

## Limits and non-goals

- The auditor starts at the first event you feed it. Partial logs that intentionally omit earlier lifecycle events will be diagnosed as incomplete.
- It does not validate SSE framing, `[DONE]` markers, HTTP status, headers, or byte-level decoder behavior.
- It does not retain or compare generated text, tool arguments, token usage, model IDs, or request IDs.
- Recognized event names follow the public provider documentation at release time. New names are warnings rather than hard failures; update the package to gain lifecycle-specific checks for them.
- A valid event sequence does not prove output correctness, safety, authorization, or schema conformance.
- `transport_error` records the consumer's finish cause; pass the original error separately to your logger if needed.

## Troubleshooting

### `missing_terminal` / `transport_closed`

The iterator ended without a provider terminal. Inspect transport and SDK error channels, proxy buffering, and cancellation paths. Do not treat accumulated text as a completed model result.

### `open_unit_at_terminal`

An output item, content part, or Anthropic block never received its documented done/stop event. Preserve the raw event log in a secure diagnostic environment to identify where the lifecycle was truncated.

### `terminal_status_mismatch`

The OpenAI terminal event name disagrees with `response.status`. This may indicate a transformed or malformed fixture/proxy response. The auditor reports `invalid` rather than guessing which field is authoritative.

### `unknown_event`

Provider protocols can add event types. The report remains successful if no structural error exists. Check current provider documentation and update this package before depending on the new event's lifecycle semantics.

### Too many diagnostics

`droppedDiagnostics` counts records beyond `maxDiagnostics`. The first bounded set is retained. Errors still affect the final outcome even when their diagnostic records are dropped. Increase the limit only when your logging and memory budgets permit.

Content parts are checked against their parent output item's lifecycle, as defined in the [OpenAI streaming events reference](https://developers.openai.com/api/reference/resources/responses/streaming-events). Orphan content parts and content activity after the output item completes make a nominal completion invalid.

## Security and privacy

The auditor does not retain raw event payloads or generated text by default because there is no retention option. Diagnostics contain event type, event index, lifecycle keys, and status/sequence values; those may still be sensitive in some systems. Apply your logging policy before exporting reports.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Runnable example and related tool

[`examples/audit-openai.mjs`](examples/audit-openai.mjs) and
[`examples/audit-anthropic.mjs`](examples/audit-anthropic.mjs) feed minimal
valid provider lifecycles through the auditor. Both are executed by
`npm run check` and ship in the npm tarball.

Use [`async-iterator-watchdog`](https://www.npmjs.com/package/async-iterator-watchdog)
when you also need active first-progress, idle, or total deadlines around the
source iterator. The watchdog enforces time; this package validates protocol
lifecycle and outcome.

## Development

Node.js 20 or newer runs the complete suite, including the dev-only official
Anthropic SDK integration:

```sh
npm ci --ignore-scripts
npm run check
```

Node.js 18 remains supported by the package runtime. Because the current
Anthropic SDK dev dependency requires Node.js 20 or newer, use the
dependency-free core and package-surface check on Node.js 18:

```sh
npm ci --omit=dev --ignore-scripts
npm run check:core
```

## License

MIT © 2026 Huzaifa Asif
