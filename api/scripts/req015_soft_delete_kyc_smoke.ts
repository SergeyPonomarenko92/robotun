/**
 * REQ-015 soft-delete → KYC cancel → restore → uncancel smoke.
 *
 *   1. provider with KYC status='in_review' is soft-deleted.
 *   2. user.soft_deleted outbox event emitted.
 *   3. kycUserSoftDeleteConsumer cron consumes → kyc row.status='cancelled',
 *      rekyc_required_reason='account_deleted', audit + outbox events.
 *   4. admin restores within 90d → kyc row.status flips back to 'not_submitted'.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { kycUserSoftDeleteConsumer } from "../src/services/cron.js";
import { deleteAccount, restoreAccount } from "../src/services/auth.service.js";
import { hashPassword } from "../src/services/crypto.js";

async function mkUser(email: string, password: string): Promise<string> {
  const pwd = await hashPassword(password);
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled)
         VALUES (${email}, ${pwd}, ${email.split("@")[0]}, 'active', true, true, 'in_review', false)
         RETURNING id`
  );
  return r[0]!.id;
}

async function main() {
  const email = `req015-prov-${Date.now()}@test.local`;
  const password = "RequiresAStrongPasswordPerHIBP1!";
  const userId = await mkUser(email, password);

  await db.execute(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, review_started_at, reviewed_by)
         VALUES (${userId}, 'in_review', now() - interval '1 hour', 1, now() - interval '30 minutes', NULL)`
  );

  // Step 1: soft-delete
  const del = await deleteAccount({ user_id: userId, password });
  if (!del.ok) throw new Error(`deleteAccount failed: ${JSON.stringify((del as any).error)}`);

  // Step 2: consumer runs
  await kycUserSoftDeleteConsumer();
  const afterDel = await db.execute<{ status: string; rekyc_required_reason: string | null }>(
    dsql`SELECT status, rekyc_required_reason FROM kyc_verifications WHERE provider_id = ${userId}`
  );
  if (afterDel[0]?.status !== "cancelled") throw new Error(`expected cancelled, got ${afterDel[0]?.status}`);
  if (afterDel[0]?.rekyc_required_reason !== "account_deleted") throw new Error(`reason: ${afterDel[0]?.rekyc_required_reason}`);

  const audit = await db.execute<{ event_type: string }>(
    dsql`SELECT event_type FROM kyc_review_events
          WHERE provider_id = ${userId} AND event_type = 'kyc.cancelled' ORDER BY created_at DESC LIMIT 1`
  );
  if (audit[0]?.event_type !== "kyc.cancelled") throw new Error("audit missing");

  const outbox = await db.execute<{ event_type: string }>(
    dsql`SELECT event_type FROM outbox_events
          WHERE event_type = 'kyc.cancelled' AND payload->>'provider_id' = ${userId}
          ORDER BY created_at DESC LIMIT 1`
  );
  if (outbox[0]?.event_type !== "kyc.cancelled") throw new Error("outbox missing");

  // Idempotent re-run
  const n2 = await kycUserSoftDeleteConsumer();
  if (n2 !== 0) throw new Error(`consumer not idempotent on second pass: ${n2}`);

  // Step 3: restore
  const res = await restoreAccount({ user_id: userId, original_email: email });
  if (!res.ok) throw new Error(`restore failed: ${JSON.stringify((res as any).error)}`);

  const afterRestore = await db.execute<{ status: string; rekyc_required_reason: string | null }>(
    dsql`SELECT status, rekyc_required_reason FROM kyc_verifications WHERE provider_id = ${userId}`
  );
  if (afterRestore[0]?.status !== "not_submitted") {
    throw new Error(`restore did not uncancel KYC: ${afterRestore[0]?.status}`);
  }
  if (afterRestore[0]?.rekyc_required_reason !== null) {
    throw new Error(`restore did not clear reason: ${afterRestore[0]?.rekyc_required_reason}`);
  }

  console.log("REQ-015 PASS");
  process.exit(0);
}

main().catch((e) => { console.error("REQ-015 FAIL", e); process.exit(1); });
