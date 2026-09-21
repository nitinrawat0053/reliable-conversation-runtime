/**
 * Verification benchmark — Problem 5: Reliable AI Conversation Runtime.
 *
 * Runs 10 iterations each of:
 *  - Successful completion
 *  - Policy rejection
 *  - Cancellation during streaming (explicit abort via runtime.cancel())
 *  - Timeout
 *  - Provider failure after partial output
 *
 * Reports terminal-state counts and verifies:
 *  1. Each run has exactly one terminal state
 *  2. Rejected runs never invoke the provider
 *  3. Cancelled, timed-out, and failed runs have no successful persisted response
 *  4. No events appear after a terminal event
 *  5. Benchmark is fully deterministic and offline
 *
 * Run with: npm run benchmark
 */

import { ConversationRuntime } from '../src/runtime.js';
import { ConversationStore } from '../src/persistence.js';
import { FakeProvider } from '../src/provider.js';
import { AllowAllPolicyGate, RejectAllPolicyGate } from '../src/policy.js';
import type { RunStatus, TraceEvent, TraceEventKind } from '../src/types.js';

const ITERATIONS = 10;

interface RunResult {
  runId: string;
  status: RunStatus;
  terminalEventCount: number;
  providerCallCount: number;
  hasAssistantResponse: boolean;
  hasEventsAfterTerminal: boolean;
  chunkCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_KINDS = new Set<TraceEventKind>([
  'run_completed', 'run_cancelled', 'run_timed_out', 'run_failed', 'run_rejected',
]);

function countTerminalEvents(trace: readonly TraceEvent[]): number {
  return trace.filter((e) => TERMINAL_KINDS.has(e.kind)).length;
}

function hasEventsAfterTerminal(trace: readonly TraceEvent[]): boolean {
  let sawTerminal = false;
  for (const e of trace) {
    if (sawTerminal) return true;
    if (TERMINAL_KINDS.has(e.kind)) sawTerminal = true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

async function runSuccessScenario(): Promise<RunResult> {
  const store = new ConversationStore();
  const provider = new FakeProvider({ mode: 'success', chunkCount: 5 });
  const runtime = new ConversationRuntime(store, { timeoutMs: 5000 });
  const result = await runtime.execute('Hello', new AllowAllPolicyGate(), provider);
  return {
    runId: result.runId,
    status: result.status,
    terminalEventCount: countTerminalEvents(result.trace),
    providerCallCount: provider.callCount,
    hasAssistantResponse: result.assistantResponse !== undefined,
    hasEventsAfterTerminal: hasEventsAfterTerminal(result.trace),
    chunkCount: result.chunks.length,
  };
}

async function runRejectionScenario(): Promise<RunResult> {
  const store = new ConversationStore();
  const provider = new FakeProvider({ mode: 'success', chunkCount: 5 });
  const runtime = new ConversationRuntime(store, { timeoutMs: 5000 });
  const result = await runtime.execute('Hello', new RejectAllPolicyGate(), provider);
  return {
    runId: result.runId,
    status: result.status,
    terminalEventCount: countTerminalEvents(result.trace),
    providerCallCount: provider.callCount,
    hasAssistantResponse: result.assistantResponse !== undefined,
    hasEventsAfterTerminal: hasEventsAfterTerminal(result.trace),
    chunkCount: result.chunks.length,
  };
}

async function runCancellationScenario(): Promise<RunResult> {
  const store = new ConversationStore();
  const provider = new FakeProvider({ chunkCount: 200, chunkDelayMs: 30 });
  const runtime = new ConversationRuntime(store, { timeoutMs: 60_000 });

  const executePromise = runtime.execute('Hello', new AllowAllPolicyGate(), provider);

  // Wait for the run to be registered in activeRuns (transition to running)
  await new Promise((r) => setTimeout(r, 5));

  const records = store.getAll();
  const runId = records[0].runId;

  // Cancel while provider is actively streaming
  runtime.cancel(runId);

  const result = await executePromise;

  return {
    runId: result.runId,
    status: result.status,
    terminalEventCount: countTerminalEvents(result.trace),
    providerCallCount: provider.callCount,
    hasAssistantResponse: result.assistantResponse !== undefined,
    hasEventsAfterTerminal: hasEventsAfterTerminal(result.trace),
    chunkCount: result.chunks.length,
  };
}

async function runTimeoutScenario(): Promise<RunResult> {
  const store = new ConversationStore();
  const provider = new FakeProvider({ mode: 'success', chunkCount: 100, chunkDelayMs: 50 });
  const runtime = new ConversationRuntime(store, { timeoutMs: 10 });
  const result = await runtime.execute('Hello', new AllowAllPolicyGate(), provider);
  return {
    runId: result.runId,
    status: result.status,
    terminalEventCount: countTerminalEvents(result.trace),
    providerCallCount: provider.callCount,
    hasAssistantResponse: result.assistantResponse !== undefined,
    hasEventsAfterTerminal: hasEventsAfterTerminal(result.trace),
    chunkCount: result.chunks.length,
  };
}

async function runFailureScenario(): Promise<RunResult> {
  const store = new ConversationStore();
  const provider = new FakeProvider({ mode: 'failure', failAfterChunks: 3 });
  const runtime = new ConversationRuntime(store, { timeoutMs: 5000 });
  const result = await runtime.execute('Hello', new AllowAllPolicyGate(), provider);
  return {
    runId: result.runId,
    status: result.status,
    terminalEventCount: countTerminalEvents(result.trace),
    providerCallCount: provider.callCount,
    hasAssistantResponse: result.assistantResponse !== undefined,
    hasEventsAfterTerminal: hasEventsAfterTerminal(result.trace),
    chunkCount: result.chunks.length,
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface ScenarioSummary {
  name: string;
  expectedStatus: RunStatus | RunStatus[];
  results: RunResult[];
  violations: string[];
}

function verify(summary: ScenarioSummary): void {
  for (let i = 0; i < summary.results.length; i++) {
    const r = summary.results[i];
    const iter = i + 1;

    // 1. Exactly one terminal event
    if (r.terminalEventCount !== 1) {
      summary.violations.push(
        `[${summary.name}] iter ${iter}: expected 1 terminal event, got ${r.terminalEventCount}`,
      );
    }

    // 2. Status matches expectation
    const expected = Array.isArray(summary.expectedStatus)
      ? summary.expectedStatus
      : [summary.expectedStatus];
    if (!expected.includes(r.status)) {
      summary.violations.push(
        `[${summary.name}] iter ${iter}: expected status in [${expected.join(', ')}], got ${r.status}`,
      );
    }

    // 3. No events after terminal
    if (r.hasEventsAfterTerminal) {
      summary.violations.push(
        `[${summary.name}] iter ${iter}: events appeared after terminal event`,
      );
    }
  }
}

function verifySucessScenario(summary: ScenarioSummary): void {
  verify(summary);
  for (let i = 0; i < summary.results.length; i++) {
    const r = summary.results[i];
    if (!r.hasAssistantResponse) {
      summary.violations.push(
        `[${summary.name}] iter ${i + 1}: completed run missing assistantResponse`,
      );
    }
  }
}

function verifyRejectionScenario(summary: ScenarioSummary): void {
  verify(summary);
  for (let i = 0; i < summary.results.length; i++) {
    const r = summary.results[i];
    // Provider must never be called on rejection
    if (r.providerCallCount !== 0) {
      summary.violations.push(
        `[${summary.name}] iter ${i + 1}: provider was called (callCount=${r.providerCallCount}), must be 0`,
      );
    }
    if (r.hasAssistantResponse) {
      summary.violations.push(
        `[${summary.name}] iter ${i + 1}: rejected run must not have assistantResponse`,
      );
    }
  }
}

function verifyNonSuccessScenario(summary: ScenarioSummary): void {
  verify(summary);
  for (let i = 0; i < summary.results.length; i++) {
    const r = summary.results[i];
    if (r.hasAssistantResponse) {
      summary.violations.push(
        `[${summary.name}] iter ${i + 1}: non-success run must not have assistantResponse`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('  Problem 5 — Reliable AI Conversation Runtime');
  console.log('  Verification Benchmark');
  console.log('='.repeat(60));
  console.log(`\nRunning ${ITERATIONS} iterations per scenario...\n`);

  const scenarios: Array<{
    name: string;
    runner: () => Promise<RunResult>;
    expectedStatus: RunStatus | RunStatus[];
    verifier: (s: ScenarioSummary) => void;
  }> = [
    {
      name: 'Successful completion',
      runner: runSuccessScenario,
      expectedStatus: 'completed',
      verifier: verifySucessScenario,
    },
    {
      name: 'Policy rejection',
      runner: runRejectionScenario,
      expectedStatus: 'rejected',
      verifier: verifyRejectionScenario,
    },
    {
      name: 'Cancellation during streaming',
      runner: runCancellationScenario,
      expectedStatus: 'cancelled',
      verifier: verifyNonSuccessScenario,
    },
    {
      name: 'Timeout',
      runner: runTimeoutScenario,
      expectedStatus: 'timed_out',
      verifier: verifyNonSuccessScenario,
    },
    {
      name: 'Provider failure after partial output',
      runner: runFailureScenario,
      expectedStatus: 'failed',
      verifier: verifyNonSuccessScenario,
    },
  ];

  let totalViolations = 0;
  const allSummaries: ScenarioSummary[] = [];

  for (const scenario of scenarios) {
    const results: RunResult[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      results.push(await scenario.runner());
    }

    const summary: ScenarioSummary = {
      name: scenario.name,
      expectedStatus: scenario.expectedStatus,
      results,
      violations: [],
    };
    scenario.verifier(summary);
    allSummaries.push(summary);

    // Count statuses
    const statusCounts: Partial<Record<RunStatus, number>> = {};
    for (const r of results) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }

    const statusStr = Object.entries(statusCounts)
      .map(([s, c]) => `${s}×${c}`)
      .join(', ');

    const ok = summary.violations.length === 0;
    const icon = ok ? '✓' : '✗';
    console.log(`${icon}  ${scenario.name}`);
    console.log(`   Status counts: ${statusStr}`);
    if (!ok) {
      for (const v of summary.violations) {
        console.log(`   VIOLATION: ${v}`);
      }
    }
    totalViolations += summary.violations.length;
    console.log();
  }

  // ---------------------------------------------------------------------------
  // Final report
  // ---------------------------------------------------------------------------
  console.log('='.repeat(60));
  if (totalViolations === 0) {
    console.log('  RESULT: ALL CHECKS PASSED');
    console.log(`  ${ITERATIONS * scenarios.length} runs across ${scenarios.length} scenarios`);
    console.log('  No violations found.');
  } else {
    console.log(`  RESULT: ${totalViolations} VIOLATION(S) FOUND`);
  }
  console.log('='.repeat(60));

  // Exit non-zero if any violations
  if (totalViolations > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
