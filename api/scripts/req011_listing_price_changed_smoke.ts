/**
 * Module 5 REQ-011 — optimistic listing price check on deal create.
 *
 *   - expected matches → ok
 *   - expected differs → 409 listing_price_changed
 *   - expected omitted → ok (skipped)
 *   - listing pricing_type='discuss' → skipped even when expected sent
 */
import { db } from "../src/db/client.js";
import { sql as dsql } from "drizzle-orm";
import { createDeal } from "../src/services/deals.service.js";

async function mkUser(email: string, role: "provider" | "client"): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO users (email, password_hash, display_name, status, email_verified, has_provider_role, kyc_status, mfa_enrolled, payout_enabled)
         VALUES (${email}, '$argon2id$v=19$m=65536,t=3,p=1$DUMMYDUMMYDUMMYDUMMY$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl', ${email.split("@")[0]},
                 'active', true, ${role === "provider"}, 'approved', true, true)
         ON CONFLICT (email) DO UPDATE SET status='active' RETURNING id`
  );
  return r[0]!.id;
}

async function getCategoryId(): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`SELECT id FROM categories WHERE status = 'active' LIMIT 1`
  );
  if (r.length === 0) throw new Error("no active category in DB — seed first");
  return r[0]!.id;
}

async function mkListing(provider: string, categoryId: string, opts: { pricingType: "fixed" | "discuss"; price: number | null }): Promise<string> {
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO listings (provider_id, category_id, title, description, service_type, pricing_type, price_amount, currency, status, version, published_at)
         VALUES (${provider}, ${categoryId}, 'Test listing REQ-011 with sufficient title length', 'Description long enough to satisfy the listings_description_chk constraint applied at the table level for content-quality reasons.', 'remote',
                 ${opts.pricingType}, ${opts.price}, ${opts.pricingType === "discuss" ? null : "UAH"},
                 'active', 1, now())
         RETURNING id`
  );
  return r[0]!.id;
}

async function main() {
  const cat = await getCategoryId();
  const prov = await mkUser(`req011-prov-${Date.now()}@test.local`, "provider");
  const cli = await mkUser(`req011-cli-${Date.now()}@test.local`, "client");
  const listingFixed = await mkListing(prov, cat, { pricingType: "fixed", price: 50_000_00 });
  const listingDiscuss = await mkListing(prov, cat, { pricingType: "discuss", price: null });

  const base = {
    client_id: cli,
    provider_id: prov,
    category_id: cat,
    title: "Test deal REQ-011",
    description: "exercise REQ-011 optimistic price check",
    agreed_price: 50_000_00,
    deadline_at: null,
  };

  // Expected matches → ok.
  const r1 = await createDeal({
    ...base,
    listing_id: listingFixed,
    expected_listing_price_kopecks: 50_000_00,
    idempotency_key: `req011-match-${Date.now()}`,
  });
  if (!r1.ok) throw new Error(`expected match should pass: ${JSON.stringify(r1.error)}`);

  // Expected differs → 409.
  const r2 = await createDeal({
    ...base,
    listing_id: listingFixed,
    expected_listing_price_kopecks: 40_000_00,
    idempotency_key: `req011-diff-${Date.now()}`,
  });
  if (r2.ok || r2.error.code !== "listing_price_changed" || r2.error.status !== 409) {
    throw new Error(`differ should 409: ${JSON.stringify(r2)}`);
  }
  if (r2.error.details?.current_listing_price_kopecks !== 50_000_00) {
    throw new Error(`error details missing current price: ${JSON.stringify(r2.error.details)}`);
  }

  // Expected omitted → ok.
  const r3 = await createDeal({
    ...base,
    listing_id: listingFixed,
    idempotency_key: `req011-omit-${Date.now()}`,
  });
  if (!r3.ok) throw new Error(`omit should pass: ${JSON.stringify(r3.error)}`);

  // discuss listing → skipped even when expected sent.
  const r4 = await createDeal({
    ...base,
    listing_id: listingDiscuss,
    expected_listing_price_kopecks: 99_999_00,
    idempotency_key: `req011-discuss-${Date.now()}`,
  });
  if (!r4.ok) throw new Error(`discuss should skip price check: ${JSON.stringify(r4.error)}`);

  console.log("REQ-011 PASS");
  process.exit(0);
}

main().catch((e) => { console.error("REQ-011 FAIL", e); process.exit(1); });
