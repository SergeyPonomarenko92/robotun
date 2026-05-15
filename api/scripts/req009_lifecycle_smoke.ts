/**
 * REQ-009 critic RISK-1 + RISK-2 lifecycle smoke.
 *
 * Full cycle: approve → near-expiry (cron sets rekyc_required_at) →
 * expire (auto-sweep) → resubmit → approve again → near-expiry again.
 * The second approval must reset rekyc_required_at to NULL, and the
 * second 30d cron pass must re-fire.
 *
 * Also exercise the flagRekyc clear path.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { kycPreExpiryWarn } from "../src/services/cron.js";
import { approve, flagRekyc } from "../src/services/kyc.service.js";

async function mkUser(email: string, admin = false): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'submitted', true)
         ON CONFLICT (email) DO UPDATE SET status='active'
         RETURNING id`
  );
  const id = r[0]!.id;
  if (admin) await db.execute(dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin') ON CONFLICT DO NOTHING`);
  return id;
}

async function rowState(kycId: string) {
  const r = await db.execute<{ status: string; rekyc_required_at: string | null; rekyc_required_reason: string | null; expires_at: string | null }>(
    dsql`SELECT status, rekyc_required_at::text, rekyc_required_reason, expires_at::text FROM kyc_verifications WHERE id = ${kycId}`
  );
  return r[0]!;
}

async function main() {
  const admin = await mkUser(`req009b-admin-${Date.now()}@test.local`, true);

  // ============ Path A: approve → warn → re-approve clears marker ============
  const provA = await mkUser(`req009b-provA-${Date.now()}@test.local`);
  const kycA = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, review_started_at, reviewed_by)
         VALUES (${provA}, 'in_review', now() - interval '1 day', 1, now() - interval '1 hour', ${admin})
         ON CONFLICT (provider_id) DO UPDATE
           SET status='in_review', review_started_at=now() - interval '1 hour', reviewed_by=${admin}, rekyc_required_at=NULL, rekyc_required_reason=NULL
         RETURNING id`
  );
  const kycAId = kycA[0]!.id;

  const r1 = await approve({ kyc_id: kycAId, admin_id: admin });
  if (!r1.ok) throw new Error("approve#1 failed: " + JSON.stringify(r1.error));

  // Force expires_at within 30d so cron picks it up.
  await db.execute(dsql`UPDATE kyc_verifications SET expires_at = now() + interval '15 days' WHERE id = ${kycAId}`);
  await kycPreExpiryWarn();
  const afterWarn1 = await rowState(kycAId);
  if (!afterWarn1.rekyc_required_at) throw new Error("first warn marker missing");

  // Simulate re-approval (re-claim → approve).
  await db.execute(dsql`UPDATE kyc_verifications SET status='in_review', review_started_at=now(), reviewed_by=${admin} WHERE id = ${kycAId}`);
  const r2 = await approve({ kyc_id: kycAId, admin_id: admin });
  if (!r2.ok) throw new Error("approve#2 failed: " + JSON.stringify(r2.error));

  const afterApprove2 = await rowState(kycAId);
  if (afterApprove2.rekyc_required_at !== null) throw new Error(`approve did not clear rekyc_required_at: ${afterApprove2.rekyc_required_at}`);
  if (afterApprove2.rekyc_required_reason !== null) throw new Error(`approve did not clear reason: ${afterApprove2.rekyc_required_reason}`);

  // Push expires_at to 15d again so cron fires once more.
  await db.execute(dsql`UPDATE kyc_verifications SET expires_at = now() + interval '15 days' WHERE id = ${kycAId}`);
  await kycPreExpiryWarn();
  const afterWarn2 = await rowState(kycAId);
  if (!afterWarn2.rekyc_required_at) throw new Error("second-cycle warn did not fire (RISK-1 unfixed)");
  console.log("Path A approve-reset PASS");

  // ============ Path B: warn → flagRekyc clears marker ============
  const provB = await mkUser(`req009b-provB-${Date.now()}@test.local`);
  const kycB = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, decided_at, last_decided_at, expires_at, rekyc_required_at, rekyc_required_reason)
         VALUES (${provB}, 'approved', now() - interval '11 months', 1, now() - interval '11 months', now() - interval '11 months', now() + interval '15 days', now(), 'document_expiry')
         ON CONFLICT (provider_id) DO UPDATE
           SET status='approved', expires_at=now() + interval '15 days', rekyc_required_at=now(), rekyc_required_reason='document_expiry'
         RETURNING id`
  );
  const kycBId = kycB[0]!.id;
  await db.execute(dsql`UPDATE users SET kyc_status='approved', payout_enabled=true WHERE id = ${provB}`);

  const rB = await flagRekyc({ provider_id: provB, admin_id: admin, reason: "lifecycle test reset marker" });
  if (!rB.ok) throw new Error("flagRekyc failed: " + JSON.stringify(rB.error));
  const afterFlag = await rowState(kycBId);
  if (afterFlag.rekyc_required_at !== null) throw new Error(`flagRekyc did not clear marker: ${afterFlag.rekyc_required_at}`);
  if (afterFlag.rekyc_required_reason !== null) throw new Error(`flagRekyc did not clear reason: ${afterFlag.rekyc_required_reason}`);
  console.log("Path B flagRekyc-reset PASS");

  console.log("REQ-009 lifecycle PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("REQ-009 lifecycle FAIL", e);
  process.exit(1);
});
