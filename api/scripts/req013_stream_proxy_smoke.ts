/**
 * REQ-013 / AC-017 / AC-018 streaming proxy authorization + audit smoke.
 *
 * Exercises resolveStreamableDocument (the route layer just pipes bytes
 * from S3 once this fn approves). Live S3 byte-pipe is left to manual
 * verification — Fastify Readable.pipe to reply.raw is well-trodden.
 *
 *   - provider self-access     → ok
 *   - other provider           → 403
 *   - admin                    → ok + kyc_review_events document_accessed
 *     row with ip/ua per REQ-014
 *   - media_status != 'ready'  → 409 media_not_ready
 *   - non-existent doc         → 404
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { resolveStreamableDocument } from "../src/services/kyc.service.js";

async function mkUser(email: string, admin = false): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]}, 'active', true, true, 'submitted', false)
         ON CONFLICT (email) DO UPDATE SET status='active' RETURNING id`
  );
  const id = r[0]!.id;
  if (admin) await db.execute(dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin') ON CONFLICT DO NOTHING`);
  return id;
}

async function main() {
  const admin = await mkUser(`req013-admin-${Date.now()}@test.local`, true);
  const owner = await mkUser(`req013-owner-${Date.now()}@test.local`);
  const stranger = await mkUser(`req013-stranger-${Date.now()}@test.local`);

  const kyc = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_verifications (provider_id, status, submitted_at, submission_count)
         VALUES (${owner}, 'submitted', now() - interval '1 hour', 1)
         ON CONFLICT (provider_id) DO UPDATE SET status='submitted' RETURNING id`
  );
  const kycId = kyc[0]!.id;

  const media = await db.execute<{ id: string }>(
    dsql`INSERT INTO media_objects (owner_user_id, purpose, storage_key, bucket_alias, mime_type, byte_size, status, is_public)
         VALUES (${owner}, 'kyc_document', 'kyc/test/req013.pdf', 'kyc-private', 'application/pdf', 1024, 'ready', false)
         RETURNING id`
  );
  const mediaId = media[0]!.id;

  const doc = await db.execute<{ id: string }>(
    dsql`INSERT INTO kyc_documents (kyc_verification_id, provider_id, document_type, media_id, submission_index)
         VALUES (${kycId}, ${owner}, 'passport_ua', ${mediaId}, 1) RETURNING id`
  );
  const docId = doc[0]!.id;

  // owner OK
  const r1 = await resolveStreamableDocument({ document_id: docId, actor_id: owner, actor_role: "provider" });
  if (!r1.ok) throw new Error(`owner stream denied: ${JSON.stringify(r1.error)}`);
  if (r1.value.key !== "kyc/test/req013.pdf" || r1.value.mime_type !== "application/pdf") {
    throw new Error(`owner stream payload wrong: ${JSON.stringify(r1.value)}`);
  }

  // stranger forbidden
  const r2 = await resolveStreamableDocument({ document_id: docId, actor_id: stranger, actor_role: "provider" });
  if (r2.ok || r2.error.code !== "forbidden") throw new Error(`stranger should 403: ${JSON.stringify(r2)}`);

  // admin OK + audit row
  const r3 = await resolveStreamableDocument({
    document_id: docId,
    actor_id: admin,
    actor_role: "admin",
    audit: { ip: "10.0.0.1", user_agent: "AdminBrowser/REQ-013" },
  });
  if (!r3.ok) throw new Error(`admin denied: ${JSON.stringify(r3.error)}`);

  const audit = await db.execute<{ event_type: string; metadata: any; ip: string | null; user_agent: string | null }>(
    dsql`SELECT event_type, metadata, ip::text AS ip, user_agent FROM kyc_review_events
          WHERE kyc_verification_id = ${kycId} AND event_type = 'document_accessed'
          ORDER BY created_at DESC LIMIT 1`
  );
  if (audit[0]?.event_type !== "document_accessed") throw new Error("admin access not audited");
  if (audit[0]?.metadata?.document_id !== docId) throw new Error(`audit metadata: ${JSON.stringify(audit[0]?.metadata)}`);
  if (!audit[0]?.ip?.startsWith("10.0.0.1")) throw new Error(`audit ip: ${audit[0]?.ip}`);
  if (audit[0]?.user_agent !== "AdminBrowser/REQ-013") throw new Error(`audit ua: ${audit[0]?.user_agent}`);

  // not_ready media
  await db.execute(dsql`UPDATE media_objects SET status = 'awaiting_scan' WHERE id = ${mediaId}`);
  const r4 = await resolveStreamableDocument({ document_id: docId, actor_id: owner, actor_role: "provider" });
  if (r4.ok || r4.error.code !== "media_not_ready") throw new Error(`not_ready should 409: ${JSON.stringify(r4)}`);

  // not found
  const r5 = await resolveStreamableDocument({
    document_id: "00000000-0000-0000-0000-000000000000",
    actor_id: owner,
    actor_role: "provider",
  });
  if (r5.ok || r5.error.code !== "not_found") throw new Error(`missing doc should 404: ${JSON.stringify(r5)}`);

  console.log("REQ-013 PASS");
  process.exit(0);
}

main().catch((e) => { console.error("REQ-013 FAIL", e); process.exit(1); });
