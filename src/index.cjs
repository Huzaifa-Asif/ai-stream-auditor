'use strict';

const DIALECTS = Object.freeze(['openai-responses', 'anthropic-messages']);
const DEFAULT_LIMITS = Object.freeze({ maxEvents: 100_000, maxOpenUnits: 10_000, maxDiagnostics: 1_000 });
const OPENAI_EVENTS = new Set([
  'error', 'response.queued', 'response.created', 'response.in_progress', 'response.completed', 'response.failed',
  'response.incomplete', 'response.cancelled', 'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done',
  'response.output_text.annotation.added', 'response.refusal.delta', 'response.refusal.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done',
  'response.file_search_call.in_progress', 'response.file_search_call.searching', 'response.file_search_call.completed',
  'response.web_search_call.in_progress', 'response.web_search_call.searching', 'response.web_search_call.completed',
  'response.code_interpreter_call.in_progress', 'response.code_interpreter_call.interpreting',
  'response.code_interpreter_call.completed', 'response.code_interpreter_call_code.delta',
  'response.code_interpreter_call_code.done', 'response.image_generation_call.in_progress',
  'response.image_generation_call.generating', 'response.image_generation_call.partial_image',
  'response.image_generation_call.completed', 'response.mcp_call.in_progress', 'response.mcp_call.arguments.delta',
  'response.mcp_call.arguments.done', 'response.mcp_call.completed', 'response.mcp_call.failed',
  'response.mcp_list_tools.in_progress', 'response.mcp_list_tools.completed', 'response.mcp_list_tools.failed',
  'response.audio.delta', 'response.audio.done', 'response.audio.transcript.delta', 'response.audio.transcript.done',
]);
const ANTHROPIC_EVENTS = new Set([
  'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
  'message_delta', 'message_stop', 'ping', 'error',
]);

class StreamAuditError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StreamAuditError';
    this.code = code;
  }
}

function limit(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1) throw new StreamAuditError(`${name} must be a positive safe integer`, 'invalid_options');
  return result;
}

function eventType(event) {
  return event && typeof event === 'object' && typeof event.type === 'string' ? event.type : undefined;
}

class StreamAuditor {
  constructor(dialect, options = {}) {
    if (!DIALECTS.includes(dialect)) throw new StreamAuditError(`unsupported dialect: ${dialect}`, 'invalid_options');
    this.dialect = dialect;
    this.limits = {
      maxEvents: limit(options.maxEvents, DEFAULT_LIMITS.maxEvents, 'maxEvents'),
      maxOpenUnits: limit(options.maxOpenUnits, DEFAULT_LIMITS.maxOpenUnits, 'maxOpenUnits'),
      maxDiagnostics: limit(options.maxDiagnostics, DEFAULT_LIMITS.maxDiagnostics, 'maxDiagnostics'),
    };
    this.eventCount = 0;
    this.counts = new Map();
    this.diagnostics = [];
    this.droppedDiagnostics = 0;
    this.terminal = undefined;
    this.started = false;
    this.openUnits = new Map();
    this.doneUnits = new Set();
    this.stopReason = undefined;
    this.lastSequence = undefined;
    this.boundExceeded = false;
    this.finished = false;
  }

  _diagnostic(severity, code, index, type, details) {
    if (this.diagnostics.length >= this.limits.maxDiagnostics) {
      this.droppedDiagnostics += 1;
      return;
    }
    this.diagnostics.push(Object.freeze({ severity, code, index, ...(type ? { eventType: type } : {}), ...(details || {}) }));
  }

  _open(key, index, type) {
    if (this.openUnits.has(key) || this.doneUnits.has(key)) {
      this._diagnostic('error', 'duplicate_start', index, type, { unit: key });
      return;
    }
    if (this.openUnits.size >= this.limits.maxOpenUnits) {
      this.boundExceeded = true;
      this._diagnostic('error', 'max_open_units', index, type);
      return;
    }
    this.openUnits.set(key, index);
  }

  _delta(key, index, type) {
    if (!this.openUnits.has(key)) {
      this._diagnostic('error', this.doneUnits.has(key) ? 'delta_after_done' : 'delta_without_start', index, type, { unit: key });
    }
  }

  _done(key, index, type) {
    if (!this.openUnits.has(key)) {
      this._diagnostic('error', this.doneUnits.has(key) ? 'duplicate_done' : 'done_without_start', index, type, { unit: key });
      return;
    }
    this.openUnits.delete(key);
    this.doneUnits.add(key);
  }

  _setTerminal(kind, index, type) {
    if (this.terminal) {
      this._diagnostic('error', 'duplicate_terminal', index, type, { previousTerminal: this.terminal.type });
      return;
    }
    this.terminal = { kind, index, type };
    for (const unit of this.openUnits.keys()) {
      this._diagnostic('error', 'open_unit_at_terminal', index, type, { unit });
    }
  }

  push(event) {
    if (this.finished) throw new StreamAuditError('cannot push after finish()', 'already_finished');
    const index = this.eventCount;
    this.eventCount += 1;
    if (this.eventCount > this.limits.maxEvents) {
      if (!this.boundExceeded) this._diagnostic('error', 'max_events', index);
      this.boundExceeded = true;
      return this;
    }
    const type = eventType(event);
    if (!type) {
      this._diagnostic('error', 'invalid_event', index);
      return this;
    }
    this.counts.set(type, (this.counts.get(type) || 0) + 1);
    if (this.terminal) this._diagnostic('error', 'event_after_terminal', index, type, { terminal: this.terminal.type });
    if (this.dialect === 'openai-responses') this._pushOpenAI(event, index, type);
    else this._pushAnthropic(event, index, type);
    return this;
  }

  _sequence(event, index, type) {
    if (!Number.isSafeInteger(event.sequence_number)) return;
    if (this.lastSequence !== undefined && event.sequence_number <= this.lastSequence) {
      this._diagnostic('error', 'non_increasing_sequence', index, type, { previous: this.lastSequence, current: event.sequence_number });
    }
    this.lastSequence = event.sequence_number;
  }

  _pushOpenAI(event, index, type) {
    this._sequence(event, index, type);
    if (!OPENAI_EVENTS.has(type)) {
      this._diagnostic('warning', 'unknown_event', index, type);
      return;
    }
    if (type === 'response.created') {
      if (this.started) this._diagnostic('error', 'duplicate_start', index, type, { unit: 'response' });
      this.started = true;
      return;
    }
    if (!this.started && type !== 'response.queued') {
      this._diagnostic('error', 'event_before_start', index, type);
    }
    if (type === 'response.output_item.added') {
      this._open(`item:${event.output_index}`, index, type);
      return;
    }
    if (type === 'response.output_item.done') {
      this._done(`item:${event.output_index}`, index, type);
      return;
    }
    if (type === 'response.content_part.added') {
      this._open(`content:${event.output_index}:${event.content_index}`, index, type);
      return;
    }
    if (type === 'response.content_part.done') {
      this._done(`content:${event.output_index}:${event.content_index}`, index, type);
      return;
    }
    if (/\.delta$/.test(type)) {
      const key = Number.isSafeInteger(event.content_index)
        ? `content:${event.output_index}:${event.content_index}`
        : `item:${event.output_index}`;
      this._delta(key, index, type);
      return;
    }
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete' || type === 'response.cancelled' || type === 'error') {
      const kind = type === 'response.completed' ? 'completed'
        : type === 'response.incomplete' ? 'incomplete'
          : type === 'response.cancelled' ? 'cancelled' : 'error';
      if (type.startsWith('response.') && event.response && typeof event.response.status === 'string') {
        const expected = type.slice('response.'.length);
        if (event.response.status !== expected) {
          this._diagnostic('error', 'terminal_status_mismatch', index, type, { expected, actual: event.response.status });
        }
      }
      this._setTerminal(kind, index, type);
    }
  }

  _pushAnthropic(event, index, type) {
    if (!ANTHROPIC_EVENTS.has(type)) {
      this._diagnostic('warning', 'unknown_event', index, type);
      return;
    }
    if (type === 'ping') return;
    if (type === 'message_start') {
      if (this.started) this._diagnostic('error', 'duplicate_start', index, type, { unit: 'message' });
      this.started = true;
      return;
    }
    if (!this.started && type !== 'ping') this._diagnostic('error', 'event_before_start', index, type);
    if (type === 'content_block_start') {
      this._open(`block:${event.index}`, index, type);
      return;
    }
    if (type === 'content_block_delta') {
      this._delta(`block:${event.index}`, index, type);
      return;
    }
    if (type === 'content_block_stop') {
      this._done(`block:${event.index}`, index, type);
      return;
    }
    if (type === 'message_delta') {
      if (!this.started) this._diagnostic('error', 'message_delta_without_start', index, type);
      if (event.delta && typeof event.delta.stop_reason === 'string') this.stopReason = event.delta.stop_reason;
      return;
    }
    if (type === 'message_stop') {
      if (!this.stopReason) this._diagnostic('error', 'missing_stop_reason', index, type);
      const incomplete = this.stopReason === 'max_tokens' || this.stopReason === 'model_context_window_exceeded';
      const refused = this.stopReason === 'refusal';
      const kind = incomplete ? 'incomplete' : refused ? 'refusal' : 'completed';
      this._setTerminal(kind, index, type);
      return;
    }
    if (type === 'error') this._setTerminal('error', index, type);
  }

  finish(options = {}) {
    if (this.finished) throw new StreamAuditError('finish() may only be called once', 'already_finished');
    this.finished = true;
    const cause = options.cause || 'iterator_end';
    if (!['iterator_end', 'cancelled', 'timeout', 'transport_error'].includes(cause)) {
      throw new StreamAuditError(`unsupported finish cause: ${cause}`, 'invalid_options');
    }
    if (!this.started && !this.terminal && this.eventCount > 0) this._diagnostic('error', 'missing_start', this.eventCount);
    if (!this.terminal && !this.boundExceeded) this._diagnostic('error', 'missing_terminal', this.eventCount);

    const hasErrors = this.diagnostics.some(({ severity }) => severity === 'error');
    let outcome;
    if (this.boundExceeded || hasErrors && this.terminal && this.terminal.kind === 'completed') outcome = 'invalid';
    else if (this.terminal) outcome = this.terminal.kind === 'completed' && this.dialect === 'anthropic-messages' && this.stopReason === 'tool_use'
      ? 'tool_use'
      : this.terminal.kind === 'completed' && this.dialect === 'anthropic-messages' && this.stopReason === 'pause_turn'
        ? 'paused'
        : this.terminal.kind;
    else if (cause === 'cancelled') outcome = 'cancelled';
    else if (cause === 'timeout') outcome = 'timeout';
    else if (cause === 'transport_error') outcome = 'error';
    else outcome = 'transport_closed';

    return Object.freeze({
      dialect: this.dialect,
      protocolComplete: Boolean(this.terminal),
      successful: ['completed', 'tool_use', 'paused'].includes(outcome),
      outcome,
      stopReason: this.stopReason,
      terminalEvent: this.terminal && this.terminal.type,
      eventCount: this.eventCount,
      eventTypes: Object.freeze(Object.fromEntries(this.counts)),
      diagnostics: Object.freeze([...this.diagnostics]),
      droppedDiagnostics: this.droppedDiagnostics,
      finishCause: cause,
    });
  }
}

function createStreamAuditor(dialect, options) {
  return new StreamAuditor(dialect, options);
}

function auditStream(events, dialect, options = {}) {
  if (!events || typeof events[Symbol.iterator] !== 'function') throw new StreamAuditError('events must be iterable', 'invalid_options');
  const auditor = createStreamAuditor(dialect, options);
  for (const event of events) auditor.push(event);
  return auditor.finish({ cause: options.cause });
}

module.exports = { DEFAULT_LIMITS, DIALECTS, StreamAuditError, StreamAuditor, auditStream, createStreamAuditor };
