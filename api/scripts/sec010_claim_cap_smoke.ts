/**
 * SEC-010 smoke: per-admin concurrent claim cap = 10.
 *
 * Strategy: bypass provider-onboarding by directly inserting 11 kyc rows
 * (with real user FKs, since provider_id REFERENCES users) in status='submitted'.
 * Then call claim() 11 times as the same admin and assert that the 11th
 * returns 429 claim_limit_exceeded.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import * as svc from "../src/services/kyc.service.js";

async function ensureUser(email: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'submitted')
         ON CONFLICT (email) DO UPDATE SET status='active'
         RETURNING id`
  );
  return r[0]!.id;
}

async function makeAdmin(email: string): Promise<string> {
  const id = await ensureUser(email);
  await db.execute(
    dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin')
         ON CONFLICT DO NOTHING`
  );
  return id;
}

async function insertSubmittedKyc(providerId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count)
         VALUES (${providerId}, 'submitted', now(), 1)
         ON CONFLICT (provider_id) DO UPDATE
           SET status='submitted', submitted_at=now(), reviewed_by=NULL, review_started_at=NULL
         RETURNING id`
  );
  return r[0]!.id;
}

async function main() {
  const adminId = await makeAdmin(`sec010-admin-${Date.now()}@test.local`);
  const kycIds: string[] = [];
  for (let i = 0; i < 11; i++) {
    const providerId = await ensureUser(`sec010-prov-${Date.now()}-${i}@test.local`);
    kycIds.push(await insertSubmittedKyc(providerId));
  }

  let okClaims = 0;
  let lastErr: any = null;
  for (let i = 0; i < 11; i++) {
    const r = await svc.claim({ kyc_id: kycIds[i]!, admin_id: adminId });
    if (r.ok) okClaims++;
    else lastErr = r.error;
  }

  console.log(JSON.stringify({ okClaims, lastErr }, null, 2));

  if (okClaims !== 10) throw new Error(`expected 10 ok claims, got ${okClaims}`);
  if (!lastErr || lastErr.code !== "claim_limit_exceeded" || lastErr.status !== 429) {
    throw new Error(`expected 429 claim_limit_exceeded, got ${JSON.stringify(lastErr)}`);
  }
  console.log("SEC-010 PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("SEC-010 FAIL", e);
  process.exit(1);
});
