/**
 * REQ-006 / §4.5 admin suspend smoke.
 *
 *   approved → rejected, payout_enabled=false, outbox kyc.suspended,
 *   audit row kyc.suspended.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { suspendApproval } from "../src/services/kyc.service.js";

async function mkUser(email: string, admin = false): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'approved', true)
         ON CONFLICT (email) DO UPDATE SET status='active' RETURNING id`
  );
  const id = r[0]!.id;
  if (admin) await db.execute(dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin') ON CONFLICT DO NOTHING`);
  return id;
}

async function main() {
  const admin = await mkUser(`req006s-admin-${Date.now()}@test.local`, true);
  const prov = await mkUser(`req006s-prov-${Date.now()}@test.local`);

  await db.execute(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, decided_at, last_decided_at, expires_at)
         VALUES (${prov}, 'approved', now() - interval '5 days', 1, now() - interval '3 days', now() - interval '3 days', now() + interval '300 days')
         ON CONFLICT (provider_id) DO UPDATE
           SET status='approved', decided_at=now() - interval '3 days', last_decided_at=now() - interval '3 days', expires_at=now() + interval '300 days'`
  );
  await db.execute(dsql`UPDATE users SET kyc_status='approved', payout_enabled=true WHERE id = ${prov}`);

  // happy path
  const r1 = await suspendApproval({
    provider_id: prov,
    admin_id: admin,
    reason_code: "fraud_detected",
    reason_note: "Sudden velocity spike + IP geo divergence + two disputes in 24h",
  });
  if (!r1.ok) throw new Error(`suspend failed: ${JSON.stringify(r1.error)}`);

  const after = await db.execute<{ status: string; rejection_note: string | null; payout_enabled: boolean; kyc_status: string }>(
    dsql`SELECT kv.status, kv.rejection_note, u.payout_enabled, u.kyc_status
           FROM kyc_verifications kv JOIN users u ON u.id = kv.provider_id
          WHERE kv.id = ${r1.value.kyc_id}`
  );
  if (after[0]?.status !== "rejected") throw new Error(`status wrong: ${after[0]?.status}`);
  if (after[0]?.payout_enabled !== false) throw new Error(`payout still on: ${after[0]?.payout_enabled}`);
  if (after[0]?.kyc_status !== "rejected") throw new Error(`kyc_status wrong: ${after[0]?.kyc_status}`);
  if (!after[0]?.rejection_note?.startsWith("[suspend:fraud_detected]")) {
    throw new Error(`rejection_note shape: ${after[0]?.rejection_note}`);
  }

  const outbox = await db.execute<{ event_type: string }>(
    dsql`SELECT event_type FROM outbox_events
          WHERE aggregate_id = ${r1.value.kyc_id} AND event_type = 'kyc.suspended'
          ORDER BY created_at DESC LIMIT 1`
  );
  if (outbox[0]?.event_type !== "kyc.suspended") throw new Error("outbox missing");

  const audit = await db.execute<{ event_type: string }>(
    dsql`SELECT event_type FROM kyc_review_events
          WHERE kyc_verification_id = ${r1.value.kyc_id} AND event_type = 'kyc.suspended'
          ORDER BY created_at DESC LIMIT 1`
  );
  if (audit[0]?.event_type !== "kyc.suspended") throw new Error("audit missing");

  // double-suspend → 422 (already rejected)
  const r2 = await suspendApproval({ provider_id: prov, admin_id: admin, reason_code: "fraud_detected", reason_note: "again again" });
  if (r2.ok || r2.error.code !== "invalid_status_for_suspend") {
    throw new Error(`double-suspend should 422: ${JSON.stringify(r2)}`);
  }

  // bad enum
  const r3 = await suspendApproval({ provider_id: prov, admin_id: admin, reason_code: "bogus", reason_note: "x".repeat(10) });
  if (r3.ok || r3.error.code !== "validation_failed") throw new Error("bad enum should 400");

  // short note
  const r4 = await suspendApproval({ provider_id: prov, admin_id: admin, reason_code: "other", reason_note: "x" });
  if (r4.ok || r4.error.code !== "validation_failed") throw new Error("short note should 400");

  console.log("REQ-006 suspend PASS");
  process.exit(0);
}

main().catch((e) => { console.error("REQ-006 FAIL", e); process.exit(1); });
