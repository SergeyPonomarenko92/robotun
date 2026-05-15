/**
 * Scheduled jobs for state-machine self-completion.
 *
 * Mirrors the notifications worker pattern — setInterval in main process,
 * single-active per tick via FOR UPDATE SKIP LOCKED, idempotent UPDATE
 * statements that emit outbox events for downstream consumers.
 *
 * Jobs:
 *  - dealAutoComplete       in_review + auto_complete_after passed → completed
 *  - dealPendingExpiry      pending + created_at + 72h → cancelled (expired_pending)
 *  - disputeEscalation      dispute_resolve_by passed + count=0 → +7d, count++
 *  - disputeAutoRefund      dispute_resolve_by passed + count>=1 → cancelled (refund)
 *  - kycExpiredSweep        approved + expires_at passed → expired (payout off)
 *  - kycStaleClaim          in_review + review_started_at + 4h → unclaim (submitted)
 *  - outboxRetention        processed + 7d → DELETE
 *  - listingDraftExpiry     listing_drafts updated_at + 30d → DELETE
 *  - mediaScanRetry         awaiting_scan rows >2min → re-run scanMediaObject
 *  - mediaVariantsBackfill  ready image rows missing @2x → regenerate
 *  - emailDrain             notifications channel='email' pending → SMTP
 *  - pushDrain              notifications channel='push' pending → VAPID
 *  - sessionsPurge          expired/revoked sessions older than retention
 */
import { sql } from "../db/client.js";
import { scanRetrySweep, regenerateMissingVariants } from "./media.service.js";
import { drainEmailQueue } from "./notifications.service.js";
import { drainPushQueue } from "./push.service.js";

/* ----------------------------- helpers ---------------------------------- */

async function exec(label: string, sqlText: string): Promise<number> {
  try {
    const r = await sql.unsafe(sqlText);
    return r.count ?? 0;
  } catch (e) {
    const msg = (e as Error).message;
    // eslint-disable-next-line no-console
    console.error(`[cron] ${label} failed:`, msg);
    return 0;
  }
}

/* --------------------------- deal lifecycle ----------------------------- */

export async function dealAutoComplete(): Promise<number> {
  // FOR UPDATE SKIP LOCKED + WITH cte → safe to run on multiple replicas.
  return exec(
    "deal_auto_complete",
    `
    WITH due AS (
      SELECT id FROM deals
       WHERE status = 'in_review'
         AND auto_complete_after IS NOT NULL
         AND auto_complete_after <= now()
       ORDER BY auto_complete_after
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE deals d
         SET status = 'completed',
             version = d.version + 1,
             completed_at = COALESCE(d.completed_at, now())
        FROM due
       WHERE d.id = due.id
       RETURNING d.id, d.provider_id, d.client_id
    ),
    ev AS (
      INSERT INTO deal_events (deal_id, actor_id, actor_role, event_type, from_status, to_status, metadata)
      SELECT id, NULL, 'system', 'deal.auto_completed', 'in_review', 'completed', '{}'::jsonb
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'deal', id, 'deal.auto_completed',
           jsonb_build_object('deal_id', id, 'provider_id', provider_id, 'client_id', client_id)
      FROM updated
    `
  );
}

export async function dealPendingExpiry(): Promise<number> {
  return exec(
    "deal_pending_expiry",
    `
    WITH expired AS (
      SELECT id FROM deals
       WHERE status = 'pending'
         AND created_at <= now() - interval '72 hours'
       ORDER BY created_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE deals d
         SET status = 'cancelled',
             cancellation_reason = 'expired_pending',
             version = d.version + 1
        FROM expired
       WHERE d.id = expired.id
       RETURNING d.id, d.client_id, d.provider_id
    ),
    ev AS (
      INSERT INTO deal_events (deal_id, actor_id, actor_role, event_type, from_status, to_status, metadata)
      SELECT id, NULL, 'system', 'deal.expired_pending', 'pending', 'cancelled',
             jsonb_build_object('reason', 'no_provider_response_72h')
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'deal', id, 'deal.expired_pending',
           jsonb_build_object('deal_id', id, 'client_id', client_id, 'provider_id', provider_id)
      FROM updated
    `
  );
}

/* --------------------------- dispute lifecycle -------------------------- */

export async function disputeEscalation(): Promise<number> {
  // First escalation: dispute_resolve_by passed, no prior escalation. Extend
  // window by 7d. (We don't have dispute_escalation_count column tracked yet;
  // use a heuristic: if dispute_resolve_by > dispute_opened_at + 14d, treat
  // as already escalated.)
  return exec(
    "dispute_escalation",
    `
    WITH due AS (
      SELECT id FROM deals
       WHERE status = 'disputed'
         AND dispute_resolve_by IS NOT NULL
         AND dispute_resolve_by <= now()
         AND dispute_opened_at IS NOT NULL
         AND dispute_resolve_by < dispute_opened_at + interval '15 days'
       ORDER BY dispute_resolve_by
       LIMIT 100
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE deals d
         SET dispute_resolve_by = d.dispute_resolve_by + interval '7 days',
             version = d.version + 1
        FROM due
       WHERE d.id = due.id
       RETURNING d.id, d.client_id, d.provider_id, d.dispute_resolve_by
    ),
    ev AS (
      INSERT INTO deal_events (deal_id, actor_id, actor_role, event_type, metadata)
      SELECT id, NULL, 'system', 'deal.dispute_escalated',
             jsonb_build_object('new_resolve_by', dispute_resolve_by)
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'deal', id, 'deal.dispute_escalated',
           jsonb_build_object('deal_id', id, 'new_resolve_by', dispute_resolve_by)
      FROM updated
    `
  );
}

export async function disputeAutoRefund(): Promise<number> {
  // Second-pass: dispute_resolve_by passed AFTER one escalation extension
  // (> dispute_opened_at + 15d). Conservative default: refund_to_client.
  return exec(
    "dispute_auto_refund",
    `
    WITH due AS (
      SELECT id FROM deals
       WHERE status = 'disputed'
         AND dispute_resolve_by IS NOT NULL
         AND dispute_resolve_by <= now()
         AND dispute_opened_at IS NOT NULL
         AND dispute_resolve_by >= dispute_opened_at + interval '15 days'
       ORDER BY dispute_resolve_by
       LIMIT 50
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE deals d
         SET status = 'cancelled',
             cancellation_reason = 'dispute_unresolved',
             resolution_outcome = 'refund_to_client',
             resolution_release_amount = 0,
             resolved_at = now(),
             version = d.version + 1
        FROM due
       WHERE d.id = due.id
       RETURNING d.id, d.client_id, d.provider_id
    ),
    ev AS (
      INSERT INTO deal_events (deal_id, actor_id, actor_role, event_type, from_status, to_status, metadata)
      SELECT id, NULL, 'system', 'deal.dispute_unresolved', 'disputed', 'cancelled',
             jsonb_build_object('outcome', 'refund_to_client', 'system_default', true)
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'deal', id, 'deal.dispute_unresolved',
           jsonb_build_object('deal_id', id, 'client_id', client_id, 'provider_id', provider_id)
      FROM updated
    `
  );
}

/* ------------------------------- KYC ------------------------------------ */

export async function kycExpiredSweep(): Promise<number> {
  return exec(
    "kyc_expired_sweep",
    `
    WITH due AS (
      SELECT id, provider_id FROM kyc_verifications
       WHERE status = 'approved'
         AND expires_at IS NOT NULL
         AND expires_at <= now()
       ORDER BY expires_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE kyc_verifications kv
         SET status = 'expired',
             decided_at = now(),
             last_decided_at = now(),
             version = kv.version + 1
        FROM due
       WHERE kv.id = due.id
       RETURNING kv.id, due.provider_id
    ),
    _users AS (
      UPDATE users
         SET kyc_status = 'expired', payout_enabled = false
       WHERE id IN (SELECT provider_id FROM updated WHERE provider_id IS NOT NULL)
    ),
    ev AS (
      INSERT INTO kyc_review_events (kyc_verification_id, provider_id, actor_id, actor_role, event_type, from_status, to_status)
      SELECT id, provider_id, NULL, 'system', 'kyc.expired', 'approved', 'expired'
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'kyc', id, 'kyc.expired',
           jsonb_build_object('kyc_id', id, 'provider_id', provider_id)
      FROM updated
    `
  );
}

export async function kycStaleClaim(): Promise<number> {
  // Reviewer claimed but didn't decide in 4h → unclaim (status back to submitted).
  return exec(
    "kyc_stale_claim",
    `
    WITH due AS (
      SELECT id FROM kyc_verifications
       WHERE status = 'in_review'
         AND review_started_at IS NOT NULL
         AND review_started_at <= now() - interval '4 hours'
       ORDER BY review_started_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE kyc_verifications kv
         SET status = 'submitted',
             reviewed_by = NULL,
             review_started_at = NULL,
             version = kv.version + 1
        FROM due
       WHERE kv.id = due.id
       RETURNING kv.id, kv.provider_id
    ),
    _users AS (
      UPDATE users
         SET kyc_status = 'submitted'
       WHERE id IN (SELECT provider_id FROM updated WHERE provider_id IS NOT NULL)
    ),
    ev AS (
      INSERT INTO kyc_review_events (kyc_verification_id, provider_id, actor_id, actor_role, event_type, from_status, to_status)
      SELECT id, provider_id, NULL, 'system', 'kyc.stale_claim_evicted', 'in_review', 'submitted'
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'kyc', id, 'kyc.stale_claim_evicted',
           jsonb_build_object('kyc_id', id, 'provider_id', provider_id)
      FROM updated
    `
  );
}

/* ----------------------------- retention -------------------------------- */

export async function outboxRetention(): Promise<number> {
  return exec(
    "outbox_retention",
    `DELETE FROM outbox_events
      WHERE status = 'processed' AND processed_at < now() - interval '7 days'`
  );
}

export async function listingDraftExpiry(): Promise<number> {
  return exec(
    "listing_draft_expiry",
    `DELETE FROM listing_drafts
      WHERE updated_at < now() - interval '30 days'`
  );
}

/* ------------------------------ scheduler ------------------------------- */

/** Run every job once. Each is idempotent + locks-aware. */
export async function runAllJobs(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  results.deal_auto_complete = await dealAutoComplete();
  results.deal_pending_expiry = await dealPendingExpiry();
  results.dispute_escalation = await disputeEscalation();
  results.dispute_auto_refund = await disputeAutoRefund();
  results.kyc_expired_sweep = await kycExpiredSweep();
  results.kyc_stale_claim = await kycStaleClaim();
  results.outbox_retention = await outboxRetention();
  results.listing_draft_expiry = await listingDraftExpiry();
  results.media_scan_retry = await scanRetrySweep().catch(() => 0);
  results.media_variants_backfill = await regenerateMissingVariants().catch(() => 0);
  results.email_drain = await drainEmailQueue().catch(() => 0);
  results.push_drain = await drainPushQueue().catch(() => 0);
  results.sessions_purge = await sessionsPurge();
  return results;
}

/** Retention sweep — purge sessions whose refresh has expired more than
 *  7 days ago, AND sessions revoked more than 30 days ago. Both windows
 *  give an investigation buffer (admin can SELECT recent-revoke rows for
 *  audit before they vanish) without letting the table grow unbounded. */
export async function sessionsPurge(): Promise<number> {
  return exec(
    "sessions_purge",
    `DELETE FROM sessions
      WHERE (revoked_at IS NULL AND expires_at < now() - interval '7 days')
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`
  );
}

let started = false;

export function startCronScheduler(intervalSeconds = 60): NodeJS.Timeout | null {
  if (started) return null;
  started = true;
  const tick = async () => {
    try {
      await runAllJobs();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[cron] tick failed:", (e as Error).message);
    }
  };
  const handle = setInterval(tick, intervalSeconds * 1000);
  handle.unref();
  // Fire-and-forget initial tick after a small delay so server is fully up.
  setTimeout(() => void tick(), 5000).unref();
  return handle;
}
