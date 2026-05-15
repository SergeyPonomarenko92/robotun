/**
 * REQ-009 pre-expiry warning smoke.
 *
 *   - Inserts an approved KYC with expires_at = now() + 15d (inside the
 *     30-day window).
 *   - Runs kycPreExpiryWarn().
 *   - Asserts: rekyc_required_at populated, rekyc_required_reason =
 *     'document_expiry', status still 'approved' (NOT auto-expired),
 *     kyc.rekyc_required event in outbox, audit row in kyc_review_events.
 *   - Runs the sweep AGAIN — second pass must be a no-op (idempotent
 *     marker check).
 *   - Inserts a far-future KYC (expires_at = now() + 90d) — sweep must
 *     NOT touch it.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { kycPreExpiryWarn } from "../src/services/cron.js";

async function mkProvider(email: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled, payout_enabled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl',
                 ${email.split("@")[0]}, 'active', true, true, 'approved', true, true)
         ON CONFLICT (email) DO UPDATE SET status='active'
         RETURNING id`
  );
  return r[0]!.id;
}

async function mkApprovedKyc(providerId: string, daysAhead: number): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count,
                                         decided_at, last_decided_at, expires_at)
         VALUES (${providerId}, 'approved', now() - interval '5 days', 1,
                 now() - interval '3 days', now() - interval '3 days',
                 now() + (${daysAhead} || ' days')::interval)
         ON CONFLICT (provider_id) DO UPDATE
           SET status='approved',
               submitted_at=now() - interval '5 days',
               decided_at=now() - interval '3 days',
               last_decided_at=now() - interval '3 days',
               expires_at=now() + (${daysAhead} || ' days')::interval,
               rekyc_required_at=NULL, rekyc_required_reason=NULL
         RETURNING id`
  );
  return r[0]!.id;
}

async function main() {
  const due = await mkProvider(`req009-due-${Date.now()}@test.local`);
  const dueKyc = await mkApprovedKyc(due, 15);

  const far = await mkProvider(`req009-far-${Date.now()}@test.local`);
  const farKyc = await mkApprovedKyc(far, 90);

  const n1 = await kycPreExpiryWarn();
  const n2 = await kycPreExpiryWarn(); // idempotent

  const dueRow = await db.execute<{
    status: string; rekyc_required_at: string | null; rekyc_required_reason: string | null;
  }>(dsql`SELECT status, rekyc_required_at::text, rekyc_required_reason FROM kyc_verifications WHERE id = ${dueKyc}`);
  const farRow = await db.execute<{ rekyc_required_at: string | null }>(
    dsql`SELECT rekyc_required_at::text FROM kyc_verifications WHERE id = ${farKyc}`
  );

  const outbox = await db.execute<{ event_type: string; payload: any }>(
    dsql`SELECT event_type, payload FROM outbox_events
          WHERE aggregate_id = ${dueKyc} AND event_type = 'kyc.rekyc_required'
          ORDER BY created_at DESC LIMIT 1`
  );

  const audit = await db.execute<{ event_type: string }>(
    dsql`SELECT event_type FROM kyc_review_events
          WHERE kyc_verification_id = ${dueKyc} AND event_type = 'kyc.rekyc_required'
          ORDER BY created_at DESC LIMIT 1`
  );

  console.log(JSON.stringify({ n1, n2, dueRow: dueRow[0], farRow: farRow[0], outbox: outbox[0], audit: audit[0] }, null, 2));

  if (n2 !== 0) throw new Error(`second pass not idempotent: ${n2}`);
  if (dueRow[0]?.status !== "approved") throw new Error(`status changed: ${dueRow[0]?.status}`);
  if (!dueRow[0]?.rekyc_required_at) throw new Error("rekyc_required_at not set");
  if (dueRow[0]?.rekyc_required_reason !== "document_expiry") throw new Error(`reason: ${dueRow[0]?.rekyc_required_reason}`);
  if (farRow[0]?.rekyc_required_at) throw new Error("far-future row touched");
  if (outbox[0]?.event_type !== "kyc.rekyc_required") throw new Error("outbox missing");
  if (outbox[0]?.payload?.reason !== "document_expiry") throw new Error(`outbox payload reason: ${outbox[0]?.payload?.reason}`);
  if (audit[0]?.event_type !== "kyc.rekyc_required") throw new Error("audit missing");

  console.log("REQ-009 PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("REQ-009 FAIL", e);
  process.exit(1);
});
