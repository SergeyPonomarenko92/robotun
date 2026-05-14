import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

const client = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === "production" ? 20 : 10,
  // Disable prepare-statement reuse to keep things simple for the dev pool.
  prepare: false,
});

export const db = drizzle(client, { schema });
export const sql = client;
