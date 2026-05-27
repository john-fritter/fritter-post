/**
 * Migration runner. Reads numbered .sql files from migrations/, applies any
 * not yet recorded in the _migrations table, and records completions.
 *
 * Usage: npm run migrate
 *
 * The _migrations table is created on first run if it doesn't exist. Migrations
 * are applied in filename order and wrapped in transactions so a failure leaves
 * the database in a clean state.
 */

import "dotenv/config";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { Pool } from "pg";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "migrations");

async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    // Bootstrap: create the migrations tracking table if it doesn't exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Collect applied migrations.
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY name"
    );
    const applied = new Set(rows.map((r) => r.name));

    // Discover migration files.
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const filename of pending) {
      const filepath = path.join(MIGRATIONS_DIR, filename);
      const sql = await readFile(filepath, "utf-8");

      console.log(`Applying ${filename}…`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO _migrations (name) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
        console.log(`  ✓ ${filename}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ✗ ${filename} failed, rolled back.`);
        throw err;
      }
    }

    console.log("Done.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
