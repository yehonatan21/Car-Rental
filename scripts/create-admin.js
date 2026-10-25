'use strict';
// Creates (or promotes) an administrator account.
// Usage: npm run create-admin -- --email admin@example.org --password 'S3cret!!' --first דנה --last כהן --phone 0501234567 --id 000000018
const { db, audit, currentPolicy } = require('../src/db');
const auth = require('../src/auth');
const time = require('../src/time');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

if (!args.email || !args.password || args.password.length < 8) {
  console.error('Usage: npm run create-admin -- --email EMAIL --password PASSWORD(8+) [--first NAME --last NAME --phone PHONE --id ID_NUMBER]');
  process.exit(1);
}

const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(args.email);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin', status = 'active', password_hash = ? WHERE id = ?").run(auth.hashPassword(args.password), existing.id);
  audit(null, 'admin.promote_cli', 'user', existing.id);
  console.log(`User ${args.email} is now an active admin.`);
} else {
  const now = time.stamp();
  const id = db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, password_hash, role, status,
      privacy_accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'admin', 'active', ?, ?, ?)`).run(
    args.first || 'מנהל', args.last || 'מערכת', args.id || `admin-${Date.now()}`, args.phone || '', args.email, auth.hashPassword(args.password),
    now, now, now,
  ).lastInsertRowid;
  db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, accepted_at) VALUES (?, ?, ?)').run(id, currentPolicy().version, now);
  audit(null, 'admin.create_cli', 'user', Number(id));
  console.log(`Admin ${args.email} created.`);
}
