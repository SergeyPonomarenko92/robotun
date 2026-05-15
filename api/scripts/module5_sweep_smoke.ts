/**
 * Module 5 sweep smoke — exercises the 4 new consumers + draft-archive
 * cron + the listing_reports auto-pause trigger end-to-end.
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import {
  listingDraftAutoArchive,
  listingsKycRevokedConsumer,
  listingsCategoryArchivedConsumer,
  listingsProviderStatusConsumer,
  listingsRoleRevokedConsumer,
} from "../src/services/cron.js";

async function mkUser(email: string, opts: { admin?: boolean; provider?: boolean } = {}): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]},
                 'active', true, ${opts.provider ?? false}, 'approved', true)
         ON CONFLICT (email) DO UPDATE SET status='active' RETURNING id`
  );
  const id = r[0]!.id;
  if (opts.admin) await db.execute(dsql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin') ON CONFLICT DO NOTHING`);
  return id;
}

async function getCategoryId(): Promise<string> {
  const r = await db.execute<{ id: string }>(dsql`SELECT id FROM categories WHERE status='active' LIMIT 1`);
  return r[0]!.id;
}

async function mkListing(provider: string, categoryId: string, status: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO listings (provider_id, category_id, title, description, service_type, pricing_type, price_amount, currency, status, version, published_at)
         VALUES (${provider}, ${categoryId}, 'Module 5 sweep ' || ${status}, 'Description long enough for the listings_description_chk content-quality check.',
                 'remote', 'fixed', 100000, 'UAH', ${status}, 1, CASE WHEN ${status} = 'active' THEN now() ELSE NULL END)
         RETURNING id`
  );
  return r[0]!.id;
}

async function statusOf(listingId: string): Promise<{ status: string; reasons: string[] }> {
  const r = await db.execute<{ status: string; auto_paused_reasons: string[] }>(
    dsql`SELECT status, auto_paused_reasons FROM listings WHERE id = ${listingId}`
  );
  return { status: r[0]!.status, reasons: r[0]!.auto_paused_reasons };
}

async function main() {
  const cat = await getCategoryId();
  const stamp = Date.now();

  // ---- listing_reports trigger ----
  const provR = await mkUser(`m5-provR-${stamp}@test.local`, { provider: true });
  const lstR = await mkListing(provR, cat, "active");
  for (let i = 0; i < 5; i++) {
    const reporter = await mkUser(`m5-rep${i}-${stamp}@test.local`);
    await db.execute(
      dsql`INSERT INTO listing_reports (listing_id, reporter_id, reason,
              reporter_kyc_approved_at_report_time,
              reporter_completed_deals_at_report_time,
              reporter_account_age_days_at_report_time)
            VALUES (${lstR}, ${reporter}, 'spam', true, 0, 10)`
    );
  }
  const sR = await statusOf(lstR);
  if (sR.status !== "paused" || !sR.reasons.includes("report_threshold")) {
    throw new Error(`auto-pause trigger fail: ${JSON.stringify(sR)}`);
  }
  console.log("auto-pause trigger PASS");

  // ---- listingsKycRevokedConsumer ----
  const provK = await mkUser(`m5-provK-${stamp}@test.local`, { provider: true });
  const lstK = await mkListing(provK, cat, "active");
  await db.execute(
    dsql`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('kyc', gen_random_uuid(), 'kyc.expired',
                 jsonb_build_object('provider_id', ${provK}::text))`
  );
  await listingsKycRevokedConsumer();
  const sK = await statusOf(lstK);
  if (sK.status !== "paused" || !sK.reasons.includes("provider_kyc_revoked")) {
    throw new Error(`kyc_revoked consumer fail: ${JSON.stringify(sK)}`);
  }
  console.log("listingsKycRevokedConsumer PASS");

  // ---- listingsCategoryArchivedConsumer ----
  const provC = await mkUser(`m5-provC-${stamp}@test.local`, { provider: true });
  const lstC = await mkListing(provC, cat, "active");
  await db.execute(
    dsql`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('category', ${cat}, 'category.archived',
                 jsonb_build_object('category_id', ${cat}::text))`
  );
  await listingsCategoryArchivedConsumer();
  const sC = await statusOf(lstC);
  if (sC.status !== "paused" || !sC.reasons.includes("category_archived")) {
    throw new Error(`category_archived consumer fail: ${JSON.stringify(sC)}`);
  }
  console.log("listingsCategoryArchivedConsumer PASS");

  // ---- listingsProviderStatusConsumer: suspend → activate ----
  const provS = await mkUser(`m5-provS-${stamp}@test.local`, { provider: true });
  const lstS = await mkListing(provS, cat, "active");
  await db.execute(
    dsql`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('user', ${provS}, 'user.suspended', jsonb_build_object('user_id', ${provS}::text))`
  );
  await listingsProviderStatusConsumer();
  let sS = await statusOf(lstS);
  if (sS.status !== "paused" || !sS.reasons.includes("provider_suspended")) {
    throw new Error(`suspend fail: ${JSON.stringify(sS)}`);
  }
  await db.execute(
    dsql`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('user', ${provS}, 'user.activated', jsonb_build_object('user_id', ${provS}::text))`
  );
  await listingsProviderStatusConsumer();
  sS = await statusOf(lstS);
  if (sS.reasons.includes("provider_suspended")) {
    throw new Error(`activate did not clear reason: ${JSON.stringify(sS)}`);
  }
  console.log("listingsProviderStatusConsumer PASS");

  // ---- listingsRoleRevokedConsumer ----
  const provRr = await mkUser(`m5-provRr-${stamp}@test.local`, { provider: true });
  const lst1 = await mkListing(provRr, cat, "active");
  const lst2 = await mkListing(provRr, cat, "draft");
  await db.execute(
    dsql`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('user', ${provRr}, 'user.role_revoked', jsonb_build_object('user_id', ${provRr}::text))`
  );
  await listingsRoleRevokedConsumer(); // stage A: enqueue
  await listingsRoleRevokedConsumer(); // stage B: drain
  const s1 = await statusOf(lst1);
  const s2 = await statusOf(lst2);
  if (s1.status !== "archived" || s2.status !== "archived") {
    throw new Error(`bulk archive fail: ${JSON.stringify({ s1, s2 })}`);
  }
  console.log("listingsRoleRevokedConsumer PASS");

  // ---- listingDraftAutoArchive (drafts older than 90d) ----
  const provD = await mkUser(`m5-provD-${stamp}@test.local`, { provider: true });
  const lstD = await mkListing(provD, cat, "draft");
  // Backdate so the 90d check fires.
  await db.execute(
    dsql`UPDATE listings SET created_at = now() - interval '120 days' WHERE id = ${lstD}`
  );
  await listingDraftAutoArchive();
  const sD = await statusOf(lstD);
  if (sD.status !== "archived") throw new Error(`draft auto-archive fail: ${JSON.stringify(sD)}`);
  console.log("listingDraftAutoArchive PASS");

  console.log("Module 5 sweep PASS");
  process.exit(0);
}

main().catch((e) => { console.error("Module 5 sweep FAIL", e); process.exit(1); });
