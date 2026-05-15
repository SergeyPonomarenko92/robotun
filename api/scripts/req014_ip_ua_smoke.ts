/**
 * REQ-014 / SEC-006 audit IP+UA smoke.
 *
 * Calls svc.claim() with an audit ctx and asserts the resulting
 * kyc_review_events row carries the IP and UA we passed in.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import * as svc from "../src/services/kyc.service.js";

async function ensureUser(email: string, admin = false): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'submitted')
         ON CONFLICT (email) DO UPDATE SET status='active'
         RETURNING id`
  );
  const id = r[0]!.id;
  if (admin) {
    await db.execute(dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin') ON CONFLICT DO NOTHING`);
  }
  return id;
}

async function main() {
  const admin = await ensureUser(`req014-admin-${Date.now()}@test.local`, true);
  const provider = await ensureUser(`req014-prov-${Date.now()}@test.local`);
  const kyc = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count)
         VALUES (${provider}, 'submitted', now(), 1)
         ON CONFLICT (provider_id) DO UPDATE
           SET status='submitted', submitted_at=now(), reviewed_by=NULL
         RETURNING id`
  );
  const kycId = kyc[0]!.id;

  const r = await svc.claim({
    kyc_id: kycId,
    admin_id: admin,
    audit: { ip: "203.0.113.42", user_agent: "MozillaSmoke/1.0 REQ-014" },
  });
  if (!r.ok) throw new Error(`claim failed: ${JSON.stringify(r.error)}`);

  const ev = await db.execute<{ ip: string | null; user_agent: string | null; event_type: string }>(
    dsql`SELECT ip::text AS ip, user_agent, event_type
           FROM kyc_review_events
          WHERE kyc_verification_id = ${kycId}
          ORDER BY created_at DESC
          LIMIT 1`
  );

  console.log(JSON.stringify(ev[0], null, 2));
  if (!ev[0]?.ip?.startsWith("203.0.113.42")) throw new Error(`IP missing/mismatched: ${ev[0]?.ip}`);
  if (ev[0]?.user_agent !== "MozillaSmoke/1.0 REQ-014") throw new Error(`UA missing/mismatched: ${ev[0]?.user_agent}`);
  console.log("REQ-014 PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("REQ-014 FAIL", e);
  process.exit(1);
});
