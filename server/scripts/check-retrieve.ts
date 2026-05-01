/**
 * Smoke test: Postgres connectivity + optional embedding ping (no index required).
 * Usage: POSTGRES_URL=postgres://... npx ts-node --transpile-only scripts/check-retrieve.ts
 */
import pg from "pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    console.error("POSTGRES_URL is not set — skipping retrieve smoke check.");
    process.exit(0);
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const r = await pool.query("SELECT 1 AS ok");
    console.log("POSTGRES_URL OK:", r.rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
