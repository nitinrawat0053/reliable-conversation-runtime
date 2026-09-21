/**
 * Runtime — state machine orchestrator.
 *
 * This is the core of the solution. It owns all state transitions and ensures:
 *  1. Policy gate fires before any provider call.
 *  2. Only one terminal state can be reached per run (atomic guard).
 *  3. Cancellation and timeout both route through the AbortController.
 *  4. Persistence reflects only what the runtime has honestly committed.
 *  5. The trace records every meaningful event in order.
 *
 * State machine:
 *   pending → rejected   (policy fires, provider never called)
 *   pending → running    (policy accepted)
 *   running → completed
 *   running → cancelled
 *   running → timed_out
 *   running → failed
 *
 * `transitionTo` is the single gate for all status changes. It checks validity
 * and prevents two concurrent paths from both winning a terminal state.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ModelProvider,
  PolicyGate,
  ProviderChunk,
  RunStatus,
  ExecuteResult,
  RuntimeConfig,
  TraceEvent,
  CancelResult,
} from './types.js';
import { isTerminal, isValidTransition, DEFAULT_CONFIG } from './types.js';
import { TraceBuilder } from './trace.js';
import { ConversationStore } from './persistence.js';
import { ProviderError } from './provider.js';

// ---------------------------------------------------------------------------
// In-memory run (working state — not persisted directly)
// ---------------------------------------------------------------------------

interface Run {
  runId: string;
  conversationId: string;
  userInput: string;
  status: RunStatus;
  chunks: ProviderChunk[];
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class ConversationRuntime {
  private readonly store: ConversationStore;
  private readonly config: RuntimeConfig;
  /** Maps runId → AbortController for runs in the 'running' state. */
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(store: ConversationStore, config: Partial<RuntimeConfig> = {}) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Cancel an active run by runId. Reuses the existing AbortController so the
   * provider receives the abort signal and stops streaming promptly.
   *
   * Returns a CancelResult indicating whether the run was found and whether
   * the cancellation signal was delivered.
   */
  cancel(runId: string): CancelResult {
    const controller = this.activeRuns.get(runId);
    if (!controller) {
      // Run is either unknown or already reached a terminal state (cleaned up).
      // Check the store to distinguish unknown from terminal.
      const record = this.store.get(runId);
      if (!record) return { found: false, cancelled: false };
      // Known but already terminal — abort is a no-op.
      return { found: true, cancelled: false };
    }
    // Deliver the abort signal. The provider will stop streaming and
    // consumeStream() will return 'cancelled', which triggers the terminal
    // state transition inside execute().
    controller.abort();
    // Remove from active map — the terminal-state cleanup in execute() will
    // also attempt removal, but this early removal ensures no duplicate cancel
    // calls can deliver a second abort (which is harmless but unnecessary).
    this.activeRuns.delete(runId);
    return { found: true, cancelled: true };
  }

  /**
   * Execute one conversational turn, returning the full result including
   * status, ordered chunks, operational trace, and (on success) the assembled
   * assistant response.
   */
  async execute(
    input: string,
    policy: PolicyGate,
    provider: ModelProvider,
    conversationId?: string,
    timeoutMs?: number,
  ): Promise<ExecuteResult> {
    const runId = uuidv4();
    const convId = conversationId ?? uuidv4();
    const trace = new TraceBuilder();
    const abortController = new AbortController();

    const run: Run = {
      runId,
      conversationId: convId,
      userInput: input,
      status: 'pending',
      chunks: [],
      abortController,
    };

    // Persist user input immediately (pending state).
    // This is the ONLY write that happens before policy evaluation.
    this.store.create(runId, convId, input);
    trace.add('run_created', `Run ${runId} created`, { runId, conversationId: convId });

    // Atomic terminal-state guard: only one path can win.
    // Returns true if the transition succeeded (i.e. this path won).
    const transitionTo = (next: RunStatus): boolean => {
      if (!isValidTransition(run.status, next)) return false;
      run.status = next;
      return true;
    };

    // ------------------------------------------------------------------
    // Step 1: Policy gate — must fire before the provider is ever invoked
    // ------------------------------------------------------------------
    const policyResult = policy.evaluate(input);

    if (!policyResult.allowed) {
      transitionTo('rejected');
      this.store.update(runId, 'rejected');
      trace.add('policy_rejected', policyResult.reason ?? 'Input rejected by policy');
      trace.add('run_rejected', `Run ${runId} rejected`);
      return this.buildResult(run, trace, undefined);
    }

    trace.add('policy_accepted', 'Input accepted by policy');

    // ------------------------------------------------------------------
    // Step 2: Transition to running
    // ------------------------------------------------------------------
    transitionTo('running');
    this.store.update(runId, 'running');

    // Register the AbortController so external callers can cancel this run.
    this.activeRuns.set(runId, abortController);

    // ------------------------------------------------------------------
    // Step 3: Set up timeout race
    // ------------------------------------------------------------------
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const effectiveTimeoutMs = timeoutMs ?? this.config.timeoutMs;

    const timeoutPromise = new Promise<'timed_out'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timed_out'), effectiveTimeoutMs);
    });

    // ------------------------------------------------------------------
    // Step 4: Stream from provider, racing against timeout
    // ------------------------------------------------------------------
    trace.add('provider_started', 'Provider stream started');

    const streamOutcome = await Promise.race([
      this.consumeStream(run, provider, abortController.signal, trace),
      timeoutPromise,
    ]);

    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    // ------------------------------------------------------------------
    // Step 5: Resolve terminal state
    // ------------------------------------------------------------------
    if (streamOutcome === 'timed_out') {
      abortController.abort(); // stop the provider from consuming further
      if (transitionTo('timed_out')) {
        this.store.update(runId, 'timed_out');
        trace.add('timeout_triggered', `Deadline of ${effectiveTimeoutMs}ms exceeded`);
        trace.add('run_timed_out', `Run ${runId} timed out`);
      }
      this.activeRuns.delete(runId);
      return this.buildResult(run, trace, undefined);
    }

    if (streamOutcome === 'completed') {
      if (transitionTo('completed')) {
        const assembled = run.chunks.map((c) => c.text).join('');
        this.store.update(runId, 'completed', assembled);
        trace.add('run_completed', `Run ${runId} completed — ${run.chunks.length} chunks`);
        this.activeRuns.delete(runId);
        return this.buildResult(run, trace, assembled);
      }
      // If transitionTo failed, the run was already cancelled/timed_out; fall through
    }

    if (streamOutcome === 'failed') {
      if (transitionTo('failed')) {
        this.store.update(runId, 'failed');
        trace.add('run_failed', `Run ${runId} failed`);
      }
      this.activeRuns.delete(runId);
      return this.buildResult(run, trace, undefined);
    }

    if (streamOutcome === 'cancelled') {
      if (transitionTo('cancelled')) {
        this.store.update(runId, 'cancelled');
        trace.add('run_cancelled', `Run ${runId} cancelled`);
      }
      this.activeRuns.delete(runId);
      return this.buildResult(run, trace, undefined);
    }

    // Should never reach here, but be safe
    this.activeRuns.delete(runId);
    return this.buildResult(run, trace, undefined);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Consume the provider's async stream until completion, cancellation, or error.
   * Returns a discriminated result rather than throwing, so the caller can
   * decide which terminal state wins.
   */
  private async consumeStream(
    run: Run,
    provider: ModelProvider,
    signal: AbortSignal,
    trace: TraceBuilder,
  ): Promise<'completed' | 'failed' | 'cancelled'> {
    try {
      for await (const chunk of provider.stream(run.userInput, signal)) {
        if (signal.aborted) return 'cancelled';
        run.chunks.push(chunk);
        trace.add('chunk_received', `Chunk ${chunk.index}: "${chunk.text}"`, {
          chunkIndex: chunk.index,
        });
      }

      // Check again after the loop in case abort fired right at the end
      if (signal.aborted) return 'cancelled';

      trace.add('provider_completed', `Provider emitted ${run.chunks.length} chunks`);
      return 'completed';
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return 'cancelled';
      }
      const message = err instanceof Error ? err.message : String(err);
      trace.add('provider_failed', `Provider error: ${message}`, {
        errorType: err instanceof ProviderError ? 'ProviderError' : 'UnknownError',
        // Intentionally no stack trace in the trace to avoid leaking internals
      });
      return 'failed';
    }
  }

  private buildResult(
    run: Run,
    trace: TraceBuilder,
    assembledResponse: string | undefined,
  ): ExecuteResult {
    return {
      runId: run.runId,
      status: run.status,
      chunks: [...run.chunks],
      trace: [...trace.getEvents()] as TraceEvent[],
      ...(assembledResponse !== undefined ? { assistantResponse: assembledResponse } : {}),
    };
  }
}
