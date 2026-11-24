// Usage:  npm run create-admin
// Creates an admin account from the command line (admins cannot be created from the UI).
require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const db = require("../src/config/mysql");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

async function createAdmin() {
  console.log("\n========================================");
  console.log("   PM System - CLI Admin Account Creator ");
  console.log("========================================\n");

  let exitCode = 0;
  try {
    const fullName = (await ask("Enter Admin Full Name: ")).trim();
    const email = (await ask("Enter Admin Email: ")).toLowerCase().trim();
    const password = await ask("Enter Admin Password (min 8 chars): ");

    if (!fullName || !email || !password) {
      throw new Error("All fields are required!");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Invalid email address.");
    }
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await db.execute(
      `INSERT INTO users (full_name, email, password_hash, role, is_active)
       VALUES (?, ?, ?, 'admin', TRUE)`,
      [fullName, email, passwordHash],
    );

    console.log(`\nSuccess: Admin user created! (User ID: ${result.insertId})`);
  } catch (error) {
    exitCode = 1;
    if (error.code === "ER_DUP_ENTRY") {
      console.error("\nError: Email address already registered.");
    } else {
      console.error("\nError creating admin:", error.message);
    }
  } finally {
    rl.close();
    await db.end();
    process.exit(exitCode);
  }
}

createAdmin();
