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
import { db, sql } from "../db/client.js";
import { sql as dsqlImport } from "drizzle-orm";
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

/**
 * REQ-009 leg: 30-day pre-expiry warning.
 *
 * For each approved kyc that will expire ≤30d from now and has not yet
 * been warned (rekyc_required_at IS NULL), set rekyc_required_at +
 * rekyc_required_reason='document_expiry', append audit event, emit
 * outbox kyc.rekyc_required. Does NOT change status — provider stays
 * approved with payout_enabled=true until expires_at; this is a heads-up.
 *
 * Idempotent: rekyc_required_at marker prevents re-emission. Batched at
 * 200 rows/tick via FOR UPDATE SKIP LOCKED so multiple worker processes
 * can run safely.
 */
export async function kycPreExpiryWarn(): Promise<number> {
  return exec(
    "kyc_pre_expiry_warn",
    `
    WITH due AS (
      SELECT id, provider_id FROM kyc_verifications
       WHERE status = 'approved'
         AND expires_at IS NOT NULL
         AND expires_at <= now() + interval '30 days'
         AND expires_at >  now()
         AND rekyc_required_at IS NULL
       ORDER BY expires_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE kyc_verifications kv
         SET rekyc_required_at    = now(),
             rekyc_required_reason = 'document_expiry',
             version              = kv.version + 1
        FROM due
       WHERE kv.id = due.id
       RETURNING kv.id, due.provider_id, kv.expires_at
    ),
    ev AS (
      INSERT INTO kyc_review_events
        (kyc_verification_id, provider_id, actor_id, actor_role, event_type, from_status, to_status, metadata)
      SELECT id, provider_id, NULL, 'system', 'kyc.rekyc_required', 'approved', 'approved',
             jsonb_build_object('reason', 'document_expiry', 'expires_at', expires_at)
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'kyc', id, 'kyc.rekyc_required',
           jsonb_build_object(
             'kyc_id',      id,
             'provider_id', provider_id,
             'reason',      'document_expiry',
             'expires_at',  expires_at,
             'from_status', 'approved'
           )
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
  results.deal_cancel_request_expiry = await dealCancelRequestExpiry();
  results.dispute_escalation = await disputeEscalation();
  results.dispute_auto_refund = await disputeAutoRefund();
  results.kyc_expired_sweep = await kycExpiredSweep();
  results.kyc_stale_claim = await kycStaleClaim();
  results.kyc_pre_expiry_warn = await kycPreExpiryWarn();
  results.kyc_user_soft_delete_consumer = await kycUserSoftDeleteConsumer();
  results.outbox_retention = await outboxRetention();
  results.listing_draft_expiry = await listingDraftExpiry();
  results.media_scan_retry = await scanRetrySweep().catch(() => 0);
  results.media_variants_backfill = await regenerateMissingVariants().catch(() => 0);
  results.email_drain = await drainEmailQueue().catch(() => 0);
  results.push_drain = await drainPushQueue().catch(() => 0);
  results.sessions_purge = await sessionsPurge();
  results.password_reset_tokens_purge = await passwordResetTokensPurge();
  results.email_verification_tokens_purge = await emailVerificationTokensPurge();
  results.email_change_tokens_purge = await emailChangeTokensPurge();
  results.auth_audit_purge = await authAuditPurge();
  results.deleted_users_purge = await deletedUsersPurge();
  results.categories_user_soft_delete_consumer = await categoriesUserSoftDeleteConsumer().catch(() => 0);
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

/** Same retention shape for password_reset_tokens — expired tokens (30
 *  min TTL) get purged after 1 day; used tokens after 30 days for audit. */
export async function passwordResetTokensPurge(): Promise<number> {
  return exec(
    "password_reset_tokens_purge",
    `DELETE FROM password_reset_tokens
      WHERE (used_at IS NULL AND expires_at < now() - interval '1 day')
         OR (used_at IS NOT NULL AND used_at < now() - interval '30 days')`
  );
}

/** Same retention shape for email_verification_tokens (24h TTL). */
export async function emailVerificationTokensPurge(): Promise<number> {
  return exec(
    "email_verification_tokens_purge",
    `DELETE FROM email_verification_tokens
      WHERE (used_at IS NULL AND expires_at < now() - interval '7 days')
         OR (used_at IS NOT NULL AND used_at < now() - interval '90 days')`
  );
}

/** Same retention shape for email_change_tokens (1h TTL). */
export async function emailChangeTokensPurge(): Promise<number> {
  return exec(
    "email_change_tokens_purge",
    `DELETE FROM email_change_tokens
      WHERE (used_at IS NULL AND expires_at < now() - interval '7 days')
         OR (used_at IS NOT NULL AND used_at < now() - interval '90 days')`
  );
}

/** auth_audit_events retention — 1 year. Security incidents typically
 *  surface within months; >1y data is mostly noise for ops. GDPR-bearing
 *  metadata (IP, email) gets removed at this boundary. */
export async function authAuditPurge(): Promise<number> {
  return exec(
    "auth_audit_purge",
    `DELETE FROM auth_audit_events WHERE created_at < now() - interval '365 days'`
  );
}

/** Module 3 AC-010 — cancel-request 48h expiry sweep.
 *  When one party of an active deal has POSTed /cancel but the other
 *  hasn't joined within 48h, clear both cancel_requested_*_at timestamps
 *  (single-party requests can be re-issued) and emit
 *  deal.cancel_request_expired.
 *
 *  Idempotent via the timer-condition WHERE clause + RETURNING zero rows
 *  on re-tick. Bounded at 200 rows/tick.
 */
export async function dealCancelRequestExpiry(): Promise<number> {
  return exec(
    "deal_cancel_request_expiry",
    `
    WITH expired AS (
      SELECT id, version FROM deals
       WHERE status = 'active'
         AND (
           (cancel_requested_by_client_at IS NOT NULL
              AND cancel_requested_by_client_at <= now() - interval '48 hours')
           OR
           (cancel_requested_by_provider_at IS NOT NULL
              AND cancel_requested_by_provider_at <= now() - interval '48 hours')
         )
       -- RISK-3: FIFO-by-oldest-request (matches idx_deals_cancel_expiry).
       ORDER BY GREATEST(
         cancel_requested_by_client_at,
         cancel_requested_by_provider_at
       )
       LIMIT 200
       FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE deals d
         -- RISK-1: defensive narrowed CASE — only NULL the side that
         -- actually expired; preserves a counterparty's still-valid
         -- request if it landed within the 48h window before sweep.
         SET cancel_requested_by_client_at = CASE
               WHEN d.cancel_requested_by_client_at <= now() - interval '48 hours'
               THEN NULL ELSE d.cancel_requested_by_client_at END,
             cancel_requested_by_provider_at = CASE
               WHEN d.cancel_requested_by_provider_at <= now() - interval '48 hours'
               THEN NULL ELSE d.cancel_requested_by_provider_at END,
             version = d.version + 1
        FROM expired
       WHERE d.id = expired.id
       RETURNING d.id, d.client_id, d.provider_id
    ),
    ev AS (
      INSERT INTO deal_events (deal_id, actor_id, actor_role, event_type,
                                from_status, to_status, metadata)
      SELECT id, NULL, 'system', 'deal.cancel_request_expired',
             'active', 'active', '{}'::jsonb
        FROM updated
    )
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    SELECT 'deal', id, 'deal.cancel_request_expired',
           jsonb_build_object('deal_id', id,
                              'client_id', client_id,
                              'provider_id', provider_id)
      FROM updated
    `
  );
}

/** Module 2 REQ-011 / AC-012 — consume user.soft_deleted outbox events
 *  and auto-reject the deleted user's pending category_proposals.
 *
 *  Uses a dedicated cursor row in notification_consumer_cursors keyed
 *  by 'categories:user_soft_deleted' so it scans the outbox independently
 *  of the notifications consumer (which would silently skip these rows
 *  since they have no notification template).
 *
 *  Spec AC-012 SLA: within 60 seconds. Cron tick is 60s so worst-case
 *  match. Idempotent: re-consuming an already-processed event finds 0
 *  matching pending rows. */
export async function categoriesUserSoftDeleteConsumer(): Promise<number> {
  // Bootstrap cursor (idempotent autocommit). Safe outside the tx.
  await sql.unsafe(`
    INSERT INTO notification_consumer_cursors (consumer_name, last_seen_id)
    VALUES ('categories:user_soft_deleted', 0)
    ON CONFLICT (consumer_name) DO NOTHING
  `);
  // RISK-4: wrap in drizzle tx + FOR UPDATE on the cursor row so concurrent
  // cron ticks serialize at the cursor — no double-processing.
  // RISK-1: emit category.auto_rejected outbox event per affected proposal
  // so downstream consumers (Feed/Search invalidation, future notification
  // templates) see the change. Single CTE keeps it atomic with UPDATE +
  // cursor advance.
  const { processed } = await db.transaction(async (tx) => {
    const lockRows = (await tx.execute(
      dsqlImport`SELECT last_seen_id FROM notification_consumer_cursors
                  WHERE consumer_name = 'categories:user_soft_deleted'
                  FOR UPDATE`
    )) as unknown as Array<{ last_seen_id: string }>;
    const lastSeen = lockRows[0]?.last_seen_id ?? "0";
    const result = (await tx.execute(
      dsqlImport`WITH events AS (
        SELECT id, (payload->>'user_id')::uuid AS user_id
          FROM outbox_events
         WHERE aggregate_type = 'user'
           AND event_type = 'user.soft_deleted'
           AND id > ${lastSeen}::bigint
         ORDER BY id ASC
         LIMIT 100
      ),
      updated AS (
        UPDATE category_proposals
           SET status = 'auto_rejected',
               rejection_code = 'proposer_deleted',
               rejection_note = 'user account soft-deleted',
               auto_rejected = true,
               reviewed_at = now()
         WHERE status = 'pending'
           AND proposer_id IN (SELECT user_id FROM events)
         RETURNING id
      ),
      emitted AS (
        INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
        SELECT 'category_proposal', id, 'category.auto_rejected',
               jsonb_build_object('proposal_id', id,
                                  'rejection_code', 'proposer_deleted',
                                  'trigger', 'proposer_deleted')
          FROM updated
      ),
      cursor_update AS (
        UPDATE notification_consumer_cursors
           SET last_seen_id = COALESCE((SELECT MAX(id) FROM events), last_seen_id),
               updated_at = now()
         WHERE consumer_name = 'categories:user_soft_deleted'
      )
      SELECT COUNT(*)::int AS n FROM updated`
    )) as unknown as Array<{ n: number }>;
    return { processed: result[0]?.n ?? 0 };
  });
  return processed;
}

/** Module 4 REQ-015 — consume user.soft_deleted outbox events and
 *  cancel the deleted user's open KYC row. Soft-delete MUST NOT be
 *  blocked by KYC state; the spec routes the side-effect through an
 *  async consumer so the deleteAccount tx is independent of KYC.
 *
 *  Mirrors categoriesUserSoftDeleteConsumer (Module 2 REQ-011): dedicated
 *  cursor 'kyc:user_soft_deleted', cursor-scoped FOR UPDATE, atomic CTE
 *  with UPDATE + outbox emit + cursor advance.
 *
 *  Spec §4.5 row "any non-terminal → cancelled, rekyc_required_reason=
 *  'account_deleted'". We extend "non-terminal" to "anything except
 *  cancelled" so a currently-approved provider's payout chain is
 *  guaranteed to flip off as part of soft-delete.
 *
 *  No user-side syncUserKycStatus call: the users row is already in the
 *  soft-deleted shape (status='deleted', email→tombstone) by the time
 *  this consumer runs, and the deleted_user_index path owns the audit
 *  for the user record itself. */
export async function kycUserSoftDeleteConsumer(): Promise<number> {
  await sql.unsafe(`
    INSERT INTO notification_consumer_cursors (consumer_name, last_seen_id)
    VALUES ('kyc:user_soft_deleted', 0)
    ON CONFLICT (consumer_name) DO NOTHING
  `);
  const { processed } = await db.transaction(async (tx) => {
    const lockRows = (await tx.execute(
      dsqlImport`SELECT last_seen_id FROM notification_consumer_cursors
                  WHERE consumer_name = 'kyc:user_soft_deleted'
                  FOR UPDATE`
    )) as unknown as Array<{ last_seen_id: string }>;
    const lastSeen = lockRows[0]?.last_seen_id ?? "0";
    const result = (await tx.execute(
      dsqlImport`WITH events AS (
        SELECT id, (payload->>'user_id')::uuid AS user_id
          FROM outbox_events
         WHERE aggregate_type = 'user'
           AND event_type = 'user.soft_deleted'
           AND id > ${lastSeen}::bigint
         ORDER BY id ASC
         LIMIT 100
      ),
      updated AS (
        UPDATE kyc_verifications kv
           SET status = 'cancelled',
               rekyc_required_reason = 'account_deleted',
               rekyc_required_at = COALESCE(rekyc_required_at, now()),
               decided_at = COALESCE(decided_at, now()),
               last_decided_at = now(),
               reviewed_by = NULL,
               review_started_at = NULL,
               version = version + 1
         WHERE provider_id IN (SELECT user_id FROM events)
           AND status <> 'cancelled'
         RETURNING kv.id, kv.provider_id, kv.status
      ),
      ev AS (
        INSERT INTO kyc_review_events
          (kyc_verification_id, provider_id, actor_id, actor_role, event_type, from_status, to_status, metadata)
        SELECT id, provider_id, NULL, 'system', 'kyc.cancelled', status, 'cancelled',
               jsonb_build_object('reason', 'account_deleted')
          FROM updated
      ),
      outbox AS (
        INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
        SELECT 'kyc', id, 'kyc.cancelled',
               jsonb_build_object(
                 'kyc_id', id,
                 'provider_id', provider_id,
                 'reason', 'account_deleted'
               )
          FROM updated
      ),
      cursor_update AS (
        UPDATE notification_consumer_cursors
           SET last_seen_id = COALESCE((SELECT MAX(id) FROM events), last_seen_id),
               updated_at = now()
         WHERE consumer_name = 'kyc:user_soft_deleted'
      )
      SELECT COUNT(*)::int AS n FROM updated`
    )) as unknown as Array<{ n: number }>;
    return { processed: result[0]?.n ?? 0 };
  });
  return processed;
}

/** REQ-010 — permanent purge of soft-deleted users whose restore window
 *  has expired. Critic RISK-1: FK direction is CASCADE-on-user-delete,
 *  NOT the inverse. Must DELETE the users row directly; the existing
 *  FK then cascades the deleted_user_index row.
 *
 *  NOTE: admin_actions.actor_admin_id is ON DELETE RESTRICT (critic
 *  RISK-2 — unfixed in this commit, awaiting migration). Admin users
 *  who wrote any admin_actions row cannot be purged until that FK is
 *  changed to SET NULL. The exec wrapper catches the RESTRICT error
 *  and returns 0 — operationally surfaces as a stuck purge counter
 *  in /admin/metrics; tracker captures the deferred fix. */
export async function deletedUsersPurge(): Promise<number> {
  return exec(
    "deleted_users_purge",
    `DELETE FROM users
      WHERE id IN (SELECT user_id FROM deleted_user_index WHERE purge_after <= now())`
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
