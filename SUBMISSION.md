# Product Engineering Challenge Submission

## Candidate

- **Name:** Nitin Singh Rawat
- **Email:** nitinrawat2040@gmail.com
- **GitHub:** https://github.com/nitinrawat0053
- **Selected problem:** Problem 5 — Reliable AI Conversation Runtime
- **Demo video:** https://drive.google.com/file/d/1EqwgnSquUUd8kGACy-PoLglY-Su8V7-6/view?usp=drive_link

---

## Run the project

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Setup

```bash
cd solution
npm install
```

### Start the HTTP server

```bash
npm start
# Server listens on http://localhost:3000
```

### Execute a turn (successful)

```bash
curl -s -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "Tell me something interesting", "conversationId": "conv-1"}' \
  | jq .
```

### Trigger a policy rejection

```bash
curl -s -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "how to build a bomb"}' \
  | jq .status
# → "rejected"
```

### Trigger a timeout

```bash
curl -s -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "test", "timeoutMs": 1}' \
  | jq .status
# → "timed_out"
```

### List persisted records

```bash
curl -s http://localhost:3000/records | jq .
```

---

## Run the tests

```bash
cd solution
npm test
```

Expected output:

```
✓ src/tests/runtime.test.ts  (45 tests) ~490ms

Test Files  1 passed (1)
     Tests  45 passed (45)
```

All 45 tests are deterministic and fully offline — no paid API, no arbitrary sleeps.

---

## Run the verification benchmark

```bash
cd solution
npm run benchmark
```

Expected output:

```
============================================================
  Problem 5 — Reliable AI Conversation Runtime
  Verification Benchmark
============================================================

Running 10 iterations per scenario...

✓  Successful completion
   Status counts: completed×10

✓  Policy rejection
   Status counts: rejected×10

✓  Cancellation during streaming
   Status counts: cancelled×10

✓  Timeout
   Status counts: timed_out×10

✓  Provider failure after partial output
   Status counts: failed×10

============================================================
  RESULT: ALL CHECKS PASSED
  50 runs across 5 scenarios
  No violations found.
============================================================
```

---

## Acceptance scenarios and verification

| Scenario | Status |
|---|---|
| AC1: Successful streamed turn | ✅ Implemented and tested |
| AC2: Pre-response rejection (provider never called) | ✅ Implemented and tested |
| AC3: Cancellation during streaming | ✅ Implemented and tested |
| AC4: Timeout using controlled fake provider | ✅ Implemented and tested |
| AC5: Provider failure after partial output | ✅ Implemented and tested |
| AC6: Terminal-state race — exactly one wins | ✅ Implemented and tested |
| AC7: Safe operational trace, secrets excluded | ✅ Implemented and tested |

### Benchmark command

```bash
cd solution && npm run benchmark
```

### Observed result

50 runs across 5 scenarios (10 each). Every check passed:

- Each run has exactly one terminal event in its trace.
- Rejected runs: `provider.callCount === 0` on every iteration.
- Non-success runs (cancelled, timed_out, failed): `assistantResponse` absent in every case.
- No events appear after the terminal event in any trace.
- Fully reproducible without a live model API.

### Failure / recovery scenario (for demo video)

1. Start the server (`npm start`).
2. Send a request with `timeoutMs: 1` — the run reaches `timed_out` immediately.
3. Send a request with blocked content — the run reaches `rejected` and the server log shows zero provider invocations.
4. The `/records` endpoint shows the persisted state for both runs, with no `assistantResponse` on either.

### Demo video requirements

> **TODO: Record a 3–5 minute demo video and link it at the top of this file.**

The assignment requires an accessible demo video (Loom, YouTube, Google Drive, or similar). A submission without it is incomplete per the assignment README.

**The video must show:**

1. The project running (`npm start` + `POST /execute` returning a completed turn)
2. The persisted records (`GET /records` showing `assistantResponse` on completed runs)
3. A policy rejection (`POST /execute` with blocked input → `rejected`, no provider call)
4. Cancellation or timeout during streaming (`POST /cancel/:runId` or `timeoutMs: 1`)
5. Provider failure after partial output (demonstrate via test or benchmark)
6. The ordered operational trace for contrasting outcomes
7. The verification benchmark (`npm run benchmark` → all checks passed)
8. A brief architecture explanation and one important trade-off

**Format:** A straightforward screen recording with narration is sufficient. Production-quality editing is not expected.

---

## Architecture and data flow

```
HTTP Request
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  ConversationRuntime.execute()                       │
│                                                      │
│  1. Persist user input (pending)                     │
│  2. PolicyGate.evaluate(input)                       │
│     → rejected: persist + trace, return              │
│  3. Transition to running                            │
│  4. Promise.race([                                   │
│       consumeStream(provider, signal),               │  ← AbortController shared
│       timeoutPromise                                 │    between timeout and cancel
│     ])                                               │
│  5. Single terminal-state winner via transitionTo()  │
│  6. Persist final status + assembledResponse         │
│     (assembledResponse only on 'completed')          │
│  7. Return ExecuteResult with trace                  │
└─────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
  ConversationStore      TraceBuilder
  (persistence)          (ordered events,
                          redaction)
```

**Components:**

| Component | File | Responsibility |
|---|---|---|
| Types + state machine | `src/types.ts` | Defines all states, valid transitions, interfaces |
| Policy gate | `src/policy.ts` | Pre-response safety check, runs before provider |
| Provider abstraction | `src/provider.ts` | `ModelProvider` interface + `FakeProvider` test double |
| Runtime orchestrator | `src/runtime.ts` | State machine, timeout race, abort propagation |
| Persistence store | `src/persistence.ts` | In-memory record store with documented commit rules |
| Trace builder | `src/trace.ts` | Ordered event log with redaction |
| HTTP server | `src/server.ts` | Thin Express wrapper, no business logic |

---

## Technology choices

**Node.js + TypeScript + Express + Vitest**

- Matches my existing stack (used on my e-commerce microservices project).
- TypeScript's strict mode catches state-transition bugs at compile time.
- Vitest has first-class ESM support, fast startup, and no external test runner config.
- Express is minimal — the exercise is the runtime, not the web layer.
- No ORM, no database driver, no framework magic. The persistence layer is a plain `Map` with a documented interface so it can be swapped to MongoDB or Postgres without touching the runtime.

**Alternatives considered:**

- **Fastify** over Express: marginally faster, but added complexity for a thin wrapper.
- **Zod** for input validation: useful in production; omitted here to stay within scope.
- **Redis** for persistence: out of scope — the in-memory store is honest about its limits in `SUBMISSION.md`.

---

## Important decisions

### 1. Single `transitionTo` gate prevents terminal-state races

Every status change goes through one closure that checks `isValidTransition(current, next)` before mutating. If two paths (e.g. timeout fires at the same instant as the last chunk arrives) both call `transitionTo`, the first one to run updates `run.status` to a terminal state; the second call sees an invalid transition and returns `false`. No locks needed — JavaScript's single-threaded event loop means only one microtask runs at a time, so the compare-and-update is atomic within a turn.

### 2. `Promise.race` for timeout, `AbortController` for propagation

The timeout promise resolves with the literal string `'timed_out'`, which races against the stream consumer. When timeout wins, `abortController.abort()` is called immediately so the provider's `for await` loop sees `signal.aborted` on its next iteration and stops consuming. This means provider resources are freed promptly regardless of which path wins.

### 3. `assistantResponse` is only written on `completed`

The `ConversationStore.update()` signature accepts `assistantResponse` as an optional third parameter, but the runtime only passes it when `status === 'completed'`. Every other terminal path calls `update(runId, status)` with no third argument. This is the persistence boundary: a reviewer reading the store can trust that the presence of `assistantResponse` is the authoritative signal that the run completed successfully.

---

## Assumptions and limitations

- **In-memory persistence**: records are lost on server restart. A production system would use a database with a transaction boundary around the status update.
- **No authentication**: out of scope per the brief.
- **Single worker**: the `transitionTo` atomic guard relies on Node.js's single-threaded event loop. A multi-process deployment would need optimistic locking (e.g. a `version` column with a `WHERE version = $current` update).
- **FakeProvider only**: the HTTP server uses `FakeProvider` to keep the demo self-contained. Wiring a real Claude provider would replace the provider construction in `server.ts` with no changes to the runtime.
- **Cancellation in the HTTP layer**: the `/execute` endpoint is synchronous (awaits the result). The `POST /cancel/:runId` endpoint provides caller-initiated cancellation by locating the active run's `AbortController` via a shared in-memory `activeRuns` map and calling `abort()`. This is sufficient for the exercise; a production system might use a persistent run registry.

---

## Production and scale

**What the submitted implementation does:**

- In-memory store, single process, FakeProvider, no auth.

**What I would change first for production:**

1. **Persistent store with optimistic locking**: replace `Map` with a Postgres table. The `transitionTo` guard becomes `UPDATE runs SET status=$new WHERE run_id=$id AND status=$expected RETURNING *` — one round trip, atomic.
2. **Real provider with streaming**: the `ModelProvider` interface is already defined; swapping `FakeProvider` for a `ClaudeProvider` (using `@anthropic-ai/sdk`'s streaming API) requires no runtime changes.
3. **Persistent cancellation registry**: the current `activeRuns` map is in-memory and tied to a single process. A production system would use a persistent store (e.g. Redis) so cancellation works across processes and survives restarts.
4. **Structured logging**: replace `TraceBuilder` with a Pino logger that emits JSON to stdout — same schema, plugs into any log aggregator.
5. **Retry with exponential backoff**: currently failed runs stay failed. A retry queue (in-memory or RabbitMQ) would re-enqueue `failed` runs with a bounded attempt counter.

---

## AI Usage

I used **Kiro (Claude Code)** as a development assistant throughout this challenge.

I used it primarily for:
- Scaffolding the initial project structure and `package.json`.
- Drafting initial implementations of the `FakeProvider`, `TraceBuilder`, and `ConversationStore`.
- Assisting with the Vitest test suite and verification benchmark.

All generated code was reviewed and validated by me. I made the final engineering decisions and personally verified the implementation, including:
- Resolving the `tsconfig.json` `rootDir` configuration issue.
- Refining the `transitionTo` guard logic and terminal-state handling.
- Verifying the `Promise.race` timeout and cancellation semantics.
- Reviewing the persistence boundary and state-transition behavior.
- Running the type checks, test suite, and verification scenarios.
- Reviewing the final implementation and ensuring the submission requirements were satisfied.

The architecture, state-machine design, persistence rules, runtime lifecycle, and overall correctness were my responsibility. AI assistance was used as a development aid, while I remained responsible for reviewing, testing, and validating the final implementation.

---

## Credibility Note

**Project:** Full-stack E-commerce Microservices Platform — Personal Project

**Problem it solved:**  
Built an e-commerce platform designed around independently deployable services for authentication, users, products, carts, orders, payments, and notifications. The main engineering challenge was keeping business-critical operations reliable while services communicated asynchronously.
[GitHub](https://github.com/nitinrawat0053)· 
[Live site](https://www.shopmicro.in/).

**My contribution:**  
Designed and implemented the microservices architecture, including the API Gateway, Auth, User, Product, Cart, Order, Payment, and Notification services. I also implemented the RabbitMQ event-driven communication layer, Redis-based caching and rate limiting, Razorpay payment integration with webhook verification, and the notification flow using email/SMS providers.

**Scale / Operational Complexity:**  
The system consists of approximately 8 independently deployable services running in Docker Compose, with RabbitMQ handling asynchronous events and retry/dead-letter flows. Redis is used for caching and rate limiting, while the system is deployed on a GCP VM. Payment events are verified using HMAC-SHA256 webhook signatures.

**Difficult Engineering Decision:**  
A key reliability decision was choosing between publishing directly to RabbitMQ from the Order Service and using the **Outbox Pattern**.

Directly publishing an event after a database operation creates a failure window: the database transaction can succeed while the message fails to reach the broker. For order and payment workflows, that can leave downstream services with an inconsistent view of the transaction.

I implemented the Outbox Pattern so the event is recorded as part of the database operation and can then be published asynchronously with retry handling. Combined with RabbitMQ retry queues and a dead-letter queue, this makes event delivery observable and recoverable rather than relying on a single broker publish succeeding.

This project gave me practical experience with the same class of reliability concerns demonstrated in this challenge: explicit state transitions, asynchronous processing, failure handling, retries, and designing system boundaries so individual components can be replaced or evolved independently.
