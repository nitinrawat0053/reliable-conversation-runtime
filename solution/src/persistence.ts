/**
 * Persistence layer — conversation record store.
 *
 * In this prototype the store is in-memory, which is sufficient for the
 * exercise and keeps tests fully self-contained. A production system would
 * replace this with a database transaction + optimistic locking.
 *
 * Persistence boundary (documented per spec requirement):
 *  - User input is written immediately when the run is created (pending state).
 *  - Partial chunks are held in the Run working state but NOT persisted as a
 *    completed assistant response until the run reaches 'completed'.
 *  - On any non-success terminal state (cancelled, timed_out, failed, rejected)
 *    the record is updated with that status and no assistantResponse is set.
 *  - This means a timed-out or cancelled run never appears as a successful turn.
 */

import type { ConversationRecord, RunStatus } from './types.js';

export class ConversationStore {
  private readonly records = new Map<string, ConversationRecord>();

  create(
    runId: string,
    conversationId: string,
    userInput: string,
  ): ConversationRecord {
    const now = new Date().toISOString();
    const record: ConversationRecord = {
      runId,
      conversationId,
      userInput,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(runId, record);
    return record;
  }

  /**
   * Transition a record to a new status.
   * On 'completed', the assembled assistantResponse is also persisted.
   * On all other terminal states, assistantResponse is left absent.
   */
  update(
    runId: string,
    status: RunStatus,
    assistantResponse?: string,
  ): ConversationRecord {
    const record = this.records.get(runId);
    if (!record) {
      throw new Error(`No record found for runId: ${runId}`);
    }
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (status === 'completed' && assistantResponse !== undefined) {
      record.assistantResponse = assistantResponse;
    }
    return record;
  }

  get(runId: string): ConversationRecord | undefined {
    return this.records.get(runId);
  }

  getAll(): ConversationRecord[] {
    return Array.from(this.records.values());
  }

  /** Wipe all records — used between benchmark iterations. */
  clear(): void {
    this.records.clear();
  }
}
