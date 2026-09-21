/**
 * Core types and state machine contract for the Reliable AI Conversation Runtime.
 *
 * State machine:
 *
 *   pending ──► running ──► completed
 *                  │
 *                  ├──► rejected   (policy gate fired before provider)
 *                  ├──► cancelled  (external cancellation during streaming)
 *                  ├──► timed_out  (configurable deadline exceeded)
 *                  └──► failed     (provider error during streaming)
 *
 * Only one terminal state is possible per run. Transitions are validated
 * against the current state by a sequential guard: only the transitions listed
 * in VALID_TRANSITIONS are accepted, and once the run reaches a terminal state
 * no further transition is valid. This is safe under Node.js's single-threaded
 * event loop, where two continuations cannot interleave within a synchronous
 * block — the guard in ConversationRuntime.transitionTo() checks and updates
 * run.status in the same synchronous step, so no second path can observe the
 * pre-transition state and also win.
 */

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'failed';

export const TERMINAL_STATES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'rejected',
  'cancelled',
  'timed_out',
  'failed',
]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/** Valid transitions. Each entry is [from, to]. */
export const VALID_TRANSITIONS: ReadonlyArray<[RunStatus, RunStatus]> = [
  ['pending', 'running'],
  ['pending', 'rejected'],   // policy check can fire before we mark running
  ['running', 'completed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['running', 'failed'],
];

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// ---------------------------------------------------------------------------
// Operational trace events
// ---------------------------------------------------------------------------

export type TraceEventKind =
  | 'run_created'
  | 'policy_accepted'
  | 'policy_rejected'
  | 'provider_started'
  | 'chunk_received'
  | 'provider_completed'
  | 'provider_failed'
  | 'cancellation_requested'
  | 'timeout_triggered'
  | 'run_completed'
  | 'run_cancelled'
  | 'run_timed_out'
  | 'run_failed'
  | 'run_rejected';

export interface TraceEvent {
  /** Monotonically increasing position within the run. */
  seq: number;
  kind: TraceEventKind;
  ts: string;           // ISO-8601 timestamp
  /** Safe summary — never contains secrets or hidden model reasoning. */
  message: string;
  /** Optional structured metadata (redacted before storage). */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

export interface ProviderChunk {
  /** Monotonically increasing chunk index. */
  index: number;
  text: string;
}

/**
 * A provider must yield chunks via an async iterable and accept an AbortSignal
 * so cancellation propagates promptly.
 */
export interface ModelProvider {
  stream(
    input: string,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk>;
}

// ---------------------------------------------------------------------------
// Policy gate
// ---------------------------------------------------------------------------

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export interface PolicyGate {
  evaluate(input: string): PolicyResult;
}

// ---------------------------------------------------------------------------
// Run record (what gets persisted)
// ---------------------------------------------------------------------------

export interface ConversationRecord {
  runId: string;
  conversationId: string;
  userInput: string;
  /** Assembled response text. Only present when status === 'completed'. */
  assistantResponse?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  /** Maximum ms to wait for a run to complete. Default: 30_000. */
  timeoutMs: number;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  timeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  runId: string;
  status: RunStatus;
  /** Ordered text chunks emitted by the provider. */
  chunks: ProviderChunk[];
  /** Safe operational trace. */
  trace: TraceEvent[];
  /** Only set when status === 'completed'. */
  assistantResponse?: string;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export interface CancelResult {
  /** Whether a run with this runId was found (active or terminal). */
  found: boolean;
  /** Whether the cancellation signal was successfully delivered.
   *  false means the run was unknown or already terminal. */
  cancelled: boolean;
}
