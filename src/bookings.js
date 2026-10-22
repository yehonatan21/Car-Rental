'use strict';
// Booking rules: validation, overlap prevention and status transitions.
const { db, transaction, getSettings, userAcceptedPolicy, audit } = require('./db');
const time = require('./time');

class BookingError extends Error {}

const STATUS_LABELS = {
  pending: 'ממתינה לאישור',
  approved: 'מאושרת',
  rejected: 'נדחתה',
  cancelled: 'בוטלה',
  completed: 'הסתיימה',
};

/**
 * Approved bookings and maintenance blocks that collide with [start, end),
 * including the configured turnaround buffer on both sides. Pending requests never block.
 */
function findConflicts(vehicleId, start, end, { excludeId = 0, buffer } = {}) {
  const b = buffer ?? getSettings().buffer_minutes;
  return db.prepare(`
    SELECT b.*, u.first_name, u.last_name FROM bookings b LEFT JOIN users u ON u.id = b.user_id
    WHERE b.vehicle_id = ? AND b.id != ? AND b.status = 'approved'
      AND b.start_at < ? AND b.end_at > ?
    ORDER BY b.start_at`).all(vehicleId, excludeId, time.addMinutes(end, b), time.addMinutes(start, -b));
}

/** Other pending requests for an overlapping slot — shown to the admin so they can choose. */
function findPendingOverlaps(vehicleId, start, end, excludeId = 0) {
  return db.prepare(`
    SELECT b.*, u.first_name, u.last_name FROM bookings b LEFT JOIN users u ON u.id = b.user_id
    WHERE b.vehicle_id = ? AND b.id != ? AND b.status = 'pending' AND b.start_at < ? AND b.end_at > ?
    ORDER BY b.created_at`).all(vehicleId, excludeId, end, start);
}

/** Reasons a user may not drive in [start, end); empty when allowed. */
function eligibilityProblems(user, end) {
  const problems = [];
  if (user.status !== 'active') problems.push('החשבון אינו פעיל להזמנות');
  if (!user.license_verified || !user.license_expiry) problems.push('רישיון הנהיגה טרם אושר על ידי המנהל');
  else if (user.license_expiry < end.slice(0, 10)) problems.push('רישיון הנהיגה אינו בתוקף לכל תקופת ההזמנה');
  if (!userAcceptedPolicy(user.id)) problems.push('יש לאשר את נהלי השאלת הרכב העדכניים');
  return problems;
}

function validateRange(start, end) {
  if (!time.isValidLocal(start) || !time.isValidLocal(end)) throw new BookingError('יש להזין תאריך ושעה תקינים');
  if (end <= start) throw new BookingError('מועד ההחזרה חייב להיות אחרי מועד האיסוף');
}

function addHistory(bookingId, from, to, actorId, note) {
  db.prepare('INSERT INTO booking_history (booking_id, from_status, to_status, actor_id, note) VALUES (?, ?, ?, ?, ?)')
    .run(bookingId, from, to, actorId ?? null, note || null);
}

function changeStatus(booking, to, actorId, note) {
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(to, booking.id);
  addHistory(booking.id, booking.status, to, actorId, note);
}

function getBooking(id) {
  return db.prepare(`
    SELECT b.*, u.first_name, u.last_name, u.email, u.phone, v.plate, v.make, v.model, v.instructions
    FROM bookings b LEFT JOIN users u ON u.id = b.user_id JOIN vehicles v ON v.id = b.vehicle_id
    WHERE b.id = ?`).get(id);
}

function conflictMessage(conflicts) {
  const c = conflicts[0];
  const what = c.kind === 'block' ? 'חסימת תחזוקה' : 'הזמנה מאושרת';
  return `הרכב תפוס במועד זה (${what} ${time.fmt(c.start_at)}–${time.fmt(c.end_at)})`;
}

function checkVehicle(vehicleId) {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!v) throw new BookingError('הרכב לא נמצא');
  if (v.status === 'disabled') throw new BookingError('הרכב מושבת כרגע ואינו זמין להזמנה');
  return v;
}

/** A user's own request. Always lands as "pending"; the admin decides. */
function createRequest(user, { vehicleId, start, end, purpose, notes }) {
  validateRange(start, end);
  const s = getSettings();
  if (start < time.now()) throw new BookingError('לא ניתן להזמין מועד שכבר עבר');
  if (s.max_booking_hours > 0 && time.hoursBetween(start, end) > s.max_booking_hours) {
    throw new BookingError(`משך הזמנה מקסימלי הוא ${s.max_booking_hours} שעות`);
  }
  const problems = eligibilityProblems(user, end);
  if (problems.length) throw new BookingError(problems.join('. '));
  checkVehicle(vehicleId);
  if (s.max_open_bookings > 0) {
    const open = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND kind = 'booking'
      AND status IN ('pending','approved') AND end_at > ?`).get(user.id, time.now()).n;
    if (open >= s.max_open_bookings) throw new BookingError(`ניתן להחזיק עד ${s.max_open_bookings} הזמנות פתוחות במקביל`);
  }
  const conflicts = findConflicts(vehicleId, start, end);
  if (conflicts.length) throw new BookingError(conflictMessage(conflicts));

  const id = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, purpose, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(vehicleId, user.id, start, end, purpose || null, notes || null, user.id).lastInsertRowid);
  addHistory(id, null, 'pending', user.id, 'בקשה הוגשה');
  return getBooking(id);
}

/** Admin approval. Availability and eligibility are re-checked atomically at this moment. */
function approve(bookingId, adminId) {
  return transaction(() => {
    const b = getBooking(bookingId);
    if (!b) throw new BookingError('ההזמנה לא נמצאה');
    if (b.status !== 'pending') throw new BookingError('ניתן לאשר רק בקשה שממתינה לאישור');
    if (b.end_at <= time.now()) throw new BookingError('מועד הבקשה כבר חלף');
    checkVehicle(b.vehicle_id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(b.user_id);
    const problems = eligibilityProblems(user, b.end_at);
    if (problems.length) throw new BookingError('לא ניתן לאשר: ' + problems.join('. '));
    const conflicts = findConflicts(b.vehicle_id, b.start_at, b.end_at, { excludeId: b.id });
    if (conflicts.length) throw new BookingError(conflictMessage(conflicts));
    changeStatus(b, 'approved', adminId);
    audit(adminId, 'booking.approve', 'booking', b.id);
    return getBooking(b.id);
  });
}

function reject(bookingId, adminId, note) {
  const b = getBooking(bookingId);
  if (!b || b.status !== 'pending') throw new BookingError('ניתן לדחות רק בקשה שממתינה לאישור');
  changeStatus(b, 'rejected', adminId, note);
  audit(adminId, 'booking.reject', 'booking', b.id, note);
  return getBooking(b.id);
}

/** Users may cancel pending requests any time, approved ones until the configured cutoff. Admins always. */
function cancel(bookingId, actor, note) {
  const b = getBooking(bookingId);
  if (!b) throw new BookingError('ההזמנה לא נמצאה');
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && b.user_id !== actor.id) throw new BookingError('ההזמנה לא נמצאה');
  if (!['pending', 'approved'].includes(b.status)) throw new BookingError('לא ניתן לבטל הזמנה בסטטוס זה');
  if (!isAdmin && b.status === 'approved') {
    const hours = getSettings().cancel_hours_before;
    if (time.hoursBetween(time.now(), b.start_at) < hours) {
      throw new BookingError(`ניתן לבטל הזמנה מאושרת עד ${hours} שעות לפני תחילתה. לביטול מאוחר יותר יש לפנות למנהל`);
    }
  }
  changeStatus(b, 'cancelled', actor.id, note || (isAdmin ? 'בוטלה על ידי המנהל' : 'בוטלה על ידי המשתמש'));
  if (isAdmin) audit(actor.id, 'booking.cancel', 'booking', b.id, note);
  return getBooking(b.id);
}

/** Admin books on behalf of a user; created already approved. */
function createManual(adminId, { vehicleId, userId, start, end, purpose, notes }) {
  validateRange(start, end);
  return transaction(() => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new BookingError('יש לבחור משתמש');
    const problems = eligibilityProblems(user, end);
    if (problems.length) throw new BookingError('לא ניתן להזמין עבור משתמש זה: ' + problems.join('. '));
    checkVehicle(vehicleId);
    const conflicts = findConflicts(vehicleId, start, end);
    if (conflicts.length) throw new BookingError(conflictMessage(conflicts));
    const id = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, purpose, notes, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`).run(vehicleId, userId, start, end, purpose || null, notes || null, adminId).lastInsertRowid);
    addHistory(id, null, 'approved', adminId, 'הזמנה ידנית על ידי המנהל');
    audit(adminId, 'booking.manual', 'booking', id);
    return getBooking(id);
  });
}

/** Maintenance / internal-use block: occupies the calendar without a user. */
function createBlock(adminId, { vehicleId, start, end, reason }) {
  validateRange(start, end);
  if (!reason) throw new BookingError('יש לציין סיבת חסימה');
  return transaction(() => {
    const conflicts = findConflicts(vehicleId, start, end, { buffer: 0 });
    if (conflicts.length) throw new BookingError(conflictMessage(conflicts) + '. יש לבטל אותה לפני החסימה');
    const id = Number(db.prepare(`INSERT INTO bookings (vehicle_id, kind, start_at, end_at, block_reason, status, created_by)
      VALUES (?, 'block', ?, ?, ?, 'approved', ?)`).run(vehicleId, start, end, reason, adminId).lastInsertRowid);
    addHistory(id, null, 'approved', adminId, 'חסימת יומן: ' + reason);
    audit(adminId, 'block.create', 'booking', id, reason);
    return getBooking(id);
  });
}

/** Approved bookings whose end time passed become "completed". Returns how many changed. */
function completeFinished() {
  const done = db.prepare("SELECT * FROM bookings WHERE status = 'approved' AND end_at <= ?").all(time.now());
  for (const b of done) changeStatus(b, 'completed', null, 'מועד ההזמנה הסתיים');
  return done.length;
}

/** Calendar entries in a window. */
function inRange(vehicleId, from, to, statuses = ['approved']) {
  const marks = statuses.map(() => '?').join(',');
  return db.prepare(`
    SELECT b.*, u.first_name, u.last_name FROM bookings b LEFT JOIN users u ON u.id = b.user_id
    WHERE b.vehicle_id = ? AND b.start_at < ? AND b.end_at > ? AND b.status IN (${marks})
    ORDER BY b.start_at`).all(vehicleId, to, from, ...statuses);
}

module.exports = {
  BookingError, STATUS_LABELS, findConflicts, findPendingOverlaps, eligibilityProblems,
  createRequest, approve, reject, cancel, createManual, createBlock, completeFinished,
  getBooking, inRange, addHistory,
};
