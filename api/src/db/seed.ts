/**
 * Demo seed — mirrors the FE mock's three accounts so the existing /login
 * page chips (client@robotun.dev / provider@robotun.dev / admin@robotun.dev)
 * keep working after the swap to real backend. Idempotent.
 *
 * Run via: `tsx src/db/seed.ts`.
 */
import { eq } from "drizzle-orm";
import { db, sql } from "./client.js";
import { userRoles, users } from "./schema.js";
import { hashPassword } from "../services/crypto.js";

type SeedUser = {
  email: string;
  display_name: string;
  avatar_url?: string;
  has_provider_role: boolean;
  kyc_status: "none" | "approved";
  payout_enabled: boolean;
  mfa_enrolled: boolean;
  roles: ("client" | "provider" | "admin")[];
};

const PASSWORD = "demo1234";

const SEEDS: SeedUser[] = [
  {
    email: "client@robotun.dev",
    display_name: "Сергій П.",
    avatar_url: "https://i.pravatar.cc/120?img=51",
    has_provider_role: false,
    kyc_status: "none",
    payout_enabled: false,
    mfa_enrolled: false,
    roles: ["client"],
  },
  {
    email: "provider@robotun.dev",
    display_name: "Bosch Group Service",
    avatar_url: "https://i.pravatar.cc/120?img=12",
    has_provider_role: true,
    kyc_status: "approved",
    payout_enabled: true,
    mfa_enrolled: true,
    roles: ["client", "provider"],
  },
  {
    email: "admin@robotun.dev",
    display_name: "Admin · Robotun",
    avatar_url: "https://i.pravatar.cc/120?img=15",
    has_provider_role: false,
    kyc_status: "none",
    payout_enabled: false,
    mfa_enrolled: true,
    roles: ["admin"],
  },
];

async function main() {
  const password_hash = await hashPassword(PASSWORD);
  for (const s of SEEDS) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, s.email))
      .limit(1);
    if (existing.length > 0) {
      console.log(`[seed] skip ${s.email} (exists)`);
      continue;
    }
    const [u] = await db
      .insert(users)
      .values({
        email: s.email,
        password_hash,
        display_name: s.display_name,
        avatar_url: s.avatar_url,
        email_verified: true,
        status: "active",
        has_provider_role: s.has_provider_role,
        kyc_status: s.kyc_status,
        payout_enabled: s.payout_enabled,
        mfa_enrolled: s.mfa_enrolled,
      })
      .returning({ id: users.id });
    if (!u) throw new Error("seed insert returned no row");
    for (const r of s.roles) {
      await db.insert(userRoles).values({ user_id: u.id, role: r });
    }
    console.log(`[seed] inserted ${s.email}`);
  }
}

await main();
await sql.end({ timeout: 5 });
