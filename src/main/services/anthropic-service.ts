/**
 * LLM Service — Central wrapper for all GLM-5.1 API calls via OpenAI-compatible endpoint.
 *
 * Three responsibilities:
 * 1. WRAP — Thin wrapper around openai.chat.completions.create()
 * 2. RETRY — Exponential backoff on transient errors (non-blocking async setTimeout)
 * 3. RECORD — Every call logged to llm_calls table for cost tracking
 *
 * REDACTION: Never records email body/subject. Only IDs and metadata.
 *
 * The file retains its original name (anthropic-service.ts) to minimize import churn
 * across the codebase. All callers import from this path.
 */
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { createLogger } from "./logger";
import { randomUUID } from "crypto";

const log = createLogger("llm");

const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

// Approximate pricing per million tokens for GLM-5.1.
// TODO: Update when Z.AI publishes official pricing.
const PRICING: Record<
  string,
  { input: number; output: number }
> = {
  "glm-5.1": { input: 3.0, output: 15.0 },
};

const DEFAULT_PRICING = { input: 3.0, output: 15.0 };

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30000 },
  server_error: { maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 30000 },
  connection: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
};

export interface LlmCallRecord {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  email_id: string | null;
  account_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

export interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

export interface CreateOptions {
  /** Which service is making this call, for cost attribution */
  caller: string;
  /** Optional email ID for tracing */
  emailId?: string;
  /** Optional account ID for attribution */
  accountId?: string;
  /** Timeout in milliseconds (default: none) */
  timeoutMs?: number;
}

// OpenAI client — singleton for production, replaceable for testing
let _client: OpenAI | null = null;
let _defaultClient: OpenAI | null = null;

/**
 * Replace the LLM client for testing. Pass null to reset.
 * The mock must have a `chat.completions.create()` method matching the SDK.
 */
export function _setClientForTesting(client: unknown): void {
  _client = client as OpenAI;
}

/**
 * Reset the cached default client, forcing a fresh OpenAI() on next call.
 * Call this when the API key changes (e.g. via Settings).
 */
export function resetClient(): void {
  _defaultClient = null;
}

export function getClient(): OpenAI {
  if (_client) return _client;
  if (!_defaultClient) {
    _defaultClient = new OpenAI({
      apiKey: process.env.ZAI_API_KEY,
      baseURL: ZAI_BASE_URL,
    });
  }
  return _defaultClient;
}

// Database handle — set via setDatabase() during app init
type DatabaseInstance = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
};

let _db: DatabaseInstance | null = null;
let _insertStmt: ReturnType<DatabaseInstance["prepare"]> | null = null;

/**
 * Set the database handle for recording LLM calls.
 * Must be called after initDatabase() during app startup.
 */
export function setAnthropicServiceDb(db: DatabaseInstance): void {
  _db = db;
  // Ensure llm_calls table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      caller TEXT NOT NULL,
      email_id TEXT,
      account_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_cents REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
  `);
  _insertStmt = db.prepare(`
    INSERT INTO llm_calls (id, model, caller, email_id, account_id,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      cost_cents, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING[model] || DEFAULT_PRICING;
  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  return (inputCost + outputCost) * 100;
}

function recordCall(
  model: string,
  caller: string,
  emailId: string | null,
  accountId: string | null,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
  success: boolean,
  errorMessage: string | null,
): void {
  if (!_insertStmt) {
    log.warn("LLM Service: database not initialized, skipping call recording");
    return;
  }

  const costCents = calculateCostCents(model, inputTokens, outputTokens);

  try {
    _insertStmt.run(
      randomUUID(),
      model,
      caller,
      emailId,
      accountId,
      inputTokens,
      outputTokens,
      0, // cache_read_tokens — GLM doesn't have prompt caching
      0, // cache_create_tokens
      costCents,
      durationMs,
      success ? 1 : 0,
      errorMessage,
    );
  } catch (err) {
    // Recording failure must never break the LLM call
    log.error({ err }, "Failed to record LLM call to database");
  }
}

/**
 * Record a streaming call's cost after it completes.
 * Use this for calls that bypass createMessage() (e.g., streaming).
 */
export function recordStreamingCall(
  model: string,
  caller: string,
  usage: Record<string, number>,
  durationMs: number,
  options?: { emailId?: string; accountId?: string },
): void {
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  recordCall(
    model,
    caller,
    options?.emailId || null,
    options?.accountId || null,
    inputTokens,
    outputTokens,
    durationMs,
    true,
    null,
  );
}

function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryCategory(error: unknown): string | null {
  if (error instanceof OpenAI.RateLimitError) return "rate_limit";
  if (error instanceof OpenAI.InternalServerError) return "server_error";
  if (error instanceof OpenAI.APIConnectionError) return "connection";
  if (error instanceof OpenAI.APIError && (error as { status?: number }).status === 529) {
    return "server_error";
  }
  return null;
}

/**
 * Create a chat completion using GLM-5.1 API with retry and cost tracking.
 *
 * This is the central entry point for all LLM calls. All callers pass
 * OpenAI-compatible ChatCompletionCreateParams.
 */
export async function createMessage(
  params: ChatCompletionCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<ChatCompletion> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();

  const client = getClient();
  let lastError: unknown = null;
  let totalAttempts = 0;

  const maxPossibleRetries = Math.max(...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries));

  for (let attempt = 0; attempt <= maxPossibleRetries; attempt++) {
    totalAttempts = attempt + 1;

    let abortController: AbortController | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      abortController = new AbortController();
      timeoutHandle = setTimeout(() => abortController!.abort(), timeoutMs);
    }

    try {
      const response = await client.chat.completions.create(params, {
        signal: abortController?.signal,
      });

      // Success — record and return
      const usage = response.usage;
      const inputTokens = usage?.prompt_tokens || 0;
      const outputTokens = usage?.completion_tokens || 0;

      recordCall(
        model,
        caller,
        emailId || null,
        accountId || null,
        inputTokens,
        outputTokens,
        Date.now() - startTime,
        true,
        null,
      );

      if (totalAttempts > 1) {
        log.info({ caller, model, attempts: totalAttempts }, "LLM call succeeded after retries");
      }

      return response;
    } catch (error) {
      lastError = error;
      const category = getRetryCategory(error);

      if (!category) break;

      const config = RETRY_CONFIGS[category];
      if (attempt >= config.maxRetries) break;

      const baseDelay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
      const jitter = baseDelay * 0.1 * Math.random();
      const delay = baseDelay + jitter;

      log.warn(
        {
          caller,
          model,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          category,
          delayMs: Math.round(delay),
        },
        "LLM call failed, retrying",
      );

      await asyncSleep(delay);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // All retries exhausted — record failure and throw
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  recordCall(
    model,
    caller,
    emailId || null,
    accountId || null,
    0,
    0,
    Date.now() - startTime,
    false,
    errMsg,
  );

  throw lastError;
}

/**
 * Get usage statistics for cost visibility.
 */
export function getUsageStats(): UsageStats {
  if (!_db) {
    return {
      today: { totalCostCents: 0, totalCalls: 0 },
      thisWeek: { totalCostCents: 0, totalCalls: 0 },
      thisMonth: { totalCostCents: 0, totalCalls: 0 },
      byModel: [],
      byCaller: [],
    };
  }

  const today = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE date(created_at) = date('now')",
    )
    .get() as { cost: number; calls: number };

  const thisWeek = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-7 days')",
    )
    .get() as { cost: number; calls: number };

  const thisMonth = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days')",
    )
    .get() as { cost: number; calls: number };

  const byModel = _db
    .prepare(
      "SELECT model, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY model ORDER BY costCents DESC",
    )
    .all() as Array<{ model: string; costCents: number; calls: number }>;

  const byCaller = _db
    .prepare(
      "SELECT caller, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY caller ORDER BY costCents DESC",
    )
    .all() as Array<{ caller: string; costCents: number; calls: number }>;

  return {
    today: { totalCostCents: today.cost, totalCalls: today.calls },
    thisWeek: { totalCostCents: thisWeek.cost, totalCalls: thisWeek.calls },
    thisMonth: { totalCostCents: thisMonth.cost, totalCalls: thisMonth.calls },
    byModel,
    byCaller,
  };
}

/**
 * Get recent call history for debugging.
 */
export function getCallHistory(limit: number = 50): LlmCallRecord[] {
  if (!_db) return [];

  return _db
    .prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LlmCallRecord[];
}
