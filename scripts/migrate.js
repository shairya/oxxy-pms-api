// Usage:
//   npm run migrate            -> creates the database if needed, runs pending migrations
//   npm run migrate -- status  -> lists applied / pending migrations
//
// Migrations are the .sql files in database/migrations, run in filename order
// (001_..., 002_...). Each applied file is recorded in the schema_migrations
// table so it never runs twice. To change the schema later, add a NEW file
// (e.g. 002_add_task_labels.sql) - never edit one that has already been applied.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const MIGRATIONS_DIR = path.join(__dirname, "..", "database", "migrations");
const DB_NAME = process.env.DB_NAME || "pm_system";

if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  console.error("DB_NAME may only contain letters, numbers and underscores.");
  process.exit(1);
}

const checksum = (sql) => crypto.createHash("sha256").update(sql).digest("hex");

async function main() {
  const mode = process.argv[2] || "up";

  // Connect without a database first so we can create it
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    multipleStatements: true,
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${DB_NAME}\``);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const [rows] = await conn.query("SELECT name, checksum FROM schema_migrations");
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    // Warn if an already-applied file was edited afterwards
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      if (applied.has(file) && applied.get(file) !== checksum(sql)) {
        console.warn(`Warning: ${file} was changed after it was applied. Add a new migration instead.`);
      }
    }

    const pending = files.filter((f) => !applied.has(f));

    if (mode === "status") {
      console.log(`Database: ${DB_NAME}`);
      files.forEach((f) => console.log(`  ${applied.has(f) ? "[applied]" : "[pending]"} ${f}`));
      return;
    }
    if (mode !== "up") throw new Error(`Unknown command "${mode}". Use: npm run migrate [-- status]`);

    if (pending.length === 0) {
      console.log(`Database "${DB_NAME}" is up to date.`);
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`Applying ${file} ... `);
      // Note: MySQL commits CREATE/ALTER TABLE immediately, so a failed file can be
      // partly applied. Write migrations with IF NOT EXISTS where possible.
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)", [file, checksum(sql)]);
      console.log("done");
    }
    console.log(`\n${pending.length} migration(s) applied to "${DB_NAME}".`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
