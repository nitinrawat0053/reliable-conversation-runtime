# Design Decisions

This document covers the eight design decisions required by the problem statement. Each section describes what the code actually does today — limitations are stated honestly rather than papered over.

---

## 1. Responsibilities and Interfaces

The runtime is split into five components. Each has a single well-defined job and communicates through a typed interface so it can be replaced without touching the others.

```
Client / HTTP request
        ↓
  server.ts  (Presentation)
        ↓
  ConversationRuntime  (Orchestration)
        ├── PolicyGate        (Policy)
        ├── ModelProvider     (Provider)
        ├── ConversationStore (Persistence)
        └── TraceBuilder      (Trace)
                ↓
          ExecuteResult
```

### Policy — `PolicyGate` interface (`src/policy.ts`)

**Responsible for:** Deciding whether a given user input is allowed before anything else runs.

**Not responsible for:** Calling the model, persisting state, or producing a response.

**Interface:**
```ts
interface PolicyGate {
  evaluate(input: string): PolicyResult;
  // { allowed: boolean; reason?: string }
}
```

The runtime calls `policy.evaluate(input)` synchronously before the provider is ever touched. If `allowed` is `false`, the run transitions to `rejected` and returns immediately. The production implementation (`KeywordPolicyGate`) is regex-based and requires no I/O, making it fully deterministic in tests. The `AllowAllPolicyGate` and `RejectAllPolicyGate` test doubles are provided in the same file.

### Provider — `ModelProvider` interface (`src/provider.ts`, `src/types.ts`)

**Responsible for:** Streaming text chunks given a user input and an `AbortSignal`.

**Not responsible for:** Policy, persistence, state transitions, or trace events.

**Interface:**
```ts
interface ModelProvider {
  stream(input: string, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}
```

The provider is an async generator abstraction. The runtime iterates it with `for await` and hands it an `AbortSignal`; when that signal fires, the provider is expected to stop yielding and return. `FakeProvider` is the deterministic test double used in all tests and the benchmark — it never calls a paid API.

### Orchestration — `ConversationRuntime` (`src/runtime.ts`)

**Responsible for:** Owning the run's state machine, coordinating all other components in the correct order, enforcing the timeout race, and assembling the final result.

**Not responsible for:** What "allowed" means (policy), how chunks are generated (provider), how records are stored (persistence), or how results are presented (HTTP layer).

The runtime's `execute()` method is the single entry point. It runs the policy gate, transitions the run through its states, races the provider stream against a timeout, and delegates every write to the store and every event to the trace.

### Persistence — `ConversationStore` (`src/persistence.ts`)

**Responsible for:** Storing and retrieving `ConversationRecord` values keyed by `runId`.

**Not responsible for:** State transitions, streaming logic, or trace events.

The store exposes three operations: `create()`, `update()`, and `get()` / `getAll()`. It enforces the persistence boundary rule: `assistantResponse` is only written when the status argument is `'completed'`. All other statuses leave that field absent.

The current implementation is **in-memory** (a `Map`). This is sufficient for the exercise and keeps tests self-contained. Replacing it with a durable store (e.g. a database transaction with optimistic locking) requires only implementing the same three-method contract.

### Presentation — `server.ts`

**Responsible for:** Translating HTTP requests into `runtime.execute()` calls and serialising results back to JSON.

**Not responsible for:** Any orchestration logic, policy decisions, or provider details.

Three endpoints are exposed:
- `POST /execute` — accepts `{ input, conversationId?, timeoutMs? }`, runs one turn, returns `ExecuteResult` as JSON. The `timeoutMs` field is a per-request override; when omitted, the server's configured default (10 000 ms) is used.
- `POST /cancel/:runId` — cancels an active run by calling `runtime.cancel(runId)`. Returns `{ found, cancelled }`.
- `GET /records` — returns all persisted `ConversationRecord` values for inspection.

The server holds no business logic. Every meaningful decision is made inside the runtime.

---

## 2. Persistence Boundary

The boundary is documented in `src/persistence.ts` (lines 8–14) and enforced by `ConversationStore.update()`.

### What is written and when

| Event | What is written | When |
|---|---|---|
| Run created | `runId`, `conversationId`, `userInput`, `status: 'pending'`, timestamps | Immediately on `execute()` entry, before policy evaluation |
| Policy check | `status` updated to `'rejected'` | If policy rejects; no `assistantResponse` |
| Provider started | `status` updated to `'running'` | After policy accepts, before streaming begins |
| Streaming completes | `status: 'completed'`, `assistantResponse` (full joined text) | Only when the stream finishes without interruption |
| Timeout fires | `status: 'timed_out'` | When the deadline is reached |
| Cancellation | `status: 'cancelled'` | When the abort signal fires and the stream stops |
| Provider error | `status: 'failed'` | When the provider throws during streaming |

### Partial streamed output

Partial chunks are held in the in-memory `run.chunks` array inside `ConversationRuntime` for the duration of the run. **They are not written to the persistent store.** On any non-success terminal state, the record's `assistantResponse` field is left absent. Partial chunks are still returned in the `ExecuteResult.chunks` array so callers can inspect the partial stream, but this is transient — it is not durable.

This is a deliberate choice: the store only ever reflects states the product can honestly represent. A timed-out or cancelled run never appears as a successful completed turn.

If a future requirement allowed users to resume from partial output after cancellation, the store schema would need a `partialResponse` field written on `'cancelled'` and `'timed_out'` transitions, and the runtime would need a new contract for resuming.

---

## 3. State Machine and Terminal-State Ownership

### States

```
pending   — run created, awaiting policy evaluation
running   — policy accepted, provider stream active
completed — stream finished successfully           [terminal]
rejected  — policy denied; provider never called  [terminal]
cancelled — stream aborted by caller signal        [terminal]
timed_out — deadline exceeded                      [terminal]
failed    — provider threw during streaming        [terminal]
```

### Allowed transitions

```
pending  ──► rejected   (policy gate fires before provider)
pending  ──► running    (policy accepted)
running  ──► completed
running  ──► cancelled
running  ──► timed_out
running  ──► failed
```

All other transitions — including any terminal → anything — are invalid. This is expressed in `VALID_TRANSITIONS` in `src/types.ts` and checked by `isValidTransition()`.

### How exactly one terminal outcome wins

The runtime uses a **sequential transition guard** implemented as a closure in `runtime.ts`:

```ts
const transitionTo = (next: RunStatus): boolean => {
  if (!isValidTransition(run.status, next)) return false;
  run.status = next;
  return true;
};
```

`transitionTo` reads and writes `run.status` in a single synchronous step. Because Node.js runs JavaScript on a single thread with cooperative scheduling (no preemption between synchronous operations), no two asynchronous continuations can interleave within this step. The practical consequence: when the `Promise.race` between `consumeStream` and the timeout settles, only one path proceeds to call `transitionTo`. The other path's subsequent call will find `run.status` already terminal and `isValidTransition` will return `false`, so it does nothing.

This is **not** a hardware-level compare-and-swap or a mutex. It is correct because JavaScript's event loop guarantees that the read–modify of `run.status` is never split across two concurrent microtasks. A multi-threaded runtime (worker threads sharing memory) would require an actual atomic operation; this implementation does not use worker threads.

---

## 4. Cancellation

### How cancellation is represented

Cancellation is represented via the Web API `AbortController` / `AbortSignal`. The runtime creates one `AbortController` per run at the start of `execute()`. The signal is passed directly to the provider's `stream()` method. When the signal fires, the provider stops yielding and the stream loop exits, producing a `'cancelled'` result.

### Flow

```
caller (HTTP or runtime)
     ↓
runtime.cancel(runId)
     ↓
activeRuns.get(runId)  →  AbortController
     ↓
controller.abort()
     ↓
signal.aborted === true
     ↓
FakeProvider.stream() checks signal before each chunk  ← provider.ts:59
     ↓
generator returns early
     ↓
consumeStream() returns 'cancelled'   ← runtime.ts:243, 251
     ↓
run transitions to 'cancelled'
```

For the delay-based fake provider, the abort signal is also wired into the `delay()` promise (via `signal.addEventListener('abort', …)`), so a chunk that is mid-sleep is interrupted immediately rather than after the full delay expires.

### Caller-facing cancellation API

The runtime exposes a `cancel(runId)` method that locates the active run's `AbortController` via an in-memory `Map<string, AbortController>` called `activeRuns`. This map is:

- **Populated** when `execute()` transitions a run to `'running'` (after policy acceptance).
- **Cleaned up** when the run reaches any terminal state (completed, cancelled, timed_out, failed).

The `cancel()` method returns a `CancelResult`:

```ts
interface CancelResult {
  found: boolean;     // Was a run with this runId known?
  cancelled: boolean; // Was the abort signal actually delivered?
}
```

| Scenario | found | cancelled |
|---|---|---|
| Unknown runId | false | false |
| Already terminal (completed, failed, rejected, timed_out) | true | false |
| Active (running) — abort delivered | true | true |

The HTTP endpoint `POST /cancel/:runId` calls `runtime.cancel(runId)` and returns:
- `200 { found: true, cancelled: true/false }` for known runs
- `404 { error: ..., found: false, cancelled: false }` for unknown runs

### How /execute and /cancel interact over HTTP

The server uses a **single shared `ConversationRuntime` instance** (not per-request instances). This means:

1. `POST /execute` calls `runtime.execute(...)` which registers the AbortController in `activeRuns`.
2. While execute is awaiting, `POST /cancel/:runId` can call `runtime.cancel(runId)` on the same runtime instance.
3. `cancel()` finds the controller, calls `abort()`, and the provider stops.
4. The `execute()` promise resolves with status `'cancelled'`.

Express handles requests concurrently on the event loop, so the cancel HTTP request is processed while the execute HTTP request is still awaiting its promise.

### What terminal state is produced

When the stream exits due to an aborted signal, `consumeStream` returns `'cancelled'`. If `transitionTo('cancelled')` succeeds, the run is marked `cancelled` and no `assistantResponse` is written.

If the timeout wins the `Promise.race` first, the runtime calls `abortController.abort()` and transitions to `'timed_out'` instead. The two paths are mutually exclusive because only one can win `transitionTo`.

If `cancel()` is called after the run is already terminal, the abort is a no-op — the `activeRuns` entry has already been cleaned up, so `cancel()` finds the record in the store but returns `{ found: true, cancelled: false }`.

---

## 5. Timeouts

### Configuration

`timeoutMs` lives in `RuntimeConfig` (`src/types.ts`), with a default of 30 000 ms. The server configures a 10 000 ms default. A per-request `timeoutMs` can be passed as the 5th argument to `runtime.execute()` (extracted from the `POST /execute` request body), which overrides the configured default for that single run.

### Implementation

The timeout is implemented as a `Promise.race` between the provider stream and a plain `setTimeout` promise:

```ts
const effectiveTimeoutMs = timeoutMs ?? this.config.timeoutMs;

const timeoutPromise = new Promise<'timed_out'>((resolve) => {
  timeoutHandle = setTimeout(() => resolve('timed_out'), effectiveTimeoutMs);
});

const streamOutcome = await Promise.race([
  this.consumeStream(run, provider, abortController.signal, trace),
  timeoutPromise,
]);
```

Whichever settles first wins. If `timeoutPromise` wins, the runtime:
1. Calls `abortController.abort()` to stop the provider from consuming further.
2. Transitions the run to `'timed_out'`.
3. Writes `timeout_triggered` and `run_timed_out` trace events.
4. Returns without an `assistantResponse`.

The `clearTimeout(timeoutHandle)` call after the race ensures the timer does not fire after a successful completion.

### How timeout behavior is tested deterministically

Tests use `FakeProvider` with a `chunkDelayMs` value that exceeds the runtime's `timeoutMs`. For example, a provider with `chunkDelayMs: 100` and a runtime with `timeoutMs: 50` will always time out before the first chunk is delivered. No arbitrary `sleep()` calls are needed in the tests — the relationship between the two values is deterministic.

The benchmark uses the same pattern: `chunkDelayMs: 50` with `timeoutMs: 10` guarantees a `timed_out` result on every iteration.

---

## 6. Operational Trace

### Purpose

The trace is an ordered log of everything that happened during a run. Its job is to let an operator or developer diagnose exactly what occurred — which state transitions fired, whether the provider was called, how many chunks arrived, and why the run ended — without needing to re-run anything or expose internal model state.

### Event types

Defined in `TraceEventKind` (`src/types.ts`):

| Kind | When emitted |
|---|---|
| `run_created` | Run object initialised |
| `policy_accepted` | Policy gate returned `allowed: true` |
| `policy_rejected` | Policy gate returned `allowed: false` |
| `provider_started` | About to begin iterating the stream |
| `chunk_received` | Each individual chunk yielded by the provider |
| `provider_completed` | Stream iterable exhausted normally |
| `provider_failed` | Provider threw an error |
| `cancellation_requested` | (Available; emitted when cancellation is explicitly requested) |
| `timeout_triggered` | Timeout deadline exceeded |
| `run_completed` | Run reached `completed` terminal state |
| `run_cancelled` | Run reached `cancelled` terminal state |
| `run_timed_out` | Run reached `timed_out` terminal state |
| `run_failed` | Run reached `failed` terminal state |
| `run_rejected` | Run reached `rejected` terminal state |

### Ordering and sequence numbers

`TraceBuilder` (`src/trace.ts`) maintains a monotonically increasing `seq` counter scoped to the run. Every call to `add()` stamps the current counter value and increments it. This means events can be replayed in emission order regardless of timestamp precision.

### What belongs in the trace

- State transitions and the reasons for them
- Provider activity (start, each chunk index, completion or error)
- Error type information (e.g. `ProviderError` vs unknown error)
- Timing context (ISO-8601 timestamps per event)

### What must not appear in the trace

- API keys, tokens, passwords, or any authentication credential
- Internal chain-of-thought or hidden model reasoning
- System prompts or other private instructions passed to the model
- Raw stack traces (the error *type* and *message* are recorded; the stack is not)

---

## 7. Secrets and Private Model Reasoning

### Sensitive fields and values

Two categories of sensitive information are excluded:

**By key name** — any object property whose key matches one of these is replaced with `"[REDACTED]"`:

```
apiKey, api_key, secret, token, authorization, password,
credential, privateKey, private_key,
chainOfThought, chain_of_thought,
hiddenReasoning, hidden_reasoning,
systemPrompt, system_prompt
```

**By value pattern** — any string value matching one of these patterns is replaced:

```
/^sk-[a-zA-Z0-9]{20,}$/          OpenAI-style API key
/^Bearer\s+\S+/i                  Authorization header value
/^[A-Za-z0-9+/]{40,}={0,2}$/     Long base64 blob
```

### How redaction is applied

The `redact()` function in `src/trace.ts` is recursive: it walks any object depth, checking both keys and string values. Arrays are mapped through `redact` element-by-element.

Redaction is applied inside `TraceBuilder.add()` at the point the event is created:

```ts
add(kind, message, meta) {
  const event = {
    ...
    ...(meta !== undefined ? { meta: redact(meta) as Record<string, unknown> } : {}),
  };
  this.events.push(event);
}
```

This means sensitive data never enters the trace at all — it is not stored and then filtered on read. The `message` string is written by the runtime itself and never contains user-supplied raw values.

### Why hidden model reasoning is excluded

The `chainOfThought`, `hidden_reasoning`, `systemPrompt`, and `system_prompt` keys are in `REDACTED_KEYS` because they represent model-internal deliberation that should not be observable through an operational log. A diagnostic trace should explain what the *runtime* did (which states were entered, whether the provider was called, how many chunks arrived), not reproduce the model's internal state.

The `FakeProvider` used in this implementation emits only chunk text, so there is no actual chain-of-thought in this codebase. The redaction rules are in place so that a live provider integration — which might include these fields in its event payloads — would have them stripped automatically without any call-site changes.

---

## 8. Web/Mobile Presentation Boundary

### The separation

```
Web client / Mobile client / CLI
           ↓
    Presentation layer
    (server.ts, or a CLI handler, or a mobile SDK bridge)
           ↓
    ConversationRuntime.execute()
    ├── PolicyGate
    ├── ModelProvider
    ├── ConversationStore
    └── TraceBuilder
           ↓
      ExecuteResult
      { runId, status, chunks, trace, assistantResponse? }
```

The runtime (`ConversationRuntime`) has no knowledge of HTTP, WebSocket, mobile transports, or any presentation detail. It takes a string input, a policy, a provider, an optional conversation ID, and an optional timeout override, and returns a plain `ExecuteResult` object. That object is a pure value — it contains no streams, no response objects, and no framework types.

### How a different client would use the same runtime

A mobile client, a CLI, or a WebSocket handler would:

1. Instantiate `ConversationStore`, `ConversationRuntime`, a `PolicyGate`, and a `ModelProvider` exactly as the HTTP server does.
2. Call `runtime.execute(input, policy, provider, conversationId, timeoutMs?)`.
3. Receive an `ExecuteResult` and render or transmit it in whatever way suits the client.

No business logic lives in `server.ts`. The HTTP layer's only job is request parsing, response serialisation, and wiring dependencies. Replacing it with a WebSocket handler or a mobile SDK bridge requires rewriting only that surface; the runtime, policy, provider, and persistence are unchanged.

### Streaming to a web or mobile client

The current HTTP endpoint waits for `execute()` to resolve fully before responding. To stream chunks to a browser or mobile client as they arrive, the runtime's `consumeStream` loop would need to emit chunks to the response incrementally — via Server-Sent Events or a WebSocket — rather than accumulating them in memory. The provider abstraction (`AsyncIterable<ProviderChunk>`) is already shaped for this: the runtime's inner loop can forward each chunk to the transport as it arrives, keeping the same policy, timeout, and terminal-state logic intact.

### Provider is also client-agnostic

`ModelProvider` is an interface. The same `FakeProvider` used in tests, a live Anthropic SDK provider, or a provider that wraps any other model API all implement the same contract. Swapping the provider does not require changing the runtime, persistence, policy, or presentation layers.

---

## Summary

The design's central goal is **state-machine correctness**: every run must reach exactly one terminal state, non-success outcomes must never be presented as successful turns, and every transition must be auditable.

To achieve this, all state-change logic is concentrated in one place (`ConversationRuntime.transitionTo()`), all writes to persistence flow through one method (`ConversationStore.update()`), and the trace is append-only and redacted at write time. The policy gate, provider, persistence, and presentation layers are each behind a clean interface so they can be replaced or extended without touching the others.

The most significant trade-offs made for this exercise:

- **In-memory persistence.** The store uses a `Map` rather than a database. This keeps tests fully self-contained and removes infrastructure dependencies, at the cost of durability. The boundary rules are designed so that swapping to a transactional database requires only re-implementing the three-method `ConversationStore` contract.
- **Caller-facing cancellation.** The runtime exposes `cancel(runId)` which locates the active `AbortController` via an in-memory map. The HTTP endpoint `POST /cancel/:runId` calls this method. Cancellation is idempotent — calling cancel on an already-terminal run returns `{ found: true, cancelled: false }` without modifying state.
- **Synchronous policy gate.** The `PolicyGate.evaluate()` method is synchronous and in-process. A production system that needs to call an external policy service would need to make the interface async, but the orchestration logic (fire before provider, reject immediately if denied) would remain identical.
