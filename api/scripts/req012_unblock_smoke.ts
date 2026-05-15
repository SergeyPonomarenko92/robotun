/**
 * REQ-012 / §4.8.4 unblock smoke. 5→10→15→20→422.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { unblockSubmissionLimit } from "../src/services/kyc.service.js";

async function mkUser(email: string, admin = false): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'rejected', true)
         ON CONFLICT (email) DO UPDATE SET status='active' RETURNING id`
  );
  const id = r[0]!.id;
  if (admin) await db.execute(dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin') ON CONFLICT DO NOTHING`);
  return id;
}

async function main() {
  const admin = await mkUser(`req012-admin-${Date.now()}@test.local`, true);
  const prov = await mkUser(`req012-prov-${Date.now()}@test.local`);

  await db.execute(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, submission_limit, decided_at, last_decided_at, rejection_code)
         VALUES (${prov}, 'rejected', now() - interval '2 days', 5, 5, now() - interval '1 day', now() - interval '1 day', 'document_unreadable')
         ON CONFLICT (provider_id) DO UPDATE
           SET status='rejected', submission_count=5, submission_limit=5,
               decided_at=now() - interval '1 day', last_decided_at=now() - interval '1 day',
               rejection_code='document_unreadable'`
  );

  const r1 = await unblockSubmissionLimit({ provider_id: prov, admin_id: admin, reason_code: "legitimate_documentation_issue" });
  if (!r1.ok || r1.value.submission_limit !== 10) throw new Error(`step1: ${JSON.stringify(r1)}`);

  const r2 = await unblockSubmissionLimit({ provider_id: prov, admin_id: admin, reason_code: "system_error_during_submission" });
  if (!r2.ok || r2.value.submission_limit !== 15) throw new Error(`step2: ${JSON.stringify(r2)}`);

  const r3 = await unblockSubmissionLimit({ provider_id: prov, admin_id: admin, reason_code: "provider_appeal_resolved" });
  if (!r3.ok || r3.value.submission_limit !== 20) throw new Error(`step3: ${JSON.stringify(r3)}`);

  // RISK-1 ceiling at 20 → 422 (use a valid non-'other' code so the
  // reason_note guard doesn't preempt the ceiling check).
  const r4 = await unblockSubmissionLimit({ provider_id: prov, admin_id: admin, reason_code: "legitimate_documentation_issue" });
  if (r4.ok) throw new Error("step4: expected ceiling 422");
  if (r4.error.code !== "unblock_ceiling_reached" || r4.error.status !== 422) {
    throw new Error(`step4: wrong error: ${JSON.stringify(r4.error)}`);
  }

  const r5 = await unblockSubmissionLimit({ provider_id: prov, admin_id: admin, reason_code: "bogus" });
  if (r5.ok || r5.error.code !== "validation_failed") {
    throw new Error(`step5: bad enum should 400: ${JSON.stringify(r5)}`);
  }

  // RISK-3 'other' without note → 400.
  const r6 = await unblockSubmissionLimit({ provider_id: prov, admin_id: admin, reason_code: "other" });
  if (r6.ok || r6.error.code !== "validation_failed") {
    throw new Error(`step6: 'other' without note should 400: ${JSON.stringify(r6)}`);
  }

  // RISK-1 status guard — unblock on approved provider should be 422.
  const provApproved = await mkUser(`req012-approved-${Date.now()}@test.local`);
  await db.execute(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, decided_at, last_decided_at, expires_at)
         VALUES (${provApproved}, 'approved', now() - interval '2 days', 1, now() - interval '1 day', now() - interval '1 day', now() + interval '300 days')
         ON CONFLICT (provider_id) DO UPDATE SET status='approved', submission_count=1`
  );
  const r7 = await unblockSubmissionLimit({ provider_id: provApproved, admin_id: admin, reason_code: "legitimate_documentation_issue" });
  if (r7.ok || r7.error.code !== "invalid_status_for_unblock") {
    throw new Error(`step7: unblock on approved should 422: ${JSON.stringify(r7)}`);
  }

  const audit = await db.execute<{ event_type: string; metadata: any }>(
    dsql`SELECT event_type, metadata FROM kyc_review_events
          WHERE provider_id = ${prov} AND event_type = 'kyc.unblock'
          ORDER BY created_at DESC LIMIT 1`
  );
  console.log(JSON.stringify({ audit: audit[0], final: r3.value }, null, 2));
  if (audit[0]?.metadata?.new_limit !== 20) throw new Error("audit metadata missing");
  console.log("REQ-012 unblock PASS");
  process.exit(0);
}

main().catch((e) => { console.error("REQ-012 FAIL", e); process.exit(1); });
