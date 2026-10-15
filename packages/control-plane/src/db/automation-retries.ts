import type { SqlDatabase } from "./sql-database";
import type { AutomationRunRow } from "./automation-store";
import { z } from "zod";

/** First retry waits beyond the observed database stalls; subsequent retries back off. */
export const AUTOMATION_RETRY_DELAY_MS = 2 * 60 * 1000;

export const automationRetryContextSchema = z.object({
  instructions: z.string(),
  platformUserId: z.string(),
  participantUserId: z.string(),
});

/** Queue only failures known to have stopped, preserving the original attempt's result. */
export async function scheduleInvocationRetries(
  db: SqlDatabase,
  invocationId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_runs SET status = 'retrying',
       retry_at = completed_at + ? * (1 << (attempt - 1))
     WHERE invocation_id = ? AND status = 'failed' AND superseded_at IS NULL
       AND (retryable = 1 OR session_id IS NULL)
       AND completed_at IS NOT NULL
       AND COALESCE(failure_reason, '') NOT LIKE '%cancel%'
       AND EXISTS (SELECT 1 FROM automations a JOIN automation_invocations i
         ON i.automation_id = a.id WHERE i.id = automation_runs.invocation_id
         AND i.retry_context IS NOT NULL AND i.failure_counted_at IS NULL
         AND a.enabled = 1 AND a.deleted_at IS NULL AND automation_runs.attempt <= a.max_retries)`
    )
    .bind(AUTOMATION_RETRY_DELAY_MS, invocationId)
    .run();
}

/** Clear pending retries when policy or explicit session cancellation withdraws permission. */
export async function getDueRetries(
  db: SqlDatabase,
  now: number,
  limit: number
): Promise<AutomationRunRow[]> {
  await db
    .prepare(
      `UPDATE automation_runs SET status = 'failed', retry_at = NULL, retryable = 0
     WHERE status = 'retrying' AND (
       NOT EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id
         AND a.enabled = 1 AND a.deleted_at IS NULL AND automation_runs.attempt <= a.max_retries)
       OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = automation_runs.session_id AND s.status = 'cancelled'))`
    )
    .run();
  const result = await db
    .prepare(
      `SELECT * FROM automation_runs WHERE status = 'retrying' AND retry_at <= ?
     ORDER BY retry_at, id LIMIT ?`
    )
    .bind(now, limit)
    .all<AutomationRunRow>();
  return result.results ?? [];
}

/**
 * Transfer ownership to a fresh attempt atomically. A second tick cannot insert a child
 * after losing the CAS: the old row records the winning new run ID as its receipt.
 */
export async function claimRetry(
  db: SqlDatabase,
  previousRunId: string,
  newRunId: string,
  now: number
): Promise<AutomationRunRow | null> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE automation_runs SET status = 'failed', retry_at = NULL,
         superseded_at = ?, retry_run_id = ?
       WHERE id = ? AND status = 'retrying' AND retry_at <= ? AND superseded_at IS NULL
         AND EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id
           AND a.enabled = 1 AND a.deleted_at IS NULL AND automation_runs.attempt <= a.max_retries)
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = automation_runs.session_id AND s.status = 'cancelled')`
      )
      .bind(now, newRunId, previousRunId, now),
    db
      .prepare(
        `INSERT INTO automation_runs
       (id, automation_id, invocation_id, status, scheduled_at, created_at,
        repo_owner, repo_name, repo_id, base_branch, environment_id, attempt)
       SELECT ?, automation_id, invocation_id, 'starting', scheduled_at, ?,
         repo_owner, repo_name, repo_id, base_branch, environment_id, attempt + 1
       FROM automation_runs WHERE id = ? AND retry_run_id = ?`
      )
      .bind(newRunId, now, previousRunId, newRunId),
  ]);
  if (!results[0]?.meta.changes) return null;
  return db
    .prepare("SELECT * FROM automation_runs WHERE id = ?")
    .bind(newRunId)
    .first<AutomationRunRow>();
}
