import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config.js";
import * as schema from "./schema.js";

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

type Db = PostgresJsDatabase<typeof schema>;

/**
 * `DATABASE_URL=pglite:memory` gives a throwaway in-process Postgres (PGlite) with all migrations applied,
 * for scripts such as agent-dry-run. PGlite is a dev dependency and is only loaded in that mode.
 * The query builder API is the same; raw `db.execute()` results differ in shape (jobs.ts is Postgres-only).
 */
async function connect(): Promise<{ db: Db; sql: { end(): Promise<unknown> } }> {
  if (env.DATABASE_URL === "pglite:memory") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    const pgliteDb = drizzlePglite(client, { schema });
    await migrate(pgliteDb, { migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)) });
    return { db: pgliteDb as unknown as Db, sql: { end: () => client.close() } };
  }
  const sql = postgres(env.DATABASE_URL, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}

export const { db, sql } = await connect();
export { schema };
