/**
 * Provider abstraction — separates orchestration from model-specific code.
 *
 * FakeProvider is the deterministic test double used in all tests and the
 * benchmark. It never calls a paid API.
 *
 * Modes:
 *  - 'success'  — emits `chunkCount` chunks then completes normally
 *  - 'failure'  — emits `failAfterChunks` chunks then throws
 *  - 'slow'     — semantic label for timeout-path tests; set chunkDelayMs > 0
 *                 so the provider takes longer than the runtime's timeout
 *  - 'cancel'   — semantic label for explicit-cancellation tests; set chunkDelayMs
 *                 > 0 so the provider runs long enough to be cancelled externally
 *                 via AbortController.abort()
 *
 * The 'slow' and 'cancel' modes share the same stream behavior (delayed chunks)
 * because the distinction is in test intent, not provider internals:
 *  - 'slow' tests verify timeout-triggered termination (Promise.race wins)
 *  - 'cancel' tests verify caller-initiated cancellation (runtime.cancel())
 *
 * The AbortSignal is checked between every chunk so cancellation is prompt.
 */

import type { ModelProvider, ProviderChunk } from './types.js';

// ---------------------------------------------------------------------------
// Fake provider configuration
// ---------------------------------------------------------------------------

export type FakeProviderMode = 'success' | 'failure' | 'slow' | 'cancel';

export interface FakeProviderOptions {
  mode?: FakeProviderMode;
  chunkCount?: number;
  /** Only for mode 'failure': throw after this many chunks. */
  failAfterChunks?: number;
  /** Delay between chunks in ms (default 0). Set > 0 to test timeout. */
  chunkDelayMs?: number;
}

export class FakeProvider implements ModelProvider {
  private readonly mode: FakeProviderMode;
  private readonly chunkCount: number;
  private readonly failAfterChunks: number;
  private readonly chunkDelayMs: number;
  /** Track whether stream() was called — used by tests to verify AC2. */
  public callCount = 0;

  constructor(opts: FakeProviderOptions = {}) {
    this.mode = opts.mode ?? 'success';
    this.chunkCount = opts.chunkCount ?? 5;
    this.failAfterChunks = opts.failAfterChunks ?? 2;
    this.chunkDelayMs = opts.chunkDelayMs ?? 0;
  }

  async *stream(
    _input: string,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    this.callCount++;

    const total =
      this.mode === 'failure' ? this.failAfterChunks + 1 : this.chunkCount;

    for (let i = 0; i < total; i++) {
      // Respect cancellation between every chunk
      if (signal.aborted) return;

      if (this.chunkDelayMs > 0) {
        await delay(this.chunkDelayMs, signal);
        if (signal.aborted) return;
      }

      if (this.mode === 'failure' && i === this.failAfterChunks) {
        throw new ProviderError('Simulated provider failure after partial output');
      }

      yield { index: i, text: `chunk-${i}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Provider error — distinguishes provider failures from other runtime errors
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
