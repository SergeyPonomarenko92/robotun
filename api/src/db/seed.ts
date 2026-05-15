/**
 * Demo seed — mirrors the FE mock's three accounts so the existing /login
 * page chips (client@robotun.dev / provider@robotun.dev / admin@robotun.dev)
 * keep working after the swap to real backend. Idempotent.
 *
 * Run via: `tsx src/db/seed.ts`.
 */
import { eq } from "drizzle-orm";
import { db, sql } from "./client.js";
import { categories, userRoles, users } from "./schema.js";
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
    // mfa_enrolled=false so the demo credentials login without a TOTP
    // code (seeding totp_secret would be pointless — the user can't
    // import a constant secret into their authenticator app). To smoke
    // the MFA flow: log in, /me/mfa/totp/enroll, scan QR, /verify.
    mfa_enrolled: false,
    roles: ["client", "provider"],
  },
  {
    email: "admin@robotun.dev",
    display_name: "Admin · Robotun",
    avatar_url: "https://i.pravatar.cc/120?img=15",
    has_provider_role: false,
    kyc_status: "none",
    payout_enabled: false,
    mfa_enrolled: false,
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

/** Category tree (Module 10 §9.5 — stable UUIDs, mirrors web/_mock taxonomy). */
type SeedCat = { id: string; slug: string; name: string; children?: SeedCat[] };

const CATEGORY_SEED: SeedCat[] = [
  {
    id: "11111111-1111-1111-1111-100000000001",
    slug: "elektryka",
    name: "Електрика",
    children: [
      {
        id: "11111111-1111-1111-1111-100000000002",
        slug: "domashnia-elektryka",
        name: "Домашня електрика",
        children: [
          { id: "11111111-1111-1111-1111-100000000003", slug: "provodka", name: "Заміна проводки" },
          { id: "11111111-1111-1111-1111-100000000004", slug: "rozetky", name: "Заміна розеток" },
          { id: "11111111-1111-1111-1111-100000000005", slug: "svitylnyky", name: "Світильники" },
        ],
      },
    ],
  },
  {
    id: "22222222-2222-2222-2222-200000000001",
    slug: "remont-tekhniky",
    name: "Ремонт побутової техніки",
    children: [
      {
        id: "22222222-2222-2222-2222-200000000002",
        slug: "pralni-mashyny",
        name: "Пральні машини",
        children: [
          { id: "22222222-2222-2222-2222-200000000003", slug: "bosch-siemens", name: "Bosch / Siemens" },
          { id: "22222222-2222-2222-2222-200000000004", slug: "lg-samsung", name: "LG / Samsung" },
        ],
      },
      {
        id: "22222222-2222-2222-2222-200000000005",
        slug: "kholodylnyky",
        name: "Холодильники",
        children: [
          { id: "22222222-2222-2222-2222-200000000006", slug: "usi-brendy", name: "Всі бренди" },
        ],
      },
    ],
  },
  {
    id: "33333333-3333-3333-3333-300000000001",
    slug: "santekhnika",
    name: "Сантехніка",
    children: [
      {
        id: "33333333-3333-3333-3333-300000000002",
        slug: "truby-ta-stoky",
        name: "Труби та стоки",
        children: [
          { id: "33333333-3333-3333-3333-300000000003", slug: "tech-truby", name: "Усунення протікання" },
          { id: "33333333-3333-3333-3333-300000000004", slug: "zasmichennia", name: "Усунення засмічень" },
        ],
      },
    ],
  },
  {
    id: "44444444-4444-4444-4444-400000000001",
    slug: "prybyrannia",
    name: "Прибирання",
    children: [
      {
        id: "44444444-4444-4444-4444-400000000002",
        slug: "kvartyry",
        name: "Квартири",
        children: [
          { id: "44444444-4444-4444-4444-400000000003", slug: "rehuliarne", name: "Регулярне" },
          { id: "44444444-4444-4444-4444-400000000004", slug: "heneralne", name: "Генеральне" },
        ],
      },
    ],
  },
  {
    id: "55555555-5555-5555-5555-500000000001",
    slug: "mebli",
    name: "Меблі під замовлення",
    children: [
      {
        id: "55555555-5555-5555-5555-500000000002",
        slug: "kukhni",
        name: "Кухні",
        children: [
          { id: "55555555-5555-5555-5555-500000000003", slug: "modulni", name: "Модульні" },
        ],
      },
    ],
  },
  {
    id: "66666666-6666-6666-6666-600000000001",
    slug: "klimat-systemy",
    name: "Клімат-системи",
    children: [
      {
        id: "66666666-6666-6666-6666-600000000002",
        slug: "kondytsioner",
        name: "Кондиціонери",
        children: [
          { id: "66666666-6666-6666-6666-600000000003", slug: "montazh-ac", name: "Монтаж" },
          { id: "66666666-6666-6666-6666-600000000004", slug: "chystka-ac", name: "Чистка та сервіс" },
        ],
      },
    ],
  },
];

async function seedCategories() {
  async function walk(node: SeedCat, parent: string | null, level: number) {
    const existing = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, node.id))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(categories).values({
        id: node.id,
        parent_id: parent,
        level,
        name: node.name,
        slug: node.slug,
        admin_created: true,
        status: "active",
      });
      console.log(`[seed] cat ${"  ".repeat(level - 1)}${node.slug}`);
    }
    for (const c of node.children ?? []) await walk(c, node.id, level + 1);
  }
  for (const root of CATEGORY_SEED) await walk(root, null, 1);
}

await main();
await seedCategories();
await sql.end({ timeout: 5 });
