# @robotun/api

Real backend service — Fastify + Drizzle + Postgres. Replaces the
in-memory mock that lives under `web/src/app/api/v1/*`. Modules ported
from the FE mock one at a time per the migration plan.

## Stack

| Layer      | Choice                              |
|------------|-------------------------------------|
| HTTP       | Fastify 4                           |
| DB         | Postgres 15 via `postgres` driver   |
| ORM        | Drizzle (schema-as-code)            |
| Object store | S3-compat (MinIO locally, AWS S3 prod) |
| Cache / pub-sub | Redis 7                        |
| Validation | zod (request schemas + env)         |
| Hashing    | argon2id (passwords) / SHA-256 (refresh tokens) |
| JWT        | RS256 via `jose`                    |

## Local setup

```bash
# 1. Bring up infra (Postgres + Redis + MinIO).
docker compose up -d postgres redis minio

# 2. Generate RS256 keypair for JWT signing.
mkdir -p api/keys
openssl genpkey -algorithm RSA -out api/keys/jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in api/keys/jwt-private.pem -pubout -out api/keys/jwt-public.pem

# 3. Install + bootstrap env.
cd api
cp .env.example .env
npm install

# 4. Apply migrations.
npm run db:migrate

# 5. Run dev server (pino-pretty logs).
npm run dev   # listens on :4000
```

`GET http://localhost:4000/health` → `{ "ok": true, ... }`.

## Migrations

Drizzle schema lives in `src/db/schema.ts`. After editing:

```bash
npm run db:generate   # emits SQL into ./migrations/
npm run db:migrate    # applies pending migrations
```

Generated SQL is reviewed in PR; never edit committed `*.sql` files —
generate a new migration instead.

## Module status

| Module | Mock (web/) | Real (api/) |
|--------|-------------|-------------|
| 1  Auth                | ✅ | 🛠  in progress |
| 2  Messaging           | ✅ | — |
| 3  Deals               | ✅ | — |
| 4  KYC                 | ✅ | — |
| 5  Listings            | ✅ | — |
| 6  Media               | ✅ | — |
| 7  Reviews             | ✅ | — |
| 8  Feed                | ✅ | — |
| 9  Notifications       | ✅ | — |
| 10 Categories          | ✅ | — |
| 11 Payments            | ✅ | — |
| 12 Admin tooling       | ✅ | — |
| 14 Disputes            | ✅ | — |
