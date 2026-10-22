'use strict';
// Fills a development database with demo users, bookings and a maintenance block.
// Usage: npm run seed            (only runs on an empty database)
//        npm run seed -- --force (adds the demo data even if users exist)
// All demo accounts use the password "Password1"; the admin is admin@example.org.
const { db, currentPolicy } = require('../src/db');
const auth = require('../src/auth');
const time = require('../src/time');

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}

const force = process.argv.includes('--force');
if (!force && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  console.log('Database already has users; skipping seed (use --force to add demo data anyway).');
  process.exit(0);
}

const PASSWORD = auth.hashPassword('Password1');
const policyVersion = currentPolicy().version;
const day = (n, hhmm) => `${time.addDays(time.today(), n)}T${hhmm}`;

const users = [
  // [first, last, id, phone, email, role, status, license expiry in days]
  ['דנה', 'כהן', '000000018', '0501234567', 'admin@example.org', 'admin', 'active', 900],
  ['נועה', 'לוי', '123456782', '0521112233', 'noa@example.org', 'user', 'active', 400],
  ['יוסי', 'מזרחי', '000000026', '0534445566', 'yossi@example.org', 'user', 'active', 20],
  ['רוני', 'אברהם', '000000034', '0547778899', 'roni@example.org', 'user', 'pending', 200],
  ['מיכל', 'פרץ', '000000042', '0549990000', 'michal@example.org', 'user', 'license_update', -3],
];

const insertUser = db.prepare(`INSERT OR IGNORE INTO users (first_name, last_name, id_number, phone, email, password_hash, role, status,
  license_expiry, license_verified, privacy_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`);
const ids = {};
for (const [first, last, id, phone, email, role, status, days] of users) {
  insertUser.run(first, last, id, phone, email, PASSWORD, role, status, time.addDays(time.today(), days), status === 'pending' ? 0 : 1);
  ids[email] = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  db.prepare('INSERT INTO policy_acceptances (user_id, policy_version) VALUES (?, ?)').run(ids[email], policyVersion);
}

db.prepare(`UPDATE vehicles SET plate = '12-345-67', make = 'טויוטה', model = 'קורולה היברידית',
  insurance_renewal = ?, registration_renewal = ?, next_service = ?,
  instructions = 'הרכב חונה בחניון הבניין, קומה 1-. המפתח בתיבה ליד הכניסה.' WHERE id = 1`)
  .run(time.addDays(time.today(), 12), time.addDays(time.today(), 120), time.addDays(time.today(), 5));

const insertBooking = db.prepare(`INSERT INTO bookings (vehicle_id, user_id, kind, start_at, end_at, purpose, block_reason, status, created_by)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`);
const history = db.prepare('INSERT INTO booking_history (booking_id, from_status, to_status, actor_id, note) VALUES (?, ?, ?, ?, ?)');
const admin = ids['admin@example.org'];
const bookings = [
  [ids['noa@example.org'], 'booking', day(1, '08:00'), day(1, '12:00'), 'פגישה בירושלים', null, 'approved'],
  [ids['yossi@example.org'], 'booking', day(1, '14:00'), day(1, '18:30'), 'קניות', null, 'pending'],
  [ids['yossi@example.org'], 'booking', day(2, '09:00'), day(4, '20:00'), 'נסיעה לצפון', null, 'approved'],
  [null, 'block', day(5, '07:00'), day(5, '13:00'), null, 'טיפול תקופתי', 'approved'],
  [ids['noa@example.org'], 'booking', day(6, '10:00'), day(6, '15:00'), 'ביקור משפחה', null, 'pending'],
  [ids['noa@example.org'], 'booking', day(-7, '09:00'), day(-7, '17:00'), 'טיול', null, 'completed'],
];
for (const [userId, kind, start, end, purpose, reason, status] of bookings) {
  const id = insertBooking.run(userId, kind, start, end, purpose, reason, status, userId ?? admin).lastInsertRowid;
  history.run(id, null, 'pending', userId ?? admin, 'נתוני דמו');
  if (status !== 'pending') history.run(id, 'pending', status, admin, null);
}

console.log('Demo data created. Log in as admin@example.org / Password1 (or noa@example.org, yossi@example.org).');
