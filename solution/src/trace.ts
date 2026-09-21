/**
 * Trace — ordered operational event log.
 *
 * Every event gets a monotonically increasing sequence number scoped to its run.
 * Secrets and hidden model reasoning are excluded at write time.
 *
 * Redaction rules:
 *  - Keys matching REDACTED_KEYS are replaced with "[REDACTED]".
 *  - Values matching SECRET_PATTERNS are replaced with "[REDACTED]".
 *  - The function is applied recursively to nested objects.
 */

import type { TraceEvent, TraceEventKind } from './types.js';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED_KEYS = new Set([
  'apiKey', 'api_key', 'secret', 'token', 'authorization', 'password',
  'credential', 'privateKey', 'private_key', 'chainOfThought', 'chain_of_thought',
  'hiddenReasoning', 'hidden_reasoning', 'systemPrompt', 'system_prompt',
]);

const SECRET_PATTERNS: RegExp[] = [
  /^sk-[a-zA-Z0-9]{20,}$/,          // OpenAI-style key
  /^Bearer\s+\S+/i,                  // Authorization header value
  /^[A-Za-z0-9+/]{40,}={0,2}$/,     // Long base64 blobs
];

function isSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return SECRET_PATTERNS.some((p) => p.test(value));
}

export function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return isSecretValue(obj) ? '[REDACTED]' : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(redact);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redact(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Trace builder
// ---------------------------------------------------------------------------

export class TraceBuilder {
  private seq = 0;
  private readonly events: TraceEvent[] = [];

  add(
    kind: TraceEventKind,
    message: string,
    meta?: Record<string, unknown>,
  ): TraceEvent {
    const event: TraceEvent = {
      seq: this.seq++,
      kind,
      ts: new Date().toISOString(),
      message,
      ...(meta !== undefined ? { meta: redact(meta) as Record<string, unknown> } : {}),
    };
    this.events.push(event);
    return event;
  }

  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  /** Returns true if any event with the given kind exists after a terminal event. */
  hasEventsAfterTerminal(): boolean {
    const terminalKinds = new Set<TraceEventKind>([
      'run_completed', 'run_cancelled', 'run_timed_out', 'run_failed', 'run_rejected',
    ]);
    let seenTerminal = false;
    for (const e of this.events) {
      if (seenTerminal) return true;
      if (terminalKinds.has(e.kind)) seenTerminal = true;
    }
    return false;
  }
}
