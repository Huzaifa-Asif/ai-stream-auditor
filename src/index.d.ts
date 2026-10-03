export type Dialect = 'openai-responses' | 'anthropic-messages';
export type FinishCause = 'iterator_end' | 'cancelled' | 'timeout' | 'transport_error';
export type AuditOutcome = 'completed' | 'tool_use' | 'paused' | 'incomplete' | 'refusal' | 'error' | 'cancelled' | 'timeout' | 'transport_closed' | 'invalid';

export interface AuditOptions {
  maxEvents?: number;
  maxOpenUnits?: number;
  maxDiagnostics?: number;
  cause?: FinishCause;
}

export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly index: number;
  readonly eventType?: string;
  readonly [detail: string]: unknown;
}

export interface AuditReport {
  readonly dialect: Dialect;
  readonly protocolComplete: boolean;
  readonly successful: boolean;
  readonly outcome: AuditOutcome;
  readonly stopReason?: string;
  readonly terminalEvent?: string;
  readonly eventCount: number;
  readonly eventTypes: Readonly<Record<string, number>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly droppedDiagnostics: number;
  readonly finishCause: FinishCause;
}

export declare const DEFAULT_LIMITS: Readonly<{ maxEvents: number; maxOpenUnits: number; maxDiagnostics: number }>;
export declare const DIALECTS: readonly Dialect[];

export declare class StreamAuditError extends Error { readonly code: string }
export declare class StreamAuditor {
  constructor(dialect: Dialect, options?: AuditOptions);
  push(event: unknown): this;
  finish(options?: { cause?: FinishCause }): AuditReport;
}
export declare function createStreamAuditor(dialect: Dialect, options?: AuditOptions): StreamAuditor;
export declare function auditStream(events: Iterable<unknown>, dialect: Dialect, options?: AuditOptions): AuditReport;

declare const api: {
  DEFAULT_LIMITS: typeof DEFAULT_LIMITS;
  DIALECTS: typeof DIALECTS;
  StreamAuditError: typeof StreamAuditError;
  StreamAuditor: typeof StreamAuditor;
  auditStream: typeof auditStream;
  createStreamAuditor: typeof createStreamAuditor;
};
export default api;
