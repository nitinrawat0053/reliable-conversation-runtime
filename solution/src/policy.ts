/**
 * Policy gate — pre-response safety check.
 *
 * The policy gate runs BEFORE the provider is ever invoked.
 * A rejected policy result must leave no provider call and no successful
 * assistant response in persistence.
 *
 * The default keyword-based policy is deterministic and requires no external
 * service, making tests fully offline.
 */

import type { PolicyGate, PolicyResult } from './types.js';

// ---------------------------------------------------------------------------
// Default keyword policy
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: RegExp[] = [
  /\b(bomb|weapon|exploit|malware|hack)\b/i,
  /\b(hate|violence|abuse)\b/i,
];

export class KeywordPolicyGate implements PolicyGate {
  private readonly blockedPatterns: RegExp[];

  constructor(blockedPatterns: RegExp[] = BLOCKED_PATTERNS) {
    this.blockedPatterns = blockedPatterns;
  }

  evaluate(input: string): PolicyResult {
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(input)) {
        return {
          allowed: false,
          reason: `Input blocked by policy: matches "${pattern.source}"`,
        };
      }
    }
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Always-allow policy (useful in tests to isolate other behaviour)
// ---------------------------------------------------------------------------

export class AllowAllPolicyGate implements PolicyGate {
  evaluate(_input: string): PolicyResult {
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Always-reject policy (useful in tests for AC2)
// ---------------------------------------------------------------------------

export class RejectAllPolicyGate implements PolicyGate {
  constructor(private readonly reason = 'Rejected by test policy') {}

  evaluate(_input: string): PolicyResult {
    return { allowed: false, reason: this.reason };
  }
}
