/**
 * Express server — thin HTTP wrapper around the runtime.
 *
 * Endpoints:
 *  POST /execute — execute a single turn
 *    Body: { input: string, conversationId?: string, timeoutMs?: number }
 *    Response: ExecuteResult
 *
 *  POST /cancel/:runId — cancel an active run
 *    Response: { found: boolean, cancelled: boolean }
 *
 *  GET /records — list all persisted records (for verification)
 *    Response: ConversationRecord[]
 */

import express, { Request, Response } from 'express';
import { pathToFileURL } from 'node:url';
import { ConversationRuntime } from './runtime.js';
import { ConversationStore } from './persistence.js';
import { FakeProvider } from './provider.js';
import { KeywordPolicyGate } from './policy.js';
import type { ExecuteResult, ModelProvider } from './types.js';

export interface AppOptions {
  /** Override the default provider factory (used by tests to inject slow providers). */
  providerFactory?: () => ModelProvider;
}

export function createApp(opts: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  const store = new ConversationStore();
  const runtime = new ConversationRuntime(store, { timeoutMs: 10_000 });
  const policy = new KeywordPolicyGate();
  const providerFactory = opts.providerFactory ?? (() => new FakeProvider({ mode: 'success', chunkCount: 5 }));
  // const providerFactory = opts.providerFactory ?? (() => new FakeProvider({ mode: 'success', chunkCount: 600, chunkDelayMs: 30 }));

  // ---------------------------------------------------------------------------
  // POST /execute
  // ---------------------------------------------------------------------------

  app.post('/execute', async (req: Request, res: Response) => {
    try {
      const { input, conversationId, timeoutMs } = req.body;

      if (!input || typeof input !== 'string') {
        return res.status(400).json({ error: 'input is required and must be a string' });
      }

      const provider = providerFactory();

      const result = await runtime.execute(
        input,
        policy,
        provider,
        conversationId,
        typeof timeoutMs === 'number' ? timeoutMs : undefined,
      );

      return res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /cancel/:runId
  // ---------------------------------------------------------------------------

  app.post('/cancel/:runId', (req: Request, res: Response) => {
    try {
      const { runId } = req.params;

      if (!runId || typeof runId !== 'string') {
        return res.status(400).json({ error: 'runId is required' });
      }

      const result = runtime.cancel(runId);

      if (!result.found) {
        return res.status(404).json({ error: `No run found for runId: ${runId}`, ...result });
      }

      return res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /records
  // ---------------------------------------------------------------------------

  app.get('/records', (_req: Request, res: Response) => {
    const records = store.getAll();
    return res.json(records);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Server startup (only when run directly, not when imported by tests)
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const PORT = process.env.PORT ?? 3000;

  app.listen(PORT, () => {
    console.log(`Reliable Conversation Runtime listening on port ${PORT}`);
    console.log(`POST /execute - Execute a conversational turn`);
    console.log(`POST /cancel/:runId - Cancel an active run`);
    console.log(`GET /records - List all conversation records`);
  });
}
