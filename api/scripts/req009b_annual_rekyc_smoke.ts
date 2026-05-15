/**
 * REQ-009 §4.12 row 4 annual re-KYC smoke.
 *
 *   - approved row with decided_at 400d ago + no rekyc_required_reason
 *     → swept: rekyc_required_reason='periodic_rekyc', outbox + audit.
 *   - approved row with decided_at 100d ago → untouched.
 *   - second pass on same row → 0 (idempotent on rekyc_required_reason).
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { kycAnnualRekyc } from "../src/services/cron.js";

async function mkProvider(email: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled, payout_enabled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'approved', true, true)
         ON CONFLICT (email) DO UPDATE SET status='active' RETURNING id`
  );
  return r[0]!.id;
}

async function mkApproved(provider: string, daysAgo: number): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count, decided_at, last_decided_at)
         VALUES (${provider}, 'approved', now() - (${daysAgo + 5} || ' days')::interval, 1,
                 now() - (${daysAgo} || ' days')::interval, now() - (${daysAgo} || ' days')::interval)
         ON CONFLICT (provider_id) DO UPDATE
           SET status='approved',
               decided_at=now() - (${daysAgo} || ' days')::interval,
               last_decided_at=now() - (${daysAgo} || ' days')::interval,
               rekyc_required_at=NULL, rekyc_required_reason=NULL
         RETURNING id`
  );
  return r[0]!.id;
}

async function main() {
  const old = await mkProvider(`req009b-old-${Date.now()}@test.local`);
  const oldKyc = await mkApproved(old, 400);
  const young = await mkProvider(`req009b-young-${Date.now()}@test.local`);
  const youngKyc = await mkApproved(young, 100);

  const n1 = await kycAnnualRekyc();
  const n2 = await kycAnnualRekyc();

  const oldRow = await db.execute<{ rekyc_required_reason: string | null }>(
    dsql`SELECT rekyc_required_reason FROM kyc_verifications WHERE id = ${oldKyc}`
  );
  const youngRow = await db.execute<{ rekyc_required_reason: string | null }>(
    dsql`SELECT rekyc_required_reason FROM kyc_verifications WHERE id = ${youngKyc}`
  );

  console.log(JSON.stringify({ n1, n2, oldRow: oldRow[0], youngRow: youngRow[0] }));

  if (n2 !== 0) throw new Error("not idempotent");
  if (oldRow[0]?.rekyc_required_reason !== "periodic_rekyc") throw new Error("old row not swept");
  if (youngRow[0]?.rekyc_required_reason !== null) throw new Error("young row touched");

  const outbox = await db.execute<{ payload: any }>(
    dsql`SELECT payload FROM outbox_events
          WHERE aggregate_id = ${oldKyc} AND event_type = 'kyc.rekyc_required'
            AND payload->>'reason' = 'periodic_rekyc'
          ORDER BY created_at DESC LIMIT 1`
  );
  if (!outbox[0]) throw new Error("outbox missing");

  console.log("REQ-009 annual PASS");
  process.exit(0);
}

main().catch((e) => { console.error("REQ-009 annual FAIL", e); process.exit(1); });
