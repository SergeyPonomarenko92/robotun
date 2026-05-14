/** Apply pending migrations against the configured DATABASE_URL.
 *  Invoked via `npm run db:migrate`. CI/prod calls this on each deploy. */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client.js";

await migrate(db, { migrationsFolder: "./migrations" });
console.log("[db:migrate] applied");
await sql.end({ timeout: 5 });
