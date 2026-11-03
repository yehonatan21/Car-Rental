'use strict';
// Vehicle documents: the vehicle license (רישיון רכב), insurance policies and other papers, uploaded by an admin.
// Files are stored like driving-license images (storage.js: DATA_DIR, or the database when it is hosted). Documents
// marked "visible to drivers" can be opened by active users, e.g. to show the vehicle license or insurance on the road.
const path = require('node:path');
const { db, audit, defaultVehicle } = require('../db');
const time = require('../time');
const storage = require('../storage');
const { html, postForm, actionButton, field, badge, icon, pageHead, fileInput, uploadLimitLabel } = require('../views/html');
const { uploadName } = require('./public');

const DOC_KINDS = {
  registration: 'רישיון רכב',
  insurance_mandatory: 'ביטוח חובה',
  insurance_comprehensive: 'ביטוח מקיף / צד ג׳',
  other: 'מסמך אחר',
};
// The vehicle's renewal date that a document of this kind keeps up to date (used by the dashboard alerts).
const RENEWAL_FIELD = { registration: 'registration_renewal', insurance_mandatory: 'insurance_renewal', insurance_comprehensive: 'insurance_renewal' };

const documentsOf = (vehicleId, { forDrivers = false } = {}) => db.prepare(`SELECT d.*, u.first_name, u.last_name FROM vehicle_documents d
  LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.vehicle_id = ? ${forDrivers ? 'AND d.visible_to_drivers = 1' : ''}
  ORDER BY CASE d.kind WHEN 'registration' THEN 0 WHEN 'insurance_mandatory' THEN 1 WHEN 'insurance_comprehensive' THEN 2 ELSE 3 END, d.id DESC`)
  .all(vehicleId);

/**
 * Keeps the vehicle's renewal dates in step with its newest documents: the vehicle license date from the newest
 * vehicle-license document, the insurance date from the earliest-expiring of the newest policy of each kind.
 * A date typed by hand stays when there is no dated document of that group.
 */
function syncRenewalDates(vehicleId) {
  const newest = (kind) => db.prepare(`SELECT expires_at FROM vehicle_documents WHERE vehicle_id = ? AND kind = ? AND expires_at IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(vehicleId, kind)?.expires_at;
  const registration = newest('registration');
  const insurance = [newest('insurance_mandatory'), newest('insurance_comprehensive')].filter(Boolean).sort()[0];
  if (registration) db.prepare('UPDATE vehicles SET registration_renewal = ? WHERE id = ?').run(registration, vehicleId);
  if (insurance) db.prepare('UPDATE vehicles SET insurance_renewal = ? WHERE id = ?').run(insurance, vehicleId);
}

function expiryBadge(date) {
  if (!date) return '';
  const today = time.today();
  if (date < today) return badge('blocked', `פג ב־${time.fmt(date)}`);
  if (date <= time.addDays(today, 30)) return badge('pending', `בתוקף עד ${time.fmt(date)}`);
  return badge('active', `בתוקף עד ${time.fmt(date)}`);
}

const docTitle = (d) => d.title || DOC_KINDS[d.kind];

/** "Other" documents that expire within `days` (vehicle license and insurance are alerted through the vehicle dates). */
const expiringOtherDocuments = (vehicleId, days = 30) => db.prepare(`SELECT * FROM vehicle_documents WHERE vehicle_id = ? AND kind = 'other'
  AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at`).all(vehicleId, time.addDays(time.today(), days));

/** The documents card on the admin vehicle page: list, and the upload form. */
function documentsCard(req, vehicle) {
  const docs = documentsOf(vehicle.id);
  return html`<section class="card" id="documents">
  <h2 class="section-title">${icon('file')} מסמכי הרכב</h2>
  ${docs.length ? html`<ul class="plain docs">${docs.map((d) => html`<li>
    <div class="doc-main">
      <a href="/vehicle/documents/${d.id}" target="_blank"><b>${docTitle(d)}</b></a>
      ${d.title ? html`<span class="muted small">${DOC_KINDS[d.kind]}</span>` : ''}
      ${expiryBadge(d.expires_at)}
      ${d.visible_to_drivers ? badge('admin', 'גלוי לנהגים') : ''}
      <br><span class="muted small">הועלה ${time.fmt(d.uploaded_at)}${d.first_name ? ` על ידי ${d.first_name} ${d.last_name}` : ''}</span>
    </div>
    <div class="doc-actions">
      ${actionButton(req, `/admin/vehicle/documents/${d.id}/visibility`, d.visible_to_drivers ? 'הסתרה מנהגים' : 'הצגה לנהגים', { cls: 'btn-light btn-sm' })}
      ${actionButton(req, `/admin/vehicle/documents/${d.id}/delete`, 'מחיקה', { cls: 'btn-danger btn-sm', confirm: `למחוק את "${docTitle(d)}"?` })}
    </div></li>`)}</ul>`
    : html`<p class="empty">${icon('file', 28)}<span>עדיין לא הועלו מסמכים. כדאי להעלות את רישיון הרכב ואת פוליסות הביטוח.</span></p>`}
  ${postForm(req, '/admin/vehicle/documents', html`
    <h3>העלאת מסמך</h3>
    <div class="grid2">
      ${field('סוג המסמך', html`<select name="kind" required>${Object.entries(DOC_KINDS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>`)}
      ${field('בתוקף עד (אופציונלי)', html`<input type="date" name="expires_at">`, 'לרישיון רכב וביטוח: מעדכן גם את מועד החידוש של הרכב')}
    </div>
    ${field('שם המסמך (אופציונלי)', html`<input name="title" maxlength="100" placeholder="למשל: פוליסת ביטוח מקיף 2027">`)}
    ${field('קובץ', fileInput('document'), `תמונה או PDF, עד ${uploadLimitLabel()}`)}
    <label class="check"><input type="checkbox" name="visible_to_drivers" value="1" checked> <span>גלוי לנהגים פעילים (להצגה בזמן נסיעה)</span></label>
    <button class="btn btn-primary">${icon('plus')} העלאת המסמך</button>
  `, 'enctype="multipart/form-data" class="doc-upload"')}
</section>`;
}

module.exports = ({ app, requireLogin, requireAdmin, documentUpload }) => {
  app.post('/admin/vehicle/documents', requireAdmin, documentUpload, (req, res) => {
    const v = defaultVehicle();
    const kind = DOC_KINDS[req.body.kind] ? req.body.kind : null;
    const expires = String(req.body.expires_at || '');
    const error = !req.file ? 'יש לבחור קובץ: תמונה או PDF'
      : !kind ? 'יש לבחור את סוג המסמך'
        : expires && !time.isValidDate(expires) ? 'תאריך התוקף אינו תקין' : null;
    if (error) {
      storage.discard(req.file);
      res.flash('error', error);
      return res.redirect('/admin/vehicle#documents');
    }
    storage.keep(req.file);
    const id = Number(db.prepare(`INSERT INTO vehicle_documents (vehicle_id, kind, title, file, original_name, expires_at, visible_to_drivers,
        uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.id, kind, String(req.body.title || '').trim().slice(0, 100) || null, req.file.filename, uploadName(req.file),
        expires || null, req.body.visible_to_drivers === '1' ? 1 : 0, req.user.id, time.stamp()).lastInsertRowid);
    if (expires) syncRenewalDates(v.id);
    audit(req.user.id, 'vehicle.document_upload', 'vehicle', v.id, `${DOC_KINDS[kind]} #${id}${expires ? ` עד ${expires}` : ''}`);
    res.flash('success', `המסמך "${String(req.body.title || '').trim() || DOC_KINDS[kind]}" נשמר${expires && RENEWAL_FIELD[kind] ? ' ומועד החידוש של הרכב עודכן' : ''}.`);
    res.redirect('/admin/vehicle#documents');
  });

  const docAction = (name, handler) => app.post(`/admin/vehicle/documents/:id/${name}`, requireAdmin, (req, res) => {
    const d = db.prepare('SELECT * FROM vehicle_documents WHERE id = ?').get(Number(req.params.id));
    if (d) res.flash('success', handler(d, req));
    res.redirect('/admin/vehicle#documents');
  });

  docAction('delete', (d, req) => {
    storage.remove(d.file);
    db.prepare('DELETE FROM vehicle_documents WHERE id = ?').run(d.id);
    syncRenewalDates(d.vehicle_id);
    audit(req.user.id, 'vehicle.document_delete', 'vehicle', d.vehicle_id, `${DOC_KINDS[d.kind]} #${d.id}`);
    return `המסמך "${docTitle(d)}" נמחק`;
  });

  docAction('visibility', (d, req) => {
    const visible = d.visible_to_drivers ? 0 : 1;
    db.prepare('UPDATE vehicle_documents SET visible_to_drivers = ? WHERE id = ?').run(visible, d.id);
    audit(req.user.id, 'vehicle.document_visibility', 'vehicle', d.vehicle_id, `#${d.id} ${visible ? 'visible' : 'hidden'}`);
    return visible ? `"${docTitle(d)}" גלוי עכשיו לנהגים` : `"${docTitle(d)}" מוסתר עכשיו מנהגים`;
  });

  // The file itself: any document for admins; for active users only documents marked visible to drivers.
  app.get('/vehicle/documents/:id', requireLogin, (req, res) => {
    const d = db.prepare('SELECT * FROM vehicle_documents WHERE id = ?').get(Number(req.params.id));
    const isAdmin = req.user.role === 'admin' && req.user.status === 'active';
    const allowed = d && (isAdmin || (d.visible_to_drivers && req.user.status === 'active'));
    const data = allowed && storage.read(d.file);
    if (!data) return res.redirect(isAdmin ? '/admin/vehicle#documents' : '/vehicle/documents');
    audit(req.user.id, 'vehicle.document_view', 'vehicle', d.vehicle_id, `#${d.id}`);
    const name = d.original_name || `${DOC_KINDS[d.kind]}${path.extname(d.file)}`;
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.type(path.extname(d.file)).send(data);
  });

  // Drivers: the documents to have at hand while using the car.
  app.get('/vehicle/documents', requireLogin, (req, res) => {
    const v = defaultVehicle();
    const docs = req.user.status === 'active' ? documentsOf(v.id, { forDrivers: true }) : [];
    res.page('מסמכי הרכב', html`
<div class="narrow">
  ${pageHead('מסמכי הרכב', { iconName: 'file', sub: `${[v.make, v.model].filter(Boolean).join(' ')} · ${v.plate}. רישיון הרכב והביטוח להצגה בעת הצורך.` })}
  ${req.user.status !== 'active' ? html`<div class="flash flash-warning">המסמכים זמינים למשתמשים פעילים בלבד.</div>` : ''}
  <section class="card">
    ${docs.length ? html`<ul class="plain docs">${docs.map((d) => html`<li>
      <div class="doc-main"><a href="/vehicle/documents/${d.id}" target="_blank"><b>${docTitle(d)}</b></a> ${expiryBadge(d.expires_at)}
        ${d.title ? html`<br><span class="muted small">${DOC_KINDS[d.kind]}</span>` : ''}</div>
      <div class="doc-actions"><a class="btn btn-light btn-sm" href="/vehicle/documents/${d.id}" target="_blank">${icon('file', 16)} פתיחה</a></div></li>`)}</ul>`
      : html`<p class="empty">${icon('file', 28)}<span>אין עדיין מסמכים להצגה.</span></p>`}
  </section>
</div>`);
  });
};

module.exports.documentsCard = documentsCard;
module.exports.expiringOtherDocuments = expiringOtherDocuments;
module.exports.DOC_KINDS = DOC_KINDS;
module.exports.visibleDocumentCount = (vehicleId) =>
  db.prepare('SELECT COUNT(*) AS n FROM vehicle_documents WHERE vehicle_id = ? AND visible_to_drivers = 1').get(vehicleId).n;
