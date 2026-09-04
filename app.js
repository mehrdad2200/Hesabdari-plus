/* =============================================================================
   حسابداری پلاس — Online Store Accounting App
   Single-file client app: customers, inventory, sales & purchase invoices,
   treasury (cash & bank), expenses, reports, settings, backup/restore.
   All data lives in localStorage on this device (see "پشتیبان‌گیری" to
   export/import a JSON backup or move data to another device/browser).
   ============================================================================= */

/* ---------------------------------------------------------------------------
   Storage keys & low-level read/write
   ------------------------------------------------------------------------- */
const K = {
    settings: 'ap_settings',
    customers: 'ap_customers',
    products: 'ap_products',
    invoices: 'ap_invoices',
    purchases: 'ap_purchases',
    expenses: 'ap_expenses',
    cashtx: 'ap_cashtx',
    seeded: 'ap_seeded',
    categories: 'ap_categories',
    checks: 'ap_checks',
    stocktakes: 'ap_stocktakes',
    backupLog: 'ap_backuplog',
    bankAccounts: 'ap_bankaccounts',
    employees: 'ap_employees',
    payroll: 'ap_payroll',
    customerPayments: 'ap_customerpayments',
    supplierPayments: 'ap_supplierpayments',
    otherAssets: 'ap_otherassets',
    partners: 'ap_partners'
};

/* Wrap the browser confirm() so the "confirm before destructive action" setting can be honored. */
function confirmAction(msg) {
    if (getSettings().confirmBeforeDelete === false) return true;
    return confirm(msg);
}

/* ---------------------------------------------------------------------------
   Dated backup history — stored in IndexedDB (NOT localStorage).
   Why: keeping many full-database copies (one per day) inside localStorage is
   what used to fill up its small (~5-10MB) quota after a handful of edits and
   trigger the "ذخیره‌سازی ناموفق" error. IndexedDB has a vastly larger quota,
   so we can safely keep up to a full year of daily snapshots there while
   localStorage only ever holds the live, current data.
   ------------------------------------------------------------------------- */
const BACKUP_DB_NAME = 'ap_backups_db';
const BACKUP_STORE = 'snapshots';
function openBackupDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('no-idb')); return; }
        const req = indexedDB.open(BACKUP_DB_NAME, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(BACKUP_STORE)) req.result.createObjectStore(BACKUP_STORE, { keyPath: 'date' }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function backupLogGetAll() {
    return openBackupDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(BACKUP_STORE, 'readonly');
        const req = tx.objectStore(BACKUP_STORE).getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.date < b.date ? 1 : -1));
        req.onerror = () => reject(req.error);
    })).catch(() => []);
}
function backupLogGet(date) {
    return backupLogGetAll().then(all => all.find(e => e.date === date));
}
function backupLogPut(entry) {
    return openBackupDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(BACKUP_STORE, 'readwrite');
        tx.objectStore(BACKUP_STORE).put(entry);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    })).then(() => backupLogTrim()).catch(() => {});
}
function backupLogTrim() {
    const days = num(getSettings().backupRetentionDays) || 365;
    return backupLogGetAll().then(all => {
        if (all.length <= days) return;
        const toDrop = all.slice(days); // list is sorted newest-first, so the tail is oldest
        return openBackupDb().then(db => {
            const tx = db.transaction(BACKUP_STORE, 'readwrite');
            toDrop.forEach(e => tx.objectStore(BACKUP_STORE).delete(e.date));
        });
    }).catch(() => {});
}
let _backupLogCache = [];
function refreshBackupLogCache() {
    backupLogGetAll().then(list => { _backupLogCache = list; if (currentView === 'backup') switchView('backup'); }).catch(() => {});
}

/* Debounced auto-backup: after every data-changing action, refresh the dated
   backup snapshot in IndexedDB and (if the user granted folder access via the
   File System Access API) silently write an updated JSON file to their chosen
   backup folder. Rolls a fresh "end of day" snapshot the first time a change
   happens on a new calendar day, and keeps updating that same day's entry
   afterwards so it always reflects the latest data. */
let _autoBackupTimer = null;
function autoBackupTick() {
    clearTimeout(_autoBackupTimer);
    _autoBackupTimer = setTimeout(() => { doAutoBackup().catch(() => {}); }, 900);
    cloudSyncTick();
}
async function doAutoBackup() {
    const data = {};
    Object.entries(K).forEach(([name, key]) => { data[name] = JSON.parse(localStorage.getItem(key) || 'null'); });
    data.exportedAt = todayISO();
    data.app = 'حسابداری پلاس';
    const json = JSON.stringify(data);

    try { localStorage.setItem('ap_last_backup_time', todayISO()); } catch (e) {}

    const todayKey = new Date().toISOString().slice(0, 10);
    await backupLogPut({ date: todayKey, jalaliLabel: isoToJalaliStr(todayISO()), json, savedAt: todayISO() });
    refreshBackupLogCache();

    // silent write to a user-granted folder handle, if available (Chrome/Edge only)
    if (window._apBackupDirHandle) {
        try {
            const fh = await window._apBackupDirHandle.getFileHandle('پشتیبان-حسابداری-پلاس.json', { create: true });
            const writable = await fh.createWritable();
            await writable.write(json);
            await writable.close();
        } catch (e) { /* permission may have been revoked; ignore silently */ }
    }
}

function dbRead(key) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : (v || []); } catch (e) { return []; } }
function dbWrite(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) {
        // Quota errors on the small (~5-10MB) localStorage store used to be common because dated
        // backups were also being kept there; those now live in IndexedDB instead (see above), so
        // this should be rare — it's kept only as an honest last-resort warning.
        showToast('ذخیره‌سازی این مورد ناموفق بود؛ فضای ذخیره‌سازی مرورگر پر است. از «تنظیمات ← پشتیبان‌گیری» یک فایل پشتیبان دانلود کنید و سپس داده‌های قدیمی/نمونه غیرضروری را پاک کنید.', 'error');
        return false;
    }
}

function getSettings() {
    try { return JSON.parse(localStorage.getItem(K.settings)) || {}; } catch (e) { return {}; }
}
function saveSettings(patch) {
    const s = Object.assign({}, getSettings(), patch);
    localStorage.setItem(K.settings, JSON.stringify(s));
    return s;
}

/* ---------------------------------------------------------------------------
   Generic helpers
   ------------------------------------------------------------------------- */
function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toEnglishDigits(str) {
    const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
    return String(str == null ? '' : str).replace(/[۰-۹٠-٩]/g, (ch) => {
        const i1 = fa.indexOf(ch); if (i1 !== -1) return i1;
        const i2 = ar.indexOf(ch); if (i2 !== -1) return i2;
        return ch;
    });
}
function num(v) {
    const n = parseFloat(toEnglishDigits(v == null ? '' : v).toString().replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
}

/* ---------------------------------------------------------------------------
   Live thousands-separator formatting for money-like numeric fields (so users
   never lose track of how many digits/zeros they've typed). Applied globally
   via delegation, so every current AND future numeric input gets it for free
   — except identifier-like fields (phone, sayad, account/card/check numbers,
   percentages, quantities) which must stay as plain digits.
   ------------------------------------------------------------------------- */
const NON_MONEY_FIELD_PATTERN = /(sayad|accno|cardno|number|phone|tel|percent|national|postal|zip|qty|Qty)/i;
function isMoneyNumericInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if ((el.getAttribute('inputmode') || '') !== 'numeric') return false;
    if (NON_MONEY_FIELD_PATTERN.test(el.id || '')) return false;
    return true;
}
function formatMoneyLive(el) {
    const digitsOnly = toEnglishDigits(el.value).replace(/[^0-9.\-]/g, '');
    if (digitsOnly === '' || digitsOnly === '-') return;
    const neg = digitsOnly.startsWith('-');
    const body = neg ? digitsOnly.slice(1) : digitsOnly;
    const [intRaw, ...restParts] = body.split('.');
    const intPart = intRaw.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') || '0';
    const formatted = (neg ? '-' : '') + intPart + (restParts.length ? '.' + restParts.join('') : '');
    if (formatted === el.value) return;
    const cursorFromEnd = el.value.length - (el.selectionStart == null ? el.value.length : el.selectionStart);
    el.value = formatted;
    const newPos = Math.max(0, formatted.length - cursorFromEnd);
    try { el.setSelectionRange(newPos, newPos); } catch (e) {}
}
document.addEventListener('input', (e) => { if (isMoneyNumericInput(e.target)) formatMoneyLive(e.target); }, true);
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function currencyLabel() { return getSettings().currency || 'تومان'; }
function digitConvert(s) {
    s = String(s);
    if (getSettings().digitStyle === 'en') return s; // toLocaleString('fa-IR') already gave Persian digits; 'en' path below handles it
    return s;
}
function localeForDigits() { return (getSettings().digitStyle === 'en') ? 'en-US' : 'fa-IR'; }
function money(n) {
    n = Math.round(num(n));
    return n.toLocaleString(localeForDigits()) + ' ' + currencyLabel();
}
function moneyPlain(n) { return Math.round(num(n)).toLocaleString(localeForDigits()); }
function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('fa-IR'); } catch (e) { return iso || ''; }
}
function fmtDateTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('fa-IR') + ' - ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso || ''; }
}
function todayISO() { return new Date().toISOString(); }
function daysAgoISO(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }

/* ---------------------------------------------------------------------------
   Jalali (Persian/Shamsi) calendar — conversion + a lightweight picker.
   All manual date entry in the app uses this; no Gregorian input is shown
   to the user anywhere.
   ------------------------------------------------------------------------- */
const FA_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const FA_WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
function j_div(a, b) { return ~~(a / b); }
function jalaliToGregorian(jy, jm, jd) {
    // days elapsed since Farvardin 1, year 1
    let jy1 = jy - 979, jm1 = jm - 1, jd1 = jd - 1;
    let jDayNo = 365 * jy1 + j_div(jy1, 33) * 8 + j_div((jy1 % 33) + 3, 4);
    for (let i = 0; i < jm1; i += 1) jDayNo += (i < 6) ? 31 : 30;
    jDayNo += jd1;
    let gDayNo = jDayNo + 79;
    let gy = 1600 + 400 * j_div(gDayNo, 146097);
    gDayNo = gDayNo % 146097;
    let leap = true;
    if (gDayNo >= 36525) {
        gDayNo -= 1; gy += 100 * j_div(gDayNo, 36524); gDayNo = gDayNo % 36524;
        if (gDayNo >= 365) gDayNo += 1; else leap = false;
    }
    gy += 4 * j_div(gDayNo, 1461); gDayNo %= 1461;
    if (gDayNo >= 366) { leap = false; gDayNo -= 1; gy += j_div(gDayNo, 365); gDayNo = gDayNo % 365; }
    const gDaysInMonth = [31, (gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm = 0;
    while (gm < 12 && gDayNo >= gDaysInMonth[gm]) { gDayNo -= gDaysInMonth[gm]; gm += 1; }
    return { gy, gm: gm + 1, gd: gDayNo + 1 };
}
function gregorianToJalali(gy, gm, gd) {
    const gDaysInMonth = [31, (gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gDayNo = 0;
    for (let i = 0; i < gm - 1; i += 1) gDayNo += gDaysInMonth[i];
    gDayNo += gd - 1;
    let gy1 = gy - 1600;
    let gDayNo2 = gDayNo + 365 * gy1 + j_div(gy1 + 3, 4) - j_div(gy1 + 99, 100) + j_div(gy1 + 399, 400);
    let jDayNo = gDayNo2 - 79;
    const jNp = j_div(jDayNo, 12053);
    jDayNo %= 12053;
    let jy = 979 + 33 * jNp + 4 * j_div(jDayNo, 1461);
    jDayNo %= 1461;
    if (jDayNo >= 366) { jy += j_div(jDayNo - 1, 365); jDayNo = (jDayNo - 1) % 365; }
    let jm, jd;
    if (jDayNo < 186) { jm = 1 + j_div(jDayNo, 31); jd = (jDayNo % 31) + 1; }
    else { jm = 7 + j_div(jDayNo - 186, 30); jd = ((jDayNo - 186) % 30) + 1; }
    return { jy, jm, jd };
}
function isoToJalaliParts(iso) {
    try { const d = new Date(iso); return gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
    catch (e) { const d = new Date(); return gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
}
function isoToJalaliStr(iso) {
    if (!iso) return '';
    const j = isoToJalaliParts(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}
/* Groups a list of records by Jalali year-month (newest month first) and renders a labeled
   section per month — used for lists that grow large over time (invoices, transactions, ...). */
function monthGroupedListHtml(items, dateGetter, itemRenderer, minCountToGroup) {
    minCountToGroup = minCountToGroup || 12;
    if (items.length < minCountToGroup) return items.map(itemRenderer).join('');
    const groups = {};
    items.forEach(it => {
        const iso = dateGetter(it);
        const j = isoToJalaliParts(iso || todayISO());
        const key = `${j.jy}-${String(j.jm).padStart(2, '0')}`;
        if (!groups[key]) groups[key] = { label: `${FA_MONTHS[j.jm - 1]} ${String(j.jy).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])}`, items: [] };
        groups[key].items.push(it);
    });
    const keys = Object.keys(groups).sort().reverse();
    return keys.map(k => `
        <div class="section-title" style="margin-top:14px; display:flex; align-items:center; gap:8px;">📅 ${esc(groups[k].label)} <span class="badge badge-cyan">${groups[k].items.length.toLocaleString(localeForDigits())}</span></div>
        ${groups[k].items.map(itemRenderer).join('')}
    `).join('');
}
function jalaliDaysInMonth(jy, jm) {
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    // month 12 (esfand): leap year check via jalCalHelper break table is complex; approximate using conversion round-trip
    const g = jalaliToGregorian(jy, 12, 30);
    const back = gregorianToJalali(g.gy, g.gm, g.gd);
    return (back.jy === jy && back.jm === 12 && back.jd === 30) ? 30 : 29;
}
function jalaliPartsToISO(jy, jm, jd) {
    const g = jalaliToGregorian(jy, jm, jd);
    return new Date(g.gy, g.gm - 1, g.gd, 12, 0, 0).toISOString();
}
let _jalaliPickerState = null;
function jalaliDateField(id, isoValue, label, required) {
    return `<div class="input-group">
        <label>${esc(label)}${required ? ' *' : ''}</label>
        <div class="jalali-date-wrap">
            <input type="text" id="${id}" class="jalali-date-field" value="${isoToJalaliStr(isoValue)}" data-iso="${isoValue || ''}" placeholder="۱۴۰۳/۰۱/۰۱" readonly onclick="openJalaliPicker('${id}')">
            <button type="button" class="jalali-date-btn" onclick="openJalaliPicker('${id}')" title="انتخاب از تقویم شمسی">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </button>
        </div>
    </div>`;
}
function getJalaliInputISO(id) {
    const el = document.getElementById(id);
    return (el && el.dataset.iso) ? el.dataset.iso : '';
}
function openJalaliPicker(inputId) {
    const el = document.getElementById(inputId);
    const current = (el && el.dataset.iso) ? isoToJalaliParts(el.dataset.iso) : isoToJalaliParts(todayISO());
    _jalaliPickerState = { inputId, jy: current.jy, jm: current.jm };
    renderJalaliPickerModal();
}
window.openJalaliPicker = openJalaliPicker;
function renderJalaliPickerModal() {
    const { jy, jm } = _jalaliPickerState;
    const todayJ = isoToJalaliParts(todayISO());
    const selEl = document.getElementById(_jalaliPickerState.inputId);
    const selectedIso = selEl ? selEl.dataset.iso : '';
    const selectedJ = selectedIso ? isoToJalaliParts(selectedIso) : null;
    const daysInMonth = jalaliDaysInMonth(jy, jm);
    // weekday of the 1st of this jalali month (Saturday = 0)
    const firstIso = jalaliPartsToISO(jy, jm, 1);
    const jsWeekday = new Date(firstIso).getDay(); // 0=Sunday
    const startOffset = (jsWeekday + 1) % 7; // convert so Saturday=0
    let cells = '';
    for (let i = 0; i < startOffset; i++) cells += `<div class="jcal-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
        const isToday = todayJ.jy === jy && todayJ.jm === jm && todayJ.jd === d;
        const isSel = selectedJ && selectedJ.jy === jy && selectedJ.jm === jm && selectedJ.jd === d;
        cells += `<div class="jcal-cell ${isToday ? 'today' : ''} ${isSel ? 'selected' : ''}" onclick="pickJalaliDate(${jy},${jm},${d})">${String(d).replace(/[0-9]/g, (x) => '۰۱۲۳۴۵۶۷۸۹'[x])}</div>`;
    }
    const html = `
    <div class="jcal-wrap">
        <div class="jcal-header">
            <button type="button" class="nav-btn" onclick="jalaliPickerNav(1)">›</button>
            <strong>${FA_MONTHS[jm - 1]} ${String(jy).replace(/[0-9]/g, (x) => '۰۱۲۳۴۵۶۷۸۹'[x])}</strong>
            <button type="button" class="nav-btn" onclick="jalaliPickerNav(-1)">‹</button>
        </div>
        <div class="jcal-grid jcal-weekdays">${FA_WEEKDAYS.map(w => `<div class="jcal-cell head">${w}</div>`).join('')}</div>
        <div class="jcal-grid">${cells}</div>
        <button type="button" class="btn-action" style="width:100%; margin-top:8px;" onclick="pickJalaliDate(${todayJ.jy},${todayJ.jm},${todayJ.jd})">امروز</button>
    </div>`;
    document.getElementById('jalaliBody').innerHTML = html;
    document.getElementById('jalaliOverlay').classList.add('active');
}
function closeJalaliPicker() { document.getElementById('jalaliOverlay').classList.remove('active'); }
window.closeJalaliPicker = closeJalaliPicker;
function closeJalaliOverlayOnBg(e) { if (e.target.id === 'jalaliOverlay') closeJalaliPicker(); }
window.closeJalaliOverlayOnBg = closeJalaliOverlayOnBg;
function jalaliPickerNav(dir) {
    let { jy, jm } = _jalaliPickerState;
    jm += dir;
    if (jm > 12) { jm = 1; jy += 1; }
    if (jm < 1) { jm = 12; jy -= 1; }
    _jalaliPickerState.jy = jy; _jalaliPickerState.jm = jm;
    renderJalaliPickerModal();
}
window.jalaliPickerNav = jalaliPickerNav;
function pickJalaliDate(jy, jm, jd) {
    const iso = jalaliPartsToISO(jy, jm, jd);
    const el = document.getElementById(_jalaliPickerState.inputId);
    if (el) {
        el.dataset.iso = iso;
        el.value = isoToJalaliStr(iso);
        el.dispatchEvent(new Event('change'));
    }
    closeJalaliPicker();
}
window.pickJalaliDate = pickJalaliDate;
function isSameDay(iso1, iso2) {
    const a = new Date(iso1), b = new Date(iso2);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function initials(name) {
    name = (name || '').trim();
    if (!name) return '؟';
    return name.charAt(0);
}
function debounce(fn, ms) {
    let t; return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

/* ---------------------------------------------------------------------------
   Toast notifications
   ------------------------------------------------------------------------- */
function showToast(msg, type) {
    type = type || 'info';
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast-item toast-' + type;
    const icon = type === 'success' ? '✓' : (type === 'error' ? '!' : 'i');
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${esc(msg)}</span>`;
    root.appendChild(el);
    setTimeout(() => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 220);
    }, 2600);
}
window.showToast = showToast;

/* ---------------------------------------------------------------------------
   Generic modal (single overlay, content injected per-use)
   ------------------------------------------------------------------------- */
function openModal(title, bodyHtml) {
    document.getElementById('modalTitle').innerHTML = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalOverlay').classList.add('active');
    try { history.pushState({ apModal: true }, '', location.href); } catch (e) {}
}
function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
}
function closeModalOnOverlay(e) {
    if (e.target.id === 'modalOverlay') closeModal();
}
window.openModal = openModal;
window.closeModal = closeModal;
window.closeModalOnOverlay = closeModalOnOverlay;

window.addEventListener('popstate', () => {
    const modalOpen = document.getElementById('modalOverlay').classList.contains('active');
    const moreOpen = document.getElementById('moreMenuOverlay').classList.contains('active');
    if (modalOpen) closeModal();
    else if (moreOpen) closeMoreMenu();
});

const NAV_ICONS = {
    home: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    dashboard: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
    invoices: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/></svg>`,
    products: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`,
    customers: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    purchases: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`,
    treasury: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 6V4h12v2"/></svg>`,
    checks: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    expenses: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
    payroll: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="19" y1="6" x2="19" y2="10"/><line x1="17" y1="8" x2="21" y2="8"/></svg>`,
    settlements: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
    partners: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M17 11a4 4 0 1 0 0-8"/><path d="M1 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/><path d="M17 13a4 4 0 0 1 4 4v2h-4"/></svg>`,
    stocktake: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    reports: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    backup: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
    help: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    about: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    settings: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};
function openMoreMenu() {
    const items = [
        ['home', 'خانه'], ['dashboard', 'داشبورد'], ['invoices', 'فاکتور فروش'], ['products', 'کالا و انبار'],
        ['customers', 'مشتریان'], ['purchases', 'خرید از تأمین‌کننده'], ['treasury', 'صندوق و بانک'],
        ['checks', 'چک‌ها'], ['expenses', 'هزینه‌ها'], ['payroll', 'حقوق پرسنل'], ['settlements', 'بدهکاران و طلبکاران'], ['partners', 'شرکا و سهم سود'],
        ['stocktake', 'انبارگردانی'], ['reports', 'گزارش‌ها'], ['backup', 'پشتیبان‌گیری'],
        ['help', 'راهنما'], ['about', 'درباره برنامه'], ['settings', 'تنظیمات']
    ];
    const html = items.map(([v, l]) => `
        <button class="btn-action more-menu-item" style="width:100%; justify-content:flex-start; gap:10px; margin-bottom:8px;" onclick="closeMoreMenu(); switchView('${v}')">
            <span class="more-menu-icon">${NAV_ICONS[v] || ''}</span>
            <span>${esc(l)}</span>
        </button>
    `).join('');
    document.getElementById('moreMenuBody').innerHTML = html;
    document.getElementById('moreMenuOverlay').classList.add('active');
    try { history.pushState({ apMore: true }, '', location.href); } catch (e) {}
}
function closeMoreMenu() { document.getElementById('moreMenuOverlay').classList.remove('active'); }
window.openMoreMenu = openMoreMenu;
window.closeMoreMenu = closeMoreMenu;

/* ---------------------------------------------------------------------------
   Theme / appearance
   ------------------------------------------------------------------------- */
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen || function () {}).call(document.documentElement);
    } else {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
}
window.toggleFullscreen = toggleFullscreen;
function initFullscreenButton() {
    const btn = document.getElementById('fullscreenBtn');
    if (!btn || !document.documentElement.requestFullscreen) { if (btn) btn.style.display = 'none'; return; }
    document.addEventListener('fullscreenchange', () => {
        btn.title = document.fullscreenElement ? 'خروج از حالت تمام‌صفحه' : 'حالت تمام‌صفحه';
    });
}

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    saveSettings({ theme: document.body.classList.contains('light-mode') ? 'light' : 'dark' });
}
window.toggleTheme = toggleTheme;

function applySavedAppearance() {
    const s = getSettings();
    if (s.theme !== 'dark') document.body.classList.add('light-mode'); else document.body.classList.remove('light-mode');
    if (s.colorTheme && s.colorTheme !== 'default') document.body.setAttribute('data-theme', s.colorTheme);
    const html = document.documentElement;
    html.setAttribute('data-font-family', s.fontFamily || 'vazirmatn');
    html.setAttribute('data-font-size', s.fontSize || 'medium');
    html.setAttribute('data-density', s.density || 'comfortable');
    html.setAttribute('data-reduced-motion', s.animationsEnabled === false ? 'true' : 'false');
    html.setAttribute('data-high-contrast', s.highContrast ? 'true' : 'false');
}

const FONT_FAMILIES = [['vazirmatn', 'وزیرمتن (پیش‌فرض)'], ['sahel', 'ساحل'], ['shabnam', 'شبنم'], ['samim', 'صمیم'], ['parastoo', 'پرستو']];
const FONT_SIZES = [['small', 'کوچک'], ['medium', 'متوسط'], ['large', 'بزرگ'], ['xlarge', 'خیلی بزرگ']];
const PRINT_TEMPLATES = [['modern', 'مدرن'], ['formal', 'رسمی'], ['classic', 'کلاسیک'], ['minimal', 'مینیمال'], ['colorful', 'رنگارنگ'], ['elegant', 'شیک'], ['compact', 'فشرده'], ['boldtitle', 'عنوان‌درشت'], ['watermark', 'واترمارک']];

function applyAppearanceLive() {
    const get = (id, fallback) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : fallback; };
    saveSettings({
        fontFamily: get('st_fontFamily', 'vazirmatn'),
        fontSize: get('st_fontSize', 'medium'),
        density: get('st_density', 'comfortable'),
        digitStyle: get('st_digitStyle', 'fa'),
        highContrast: get('st_highContrast', false),
        animationsEnabled: get('st_animations', true),
        confirmBeforeDelete: get('st_confirmDelete', true),
        paperSize: get('st_paperSize', 'A4'),
        printOrientation: get('st_printOrientation', 'portrait')
    });
    applySavedAppearance();
}
window.applyAppearanceLive = applyAppearanceLive;

function setPrintTemplate(id) { saveSettings({ printTemplate: id }); switchView('settings'); showToast('قالب چاپ تغییر کرد', 'success'); }
window.setPrintTemplate = setPrintTemplate;

function printTemplatePreviewHtml(templateId) {
    const cls = 'tpl-' + (templateId || 'modern');
    let styleAttr = '';
    if (templateId === 'watermark') {
        const s = getSettings(); const wm = s.watermark || {};
        styleAttr = ` style="--wm-text:'${esc(wm.text || 'حسابداری پلاس')}'; --wm-size:${(num(wm.fontSize) || 42) * 0.4}px; --wm-opacity:${wm.opacity !== undefined ? wm.opacity : 0.06}; --wm-angle:${wm.angle !== undefined ? wm.angle : -30}deg; --wm-top:${wm.top !== undefined ? wm.top : 50}%; --wm-left:${wm.left !== undefined ? wm.left : 50}%;"`;
    }
    if (templateId === 'custom') styleAttr = customTemplateStyleAttr();
    return `
    <div class="bill-template ${cls}" style="transform:scale(0.9); transform-origin:top right; pointer-events:none;"${styleAttr}>
        <div class="bill-header"><h4>فروشگاه نمونه</h4><span>پیش‌نمایش قالب</span></div>
        <table class="bill-table"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت</th></tr></thead>
        <tbody><tr><td>کالای نمونه</td><td>۲</td><td>۱۵۰,۰۰۰</td></tr></tbody></table>
    </div>`;
}
function onPrintTemplateChange(value) {
    if (value === 'custom') {
        openCustomTemplateDesigner();
        return;
    }
    if (value === 'watermark') {
        openWatermarkDesigner();
        return;
    }
    setPrintTemplate(value);
}
window.onPrintTemplateChange = onPrintTemplateChange;

function openWatermarkDesigner() {
    const wm = getSettings().watermark || { text: 'حسابداری پلاس', fontSize: 42, opacity: 0.06, angle: -30, top: 50, left: 50 };
    const html = `
        <div class="input-group"><label>متن واترمارک</label><input type="text" id="wm_text" value="${esc(wm.text || 'حسابداری پلاس')}"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>اندازه فونت (px)</label><input type="range" id="wm_size" min="16" max="90" value="${num(wm.fontSize) || 42}" oninput="document.getElementById('wm_sizeVal').textContent=this.value; refreshWatermarkPreview();"><span class="txt-caption" id="wm_sizeVal">${num(wm.fontSize) || 42}</span></div>
            <div class="input-group"><label>زاویه چرخش</label><input type="range" id="wm_angle" min="-90" max="90" value="${wm.angle !== undefined ? wm.angle : -30}" oninput="document.getElementById('wm_angleVal').textContent=this.value; refreshWatermarkPreview();"><span class="txt-caption" id="wm_angleVal">${wm.angle !== undefined ? wm.angle : -30}</span></div>
        </div>
        <div class="input-group"><label>شفافیت (کم = محوتر)</label><input type="range" id="wm_opacity" min="0.02" max="0.35" step="0.01" value="${wm.opacity !== undefined ? wm.opacity : 0.06}" oninput="refreshWatermarkPreview();"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>موقعیت عمودی (٪ از بالا)</label><input type="range" id="wm_top" min="10" max="90" value="${wm.top !== undefined ? wm.top : 50}" oninput="refreshWatermarkPreview();"></div>
            <div class="input-group"><label>موقعیت افقی (٪ از راست)</label><input type="range" id="wm_left" min="10" max="90" value="${wm.left !== undefined ? wm.left : 50}" oninput="refreshWatermarkPreview();"></div>
        </div>
        <p class="txt-caption">پیش‌فرض دقیقاً وسط صفحه است؛ با اسلایدرهای بالا می‌توانید محل، زاویه، اندازه و شفافیت را تغییر دهید.</p>
        <div class="print-template-preview" id="wmPreview" style="margin-top:6px;"></div>
        <button class="calc-btn" style="margin-top:10px;" onclick="saveWatermarkSettings()">ذخیره و فعال‌سازی واترمارک</button>
    `;
    openModal('طراحی واترمارک', html);
    setTimeout(refreshWatermarkPreview, 30);
}
window.openWatermarkDesigner = openWatermarkDesigner;
function refreshWatermarkPreview() {
    const box = document.getElementById('wmPreview');
    if (!box) return;
    const text = document.getElementById('wm_text').value || 'حسابداری پلاس';
    const size = num(document.getElementById('wm_size').value) || 42;
    const angle = num(document.getElementById('wm_angle').value) || 0;
    const opacity = document.getElementById('wm_opacity').value;
    const top = document.getElementById('wm_top').value;
    const left = document.getElementById('wm_left').value;
    box.innerHTML = `
    <div class="bill-template tpl-watermark" style="transform:scale(0.9); transform-origin:top right; pointer-events:none; --wm-text:'${esc(text)}'; --wm-size:${size * 0.5}px; --wm-opacity:${opacity}; --wm-angle:${angle}deg; --wm-top:${top}%; --wm-left:${left}%;">
        <div class="bill-header"><h4>فروشگاه نمونه</h4><span>پیش‌نمایش واترمارک</span></div>
        <table class="bill-table"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت</th></tr></thead>
        <tbody><tr><td>کالای نمونه</td><td>۲</td><td>۱۵۰,۰۰۰</td></tr></tbody></table>
    </div>`;
}
window.refreshWatermarkPreview = refreshWatermarkPreview;
function saveWatermarkSettings() {
    const watermark = {
        text: document.getElementById('wm_text').value.trim() || 'حسابداری پلاس',
        fontSize: num(document.getElementById('wm_size').value) || 42,
        angle: num(document.getElementById('wm_angle').value) || 0,
        opacity: parseFloat(document.getElementById('wm_opacity').value) || 0.06,
        top: num(document.getElementById('wm_top').value) || 50,
        left: num(document.getElementById('wm_left').value) || 50
    };
    saveSettings({ watermark, printTemplate: 'watermark' });
    closeModal();
    showToast('واترمارک ذخیره و فعال شد', 'success');
    switchView('settings');
}
window.saveWatermarkSettings = saveWatermarkSettings;

function customTemplateStyleAttr() {
    const ct = getSettings().customTemplate || {};
    const accent = ct.accent || '#2563eb';
    const border = ct.borderStyle || 'solid';
    const radius = ct.rounded ? '14px' : '0px';
    const headerFill = ct.headerFill !== false;
    const align = ct.align || 'right';
    return ` style="--ct-accent:${accent}; --ct-border-style:${border}; --ct-radius:${radius}; --ct-header-bg:${headerFill ? accent : 'transparent'}; --ct-header-fg:${headerFill ? '#fff' : accent}; --ct-align:${align};"`;
}
function openCustomTemplateDesigner() {
    const ct = getSettings().customTemplate || { accent: '#2563eb', borderStyle: 'solid', rounded: true, headerFill: true, align: 'right' };
    const html = `
        <div class="input-group"><label>رنگ اصلی قالب</label><input type="color" id="ct_accent" value="${ct.accent || '#2563eb'}" style="height:44px; width:100%; padding:4px;"></div>
        <div class="input-group"><label>سبک خط دور جدول</label>
            <select id="ct_border">
                <option value="solid" ${ct.borderStyle === 'solid' ? 'selected' : ''}>ساده</option>
                <option value="dashed" ${ct.borderStyle === 'dashed' ? 'selected' : ''}>خط‌چین</option>
                <option value="double" ${ct.borderStyle === 'double' ? 'selected' : ''}>دوخط</option>
                <option value="none" ${ct.borderStyle === 'none' ? 'selected' : ''}>بدون خط</option>
            </select>
        </div>
        <div class="input-group"><label>تراز متن سربرگ</label>
            <select id="ct_align">
                <option value="right" ${(ct.align || 'right') === 'right' ? 'selected' : ''}>راست</option>
                <option value="center" ${ct.align === 'center' ? 'selected' : ''}>وسط</option>
                <option value="left" ${ct.align === 'left' ? 'selected' : ''}>چپ</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">گوشه‌های گرد</div>
            <label class="switch"><input type="checkbox" id="ct_rounded" ${ct.rounded !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">پرکردن رنگی سربرگ جدول</div>
            <label class="switch"><input type="checkbox" id="ct_headerFill" ${ct.headerFill !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="print-template-preview" id="ctPreview" style="margin-top:10px;"></div>
        <button class="calc-btn" style="margin-top:10px;" onclick="saveCustomTemplate()">ذخیره طراحی سفارشی</button>
    `;
    openModal('طراحی سفارشی فاکتور', html);
    setTimeout(refreshCustomTemplatePreview, 30);
    ['ct_accent', 'ct_border', 'ct_align', 'ct_rounded', 'ct_headerFill'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', refreshCustomTemplatePreview);
    });
}
window.openCustomTemplateDesigner = openCustomTemplateDesigner;
function refreshCustomTemplatePreview() {
    const box = document.getElementById('ctPreview');
    if (!box) return;
    const draft = {
        accent: document.getElementById('ct_accent').value,
        borderStyle: document.getElementById('ct_border').value,
        align: document.getElementById('ct_align').value,
        rounded: document.getElementById('ct_rounded').checked,
        headerFill: document.getElementById('ct_headerFill').checked
    };
    const radius = draft.rounded ? '14px' : '0px';
    box.innerHTML = `
    <div class="bill-template tpl-custom" style="transform:scale(0.9); transform-origin:top right; pointer-events:none; --ct-accent:${draft.accent}; --ct-border-style:${draft.borderStyle}; --ct-radius:${radius}; --ct-header-bg:${draft.headerFill ? draft.accent : 'transparent'}; --ct-header-fg:${draft.headerFill ? '#fff' : draft.accent}; --ct-align:${draft.align};">
        <div class="bill-header"><h4>فروشگاه نمونه</h4><span>پیش‌نمایش طراحی شما</span></div>
        <table class="bill-table"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت</th></tr></thead>
        <tbody><tr><td>کالای نمونه</td><td>۲</td><td>۱۵۰,۰۰۰</td></tr></tbody></table>
    </div>`;
}
window.refreshCustomTemplatePreview = refreshCustomTemplatePreview;
function saveCustomTemplate() {
    const customTemplate = {
        accent: document.getElementById('ct_accent').value,
        borderStyle: document.getElementById('ct_border').value,
        align: document.getElementById('ct_align').value,
        rounded: document.getElementById('ct_rounded').checked,
        headerFill: document.getElementById('ct_headerFill').checked
    };
    saveSettings({ customTemplate, printTemplate: 'custom' });
    closeModal();
    showToast('طراحی سفارشی ذخیره و فعال شد', 'success');
    switchView('settings');
}
window.saveCustomTemplate = saveCustomTemplate;

function onLogoFileChange(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) { showToast('حجم تصویر باید کمتر از ۱.۵ مگابایت باشد', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        saveSettings({ logoDataUrl: e.target.result });
        refreshBrandChip();
        switchView('settings');
        showToast('لوگو ذخیره شد', 'success');
    };
    reader.readAsDataURL(file);
}
window.onLogoFileChange = onLogoFileChange;
function clearLogo() { saveSettings({ logoDataUrl: '' }); refreshBrandChip(); switchView('settings'); }
window.clearLogo = clearLogo;

function setColorTheme(t) {
    if (t === 'default') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', t);
    saveSettings({ colorTheme: t });
    switchView('settings');
}
window.setColorTheme = setColorTheme;

function toggleSidebarCollapse() {
    const shell = document.getElementById('appShell');
    const collapsed = shell.getAttribute('data-sidebar-collapsed') === 'true';
    shell.setAttribute('data-sidebar-collapsed', collapsed ? 'false' : 'true');
    saveSettings({ sidebarCollapsed: !collapsed });
}
window.toggleSidebarCollapse = toggleSidebarCollapse;

function refreshBrandChip() {
    const s = getSettings();
    const name = s.storeName || 'فروشگاه من';
    document.getElementById('sidebarBrandText').textContent = name;
    document.getElementById('storeChipLabel').textContent = name.length > 12 ? name.slice(0, 12) + '…' : name;
    const avatarEl = document.getElementById('storeAvatar');
    const sidebarIconEl = document.getElementById('sidebarBrandIconImg');
    if (s.logoDataUrl) {
        avatarEl.innerHTML = `<img src="${s.logoDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        if (sidebarIconEl) sidebarIconEl.src = s.logoDataUrl;
    } else {
        avatarEl.textContent = initials(name);
        if (sidebarIconEl) sidebarIconEl.src = 'icons/icon-192.png';
    }
}

/* ---------------------------------------------------------------------------
   Navigation
   ------------------------------------------------------------------------- */
let currentView = 'dashboard';
const VIEW_RENDERERS = {}; // filled in per-view sections below

function switchView(name) {
    currentView = name;
    document.querySelectorAll('.bn-item[data-view]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === name);
    });
    const root = document.getElementById('viewRoot');
    const renderer = VIEW_RENDERERS[name];
    root.innerHTML = renderer ? renderer() : `<div class="empty-state">این بخش یافت نشد.</div>`;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    afterViewRender(name);
}
window.switchView = switchView;

/* Some views build their list lazily (infinite scroll) after the HTML has been injected,
   since inline <script> tags inside innerHTML never execute. */
function afterViewRender(name) {
    if (name === 'products' && document.getElementById('productListWrap')) renderProductFlatList();
    if (name === 'customers' && document.getElementById('customerListWrap')) renderCustomerFlatList();
    if (name === 'invoices' && document.getElementById('invoiceListWrap')) renderInvoiceFlatList();
    if (name === 'invoiceNew') diApplyAutoPaid();
    if (name === 'purchaseNew') dpApplyAutoPaid();
}

function viewHeader(eyebrow, title, subtitle, actionsHtml) {
    return `
    <div class="page-header">
        <div class="page-header-row">
            <div>
                <div class="page-eyebrow">${esc(eyebrow)}</div>
                <div class="page-title">${esc(title)}</div>
                ${subtitle ? `<div class="page-subtitle">${esc(subtitle)}</div>` : ''}
            </div>
            ${actionsHtml ? `<div style="display:flex; gap:8px;">${actionsHtml}</div>` : ''}
        </div>
    </div>`;
}

/* ---------------------------------------------------------------------------
   Demo / seed data
   ------------------------------------------------------------------------- */
const BUSINESS_TYPES = [
    { id: 'clothing', label: 'پوشاک', emoji: '👕' },
    { id: 'digital', label: 'لوازم دیجیتال', emoji: '📱' },
    { id: 'grocery', label: 'مواد غذایی', emoji: '🛒' },
    { id: 'home', label: 'لوازم خانگی', emoji: '🏠' },
    { id: 'beauty', label: 'آرایشی بهداشتی', emoji: '💄' },
    { id: 'stationery', label: 'کتاب و لوازم‌التحریر', emoji: '📚' },
    { id: 'auto', label: 'لوازم یدکی خودرو', emoji: '🚗' },
    { id: 'other', label: 'سایر مشاغل', emoji: '🏪' }
];

const PRODUCT_POOLS = {
    clothing: [
        ['پیراهن مردانه کلاسیک', 'عدد', 320000, 480000],
        ['شلوار جین اسلیم', 'عدد', 410000, 620000],
        ['تی‌شرت نخی طرح‌دار', 'عدد', 150000, 240000],
        ['کاپشن زمستانی', 'عدد', 950000, 1450000],
        ['مانتو اسپرت زنانه', 'عدد', 520000, 780000],
        ['شال و روسری نخی', 'عدد', 90000, 150000],
        ['کفش اسپرت مردانه', 'جفت', 780000, 1150000],
        ['کیف دستی زنانه', 'عدد', 380000, 590000],
        ['شلوار اسلش زنانه', 'عدد', 260000, 400000],
        ['ژاکت بافت', 'عدد', 340000, 520000],
        ['جوراب طرح‌دار (بسته ۳ تایی)', 'بسته', 60000, 95000],
        ['کمربند چرم', 'عدد', 140000, 220000]
    ],
    digital: [
        ['هندزفری بلوتوثی', 'عدد', 380000, 590000],
        ['پاوربانک ۱۰۰۰۰', 'عدد', 520000, 780000],
        ['کابل شارژ تایپ-C', 'عدد', 65000, 110000],
        ['شارژر دیواری فست‌شارژ', 'عدد', 180000, 280000],
        ['ماوس بی‌سیم', 'عدد', 250000, 390000],
        ['کیبورد مکانیکال', 'عدد', 890000, 1350000],
        ['قاب گوشی سیلیکونی', 'عدد', 45000, 85000],
        ['محافظ صفحه گلس', 'عدد', 35000, 65000],
        ['اسپیکر بلوتوثی', 'عدد', 620000, 950000],
        ['فلش مموری ۶۴ گیگ', 'عدد', 210000, 320000],
        ['هاب USB چندپورت', 'عدد', 290000, 430000],
        ['پایه نگهدارنده گوشی', 'عدد', 75000, 130000]
    ],
    grocery: [
        ['برنج ایرانی (کیسه ۱۰ کیلو)', 'کیسه', 950000, 1250000],
        ['روغن مایع آفتابگردان', 'بطری', 145000, 195000],
        ['قند و شکر (بسته ۹۰۰ گرم)', 'بسته', 65000, 89000],
        ['چای احمد ۴۵۰ گرم', 'بسته', 210000, 275000],
        ['رب گوجه‌فرنگی', 'قوطی', 55000, 78000],
        ['ماکارونی ۷۰۰ گرم', 'بسته', 48000, 68000],
        ['حبوبات میکس', 'کیلوگرم', 90000, 125000],
        ['خرما مضافتی', 'کیلوگرم', 180000, 240000],
        ['کنسرو تن ماهی', 'قوطی', 68000, 92000],
        ['شیر پرچرب ۱ لیتری', 'بطری', 42000, 58000],
        ['پنیر پیتزا ۴۰۰ گرم', 'بسته', 135000, 175000],
        ['تخم‌مرغ (شانه ۳۰ تایی)', 'شانه', 220000, 285000]
    ],
    home: [
        ['سرویس قابلمه ۶ پارچه', 'سرویس', 3200000, 4500000],
        ['اتو بخار', 'عدد', 780000, 1150000],
        ['چای‌ساز برقی', 'عدد', 650000, 950000],
        ['سرویس چاقوی آشپزخانه', 'سرویس', 420000, 620000],
        ['حوله سرویس ۶ تکه', 'سرویس', 380000, 560000],
        ['رومیزی و سرویس سفره', 'سرویس', 290000, 430000],
        ['جاروبرقی رومیزی', 'عدد', 1350000, 1850000],
        ['مخلوط‌کن', 'عدد', 890000, 1250000],
        ['سرویس لیوان کریستال', 'سرویس', 340000, 490000],
        ['پتوی دو نفره', 'عدد', 520000, 750000],
        ['سطل زباله پدالی', 'عدد', 180000, 260000],
        ['آبکش استیل', 'عدد', 95000, 140000]
    ],
    beauty: [
        ['کرم مرطوب‌کننده صورت', 'عدد', 180000, 280000],
        ['شامپو بدن', 'عدد', 95000, 150000],
        ['رژ لب مات', 'عدد', 140000, 220000],
        ['کرم ضدآفتاب SPF50', 'عدد', 260000, 380000],
        ['عطر جیبی', 'عدد', 320000, 480000],
        ['ماسک مو کراتینه', 'عدد', 165000, 250000],
        ['سرم ویتامین C', 'عدد', 290000, 430000],
        ['اتو مو حرفه‌ای', 'عدد', 780000, 1150000],
        ['ست مسواک برقی', 'عدد', 650000, 950000],
        ['لوسیون بدن', 'عدد', 130000, 200000],
        ['پنکک و پودر فیکس', 'عدد', 240000, 360000],
        ['ژل شست‌وشوی صورت', 'عدد', 110000, 175000]
    ],
    stationery: [
        ['دفتر ۱۰۰ برگ فنری', 'عدد', 45000, 75000],
        ['خودکار جوهری (بسته ۱۲ تایی)', 'بسته', 90000, 140000],
        ['کیف مدرسه', 'عدد', 480000, 720000],
        ['مداد رنگی ۲۴ رنگ', 'جعبه', 165000, 250000],
        ['کتاب رمان ایرانی', 'جلد', 180000, 260000],
        ['ماژیک وایت‌برد', 'عدد', 35000, 55000],
        ['پوشه فنری A4', 'عدد', 40000, 65000],
        ['ست هندسی', 'عدد', 65000, 100000],
        ['چسب‌نوار پهن', 'عدد', 25000, 40000],
        ['ماشین‌حساب دانش‌آموزی', 'عدد', 220000, 330000],
        ['دفترچه یادداشت جیبی', 'عدد', 30000, 48000],
        ['کاغذ A4 (بسته ۵۰۰ برگ)', 'بسته', 190000, 260000]
    ],
    auto: [
        ['روغن موتور ۴ لیتری', 'گالن', 480000, 680000],
        ['فیلتر روغن', 'عدد', 95000, 145000],
        ['لنت ترمز جلو', 'دست', 620000, 890000],
        ['برف‌پاک‌کن جفت', 'جفت', 280000, 420000],
        ['باتری خودرو ۶۰ آمپر', 'عدد', 2800000, 3600000],
        ['روکش صندلی خودرو', 'دست', 950000, 1400000],
        ['لامپ هدلایت', 'عدد', 320000, 480000],
        ['اسپری تمیزکننده داشبورد', 'عدد', 85000, 130000],
        ['شمع موتور (بسته ۴ تایی)', 'بسته', 380000, 560000],
        ['ضدیخ رادیاتور', 'بطری', 140000, 210000],
        ['فیلتر هوا موتور', 'عدد', 150000, 225000],
        ['جک هیدرولیک', 'عدد', 780000, 1150000]
    ],
    other: [
        ['بسته محصول نوع اول', 'عدد', 200000, 300000],
        ['بسته محصول نوع دوم', 'عدد', 350000, 520000],
        ['بسته محصول نوع سوم', 'عدد', 120000, 190000],
        ['بسته محصول نوع چهارم', 'عدد', 480000, 720000],
        ['بسته محصول نوع پنجم', 'عدد', 90000, 145000],
        ['بسته محصول نوع ششم', 'عدد', 610000, 890000],
        ['بسته محصول نوع هفتم', 'عدد', 250000, 380000],
        ['بسته محصول نوع هشتم', 'عدد', 155000, 235000],
        ['بسته محصول نوع نهم', 'عدد', 320000, 470000],
        ['بسته محصول نوع دهم', 'عدد', 410000, 610000],
        ['بسته محصول نوع یازدهم', 'عدد', 70000, 115000],
        ['بسته محصول نوع دوازدهم', 'عدد', 540000, 790000]
    ]
};

const DEMO_CUSTOMER_NAMES = [
    'علی محمدی', 'زهرا احمدی', 'حسین رضایی', 'فاطمه کریمی', 'محمد حسینی',
    'مریم صادقی', 'رضا نوری', 'سارا جعفری', 'امیر قاسمی', 'نگار مرادی',
    'کیوان شریفی', 'الهام رستمی', 'بهرام یوسفی', 'شیوا عزیزی'
];
const DEMO_SUPPLIER_NAMES = [
    'پخش پارس تجارت', 'بازرگانی نوین کالا', 'شرکت توزیع البرز', 'عمده‌فروشی مرکزی', 'وارداتی ایران‌کالا'
];
const EXPENSE_CATEGORIES_DEFAULT = ['اجاره مغازه', 'قبض برق', 'قبض آب و گاز', 'حقوق پرسنل', 'بیمه پرسنل', 'تبلیغات', 'تعمیر و نگهداری', 'حمل و نقل', 'متفرقه'];
function getExpenseCategories() {
    const custom = dbRead('ap_expense_categories');
    const merged = EXPENSE_CATEGORIES_DEFAULT.concat((Array.isArray(custom) ? custom : []).filter(c => !EXPENSE_CATEGORIES_DEFAULT.includes(c)));
    return merged;
}
function addExpenseCategory(name) {
    name = (name || '').trim();
    if (!name) return;
    const custom = dbRead('ap_expense_categories');
    const list = Array.isArray(custom) ? custom : [];
    if (!getExpenseCategories().includes(name)) { list.push(name); dbWrite('ap_expense_categories', list); }
}
const EXPENSE_CATEGORIES = EXPENSE_CATEGORIES_DEFAULT; // kept for any legacy reference; use getExpenseCategories() everywhere new

function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

function generateSeedData(businessType) {
    const pool = PRODUCT_POOLS[businessType] || PRODUCT_POOLS.other;

    // Products
    const products = pool.map((p) => {
        const qty = randInt(3, 60);
        return {
            id: uid('p'), name: p[0], category: (BUSINESS_TYPES.find(b => b.id === businessType) || {}).label || 'عمومی',
            unit: p[1], buyPrice: p[2], sellPrice: p[3], qty, minQty: randInt(3, 8), createdAt: daysAgoISO(randInt(30, 200))
        };
    });
    dbWrite(K.products, products);

    // Customers
    const customers = DEMO_CUSTOMER_NAMES.map((name) => ({
        id: uid('c'), name, phone: '09' + randInt(10, 39) + randInt(1000000, 9999999),
        address: '', notes: '', createdAt: daysAgoISO(randInt(10, 200))
    }));
    dbWrite(K.customers, customers);

    // Invoices (sales) over the last ~75 days
    const invoices = [];
    let invCounter = 1000;
    for (let i = 0; i < 46; i++) {
        const date = daysAgoISO(randInt(0, 75));
        const cust = Math.random() > 0.12 ? pick(customers) : null;
        const itemCount = randInt(1, 4);
        const items = [];
        const usedIdx = new Set();
        for (let j = 0; j < itemCount; j++) {
            let idx = randInt(0, products.length - 1);
            if (usedIdx.has(idx)) continue;
            usedIdx.add(idx);
            const prod = products[idx];
            const qty = randInt(1, 4);
            items.push({ productId: prod.id, name: prod.name, qty, price: prod.sellPrice, discount: 0 });
        }
        if (!items.length) continue;
        const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);
        const discountTotal = Math.random() > 0.75 ? Math.round(subtotal * 0.05) : 0;
        const taxAmount = getSettings().taxEnabled ? Math.round((subtotal - discountTotal) * (num(getSettings().taxPercent) || 9) / 100) : 0;
        const total = subtotal - discountTotal + taxAmount;
        const statusRoll = Math.random();
        const status = statusRoll > 0.82 ? 'unpaid' : (statusRoll > 0.68 ? 'partial' : 'paid');
        const paidAmount = status === 'paid' ? total : (status === 'partial' ? Math.round(total * randInt(30, 70) / 100) : 0);
        invoices.push({
            id: uid('inv'), number: invCounter++, date, customerId: cust ? cust.id : null,
            customerNameSnapshot: cust ? cust.name : 'مشتری نقدی', items, discountTotal, taxAmount, total,
            paidAmount, status, note: ''
        });
    }
    invoices.sort((a, b) => new Date(a.date) - new Date(b.date));
    dbWrite(K.invoices, invoices);

    // Purchases
    const purchases = [];
    let purCounter = 500;
    for (let i = 0; i < 11; i++) {
        const date = daysAgoISO(randInt(0, 90));
        const supplier = pick(DEMO_SUPPLIER_NAMES);
        const itemCount = randInt(2, 5);
        const items = [];
        for (let j = 0; j < itemCount; j++) {
            const prod = pick(products);
            const qty = randInt(5, 20);
            items.push({ productId: prod.id, name: prod.name, qty, price: prod.buyPrice });
        }
        const total = items.reduce((s, it) => s + it.qty * it.price, 0);
        const status = Math.random() > 0.7 ? 'partial' : 'paid';
        const paidAmount = status === 'paid' ? total : Math.round(total * 0.5);
        purchases.push({ id: uid('pur'), number: purCounter++, date, supplier, items, total, paidAmount, status });
    }
    purchases.sort((a, b) => new Date(a.date) - new Date(b.date));
    dbWrite(K.purchases, purchases);

    // Expenses
    const expenses = [];
    for (let i = 0; i < 16; i++) {
        const cat = pick(EXPENSE_CATEGORIES);
        expenses.push({
            id: uid('exp'), date: daysAgoISO(randInt(0, 80)), title: cat, category: cat,
            amount: randInt(300, 4500) * 1000, note: ''
        });
    }
    expenses.sort((a, b) => new Date(a.date) - new Date(b.date));
    dbWrite(K.expenses, expenses);

    // A couple of manual cash transactions
    dbWrite(K.cashtx, [
        { id: uid('tx'), date: daysAgoISO(60), type: 'in', amount: 15000000, desc: 'سرمایه اولیه صندوق' },
        { id: uid('tx'), date: daysAgoISO(20), type: 'out', amount: 2000000, desc: 'برداشت شخصی مالک' }
    ]);

    dbWrite(K.seeded, true);
}

/* ---------------------------------------------------------------------------
   Onboarding wizard (first run)
   ------------------------------------------------------------------------- */
let onboardState = { step: 1, storeName: '', ownerName: '', businessType: 'clothing', phone: '', address: '', currency: 'تومان', taxEnabled: false, taxPercent: 9, loadDemo: true, hasPartners: false, percentMode: 'auto', partnersDraft: [], appMode: 'pro' };

function startOnboarding() {
    onboardState = { phase: 'intro', step: 1, storeName: '', ownerName: '', businessType: 'clothing', phone: '', address: '', currency: 'تومان', taxEnabled: false, taxPercent: 9, loadDemo: false, hasPartners: false, percentMode: 'auto', partnersDraft: [], appMode: 'pro' };
    const overlay = document.getElementById('onboardOverlay');
    overlay.hidden = false;
    renderOnboard();
}

function renderOnboardIntroPhase() {
    const overlay = document.getElementById('onboardOverlay');
    overlay.innerHTML = `
    <div class="onboard-card">
        <div class="onboard-logo"><img src="icons/icon-192.png" alt="لوگو"></div>
        <div class="onboard-title">به حسابداری پلاس خوش آمدید</div>
        <div class="onboard-sub" style="margin-bottom:14px;">پیش از شروع، بگذارید بگوییم این برنامه چیست</div>
        <p class="txt-body" style="color:var(--text-secondary); line-height:2; text-align:right;">
            «حسابداری پلاس» یک نرم‌افزار کامل مدیریت فروشگاه است: فاکتور فروش و خرید، مدیریت انبار و کالا، صندوق و بانک، چک‌ها، حقوق پرسنل، بدهکاران و طلبکاران، گزارش‌های سود و زیان، و پشتیبان‌گیری خودکار — همه در یک‌جا. تمام اطلاعات شما روی همین دستگاه ذخیره می‌شود و در صورت ورود با حساب گوگل، به‌صورت خودکار روی حساب شما هم نگه‌داری و بین دستگاه‌ها همگام می‌شود.
        </p>
        <div class="onboard-nav" style="margin-top:18px;">
            <button class="calc-btn" style="width:100%;" onclick="onboardState.phase='account'; renderOnboard();">متوجه شدم، ادامه</button>
        </div>
    </div>`;
}
function renderOnboardAccountPhase() {
    const overlay = document.getElementById('onboardOverlay');
    overlay.innerHTML = `
    <div class="onboard-card">
        <div class="onboard-logo"><img src="icons/icon-192.png" alt="لوگو"></div>
        <div class="onboard-title">قبلاً از این برنامه استفاده کرده‌اید؟</div>
        <div class="onboard-sub" style="margin-bottom:14px;">اگر روی دستگاه دیگری با حساب گوگل وارد شده‌اید، همین‌جا وارد شوید تا تمام اطلاعات‌تان به این دستگاه هم بیاید — بدون نیاز به وارد کردن دوباره چیزی.</div>
        <button class="calc-btn" style="width:100%; margin-bottom:10px; display:flex; align-items:center; justify-content:center; gap:8px;" onclick="onboardSignInGoogle()">
            <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.28 1.48-1.13 2.73-2.4 3.58v2.98h3.88c2.27-2.09 3.54-5.17 3.54-8.8z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-2.98c-1.08.72-2.45 1.15-4.05 1.15-3.11 0-5.75-2.1-6.69-4.93H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.31 14.33c-.24-.72-.38-1.49-.38-2.28s.14-1.56.38-2.28V6.68H1.29A11.96 11.96 0 000 12.05c0 1.93.46 3.76 1.29 5.37l4.02-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.68l4.02 3.09c.94-2.83 3.58-4.93 6.69-4.93z"/></svg>
            ورود با حساب گوگل قبلی
        </button>
        <p class="txt-caption" style="text-align:center; margin-bottom:10px;">— یا —</p>
        <button class="btn-action" style="width:100%;" onclick="onboardState.phase='wizard'; renderOnboard();">🏪 ساخت فروشگاه جدید از صفر</button>
    </div>`;
}
function onboardSignInGoogle() {
    signInWithGoogle();
    // if sign-in succeeds and cloud data exists, autoReconcileCloud() (triggered by onCloudAuthChange)
    // will pull it and reload the page automatically — this onboarding overlay simply disappears.
}
window.onboardSignInGoogle = onboardSignInGoogle;

function renderOnboard() {
    if (onboardState.phase === 'intro') { renderOnboardIntroPhase(); return; }
    if (onboardState.phase === 'account') { renderOnboardAccountPhase(); return; }
    const overlay = document.getElementById('onboardOverlay');
    const totalSteps = onboardState.hasPartners ? 4 : 4;
    const dots = [1, 2, 3, 4].map(n => `<span class="onboard-dot ${n <= onboardState.step ? 'active' : ''}"></span>`).join('');
    let body = '';

    if (onboardState.step === 1) {
        body = `
        <div class="input-group">
            <label>اسم فروشگاه شما چیست؟ *</label>
            <input type="text" id="ob_storeName" placeholder="مثلاً: فروشگاه پوشاک آرمان" value="${esc(onboardState.storeName)}">
        </div>
        <div class="input-group">
            <label>نام مدیر / مالک</label>
            <input type="text" id="ob_ownerName" placeholder="نام و نام‌خانوادگی" value="${esc(onboardState.ownerName)}">
        </div>
        <div class="input-group">
            <label>شماره تماس فروشگاه</label>
            <input type="text" id="ob_phone" placeholder="0912xxxxxxx" value="${esc(onboardState.phone)}">
        </div>`;
    } else if (onboardState.step === 2) {
        body = `
        <div class="input-group">
            <label>استفاده شما از این برنامه به چه صورت است؟ *</label>
            <div class="biz-type-grid" style="grid-template-columns:repeat(2,1fr);">
                <div class="biz-type-card ${onboardState.appMode !== 'pro' ? 'active' : ''}" onclick="obSelectAppMode('simple')">
                    <div class="biz-type-emoji">🏠</div><div class="biz-type-label">خانگی / مغازه کوچک (ساده)</div>
                </div>
                <div class="biz-type-card ${onboardState.appMode === 'pro' ? 'active' : ''}" onclick="obSelectAppMode('pro')">
                    <div class="biz-type-emoji">🏢</div><div class="biz-type-label">حرفه‌ای (کسب‌وکار متوسط تا بزرگ)</div>
                </div>
            </div>
            <p class="txt-caption" style="margin-top:6px;">در حالت ساده، بخش‌های پیشرفته (مثل شرکا و سهم سود) از منو مخفی می‌شوند تا محیط شلوغ نشود؛ همیشه از تنظیمات قابل تغییر است.</p>
        </div>
        <div class="input-group">
            <label>شغل / صنف شما چیست؟ *</label>
            <div class="biz-type-grid">
                ${BUSINESS_TYPES.map(b => `
                    <div class="biz-type-card ${onboardState.businessType === b.id ? 'active' : ''}" onclick="obSelectBiz('${b.id}')">
                        <div class="biz-type-emoji">${b.emoji}</div>
                        <div class="biz-type-label">${esc(b.label)}</div>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="input-group">
            <label>آدرس فروشگاه (برای سربرگ فاکتور)</label>
            <textarea id="ob_address" placeholder="آدرس کامل...">${esc(onboardState.address)}</textarea>
        </div>`;
    } else if (onboardState.step === 3) {
        body = `
        <div class="input-group">
            <label>این فروشگاه چگونه اداره می‌شود؟ *</label>
            <div class="biz-type-grid" style="grid-template-columns:repeat(2,1fr);">
                <div class="biz-type-card ${!onboardState.hasPartners ? 'active' : ''}" onclick="obSelectOwnership(false)">
                    <div class="biz-type-emoji">🧍</div><div class="biz-type-label">تک‌نفره (فقط من)</div>
                </div>
                <div class="biz-type-card ${onboardState.hasPartners ? 'active' : ''}" onclick="obSelectOwnership(true)">
                    <div class="biz-type-emoji">🤝</div><div class="biz-type-label">شراکتی (چند نفر)</div>
                </div>
            </div>
        </div>
        ${onboardState.hasPartners ? `
        <div class="input-group">
            <label>نحوه محاسبه درصد سهم هرکس</label>
            <select id="ob_percentMode" onchange="onboardState.percentMode=this.value; renderOnboard();">
                <option value="auto" ${onboardState.percentMode === 'auto' ? 'selected' : ''}>خودکار بر اساس مبلغ سرمایه هرکس</option>
                <option value="manual" ${onboardState.percentMode === 'manual' ? 'selected' : ''}>دستی — خودم درصد هرکس را مشخص می‌کنم</option>
            </select>
        </div>
        <div id="ob_partnersList">${obPartnersListHtml()}</div>
        <button type="button" class="btn-action" style="width:100%; margin-top:6px;" onclick="obAddPartnerRow()">+ افزودن شریک</button>
        ` : ''}`;
    } else {
        body = `
        <div class="input-group">
            <label>واحد پول</label>
            <select id="ob_currency">
                <option value="تومان" ${onboardState.currency === 'تومان' ? 'selected' : ''}>تومان</option>
                <option value="ریال" ${onboardState.currency === 'ریال' ? 'selected' : ''}>ریال</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div>
                <div class="settings-row-label">مالیات بر ارزش افزوده</div>
                <div class="settings-row-sub">محاسبه خودکار مالیات روی فاکتورها</div>
            </div>
            <label class="switch"><input type="checkbox" id="ob_taxEnabled" ${onboardState.taxEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="input-group" style="margin-top:10px;">
            <label>درصد مالیات</label>
            <input type="text" inputmode="numeric" id="ob_taxPercent" value="${esc(onboardState.taxPercent)}">
        </div>
        <div class="onboard-demo-warning">
            <div class="settings-row" style="padding-inline:0;">
                <div>
                    <div class="settings-row-label">بارگذاری داده‌های نمونه (تستی)</div>
                    <div class="settings-row-sub">چند مشتری، کالا و فاکتور ساختگی برای آشنایی با محیط برنامه اضافه می‌شود</div>
                </div>
                <label class="switch"><input type="checkbox" id="ob_loadDemo" ${onboardState.loadDemo ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <p class="txt-body" style="color:var(--accent-rose); font-weight:700; margin-top:8px; line-height:1.9;">
                ⚠️ این گزینه فقط برای آزمایش و آشنایی با امکانات برنامه است — اطلاعاتی که وارد می‌کند واقعی نیست. بعد از این‌که با برنامه آشنا شدید، حتماً از «تنظیمات ← پاک کردن همه اطلاعات و شروع مجدد» استفاده کنید و از صفر و به‌صورت واقعی شروع به کار کنید. توصیه می‌شود این گزینه را <u>خاموش</u> نگه دارید مگر بخواهید همین الان محیط برنامه را امتحان کنید.
            </p>
        </div>`;
    }

    overlay.innerHTML = `
    <div class="onboard-card">
        <div class="onboard-logo"><img src="icons/icon-192.png" alt="لوگو"></div>
        <div class="onboard-title">به حسابداری پلاس خوش آمدید</div>
        <div class="onboard-sub">برای شروع، چند سؤال کوتاه درباره فروشگاه‌تان می‌پرسیم</div>
        <div class="onboard-steps">${dots}</div>
        <div id="onboardBody">${body}</div>
        <div class="onboard-nav">
            ${onboardState.step > 1 ? `<button class="btn-action" onclick="obPrev()">بازگشت</button>` : ''}
            <button class="calc-btn" onclick="obNext()">${onboardState.step < 4 ? 'ادامه' : 'شروع کار با برنامه'}</button>
        </div>
    </div>`;
}

function obSelectOwnership(hasPartners) {
    onboardState.hasPartners = hasPartners;
    if (hasPartners && !onboardState.partnersDraft.length) {
        onboardState.partnersDraft = [
            { name: onboardState.ownerName || 'من (صاحب فروشگاه)', capital: '', percent: '' },
            { name: '', capital: '', percent: '' }
        ];
    }
    renderOnboard();
}
window.obSelectOwnership = obSelectOwnership;
function obPartnersListHtml() {
    return onboardState.partnersDraft.map((p, i) => `
        <div class="mini-form-grid" style="align-items:end; margin-bottom:8px;">
            <div class="input-group"><label>نام شریک ${(i + 1).toLocaleString(localeForDigits())}</label><input type="text" data-pidx="${i}" class="ob-partner-name" value="${esc(p.name)}" oninput="obSyncPartnerDraft()"></div>
            ${onboardState.percentMode === 'auto'
            ? `<div class="input-group"><label>مبلغ سرمایه (تومان)</label><input type="text" inputmode="numeric" data-pidx="${i}" class="ob-partner-capital" value="${esc(p.capital)}" oninput="obSyncPartnerDraft()"></div>`
            : `<div class="input-group"><label>درصد سهم (٪)</label><input type="text" inputmode="numeric" data-pidx="${i}" class="ob-partner-percent" value="${esc(p.percent)}" oninput="obSyncPartnerDraft()"></div>`}
        </div>`).join('');
}
function obSyncPartnerDraft() {
    document.querySelectorAll('.ob-partner-name').forEach(el => { onboardState.partnersDraft[+el.dataset.pidx].name = el.value; });
    document.querySelectorAll('.ob-partner-capital').forEach(el => { onboardState.partnersDraft[+el.dataset.pidx].capital = el.value; });
    document.querySelectorAll('.ob-partner-percent').forEach(el => { onboardState.partnersDraft[+el.dataset.pidx].percent = el.value; });
}
window.obSyncPartnerDraft = obSyncPartnerDraft;
function obAddPartnerRow() {
    obSyncPartnerDraft();
    onboardState.partnersDraft.push({ name: '', capital: '', percent: '' });
    renderOnboard();
}
window.obAddPartnerRow = obAddPartnerRow;

function obSelectBiz(id) { onboardState.businessType = id; renderOnboard(); }
window.obSelectBiz = obSelectBiz;
function obSelectAppMode(mode) { onboardState.appMode = mode; renderOnboard(); }
window.obSelectAppMode = obSelectAppMode;

function obCollectStep() {
    if (onboardState.step === 1) {
        onboardState.storeName = document.getElementById('ob_storeName').value.trim();
        onboardState.ownerName = document.getElementById('ob_ownerName').value.trim();
        onboardState.phone = document.getElementById('ob_phone').value.trim();
    } else if (onboardState.step === 2) {
        onboardState.address = document.getElementById('ob_address').value.trim();
    } else if (onboardState.step === 3) {
        if (onboardState.hasPartners) obSyncPartnerDraft();
    } else {
        onboardState.currency = document.getElementById('ob_currency').value;
        onboardState.taxEnabled = document.getElementById('ob_taxEnabled').checked;
        onboardState.taxPercent = num(document.getElementById('ob_taxPercent').value) || 9;
        onboardState.loadDemo = document.getElementById('ob_loadDemo').checked;
    }
}

function obNext() {
    obCollectStep();
    if (onboardState.step === 1 && !onboardState.storeName) {
        showToast('لطفاً اسم فروشگاه را وارد کنید', 'error');
        return;
    }
    if (onboardState.step < 4) {
        onboardState.step++;
        renderOnboard();
        return;
    }
    finishOnboarding();
}
function obPrev() {
    obCollectStep();
    if (onboardState.step <= 1) { onboardState.phase = 'account'; renderOnboard(); return; }
    onboardState.step--;
    renderOnboard();
}
window.obNext = obNext;
window.obPrev = obPrev;

function finishOnboarding() {
    saveSettings({
        storeName: onboardState.storeName,
        ownerName: onboardState.ownerName,
        phone: onboardState.phone,
        businessType: onboardState.businessType,
        address: onboardState.address,
        currency: onboardState.currency,
        taxEnabled: onboardState.taxEnabled,
        taxPercent: onboardState.taxPercent,
        invoicePrefix: 'INV',
        onboarded: true,
        partnershipMode: onboardState.hasPartners ? onboardState.percentMode : 'none',
        appMode: onboardState.appMode || 'pro'
    });
    if (onboardState.loadDemo) {
        generateSeedData(onboardState.businessType);
    } else {
        dbWrite(K.products, []); dbWrite(K.customers, []); dbWrite(K.invoices, []);
        dbWrite(K.purchases, []); dbWrite(K.expenses, []); dbWrite(K.cashtx, []);
    }
    if (onboardState.hasPartners) {
        const validPartners = onboardState.partnersDraft.filter(p => p.name.trim());
        const partners = validPartners.map(p => ({
            id: uid('ptn'),
            name: p.name.trim(),
            capitalToman: onboardState.percentMode === 'auto' ? num(p.capital) : 0,
            percentManual: onboardState.percentMode === 'manual' ? num(p.percent) : null,
            joinDate: todayISO(),
            note: ''
        }));
        dbWrite(K.partners, partners);
    }
    document.getElementById('onboardOverlay').hidden = true;
    refreshBrandChip();
    applyAppModeVisibility();
    switchView('home');
    showToast('فروشگاه شما آماده شد!', 'success');
    setTimeout(showWelcomeTourPopup, 400);
}

function showWelcomeTourPopup() {
    document.getElementById('welcomeTourBody').innerHTML = `
        <p class="txt-body" style="color:var(--text-secondary); margin-bottom:14px; line-height:1.9;">
            فروشگاه شما آماده است! اگر برای اولین‌بار از این برنامه استفاده می‌کنید، پیشنهاد می‌کنیم چند دقیقه وقت بگذارید و با «تور آموزشی نمایشی» با تمام بخش‌های برنامه (فروش، انبار، صندوق و بانک، چک‌ها، حقوق پرسنل، گزارش‌ها و ...) آشنا شوید. هر زمان هم که خواستید می‌توانید از منوی «راهنما» دوباره آن را اجرا کنید.
        </p>
        <div class="action-grid">
            <button class="btn-action" onclick="dismissWelcomeTour()">فعلاً نه، می‌خواهم خودم شروع کنم</button>
            <button class="calc-btn" onclick="dismissWelcomeTour(); startAppTour();">🎯 شروع تور آموزشی</button>
        </div>
    `;
    document.getElementById('welcomeTourOverlay').classList.add('active');
}
window.showWelcomeTourPopup = showWelcomeTourPopup;
function dismissWelcomeTour() { document.getElementById('welcomeTourOverlay').classList.remove('active'); }
window.dismissWelcomeTour = dismissWelcomeTour;

/* ---------------------------------------------------------------------------
   Dashboard
   ------------------------------------------------------------------------- */
function computeStats() {
    const invoices = dbRead(K.invoices);
    const purchases = dbRead(K.purchases);
    const expenses = dbRead(K.expenses);
    const products = dbRead(K.products);
    const customers = dbRead(K.customers);
    const cashtx = dbRead(K.cashtx);

    const now = new Date();
    const todaySales = invoices.filter(i => isSameDay(i.date, todayISO())).reduce((s, i) => s + num(i.total), 0);
    const monthSales = invoices.filter(i => { const d = new Date(i.date); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).reduce((s, i) => s + num(i.total), 0);
    const totalReceivable = invoices.reduce((s, i) => s + Math.max(0, num(i.total) - num(i.paidAmount)), 0);
    const totalPayable = purchases.reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0);
    const cashIn = invoices.reduce((s, i) => s + num(i.paidAmount), 0) + cashtx.filter(t => t.type === 'in').reduce((s, t) => s + num(t.amount), 0);
    const cashOut = purchases.reduce((s, p) => s + num(p.paidAmount), 0) + expenses.reduce((s, e) => s + num(e.amount), 0) + cashtx.filter(t => t.type === 'out').reduce((s, t) => s + num(t.amount), 0);
    const cashBalance = cashIn - cashOut;
    const lowStock = products.filter(p => num(p.qty) <= num(p.minQty));

    return { invoices, purchases, expenses, products, customers, todaySales, monthSales, totalReceivable, totalPayable, cashBalance, lowStock };
}

function last7DaysChart(invoices) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const total = invoices.filter(inv => isSameDay(inv.date, d.toISOString())).reduce((s, inv) => s + num(inv.total), 0);
        days.push({ label: d.toLocaleDateString('fa-IR', { weekday: 'short' }), total });
    }
    const max = Math.max(1, ...days.map(d => d.total));
    return days.map(d => `
        <div class="bar-chart-row">
            <span class="bar-chart-label">${esc(d.label)}</span>
            <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.max(3, Math.round(d.total / max * 100))}%"></div></div>
            <span class="bar-chart-val">${moneyPlain(d.total)}</span>
        </div>`).join('');
}

function renderDashboard() {
    const st = computeStats();
    const s = getSettings();
    const recent = [...st.invoices].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);

    const statusBadge = (status) => status === 'paid' ? '<span class="badge badge-emerald">پرداخت‌شده</span>' : status === 'partial' ? '<span class="badge badge-amber">پرداخت جزئی</span>' : '<span class="badge badge-rose">پرداخت‌نشده</span>';

    return `
    ${viewHeader('داشبورد', (s.storeName || 'فروشگاه من'), 'خلاصه وضعیت مالی و فروش امروز شما')}

    <div class="qa-grid">
        <div class="qa-item" onclick="openInvoiceEditor()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>فاکتور جدید</span>
        </div>
        <div class="qa-item" onclick="openProductEditor()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>
            <span>کالای جدید</span>
        </div>
        <div class="qa-item" onclick="openCustomerEditor()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            <span>مشتری جدید</span>
        </div>
        <div class="qa-item" onclick="switchView('reports')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            <span>گزارش‌ها</span>
        </div>
    </div>

    <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${money(st.todaySales)}</div><div class="stat-label">فروش امروز</div></div>
        <div class="stat-card"><div class="stat-val">${money(st.monthSales)}</div><div class="stat-label">فروش این ماه</div></div>
        <div class="stat-card"><div class="stat-val" style="color:${st.cashBalance >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${money(st.cashBalance)}</div><div class="stat-label">موجودی صندوق</div></div>
        <div class="stat-card"><div class="stat-val" style="color:var(--accent-amber)">${money(st.totalReceivable)}</div><div class="stat-label">مطالبات از مشتریان</div></div>
    </div>

    <div class="section-box">
        <div class="section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            فروش ۷ روز اخیر
        </div>
        ${last7DaysChart(st.invoices)}
    </div>

    ${st.lowStock.length ? `
    <div class="section-box">
        <div class="section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            کالاهای رو به اتمام (${st.lowStock.length.toLocaleString(localeForDigits())})
        </div>
        ${st.lowStock.slice(0, 5).map(p => `
            <div class="list-item" style="margin-bottom:8px; cursor:pointer;" onclick="openProductEditor('${p.id}')">
                <div class="list-item-row"><span class="list-item-title">${esc(p.name)}</span><span class="badge badge-rose">${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit)} باقی‌مانده</span></div>
            </div>`).join('')}
    </div>` : ''}

    <div class="section-box">
        <div class="section-title" style="justify-content:space-between;">
            <span style="display:flex; align-items:center; gap:8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                آخرین فاکتورها
            </span>
            <a onclick="switchView('invoices')" style="font-size:0.72rem; color:var(--accent-cyan); font-weight:800; cursor:pointer;">مشاهده همه</a>
        </div>
        ${recent.length ? recent.map(inv => `
            <div class="list-item" style="margin-bottom:8px; cursor:pointer;" onclick="openInvoiceView('${inv.id}')">
                <div class="list-item-row">
                    <div>
                        <div class="list-item-title">${esc(inv.customerNameSnapshot || 'مشتری نقدی')} <span class="txt-caption">#${inv.number}</span></div>
                        <div class="list-item-sub">${fmtDate(inv.date)}</div>
                    </div>
                    <div style="text-align:left;">
                        <div class="list-item-title">${money(inv.total)}</div>
                        ${statusBadge(inv.status)}
                    </div>
                </div>
            </div>`).join('') : `<div class="empty-state">هنوز فاکتوری ثبت نشده است.</div>`}
    </div>`;
}
VIEW_RENDERERS.dashboard = renderDashboard;

/* ---------------------------------------------------------------------------
   Customers
   ------------------------------------------------------------------------- */
let customerSearchTerm = '';
let customerOpenProvince = null;

const IRAN_PROVINCES = {
    'تهران': ['تهران', 'شهریار', 'اسلام‌شهر', 'ورامین', 'دماوند'],
    'اصفهان': ['اصفهان', 'کاشان', 'نجف‌آباد', 'خمینی‌شهر'],
    'فارس': ['شیراز', 'مرودشت', 'جهرم', 'کازرون'],
    'خراسان رضوی': ['مشهد', 'نیشابور', 'سبزوار', 'تربت حیدریه'],
    'آذربایجان شرقی': ['تبریز', 'مراغه', 'میانه'],
    'آذربایجان غربی': ['ارومیه', 'خوی', 'مهاباد'],
    'قم': ['قم'],
    'البرز': ['کرج', 'نظرآباد', 'فردیس'],
    'گیلان': ['رشت', 'انزلی', 'لاهیجان'],
    'مازندران': ['ساری', 'بابل', 'آمل', 'قائم‌شهر'],
    'کرمان': ['کرمان', 'رفسنجان', 'سیرجان'],
    'خوزستان': ['اهواز', 'آبادان', 'دزفول'],
    'یزد': ['یزد', 'میبد'],
    'همدان': ['همدان', 'ملایر'],
    'کرمانشاه': ['کرمانشاه'],
    'مرکزی': ['اراک'],
    'قزوین': ['قزوین'],
    'زنجان': ['زنجان'],
    'گلستان': ['گرگان', 'گنبد کاووس'],
    'اردبیل': ['اردبیل'],
    'سیستان و بلوچستان': ['زاهدان', 'زابل'],
    'هرمزگان': ['بندرعباس'],
    'بوشهر': ['بوشهر'],
    'لرستان': ['خرم‌آباد'],
    'کردستان': ['سنندج'],
    'سمنان': ['سمنان'],
    'ایلام': ['ایلام'],
    'چهارمحال و بختیاری': ['شهرکرد'],
    'کهگیلویه و بویراحمد': ['یاسوج'],
    'خراسان شمالی': ['بجنورد'],
    'خراسان جنوبی': ['بیرجند'],
    'سایر / متفرقه': ['متفرقه']
};

function customerBalance(customerId) {
    const invoices = dbRead(K.invoices).filter(i => i.customerId === customerId);
    return invoices.reduce((s, i) => s + Math.max(0, num(i.total) - num(i.paidAmount)), 0);
}

function customerItemHtml(c) {
    const bal = customerBalance(c.id);
    return `
    <div class="list-item" style="cursor:pointer;" onclick="openCustomerView('${c.id}')">
        <div class="list-item-row-full">
            <div class="entity-avatar">${esc(initials(c.name))}</div>
            <div class="list-item-body">
                <div class="list-item-title">${esc(c.name)}</div>
                <div class="list-item-sub">${esc(c.phone || 'بدون شماره')}${c.city ? ' · ' + esc(c.city) : ''}</div>
            </div>
            <div style="text-align:left;">${bal > 0 ? `<span class="badge badge-rose">بدهکار ${moneyPlain(bal)}</span>` : `<span class="badge badge-emerald">تسویه</span>`}</div>
        </div>
    </div>`;
}

function renderCustomers() {
    const all = dbRead(K.customers);
    const term = customerSearchTerm.trim();
    const header = viewHeader('اشخاص', 'مشتریان', `${all.length.toLocaleString(localeForDigits())} مشتری ثبت‌شده`,
        `<button class="nav-btn" onclick="openListPrintOptions('customers')" title="چاپ لیست مشتریان"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);
    const searchBar = `<div class="search-bar">
        <input type="text" placeholder="جستجوی نام، شماره یا شهر..." value="${esc(customerSearchTerm)}" oninput="customerSearchTerm=this.value; rerenderIfActive('customers')">
        <button class="fab-add" onclick="openCustomerEditor()" title="افزودن مشتری">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>`;

    if (term) {
        const list = all.filter(c => (c.name + (c.phone || '') + (c.province || '') + (c.city || '')).includes(term));
        return header + searchBar + (list.length ? `<div id="customerListWrap"></div><div style="display:none" id="customerFlatData">${esc(JSON.stringify(list.map(c => c.id)))}</div>` : `<div class="empty-state">مشتری‌ای یافت نشد.</div>`);
    }

    if (!customerOpenProvince) {
        const groups = {};
        all.forEach(c => { const p = c.province || 'سایر / متفرقه'; (groups[p] = groups[p] || []).push(c); });
        const provNames = Object.keys(groups).sort();
        return header + searchBar + (provNames.length ? provNames.map(p => `
            <div class="list-item" style="cursor:pointer;" onclick="customerOpenProvince='${esc(p).replace(/'/g, "\\'")}'; rerenderIfActive('customers')">
                <div class="list-item-row"><div class="list-item-title">📁 ${esc(p)}</div><div class="badge badge-cyan">${groups[p].length.toLocaleString(localeForDigits())} مشتری</div></div>
            </div>`).join('') : `<div class="empty-state">مشتری‌ای یافت نشد. یکی اضافه کنید.</div>`);
    }

    const inProv = all.filter(c => (c.province || 'سایر / متفرقه') === customerOpenProvince);
    return header + `
        <button class="btn-action" style="margin-bottom:10px;" onclick="customerOpenProvince=null; rerenderIfActive('customers')">→ بازگشت به استان‌ها</button>
        ${searchBar}
        <div class="section-title">📁 ${esc(customerOpenProvince)} (${inProv.length.toLocaleString(localeForDigits())})</div>
        ${inProv.map(customerItemHtml).join('') || `<div class="empty-state">مشتری‌ای در این استان نیست.</div>`}
    `;
}
VIEW_RENDERERS.customers = renderCustomers;
window.customerOpenProvince = null;

function renderCustomerFlatList() {
    const wrap = document.getElementById('customerListWrap');
    const dataEl = document.getElementById('customerFlatData');
    if (!wrap || !dataEl) return;
    const ids = JSON.parse(dataEl.textContent);
    const all = dbRead(K.customers);
    const list = ids.map(id => all.find(c => c.id === id)).filter(Boolean);
    attachInfiniteRenderWindow(wrap, list, 40, customerItemHtml);
}
window.renderCustomerFlatList = renderCustomerFlatList;

function rerenderIfActive(name) {
    if (currentView === name) {
        const scrollY = window.scrollY;
        document.getElementById('viewRoot').innerHTML = VIEW_RENDERERS[name]();
        window.scrollTo(0, scrollY);
        afterViewRender(name);
    }
}
window.rerenderIfActive = rerenderIfActive;
window.customerSearchTerm = '';

function getCustomProvinces() {
    const custom = dbRead('ap_custom_provinces');
    return (Array.isArray(custom) ? custom : []); // array of {name, cities:[...]}
}
function allProvinceNames() {
    const custom = getCustomProvinces().map(p => p.name);
    return Object.keys(IRAN_PROVINCES).concat(custom.filter(n => !IRAN_PROVINCES[n]));
}
function citiesForProvince(name) {
    if (IRAN_PROVINCES[name]) {
        const extra = (getCustomProvinces().find(p => p.name === name) || {}).cities || [];
        return IRAN_PROVINCES[name].concat(extra.filter(c => !IRAN_PROVINCES[name].includes(c)));
    }
    const custom = getCustomProvinces().find(p => p.name === name);
    return custom ? custom.cities : [];
}
function addCustomCity(provinceName, cityName) {
    const list = getCustomProvinces();
    let entry = list.find(p => p.name === provinceName);
    if (!entry) { entry = { name: provinceName, cities: [] }; list.push(entry); }
    if (!entry.cities.includes(cityName)) entry.cities.push(cityName);
    dbWrite('ap_custom_provinces', list);
}
function addCustomProvince(provinceName, cityName) {
    const list = getCustomProvinces();
    if (!list.find(p => p.name === provinceName)) list.push({ name: provinceName, cities: cityName ? [cityName] : [] });
    else if (cityName) addCustomCity(provinceName, cityName);
    dbWrite('ap_custom_provinces', list);
}

function openCustomerEditor(id) {
    const c = id ? dbRead(K.customers).find(x => x.id === id) : null;
    const provNames = allProvinceNames();
    const html = `
        <div class="input-group"><label>نام مشتری *</label><input type="text" id="cf_name" value="${esc(c ? c.name : '')}" placeholder="نام و نام‌خانوادگی"></div>
        <div class="input-group"><label>شماره تماس</label><input type="text" id="cf_phone" value="${esc(c ? c.phone : '')}" placeholder="09xxxxxxxxx"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>استان</label>
                <select id="cf_province" onchange="cfRefreshCities()">
                    ${provNames.map(p => `<option value="${esc(p)}" ${c && c.province === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
                    <option value="__newProvince__">+ افزودن استان و شهر جدید…</option>
                </select>
            </div>
            <div class="input-group"><label>شهر</label>
                <select id="cf_city" onchange="cfOnCityChange()"></select>
            </div>
        </div>
        <div class="mini-form-grid" id="cf_newCityWrap" style="display:none;">
            <div class="input-group"><label>نام شهر جدید</label><input type="text" id="cf_newCityName" placeholder="مثلاً: شهر جدید"></div>
        </div>
        <div class="mini-form-grid" id="cf_newProvinceWrap" style="display:none;">
            <div class="input-group"><label>نام استان جدید</label><input type="text" id="cf_newProvinceName"></div>
            <div class="input-group"><label>نام شهر (اختیاری)</label><input type="text" id="cf_newProvinceCityName"></div>
        </div>
        <div class="input-group"><label>آدرس</label><textarea id="cf_address" placeholder="آدرس (اختیاری)">${esc(c ? c.address : '')}</textarea></div>
        <div class="input-group"><label>یادداشت</label><textarea id="cf_notes" placeholder="یادداشت (اختیاری)">${esc(c ? c.notes : '')}</textarea></div>
        <button class="calc-btn" onclick="saveCustomer('${id || ''}')">${c ? 'ذخیره تغییرات' : 'افزودن مشتری'}</button>
        ${c ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteCustomer('${id}')">حذف مشتری</button>` : ''}
    `;
    openModal(c ? 'ویرایش مشتری' : 'مشتری جدید', html);
    cfRefreshCities(c ? c.city : null);
}
window.openCustomerEditor = openCustomerEditor;

function cfRefreshCities(presetCity) {
    const provSel = document.getElementById('cf_province');
    const citySel = document.getElementById('cf_city');
    if (!provSel || !citySel) return;
    document.getElementById('cf_newProvinceWrap').style.display = (provSel.value === '__newProvince__') ? 'block' : 'none';
    if (provSel.value === '__newProvince__') { citySel.innerHTML = ''; return; }
    const cities = citiesForProvince(provSel.value);
    citySel.innerHTML = cities.map(c => `<option value="${esc(c)}" ${presetCity === c ? 'selected' : ''}>${esc(c)}</option>`).join('') + `<option value="__newCity__">+ شهر دلخواه (در لیست نیست)…</option>`;
    document.getElementById('cf_newCityWrap').style.display = 'none';
}
window.cfRefreshCities = cfRefreshCities;
function cfOnCityChange() {
    const citySel = document.getElementById('cf_city');
    document.getElementById('cf_newCityWrap').style.display = (citySel.value === '__newCity__') ? 'block' : 'none';
}
window.cfOnCityChange = cfOnCityChange;

function saveCustomer(id) {
    const name = document.getElementById('cf_name').value.trim();
    if (!name) { showToast('نام مشتری الزامی است', 'error'); return; }
    let province = document.getElementById('cf_province').value;
    let city = document.getElementById('cf_city').value;
    if (province === '__newProvince__') {
        province = document.getElementById('cf_newProvinceName').value.trim();
        city = document.getElementById('cf_newProvinceCityName').value.trim();
        if (!province) { showToast('نام استان جدید را وارد کنید', 'error'); return; }
        addCustomProvince(province, city || null);
    } else if (city === '__newCity__') {
        city = document.getElementById('cf_newCityName').value.trim();
        if (!city) { showToast('نام شهر جدید را وارد کنید', 'error'); return; }
        addCustomCity(province, city);
    }
    const list = dbRead(K.customers);
    const data = {
        name, phone: document.getElementById('cf_phone').value.trim(),
        province, city,
        address: document.getElementById('cf_address').value.trim(),
        notes: document.getElementById('cf_notes').value.trim()
    };
    if (id) {
        const idx = list.findIndex(c => c.id === id);
        if (idx > -1) list[idx] = Object.assign(list[idx], data);
    } else {
        list.push(Object.assign({ id: uid('c'), createdAt: todayISO() }, data));
    }
    dbWrite(K.customers, list);
    autoBackupTick();
    closeModal();
    showToast('مشتری ذخیره شد', 'success');
    switchView('customers');
}
window.saveCustomer = saveCustomer;

function deleteCustomer(id) {
    if (!confirmAction('آیا از حذف این مشتری مطمئن هستید؟')) return;
    dbWrite(K.customers, dbRead(K.customers).filter(c => c.id !== id));
    autoBackupTick();
    closeModal();
    showToast('مشتری حذف شد', 'success');
    switchView('customers');
}
window.deleteCustomer = deleteCustomer;

function openCustomerView(id) {
    const c = dbRead(K.customers).find(x => x.id === id);
    if (!c) return;
    const invoices = dbRead(K.invoices).filter(i => i.customerId === id).sort((a, b) => new Date(b.date) - new Date(a.date));
    const bal = customerBalance(id);
    const html = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
            <div class="entity-avatar" style="width:50px; height:50px; font-size:1.1rem;">${esc(initials(c.name))}</div>
            <div>
                <div class="txt-h2">${esc(c.name)}</div>
                <div class="txt-caption">${esc(c.phone || 'بدون شماره تماس')}</div>
            </div>
        </div>
        <div class="totals-box" style="margin-bottom:16px;">
            <div class="totals-row grand"><span>مانده بدهی</span><span style="color:${bal > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)'}">${money(bal)}</span></div>
        </div>
        <div class="action-grid">
            <button class="btn-action" onclick="closeModal(); openCustomerEditor('${id}')">ویرایش اطلاعات</button>
            <button class="btn-action" onclick="closeModal(); openInvoiceEditor(null,'${id}')">فاکتور جدید</button>
        </div>
        <button class="btn-action" style="width:100%; margin-top:8px;" onclick="printCustomerStatement('${id}')">🖨 چاپ صورت‌حساب مشتری</button>
        <div class="section-title" style="margin-top:16px;">تاریخچه فاکتورها (${invoices.length.toLocaleString(localeForDigits())})</div>
        ${invoices.length ? invoices.map(inv => `
            <div class="list-item" style="cursor:pointer;" onclick="closeModal(); setTimeout(()=>openInvoiceView('${inv.id}'),150)">
                <div class="list-item-row">
                    <div><div class="list-item-title">فاکتور #${inv.number}</div><div class="list-item-sub">${fmtDate(inv.date)}</div></div>
                    <div style="text-align:left;"><div class="list-item-title">${money(inv.total)}</div></div>
                </div>
            </div>`).join('') : `<div class="empty-state">فاکتوری برای این مشتری ثبت نشده.</div>`}
    `;
    openModal('پرونده مشتری', html);
}
window.openCustomerView = openCustomerView;

function printCustomerStatement(id) {
    const c = dbRead(K.customers).find(x => x.id === id);
    if (!c) return;
    const invoices = dbRead(K.invoices).filter(i => i.customerId === id).sort((a, b) => new Date(a.date) - new Date(b.date));
    const bal = customerBalance(id);
    const html = `
    ${billTemplateOpenTag()}
        ${billHeaderHtml('صورت‌حساب مشتری')}
        <div class="bill-info-container"><div class="bill-info-grid">
            <div><strong>مشتری:</strong> ${esc(c.name)}</div>
            <div><strong>تلفن:</strong> ${esc(c.phone || '-')}</div>
            <div><strong>شهر:</strong> ${esc(c.city || '-')}</div>
            <div><strong>تاریخ صدور:</strong> ${fmtDate(todayISO())}</div>
        </div></div>
        <table class="bill-table">
            <thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>مبلغ کل</th><th>پرداخت‌شده</th><th>مانده</th></tr></thead>
            <tbody>${invoices.map(inv => `<tr><td>${inv.number}</td><td>${fmtDate(inv.date)}</td><td>${moneyPlain(inv.total)}</td><td>${moneyPlain(inv.paidAmount)}</td><td>${moneyPlain(Math.max(0, inv.total - inv.paidAmount))}</td></tr>`).join('')}</tbody>
        </table>
        <div class="bill-totals"><div class="totals-row grand"><span>مانده کل بدهی</span><span>${moneyPlain(bal)} ${esc(currencyLabel())}</span></div></div>
        <div class="signatures-container">
            <div class="signature-card"><div class="signature-card-name">مهر و امضای فروشگاه</div><div class="signature-space"></div></div>
        </div>
    </div>
    ${printFooterButton()}`;
    openModal('صورت‌حساب ' + c.name, html);
}
window.printCustomerStatement = printCustomerStatement;

/* ---------------------------------------------------------------------------
   Products / Inventory
   ------------------------------------------------------------------------- */
let productSearchTerm = '';
let productFilter = 'all'; // all | low
let productOpenFolders = new Set(); // accordion: any number of categories can be expanded at once
function toggleProductFolder(cat) {
    if (productOpenFolders.has(cat)) productOpenFolders.delete(cat); else productOpenFolders.add(cat);
    rerenderIfActive('products');
}
window.toggleProductFolder = toggleProductFolder;

function renderProducts() {
    const all = dbRead(K.products);
    const term = productSearchTerm.trim();
    const totalValue = all.reduce((s, p) => s + num(p.qty) * num(p.buyPrice), 0);
    const header = viewHeader('انبار', 'کالا و انبار', `${all.length.toLocaleString(localeForDigits())} کالا · ارزش انبار: ${money(totalValue)}`,
        `<button class="nav-btn" onclick="openListPrintOptions('products')" title="چاپ لیست انبار"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);

    const searchBar = `
    <div class="chip-row">
        <span class="chip ${productFilter === 'all' ? 'active' : ''}" onclick="productFilter='all'; rerenderIfActive('products')">همه</span>
        <span class="chip ${productFilter === 'low' ? 'active' : ''}" onclick="productFilter='low'; rerenderIfActive('products')">رو به اتمام</span>
    </div>
    <div class="search-bar">
        <input type="text" placeholder="جستجوی نام یا دسته کالا..." value="${esc(productSearchTerm)}" oninput="productSearchTerm=this.value; rerenderIfActive('products')">
        <button class="fab-add" onclick="openProductEditor()" title="افزودن کالا">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>`;

    const productItemHtml = (p) => {
        const low = num(p.qty) <= num(p.minQty);
        return `
        <div class="list-item" style="cursor:pointer;" onclick="openProductEditor('${p.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(p.name)}</div><div class="list-item-sub">${esc(p.category || 'بدون دسته')} · قیمت فروش: ${moneyPlain(p.sellPrice)}</div></div>
                <div style="text-align:left;">
                    <div class="list-item-title ${low ? 'stock-low' : 'stock-ok'}">${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit || '')}</div>
                    ${low ? '<span class="badge badge-rose">کم موجود</span>' : ''}
                </div>
            </div>
        </div>`;
    };

    // Search or low-stock filter: show a flat filtered list (no folders needed)
    if (term || productFilter === 'low') {
        let list = term ? all.filter(p => (p.name + (p.category || '')).includes(term)) : all;
        if (productFilter === 'low') list = list.filter(p => num(p.qty) <= num(p.minQty));
        return header + searchBar + (list.length ? `<div id="productListWrap"></div><div style="display:none" id="productFlatData">${esc(JSON.stringify(list.map(p => p.id)))}</div>` : `<div class="empty-state">کالایی یافت نشد.</div>`);
    }

    // Folder view: accordion grouped by category — folders expand/collapse in place, sorted alphabetically
    const cats = {};
    all.forEach(p => { const c = p.category || 'بدون دسته'; (cats[c] = cats[c] || []).push(p); });
    const catNames = Object.keys(cats).sort((a, b) => a.localeCompare(b, 'fa'));
    return header + searchBar + (catNames.length ? catNames.map(c => {
        const open = productOpenFolders.has(c);
        const itemsSorted = cats[c].slice().sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        return `
        <div class="accordion-item">
            <div class="list-item" style="cursor:pointer;" onclick="toggleProductFolder('${esc(c).replace(/'/g, "\\'")}')">
                <div class="list-item-row">
                    <div class="list-item-title">📁 ${esc(c)}</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="badge badge-cyan">${cats[c].length.toLocaleString(localeForDigits())} کالا</div>
                        <span style="transition:transform .15s; display:inline-block; transform:rotate(${open ? '180deg' : '0deg'});">▾</span>
                    </div>
                </div>
            </div>
            ${open ? `<div class="accordion-body" style="padding-inline-start:10px;">${itemsSorted.map(productItemHtml).join('') || `<div class="empty-state">کالایی در این دسته نیست.</div>`}</div>` : ''}
        </div>`;
    }).join('') : `<div class="empty-state">کالایی یافت نشد. یکی اضافه کنید.</div>`);
}
VIEW_RENDERERS.products = renderProducts;
window.productFilter = 'all';

function renderProductFlatList() {
    const wrap = document.getElementById('productListWrap');
    const dataEl = document.getElementById('productFlatData');
    if (!wrap || !dataEl) return;
    const ids = JSON.parse(dataEl.textContent);
    const all = dbRead(K.products);
    const list = ids.map(id => all.find(p => p.id === id)).filter(Boolean);
    attachInfiniteRenderWindow(wrap, list, 40, (p) => {
        const low = num(p.qty) <= num(p.minQty);
        return `<div class="list-item" style="cursor:pointer;" onclick="openProductEditor('${p.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(p.name)}</div><div class="list-item-sub">${esc(p.category || 'بدون دسته')} · قیمت فروش: ${moneyPlain(p.sellPrice)}</div></div>
                <div style="text-align:left;"><div class="list-item-title ${low ? 'stock-low' : 'stock-ok'}">${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit || '')}</div>${low ? '<span class="badge badge-rose">کم موجود</span>' : ''}</div>
            </div></div>`;
    });
}
window.renderProductFlatList = renderProductFlatList;

function openProductEditor(id) {
    const p = id ? dbRead(K.products).find(x => x.id === id) : null;
    const cats = allCategories();
    const html = `
        <div class="input-group"><label>نام کالا *</label><input type="text" id="pf_name" value="${esc(p ? p.name : '')}" placeholder="مثلاً: پیراهن مردانه"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>دسته‌بندی</label>
                <input type="text" id="pf_category" list="pf_category_list" value="${esc(p ? p.category : '')}" placeholder="مثلاً: پوشاک (یا دسته جدید تایپ کنید)">
                <datalist id="pf_category_list">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
                <div class="field-hint">💡 برای دیدن لیست دسته‌های قبلی، روی فیلد دوبار کلیک کنید یا شروع به تایپ کنید</div>
            </div>
            <div class="input-group"><label>واحد شمارش</label>
                <input type="text" id="pf_unit" list="pf_unit_list" value="${esc(p ? p.unit : 'عدد')}" placeholder="انتخاب کنید یا واحد دلخواه تایپ کنید">
                <datalist id="pf_unit_list">
                    ${['عدد', 'کیلوگرم', 'گرم', 'بسته', 'کارتن', 'متر', 'سانتی‌متر', 'لیتر', 'میلی‌لیتر', 'جفت', 'دست', 'رول', 'شاخه', 'بطری', 'قوطی', 'ست'].map(u => `<option value="${u}">`).join('')}
                </datalist>
                <div class="field-hint">💡 دوبار کلیک کنید تا لیست واحدهای رایج نشان داده شود</div>
            </div>
            <div class="input-group"><label>قیمت خرید</label><input type="text" inputmode="numeric" id="pf_buy" value="${p ? num(p.buyPrice) : ''}" placeholder="0"></div>
            <div class="input-group"><label>قیمت فروش *</label><input type="text" inputmode="numeric" id="pf_sell" value="${p ? num(p.sellPrice) : ''}" placeholder="0"></div>
            <div class="input-group"><label>موجودی فعلی</label><input type="text" inputmode="numeric" id="pf_qty" value="${p ? num(p.qty) : 0}" placeholder="0"></div>
            <div class="input-group"><label>حداقل موجودی هشدار</label><input type="text" inputmode="numeric" id="pf_minqty" value="${p ? num(p.minQty) : 3}" placeholder="3"></div>
        </div>
        <button class="calc-btn" onclick="saveProduct('${id || ''}')">${p ? 'ذخیره تغییرات' : 'افزودن کالا'}</button>
        ${p ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteProduct('${id}')">حذف کالا</button>` : ''}
    `;
    openModal(p ? 'ویرایش کالا' : 'کالای جدید', html);
}
window.openProductEditor = openProductEditor;

let _productCreateForPurchaseIdx = null;
function openNewProductForPurchase(idx) {
    _productCreateForPurchaseIdx = idx;
    closeModal();
    openProductEditor();
}
window.openNewProductForPurchase = openNewProductForPurchase;

function saveProduct(id) {
    const name = document.getElementById('pf_name').value.trim();
    const sell = num(document.getElementById('pf_sell').value);
    if (!name) { showToast('نام کالا الزامی است', 'error'); return; }
    if (!sell) { showToast('قیمت فروش را وارد کنید', 'error'); return; }
    const category = document.getElementById('pf_category').value.trim();
    ensureCategory(category);
    const list = dbRead(K.products);
    const data = {
        name, category,
        unit: document.getElementById('pf_unit').value.trim() || 'عدد',
        buyPrice: num(document.getElementById('pf_buy').value),
        sellPrice: sell,
        qty: num(document.getElementById('pf_qty').value),
        minQty: num(document.getElementById('pf_minqty').value)
    };
    let created = null;
    if (id) {
        const idx = list.findIndex(p => p.id === id);
        if (idx > -1) list[idx] = Object.assign(list[idx], data);
    } else {
        created = Object.assign({ id: uid('p'), createdAt: todayISO() }, data);
        list.push(created);
    }
    dbWrite(K.products, list);
    autoBackupTick();

    // Special case: this product was created from inside the "خرید از تأمین‌کننده" flow
    // (buying a brand-new item straight from the supplier) — wire it into that purchase row.
    if (created && _productCreateForPurchaseIdx !== null) {
        const idx = _productCreateForPurchaseIdx;
        _productCreateForPurchaseIdx = null;
        draftPurchase.items[idx] = { productId: created.id, name: created.name, qty: draftPurchase.items[idx] ? (draftPurchase.items[idx].qty || 1) : 1, price: created.buyPrice };
        closeModal();
        showToast('کالای جدید ثبت و به این خرید اضافه شد', 'success');
        rerenderPurchaseNew();
        return;
    }

    closeModal();
    showToast('کالا ذخیره شد', 'success');
    switchView('products');
}
window.saveProduct = saveProduct;

function deleteProduct(id) {
    if (!confirmAction('آیا از حذف این کالا مطمئن هستید؟')) return;
    dbWrite(K.products, dbRead(K.products).filter(p => p.id !== id));
    autoBackupTick();
    closeModal();
    showToast('کالا حذف شد', 'success');
    switchView('products');
}
window.deleteProduct = deleteProduct;

/* ---------------------------------------------------------------------------
   Invoices (sales)
   ------------------------------------------------------------------------- */
let invoiceSearchTerm = '';
let invoiceFilter = 'all';
let draftInvoice = null;

function invStatusBadge(status) { return status === 'paid' ? '<span class="badge badge-emerald">پرداخت‌شده</span>' : status === 'partial' ? '<span class="badge badge-amber">جزئی</span>' : '<span class="badge badge-rose">پرداخت‌نشده</span>'; }
function invoiceItemHtml(inv) {
    return `
    <div class="list-item" style="cursor:pointer;" onclick="openInvoiceView('${inv.id}')">
        <div class="list-item-row">
            <div>
                <div class="list-item-title">${inv.invoiceType === 'proforma' ? '<span class="badge badge-cyan" style="margin-inline-end:4px;">پیش‌فاکتور</span>' : ''}${inv.excludeFromPartnership ? '<span class="badge badge-amber" style="margin-inline-end:4px;" title="مشترک با شرکا نیست">🚫شرکا</span>' : ''}${esc(inv.customerNameSnapshot || 'مشتری نقدی')} <span class="txt-caption">#${inv.number}</span></div>
                <div class="list-item-sub">${fmtDate(inv.date)} · ${inv.items.length.toLocaleString(localeForDigits())} قلم کالا</div>
            </div>
            <div style="text-align:left;"><div class="list-item-title">${money(inv.total)}</div>${invStatusBadge(inv.status)}</div>
        </div>
    </div>`;
}

function renderInvoices() {
    const all = dbRead(K.invoices).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const term = invoiceSearchTerm.trim();
    let list = term ? all.filter(i => (String(i.number) + (i.customerNameSnapshot || '')).includes(term)) : all;
    if (invoiceFilter !== 'all') list = list.filter(i => i.status === invoiceFilter);

    const header = viewHeader('فروش', 'فاکتورهای فروش', `${all.length.toLocaleString(localeForDigits())} فاکتور ثبت‌شده`,
        `<button class="nav-btn" onclick="openListPrintOptions('invoices')" title="چاپ لیست فاکتورها"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);

    const controls = `
    <div class="chip-row">
        <span class="chip ${invoiceFilter === 'all' ? 'active' : ''}" onclick="invoiceFilter='all'; rerenderIfActive('invoices')">همه</span>
        <span class="chip ${invoiceFilter === 'paid' ? 'active' : ''}" onclick="invoiceFilter='paid'; rerenderIfActive('invoices')">پرداخت‌شده</span>
        <span class="chip ${invoiceFilter === 'partial' ? 'active' : ''}" onclick="invoiceFilter='partial'; rerenderIfActive('invoices')">جزئی</span>
        <span class="chip ${invoiceFilter === 'unpaid' ? 'active' : ''}" onclick="invoiceFilter='unpaid'; rerenderIfActive('invoices')">پرداخت‌نشده</span>
    </div>
    <div class="input-group" style="margin-bottom:10px;">
        <label>نحوه نمایش / دسته‌بندی</label>
        <select id="inv_groupMode" onchange="invoiceGroupMode=this.value; rerenderIfActive('invoices')">
            <option value="none" ${invoiceGroupMode === 'none' ? 'selected' : ''}>فهرست ساده (جدیدترین اول)</option>
            <option value="year" ${invoiceGroupMode === 'year' ? 'selected' : ''}>بر اساس سال</option>
            <option value="month" ${invoiceGroupMode === 'month' ? 'selected' : ''}>بر اساس ماه (تقویم شمسی)</option>
            <option value="customer" ${invoiceGroupMode === 'customer' ? 'selected' : ''}>بر اساس مشتری</option>
            <option value="year_customer" ${invoiceGroupMode === 'year_customer' ? 'selected' : ''}>بر اساس سال، سپس مشتری</option>
            <option value="customer_year" ${invoiceGroupMode === 'customer_year' ? 'selected' : ''}>بر اساس مشتری، سپس سال</option>
        </select>
    </div>
    <div class="search-bar">
        <input type="text" placeholder="جستجوی شماره فاکتور یا نام مشتری..." value="${esc(invoiceSearchTerm)}" oninput="invoiceSearchTerm=this.value; rerenderIfActive('invoices')">
        <button class="fab-add" onclick="openInvoiceEditor()" title="فاکتور جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>`;

    if (!list.length) return header + controls + `<div class="empty-state">فاکتوری یافت نشد.</div>`;
    if (invoiceGroupMode !== 'none') return header + controls + invoiceGroupedHtml(list, invoiceGroupMode);
    return header + controls + `<div id="invoiceListWrap"></div><div style="display:none" id="invoiceFlatData">${esc(JSON.stringify(list.map(i => i.id)))}</div>`;
}
VIEW_RENDERERS.invoices = renderInvoices;
window.invoiceGroupMode = 'none';
let invoiceOpenGroups = new Set();
function toggleInvoiceGroup(key) {
    if (invoiceOpenGroups.has(key)) invoiceOpenGroups.delete(key); else invoiceOpenGroups.add(key);
    rerenderIfActive('invoices');
}
window.toggleInvoiceGroup = toggleInvoiceGroup;
function invoiceGroupLabelParts(inv) {
    const j = isoToJalaliParts(inv.date);
    return { year: String(j.jy).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]), month: FA_MONTHS[j.jm - 1], customer: inv.customerNameSnapshot || 'مشتری نقدی' };
}
function invoiceGroupedHtml(list, mode) {
    // build a 1 or 2-level grouping tree based on the selected mode
    const level1 = {}; // key -> { label, items:[] }
    list.forEach(inv => {
        const parts = invoiceGroupLabelParts(inv);
        let key1, label1;
        if (mode === 'year') { key1 = parts.year; label1 = 'سال ' + parts.year; }
        else if (mode === 'month') { key1 = parts.year + '-' + parts.month; label1 = parts.month + ' ' + parts.year; }
        else if (mode === 'customer' || mode === 'customer_year') { key1 = parts.customer; label1 = parts.customer; }
        else { key1 = parts.year; label1 = 'سال ' + parts.year; } // year_customer
        if (!level1[key1]) level1[key1] = { label: label1, items: [] };
        level1[key1].items.push(inv);
    });
    const level1Keys = Object.keys(level1).sort((a, b) => b.localeCompare(a, 'fa'));
    return level1Keys.map(k1 => {
        const g1 = level1[k1];
        const open1 = invoiceOpenGroups.has('L1:' + k1);
        const g1Total = g1.items.reduce((s, i) => s + num(i.total), 0);
        let bodyHtml;
        if (mode === 'year_customer' || mode === 'customer_year') {
            const level2 = {};
            g1.items.forEach(inv => {
                const parts = invoiceGroupLabelParts(inv);
                const key2 = mode === 'year_customer' ? parts.customer : parts.year;
                const label2 = mode === 'year_customer' ? parts.customer : ('سال ' + parts.year);
                if (!level2[key2]) level2[key2] = { label: label2, items: [] };
                level2[key2].items.push(inv);
            });
            const level2Keys = Object.keys(level2).sort((a, b) => a.localeCompare(b, 'fa'));
            bodyHtml = level2Keys.map(k2 => {
                const g2 = level2[k2];
                const open2 = invoiceOpenGroups.has('L2:' + k1 + ':' + k2);
                const g2Total = g2.items.reduce((s, i) => s + num(i.total), 0);
                return `<div class="accordion-item" style="margin-inline-start:14px;">
                    <div class="list-item" style="cursor:pointer;" onclick="toggleInvoiceGroup('L2:${esc(k1).replace(/'/g, "\\'")}:${esc(k2).replace(/'/g, "\\'")}')">
                        <div class="list-item-row"><div class="list-item-title">${esc(g2.label)}</div>
                        <div style="display:flex; align-items:center; gap:8px;"><div class="badge badge-cyan">${g2.items.length.toLocaleString(localeForDigits())}</div><span style="transform:rotate(${open2 ? '180deg' : '0deg'}); display:inline-block;">▾</span></div></div>
                    </div>
                    ${open2 ? `<div class="accordion-body">${g2.items.map(invoiceItemHtml).join('')}</div>` : ''}
                </div>`;
            }).join('');
        } else {
            bodyHtml = g1.items.map(invoiceItemHtml).join('');
        }
        return `<div class="accordion-item">
            <div class="list-item" style="cursor:pointer;" onclick="toggleInvoiceGroup('L1:${esc(k1).replace(/'/g, "\\'")}')">
                <div class="list-item-row"><div class="list-item-title">📅 ${esc(g1.label)}</div>
                <div style="display:flex; align-items:center; gap:8px;"><span class="txt-caption">${moneyPlain(g1Total)}</span><div class="badge badge-cyan">${g1.items.length.toLocaleString(localeForDigits())}</div><span style="transform:rotate(${open1 ? '180deg' : '0deg'}); display:inline-block;">▾</span></div></div>
            </div>
            ${open1 ? `<div class="accordion-body">${bodyHtml}</div>` : ''}
        </div>`;
    }).join('');
}

function renderInvoiceFlatList() {
    const wrap = document.getElementById('invoiceListWrap');
    const dataEl = document.getElementById('invoiceFlatData');
    if (!wrap || !dataEl) return;
    const ids = JSON.parse(dataEl.textContent);
    const all = dbRead(K.invoices);
    const list = ids.map(id => all.find(i => i.id === id)).filter(Boolean);
    attachInfiniteRenderWindow(wrap, list, 40, invoiceItemHtml);
}
window.renderInvoiceFlatList = renderInvoiceFlatList;
window.invoiceFilter = 'all';

function nextInvoiceNumber() {
    const all = dbRead(K.invoices);
    const max = all.reduce((m, i) => Math.max(m, num(i.number)), 1000);
    return max + 1;
}

function openInvoiceEditor(id, presetCustomerId) {
    const existing = id ? dbRead(K.invoices).find(x => x.id === id) : null;
    draftInvoice = existing ? JSON.parse(JSON.stringify(existing)) : {
        id: null, number: nextInvoiceNumber(), date: todayISO(), customerId: presetCustomerId || null,
        customerNameSnapshot: '', items: [], discountTotal: 0, taxAmount: 0, total: 0, paidAmount: 0,
        status: 'unpaid', note: '', invoiceType: 'invoice', paymentMethod: 'cash'
    };
    if (!draftInvoice.items.length) draftInvoice.items.push({ productId: '', name: '', qty: 1, price: 0, discount: 0 });
    switchView('invoiceNew');
}
window.openInvoiceEditor = openInvoiceEditor;

const PAYMENT_METHODS = [['cash', 'نقدی'], ['card', 'کارت‌خوان / کارت به کارت'], ['check', 'چک'], ['credit', 'نسیه / اعتباری'], ['openaccount', 'حساب باز']];

function renderInvoiceEditorPage() {
    if (!draftInvoice) { switchView('invoices'); return ''; }
    const customers = dbRead(K.customers);
    const d = draftInvoice;

    const hasPartners = dbRead(K.partners).length > 0;
    const itemRows = d.items.map((it, idx) => `
        <div class="item-row ${it.isConsignment ? 'consignment-row' : ''}">
            <button class="item-pick-btn" onclick="openItemPicker('sale', ${idx})" type="button">
                ${it.isConsignment ? '<span class="badge badge-amber" style="margin-inline-end:4px;">★ امانی</span>' : ''}${esc(it.name) || '— انتخاب کالا —'}
            </button>
            <input type="text" inputmode="numeric" value="${num(it.qty)}" title="تعداد" oninput="diUpdate(${idx},'qty',this.value)">
            <input type="text" inputmode="numeric" value="${num(it.price)}" title="قیمت واحد" oninput="diUpdate(${idx},'price',this.value)">
            <input type="text" value="${moneyPlain(num(it.qty) * num(it.price))}" title="جمع" disabled>
            ${hasPartners ? `<button class="item-partner-toggle ${it.excludeFromPartnership ? 'excluded' : ''}" onclick="diToggleItemPartner(${idx})" type="button" title="${it.excludeFromPartnership ? 'این قلم به‌طور کامل مستثناست (دستی) — برای بازگشت به حالت خودکار کلیک کنید' : 'خودکار: بر اساس تاریخ ورود کالا به انبار نسبت به تاریخ عضویت هر شریک تقسیم می‌شود — برای مستثنا کردن کامل و دستی کلیک کنید'}">${it.excludeFromPartnership ? '🚫' : '🤖'}</button>` : ''}
            <button class="item-remove" onclick="diRemoveRow(${idx})" title="حذف ردیف" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        ${it.isConsignment ? `<div class="txt-caption" style="margin:-4px 0 8px;">از همکار: ${esc(it.colleagueName || '')}</div>` : ''}
    `).join('');

    const subtotal = d.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const afterDiscount = Math.max(0, subtotal - num(d.discountTotal));
    const settings = getSettings();
    const taxAmount = settings.taxEnabled ? Math.round(afterDiscount * (num(settings.taxPercent) || 0) / 100) : num(d.taxAmount) || 0;
    const interestAmount = d.paymentMethod === 'credit' || (d && d.paymentMethod === 'check') ? creditInterestAmount(afterDiscount + taxAmount, d.paymentDetails) : 0;
    const total = afterDiscount + (settings.taxEnabled ? taxAmount : 0) + interestAmount;

    return `
    ${viewHeader('فروش', d.id ? `ویرایش فاکتور #${d.number}` : 'فاکتور فروش جدید', 'اطلاعات را کامل کرده و در پایین ثبت کنید', `<button class="nav-btn" onclick="switchView('invoices')" title="بازگشت به لیست"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>`)}

    <div class="chip-row">
        <span class="chip ${d.invoiceType !== 'proforma' ? 'active' : ''}" onclick="diSetType('invoice')">فاکتور رسمی فروش</span>
        <span class="chip ${d.invoiceType === 'proforma' ? 'active' : ''}" onclick="diSetType('proforma')">پیش‌فاکتور</span>
    </div>

    <div class="section-box">
        <div class="mini-form-grid">
            <div class="input-group">
                <label>مشتری</label>
                <select id="if_customer">
                    <option value="">مشتری نقدی (بدون ثبت نام)</option>
                    ${customers.map(c => `<option value="${c.id}" ${d.customerId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                </select>
            </div>
            ${jalaliDateField('if_date', d.date || todayISO(), 'تاریخ فاکتور')}
        </div>
        <div class="input-group">
            <label>روش پرداخت</label>
            <select id="if_paymethod" onchange="diOnPaymentMethodChange()">
                ${PAYMENT_METHODS.map(([v, l]) => `<option value="${v}" ${(d.paymentMethod || 'cash') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
        </div>
        <div id="if_paymentDetailsBox">${paymentDetailsHtml('if', d.paymentMethod || 'cash', d.paymentDetails, false)}</div>
    </div>

    <div class="section-box">
        <div class="item-row-head"><span>کالا</span><span>تعداد</span><span>قیمت واحد</span><span>جمع</span></div>
        <div id="itemRowsWrap">${itemRows}</div>
        <button class="btn-action" style="width:100%; margin-bottom:6px;" onclick="diAddRow()" type="button">+ افزودن ردیف کالا</button>
        <div class="txt-caption">ردیف‌های علامت‌دار با ★ کالای امانی از همکار هستند و روی موجودی انبار شما اثر نمی‌گذارند.</div>
    </div>

    <div class="section-box">
        <div class="mini-form-grid">
            <div class="input-group"><label>تخفیف کل (${esc(currencyLabel())})</label><input type="text" inputmode="numeric" id="if_discount" value="${num(d.discountTotal)}" oninput="diRecalc()"></div>
            <div class="input-group"><label>مبلغ پرداخت‌شده</label><input type="text" inputmode="numeric" id="if_paid" value="${num(d.paidAmount)}" oninput="diRecalc()"></div>
        </div>
        <div class="input-group"><label>یادداشت فاکتور</label><textarea id="if_note" placeholder="اختیاری">${esc(d.note || '')}</textarea></div>
        ${hasPartners ? `<p class="txt-caption">🤖 سیستم خودش تشخیص می‌دهد هر کالا قبل یا بعد از عضویت هر شریک به انبار اضافه شده و بر همان اساس سود را تقسیم می‌کند — نیازی به کار دستی نیست. فقط اگر مورد خاصی هست که می‌خواهید کاملاً از شراکت خارج بماند، روی 🤖 کنار همان ردیف بزنید تا 🚫 شود.
            <a href="#" onclick="diMarkAllPartner(true); return false;" style="margin-inline-start:6px;">بازگرداندن همه به حالت خودکار</a> ·
            <a href="#" onclick="diMarkAllPartner(false); return false;">مستثنا کردن کامل همه اقلام</a>
        </p>` : ''}
        <div class="totals-box" id="invoiceTotalsBox">${invoiceTotalsHtml(subtotal, num(d.discountTotal), taxAmount, total, num(d.paidAmount), interestAmount)}</div>
    </div>

    <button class="calc-btn" onclick="saveInvoice()" type="button">${d.id ? 'ذخیره تغییرات فاکتور' : 'ثبت فاکتور'}</button>
    ${d.id ? `<div class="action-grid" style="margin-top:8px;">
        <button class="btn-action" onclick="printInvoice('${d.id}')" type="button">🖨 چاپ فاکتور</button>
        <button class="btn-action" style="color:var(--accent-rose);" onclick="deleteInvoice('${d.id}')" type="button">حذف فاکتور</button>
    </div>` : ''}
    `;
}
VIEW_RENDERERS.invoiceNew = renderInvoiceEditorPage;

function syncInvoiceDraftFromDom() {
    const custEl = document.getElementById('if_customer');
    if (custEl) draftInvoice.customerId = custEl.value || null;
    const dateIso = getJalaliInputISO('if_date');
    if (dateIso) draftInvoice.date = dateIso;
    const pmEl = document.getElementById('if_paymethod');
    if (pmEl) { draftInvoice.paymentMethod = pmEl.value; draftInvoice.paymentDetails = paymentDetailsCollect('if', pmEl.value); }
    const discEl = document.getElementById('if_discount');
    if (discEl) draftInvoice.discountTotal = num(discEl.value);
    const paidEl = document.getElementById('if_paid');
    if (paidEl) draftInvoice.paidAmount = num(paidEl.value);
    const noteEl = document.getElementById('if_note');
    if (noteEl) draftInvoice.note = noteEl.value;
}
function rerenderInvoiceNew() { syncInvoiceDraftFromDom(); rerenderIfActive('invoiceNew'); }
window.rerenderInvoiceNew = rerenderInvoiceNew;

function syncPurchaseDraftFromDom() {
    const supEl = document.getElementById('pf_supplier');
    if (supEl) draftPurchase.supplier = supEl.value;
    const dateIso = getJalaliInputISO('pf_date');
    if (dateIso) draftPurchase.date = dateIso;
    const pmEl = document.getElementById('pf_paymethod');
    if (pmEl) { draftPurchase.paymentMethod = pmEl.value; draftPurchase.paymentDetails = paymentDetailsCollect('pf', pmEl.value); }
    const paidEl = document.getElementById('pf_paid');
    if (paidEl) draftPurchase.paidAmount = num(paidEl.value);
    const exclEl = document.getElementById('pf_excludePartner');
    if (exclEl) draftPurchase.excludeFromPartnership = exclEl.checked;
}
function rerenderPurchaseNew() { syncPurchaseDraftFromDom(); rerenderIfActive('purchaseNew'); }
window.rerenderPurchaseNew = rerenderPurchaseNew;

function diSetType(t) { syncInvoiceDraftFromDom(); draftInvoice.invoiceType = t; rerenderIfActive('invoiceNew'); }
window.diSetType = diSetType;

function invoiceTotalsHtml(subtotal, discount, tax, total, paid, interest) {
    interest = num(interest) || 0;
    const remain = Math.max(0, total - paid);
    return `
        <div class="totals-row"><span>جمع کل کالاها</span><span>${moneyPlain(subtotal)}</span></div>
        <div class="totals-row"><span>تخفیف</span><span>${discount ? '−' + moneyPlain(discount) : '۰'}</span></div>
        ${getSettings().taxEnabled ? `<div class="totals-row"><span>مالیات (${esc(num(getSettings().taxPercent))}٪)</span><span>${moneyPlain(tax)}</span></div>` : ''}
        ${interest ? `<div class="totals-row"><span>سود نسیه</span><span>${moneyPlain(interest)}</span></div>` : ''}
        <div class="totals-row grand"><span>مبلغ قابل پرداخت</span><span>${moneyPlain(total)} ${esc(currencyLabel())}</span></div>
        <div class="totals-row"><span>پرداخت‌شده</span><span>${moneyPlain(paid)}</span></div>
        <div class="totals-row" style="color:${remain > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)'}"><span>مانده</span><span>${moneyPlain(remain)}</span></div>
    `;
}

/* -------- Payment-method detail sub-forms (shared by sale invoice & purchase forms) -------- */
function paymentDetailsHtml(prefix, method, pd, allowExisting, direction) {
    pd = pd || {};
    allowExisting = allowExisting !== false;
    direction = direction || 'in'; // 'in' = we are receiving (sale/settleCustomer), 'out' = we are paying (purchase/payroll/settleSupplier)
    const banks = dbRead(K.bankAccounts);
    if (method === 'cash') {
        return `<div class="pm-detail-box"><span class="badge badge-emerald">💵 از صندوق نقدی مغازه پرداخت/دریافت می‌شود</span></div>`;
    }
    if (method === 'card') {
        return `<div class="pm-detail-box">
            ${direction === 'out' ? '' : `<div class="input-group"><label>نوع</label>
                <select id="${prefix}_cardType">
                    <option value="pos" ${pd.cardType !== 'transfer' ? 'selected' : ''}>دستگاه کارت‌خوان</option>
                    <option value="transfer" ${pd.cardType === 'transfer' ? 'selected' : ''}>کارت به کارت</option>
                </select>
            </div>`}
            <div class="input-group"><label>${direction === 'out' ? 'پرداخت از حساب' : 'واریز به حساب'}</label>
                <select id="${prefix}_bankId">
                    <option value="">— انتخاب نشده —</option>
                    ${banks.map(b => `<option value="${b.id}" ${pd.bankAccountId === b.id ? 'selected' : ''}>${esc(b.bankName)} — ${esc(b.title)}</option>`).join('')}
                </select>
            </div>
            ${!banks.length ? `<p class="txt-caption">هنوز حسابی ثبت نشده؛ از «صندوق و بانک ← افزودن حساب بانکی» اضافه کنید.</p>` : ''}
        </div>`;
    }
    if (method === 'check') {
        const availableChecks = dbRead(K.checks).filter(c => c.direction === 'receive' && c.status === 'pending' && !c.endorsedTo);
        const ledger = treasuryLedger();
        const cashBalance = ledger.reduce((sum, t) => sum + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
        const upcomingPayChecks = dbRead(K.checks).filter(c => c.status === 'pending' && c.direction === 'pay').sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        return `<div class="pm-detail-box">
            <div class="bank-account-card" style="margin-bottom:10px;">
                <div><div class="bac-name">موجودی فعلی صندوق نقدی</div><div class="bac-sub">${upcomingPayChecks.length.toLocaleString(localeForDigits())} چک پرداختی در انتظار پاس شدن</div></div>
                <div class="list-item-title" style="color:${cashBalance >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${moneyPlain(cashBalance)}</div>
            </div>
            ${upcomingPayChecks.length ? `<div style="max-height:140px; overflow-y:auto; margin-bottom:10px;">
                ${upcomingPayChecks.map(c => {
                    const days = Math.round((new Date(c.dueDate) - new Date()) / 86400000);
                    return `<div class="list-item" style="padding:8px 10px;"><div class="list-item-row">
                        <div><div class="list-item-title" style="font-size:0.8rem;">${esc(c.who)}</div><div class="txt-caption">سررسید: ${fmtDate(c.dueDate)} · ${days >= 0 ? days.toLocaleString(localeForDigits()) + ' روز مانده' : 'سررسید گذشته'}</div></div>
                        <div class="txt-caption" style="font-weight:700;">${moneyPlain(c.amount)}</div>
                    </div></div>`;
                }).join('')}
            </div>` : ''}
            ${allowExisting ? `<div class="input-group"><label>منبع چک</label>
                <select id="${prefix}_ckSource" onchange="ckSourceChange('${prefix}')">
                    <option value="new" ${pd.source !== 'existing' ? 'selected' : ''}>ثبت چک جدید</option>
                    <option value="existing" ${pd.source === 'existing' ? 'selected' : ''}>استفاده از چک دریافتی موجود (واگذاری/خرج کردن چک)</option>
                </select>
            </div>` : ''}
            <div id="${prefix}_ckNewBox" style="display:${(allowExisting && pd.source === 'existing') ? 'none' : 'block'};">
                <div class="mini-form-grid">
                    <div class="input-group"><label>شماره چک</label><input type="text" id="${prefix}_ckNumber" value="${esc(pd.checkNumber || '')}"></div>
                    <div class="input-group"><label>بانک</label><input type="text" id="${prefix}_ckBank" value="${esc(pd.bank || '')}"></div>
                </div>
                <div class="mini-form-grid">
                    <div class="input-group"><label>شماره حساب</label><input type="text" id="${prefix}_ckAccNo" value="${esc(pd.accountNo || '')}"></div>
                    <div class="input-group"><label>شماره صیادی</label><input type="text" inputmode="numeric" id="${prefix}_ckSayad" value="${esc(pd.sayadNo || '')}"></div>
                </div>
                ${jalaliDateField(prefix + '_ckDue', pd.dueDate || '', 'تاریخ سررسید چک')}
            </div>
            <div id="${prefix}_ckExistingBox" style="display:${pd.source === 'existing' ? 'block' : 'none'};">
                <div class="input-group"><label>انتخاب چک</label>
                    <select id="${prefix}_ckExistingId" onchange="if('${prefix}'==='pf') dpApplyAutoPaid();">
                        <option value="">— انتخاب کنید —</option>
                        ${availableChecks.map(c => `<option value="${c.id}" ${pd.existingCheckId === c.id ? 'selected' : ''}>${esc(c.who)} — ${moneyPlain(c.amount)} — سررسید ${fmtDate(c.dueDate)}${c.number ? ' — #' + esc(c.number) : ''}</option>`).join('')}
                    </select>
                    ${!availableChecks.length ? `<p class="txt-caption">چک دریافتیِ در دسترسی برای واگذاری موجود نیست.</p>` : ''}
                </div>
            </div>
            <div class="settings-row" style="padding-inline:0; margin-top:8px;">
                <div class="settings-row-label">این چک بابت نسیه است و سود ماهانه دارد</div>
                <label class="switch"><input type="checkbox" id="${prefix}_ckHasInterest" ${num(pd.monthlyPercent) ? 'checked' : ''} onchange="document.getElementById('${prefix}_ckInterestBox').style.display=this.checked?'block':'none'; ${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}"><span class="switch-slider"></span></label>
            </div>
            <div class="pm-detail-box" id="${prefix}_ckInterestBox" style="display:${num(pd.monthlyPercent) ? 'block' : 'none'};">
                <div class="input-group"><label>سود نسیه (٪ در ماه)</label><input type="text" inputmode="numeric" id="${prefix}_ckPercent" value="${esc(num(pd.monthlyPercent) || 0)}" oninput="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}"></div>
                <div class="input-group"><label>گرد کردن مدت</label>
                    <select id="${prefix}_ckRound" onchange="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}">
                        <option value="none" ${(!pd.roundMode || pd.roundMode === 'none') ? 'selected' : ''}>بدون گرد کردن (دقیق به روز)</option>
                        <option value="up" ${pd.roundMode === 'up' ? 'selected' : ''}>گرد به بالا</option>
                        <option value="down" ${pd.roundMode === 'down' ? 'selected' : ''}>گرد به پایین</option>
                    </select>
                </div>
                <div class="settings-row" style="padding-inline:0;">
                    <div class="settings-row-label">سود مرکب</div>
                    <label class="switch"><input type="checkbox" id="${prefix}_ckCompound" ${pd.compound ? 'checked' : ''} onchange="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}"><span class="switch-slider"></span></label>
                </div>
            </div>
        </div>`;
    }
    if (method === 'credit') {
        return `<div class="pm-detail-box">
            ${jalaliDateField(prefix + '_crDue', pd.dueDate || '', 'موعد تسویه نسیه')}
            <div class="input-group"><label>سود نسیه (٪ در ماه)</label><input type="text" inputmode="numeric" id="${prefix}_crPercent" value="${esc(num(pd.monthlyPercent) || 0)}" oninput="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}" placeholder="مثلاً 4"></div>
            <div class="input-group"><label>گرد کردن مدت</label>
                <select id="${prefix}_crRound" onchange="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}">
                    <option value="none" ${(!pd.roundMode || pd.roundMode === 'none') ? 'selected' : ''}>بدون گرد کردن (دقیق به روز)</option>
                    <option value="up" ${pd.roundMode === 'up' ? 'selected' : ''}>گرد به بالا (به ماه بعد)</option>
                    <option value="down" ${pd.roundMode === 'down' ? 'selected' : ''}>گرد به پایین (به ماه قبل)</option>
                </select>
            </div>
            <div class="settings-row" style="padding-inline:0;">
                <div class="settings-row-label">سود مرکب</div>
                <label class="switch"><input type="checkbox" id="${prefix}_crCompound" ${pd.compound ? 'checked' : ''} onchange="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}"><span class="switch-slider"></span></label>
            </div>
            <p class="txt-caption" id="${prefix}_crInfo">${esc(creditInterestBreakdownText(pd))}</p>
        </div>`;
    }
    if (method === 'openaccount') {
        return `<div class="pm-detail-box">
            <div class="input-group"><label>توضیحات حساب باز</label><textarea id="${prefix}_oaNote" placeholder="توضیحات دلخواه">${esc(pd.note || '')}</textarea></div>
        </div>`;
    }
    return '';
}
function ckSourceChange(prefix) {
    const source = document.getElementById(prefix + '_ckSource').value;
    document.getElementById(prefix + '_ckNewBox').style.display = source === 'existing' ? 'none' : 'block';
    document.getElementById(prefix + '_ckExistingBox').style.display = source === 'existing' ? 'block' : 'none';
    if (prefix === 'pf') dpApplyAutoPaid();
}
window.ckSourceChange = ckSourceChange;
function paymentDetailsCollect(prefix, method) {
    if (method === 'card') {
        return { cardType: (document.getElementById(prefix + '_cardType') || {}).value || 'pos', bankAccountId: (document.getElementById(prefix + '_bankId') || {}).value || '' };
    }
    if (method === 'check') {
        const sourceEl = document.getElementById(prefix + '_ckSource');
        const source = sourceEl ? sourceEl.value : 'new';
        const hasInterest = !!(document.getElementById(prefix + '_ckHasInterest') || {}).checked;
        const interestFields = hasInterest ? {
            monthlyPercent: num((document.getElementById(prefix + '_ckPercent') || {}).value),
            roundMode: ((document.getElementById(prefix + '_ckRound') || {}).value) || 'none',
            compound: !!(document.getElementById(prefix + '_ckCompound') || {}).checked
        } : { monthlyPercent: 0, roundMode: 'none', compound: false };
        if (source === 'existing') {
            const existingId = (document.getElementById(prefix + '_ckExistingId') || {}).value || '';
            const existing = existingId ? dbRead(K.checks).find(c => c.id === existingId) : null;
            return Object.assign({
                source: 'existing', existingCheckId: existingId,
                checkNumber: existing ? existing.number : '', bank: existing ? existing.bank : '',
                accountNo: existing ? existing.accountNo : '', sayadNo: existing ? existing.sayadNo : '',
                dueDate: existing ? existing.dueDate : ''
            }, interestFields);
        }
        return Object.assign({
            source: 'new',
            checkNumber: ((document.getElementById(prefix + '_ckNumber') || {}).value || '').trim(),
            bank: ((document.getElementById(prefix + '_ckBank') || {}).value || '').trim(),
            accountNo: ((document.getElementById(prefix + '_ckAccNo') || {}).value || '').trim(),
            sayadNo: ((document.getElementById(prefix + '_ckSayad') || {}).value || '').trim(),
            dueDate: getJalaliInputISO(prefix + '_ckDue')
        }, interestFields);
    }
    if (method === 'credit') {
        return { dueDate: getJalaliInputISO(prefix + '_crDue'), monthlyPercent: num((document.getElementById(prefix + '_crPercent') || {}).value), roundMode: ((document.getElementById(prefix + '_crRound') || {}).value) || 'none', compound: !!(document.getElementById(prefix + '_crCompound') || {}).checked };
    }
    if (method === 'openaccount') {
        return { note: ((document.getElementById(prefix + '_oaNote') || {}).value || '').trim() };
    }
    return {};
}
function creditInterestAmount(baseAmount, pd) {
    if (!pd || !pd.dueDate || !num(pd.monthlyPercent)) return 0;
    const days = Math.max(0, Math.round((new Date(pd.dueDate) - new Date()) / 86400000));
    if (days <= 0) return 0;
    let months = days / 30; // exact, fractional — e.g. 40 days = 1.333 months
    if (pd.roundMode === 'up') months = Math.ceil(months);
    else if (pd.roundMode === 'down') months = Math.floor(months);
    const rate = num(pd.monthlyPercent) / 100;
    let interest;
    if (pd.compound) {
        interest = baseAmount * (Math.pow(1 + rate, months) - 1);
    } else {
        interest = baseAmount * rate * months;
    }
    return Math.round(interest);
}
function creditInterestBreakdownText(pd) {
    if (!pd || !pd.dueDate || !num(pd.monthlyPercent)) return '';
    const days = Math.max(0, Math.round((new Date(pd.dueDate) - new Date()) / 86400000));
    if (days <= 0) return 'تاریخ سررسید گذشته یا امروز است — سودی محاسبه نمی‌شود.';
    const months = days / 30;
    return `${days.toLocaleString(localeForDigits())} روز (معادل ${months.toFixed(2).replace(/[0-9.]/g, (c) => c === '.' ? '.' : '۰۱۲۳۴۵۶۷۸۹'[c])} ماه) تا سررسید — سود ${pd.compound ? 'به‌صورت مرکب' : 'به‌صورت ساده'} محاسبه می‌شود${pd.roundMode === 'up' ? ' (گرد شده به بالا)' : pd.roundMode === 'down' ? ' (گرد شده به پایین)' : ''}.`;
}

/* -------- Category-folder + colleague-consignment item picker (shared by sale & purchase) -------- */
let pickerState = { kind: 'sale', idx: 0, category: null, term: '' };

function allCategories() {
    const stored = dbRead(K.categories);
    const fromProducts = dbRead(K.products).map(p => p.category).filter(Boolean);
    return Array.from(new Set([...stored, ...fromProducts])).sort();
}
function ensureCategory(name) {
    if (!name) return;
    const cats = dbRead(K.categories);
    if (!cats.includes(name)) { cats.push(name); dbWrite(K.categories, cats); }
}

function openItemPicker(kind, idx) {
    pickerState = { kind, idx, category: null, term: '' };
    renderItemPicker();
}
window.openItemPicker = openItemPicker;

function renderItemPicker() {
    const cats = allCategories();
    const html = `
        <input type="text" placeholder="جستجوی نام کالا..." id="pickerSearch" value="${esc(pickerState.term)}" oninput="pickerState.term=this.value; renderPickerList();" style="margin-bottom:10px;">
        <div class="chip-row" id="pickerCatRow">
            <span class="chip ${!pickerState.category ? 'active' : ''}" onclick="pickerSetCat(null)">همه دسته‌ها</span>
            ${cats.map(c => `<span class="chip ${pickerState.category === c ? 'active' : ''}" onclick="pickerSetCat('${esc(c).replace(/'/g, "\\'")}')">📁 ${esc(c)}</span>`).join('')}
        </div>
        <div id="pickerList" style="max-height:38vh; overflow-y:auto;"></div>
        <div class="action-grid" style="margin-top:12px;">
            ${pickerState.kind === 'purchase' ? `<button class="btn-action" onclick="openNewProductForPurchase(pickerState.idx)" type="button">🆕 کالای جدید (ثبت در انبار)</button>` : `<button class="btn-action" onclick="openConsignmentForm()" type="button">★ کالای امانی از همکار</button>`}
            <button class="btn-action" onclick="pickerFreeText()" type="button">✎ کالای متفرقه (تایپ آزاد)</button>
        </div>
    `;
    openModal('انتخاب کالا', html);
    renderPickerList();
}

function pickerSetCat(c) { pickerState.category = c; renderItemPicker(); }
window.pickerSetCat = pickerSetCat;

function renderPickerList() {
    const wrap = document.getElementById('pickerList');
    if (!wrap) return;
    let list = dbRead(K.products);
    if (pickerState.category) list = list.filter(p => p.category === pickerState.category);
    const term = pickerState.term.trim();
    if (term) list = list.filter(p => p.name.includes(term));
    if (!list.length) { wrap.innerHTML = `<div class="empty-state">کالایی یافت نشد.</div>`; return; }
    attachInfiniteRender(wrap, list, 40, (p) => `
        <div class="list-item" style="cursor:pointer; margin-bottom:6px;" onclick="pickerChoose('${p.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(p.name)}</div><div class="list-item-sub">${esc(p.category || 'بدون دسته')} · موجودی: ${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit)}</div></div>
                <div class="list-item-title">${moneyPlain(pickerState.kind === 'sale' ? p.sellPrice : p.buyPrice)}</div>
            </div>
        </div>`);
}
window.renderPickerList = renderPickerList;

function pickerChoose(productId) {
    const prod = dbRead(K.products).find(p => p.id === productId);
    if (!prod) return;
    if (pickerState.kind === 'sale') {
        draftInvoice.items[pickerState.idx] = { productId: prod.id, name: prod.name, qty: draftInvoice.items[pickerState.idx].qty || 1, price: prod.sellPrice, discount: 0 };
        closeModal(); rerenderInvoiceNew();
    } else {
        draftPurchase.items[pickerState.idx] = { productId: prod.id, name: prod.name, qty: draftPurchase.items[pickerState.idx].qty || 1, price: prod.buyPrice };
        closeModal(); rerenderPurchaseNew();
    }
}
window.pickerChoose = pickerChoose;

function pickerFreeText() {
    const name = prompt('نام کالا را وارد کنید:');
    if (!name) return;
    if (pickerState.kind === 'sale') {
        draftInvoice.items[pickerState.idx] = Object.assign(draftInvoice.items[pickerState.idx] || {}, { productId: '', name, isConsignment: false });
        closeModal(); rerenderInvoiceNew();
    } else {
        draftPurchase.items[pickerState.idx] = Object.assign(draftPurchase.items[pickerState.idx] || {}, { productId: '', name, isConsignment: false });
        closeModal(); rerenderPurchaseNew();
    }
}
window.pickerFreeText = pickerFreeText;

function openConsignmentForm() {
    const html = `
        <div class="input-group"><label>نام همکار / تأمین‌کننده *</label><input type="text" id="cg_colleague" placeholder="مثلاً: فروشگاه رضایی"></div>
        <div class="input-group"><label>نام کالا *</label><input type="text" id="cg_name" placeholder="نام کالای امانی"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>تعداد</label><input type="text" inputmode="numeric" id="cg_qty" value="1"></div>
            <div class="input-group"><label>قیمت واحد فروش</label><input type="text" inputmode="numeric" id="cg_price" value="0"></div>
        </div>
        <p class="txt-caption" style="margin-bottom:12px;">این کالا در انبار شما ثبت نمی‌شود و فقط در همین فاکتور با علامت ★ نمایش داده می‌شود (کالایی که از همکار امانت گرفته و مستقیم فروخته‌اید).</p>
        <button class="calc-btn" onclick="saveConsignmentItem()" type="button">افزودن به فاکتور</button>
    `;
    openModal('کالای امانی از همکار', html);
}
window.openConsignmentForm = openConsignmentForm;

function saveConsignmentItem() {
    const colleagueName = document.getElementById('cg_colleague').value.trim();
    const name = document.getElementById('cg_name').value.trim();
    const qty = num(document.getElementById('cg_qty').value) || 1;
    const price = num(document.getElementById('cg_price').value);
    if (!colleagueName || !name) { showToast('نام همکار و نام کالا الزامی است', 'error'); return; }
    const item = { productId: '', name, qty, price, discount: 0, isConsignment: true, colleagueName, consignmentDate: todayISO() };
    if (pickerState.kind === 'sale') { draftInvoice.items[pickerState.idx] = item; closeModal(); rerenderInvoiceNew(); }
    else { draftPurchase.items[pickerState.idx] = item; closeModal(); rerenderPurchaseNew(); }
}
window.saveConsignmentItem = saveConsignmentItem;

/* -------- Generic infinite-scroll batch renderers --------
   attachInfiniteRender: for scrollable containers with their own overflow (e.g. modal-body pickers).
   attachInfiniteRenderWindow: for page-level lists that scroll with the whole window (no pause/lag,
   no "load more" button — just keep scrolling and more rows appear). */
function attachInfiniteRender(container, items, pageSize, itemHtmlFn) {
    let shown = Math.min(pageSize, items.length);
    const paint = () => { container.innerHTML = items.slice(0, shown).map(itemHtmlFn).join(''); };
    paint();
    container.onscroll = () => {
        if (shown >= items.length) return;
        if (container.scrollTop + container.clientHeight > container.scrollHeight - 200) {
            shown = Math.min(shown + pageSize, items.length);
            paint();
        }
    };
}
function attachInfiniteRenderWindow(container, items, pageSize, itemHtmlFn) {
    let shown = Math.min(pageSize, items.length);
    const paint = () => { container.innerHTML = items.slice(0, shown).map(itemHtmlFn).join(''); };
    paint();
    window.onscroll = () => {
        if (shown >= items.length) return;
        if (window.innerHeight + window.scrollY > document.body.offsetHeight - 400) {
            shown = Math.min(shown + pageSize, items.length);
            paint();
        }
    };
}

function diUpdate(idx, field, value) {
    if (field === 'qty' || field === 'price') draftInvoice.items[idx][field] = num(value);
    else draftInvoice.items[idx][field] = value;
    diRecalc(true);
    diApplyAutoPaid();
}
window.diUpdate = diUpdate;

function diToggleItemPartner(idx) {
    syncInvoiceDraftFromDom();
    draftInvoice.items[idx].excludeFromPartnership = !draftInvoice.items[idx].excludeFromPartnership;
    rerenderInvoiceNew();
}
window.diToggleItemPartner = diToggleItemPartner;
function diMarkAllPartner(shared) {
    syncInvoiceDraftFromDom();
    draftInvoice.items.forEach(it => { it.excludeFromPartnership = !shared; });
    rerenderInvoiceNew();
}
window.diMarkAllPartner = diMarkAllPartner;
function diAddRow() { syncInvoiceDraftFromDom(); draftInvoice.items.push({ productId: '', name: '', qty: 1, price: 0, discount: 0 }); rerenderIfActive('invoiceNew'); }
window.diAddRow = diAddRow;
function diRemoveRow(idx) {
    syncInvoiceDraftFromDom();
    draftInvoice.items.splice(idx, 1);
    if (!draftInvoice.items.length) draftInvoice.items.push({ productId: '', name: '', qty: 1, price: 0, discount: 0 });
    rerenderIfActive('invoiceNew');
}
window.diRemoveRow = diRemoveRow;

function diRecalc(skipFullRender) {
    const subtotal = draftInvoice.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const discEl = document.getElementById('if_discount'), paidEl = document.getElementById('if_paid');
    const discount = num(discEl ? discEl.value : draftInvoice.discountTotal);
    const paid = num(paidEl ? paidEl.value : draftInvoice.paidAmount);
    const afterDiscount = Math.max(0, subtotal - discount);
    const settings = getSettings();
    const tax = settings.taxEnabled ? Math.round(afterDiscount * (num(settings.taxPercent) || 0) / 100) : 0;
    const methodEl = document.getElementById('if_paymethod');
    const method = methodEl ? methodEl.value : (draftInvoice.paymentMethod || 'cash');
    const pd = (method === 'credit' || method === 'check') ? paymentDetailsCollect('if', method) : null;
    const interest = (method === 'credit' || method === 'check') ? creditInterestAmount(afterDiscount + tax, pd) : 0;
    const total = afterDiscount + tax + interest;
    const box = document.getElementById('invoiceTotalsBox');
    if (box) box.innerHTML = invoiceTotalsHtml(subtotal, discount, tax, total, paid, interest);
    const infoEl = document.getElementById('if_crInfo');
    if (infoEl && method === 'credit') infoEl.textContent = creditInterestBreakdownText(pd);
    if (!skipFullRender) return;
    document.querySelectorAll('#itemRowsWrap .item-row').forEach((row, i) => {
        const it = draftInvoice.items[i]; if (!it) return;
        const totalCell = row.querySelectorAll('input')[2];
        if (totalCell) totalCell.value = moneyPlain(num(it.qty) * num(it.price));
    });
}
window.diRecalc = diRecalc;
function diOnPaymentMethodChange() {
    const method = document.getElementById('if_paymethod').value;
    const box = document.getElementById('if_paymentDetailsBox');
    if (box) box.innerHTML = paymentDetailsHtml('if', method, method === draftInvoice.paymentMethod ? draftInvoice.paymentDetails : {}, false);
    diRecalc();
    diApplyAutoPaid();
}
window.diOnPaymentMethodChange = diOnPaymentMethodChange;
function diApplyAutoPaid() {
    const methodEl = document.getElementById('if_paymethod');
    const paidEl = document.getElementById('if_paid');
    if (!methodEl || !paidEl) return;
    const method = methodEl.value;
    if (method === 'cash' || method === 'card') {
        const subtotal = draftInvoice.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
        const discount = num((document.getElementById('if_discount') || {}).value);
        const afterDiscount = Math.max(0, subtotal - discount);
        const settings = getSettings();
        const tax = settings.taxEnabled ? Math.round(afterDiscount * (num(settings.taxPercent) || 0) / 100) : 0;
        paidEl.value = afterDiscount + tax;
        paidEl.readOnly = true;
        paidEl.title = 'در پرداخت نقدی/کارتی، مبلغ به‌طور کامل و همان لحظه دریافت می‌شود';
        diRecalc();
    } else {
        paidEl.readOnly = false;
        paidEl.title = '';
    }
}
window.diApplyAutoPaid = diApplyAutoPaid;

function adjustStock(items, sign) {
    const products = dbRead(K.products);
    let changed = false;
    items.forEach(it => {
        if (!it.productId || it.isConsignment) return;
        const p = products.find(x => x.id === it.productId);
        if (p) { p.qty = num(p.qty) + sign * num(it.qty); changed = true; }
    });
    if (changed) dbWrite(K.products, products);
}

function saveInvoice() {
    const customerId = document.getElementById('if_customer').value || null;
    const customer = customerId ? dbRead(K.customers).find(c => c.id === customerId) : null;
    const paymentMethod = document.getElementById('if_paymethod').value;
    const paymentDetails = paymentDetailsCollect('if', paymentMethod);
    const items = draftInvoice.items.filter(it => (it.name || it.productId) && num(it.qty) > 0 && num(it.price) >= 0);
    if (!items.length) { showToast('حداقل یک ردیف کالا وارد کنید', 'error'); return; }

    const subtotal = items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const discountTotal = num(document.getElementById('if_discount').value);
    const afterDiscount = Math.max(0, subtotal - discountTotal);
    const settings = getSettings();
    const taxAmount = settings.taxEnabled ? Math.round(afterDiscount * (num(settings.taxPercent) || 0) / 100) : 0;
    const interestAmount = paymentMethod === 'credit' || paymentMethod === 'check' ? creditInterestAmount(afterDiscount + taxAmount, paymentDetails) : 0;
    const total = afterDiscount + taxAmount + interestAmount;
    const paidAmount = Math.min(total, num(document.getElementById('if_paid').value));
    const status = paidAmount >= total && total > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');
    const note = document.getElementById('if_note').value.trim();
    const invoiceType = draftInvoice.invoiceType || 'invoice';
    const date = getJalaliInputISO('if_date') || draftInvoice.date || todayISO();
    // Roll-up flag purely for list badges/filters: true only when every line item is excluded
    const excludeFromPartnership = items.length > 0 && items.every(it => it.excludeFromPartnership);

    const list = dbRead(K.invoices);
    let savedId = draftInvoice.id;
    if (draftInvoice.id) {
        const old = list.find(i => i.id === draftInvoice.id);
        if (old) adjustStock(old.items, +1);
        const idx = list.findIndex(i => i.id === draftInvoice.id);
        list[idx] = Object.assign(list[idx], {
            customerId, customerNameSnapshot: customer ? customer.name : 'مشتری نقدی',
            items, discountTotal, taxAmount, interestAmount, total, paidAmount, status, note, invoiceType, paymentMethod, paymentDetails, date, excludeFromPartnership
        });
        if (invoiceType !== 'proforma') adjustStock(items, -1);
    } else {
        savedId = uid('inv');
        list.push({
            id: savedId, number: draftInvoice.number, date, customerId,
            customerNameSnapshot: customer ? customer.name : 'مشتری نقدی', items, discountTotal, taxAmount, interestAmount, total,
            paidAmount, status, note, invoiceType, paymentMethod, paymentDetails, excludeFromPartnership
        });
        if (invoiceType !== 'proforma') adjustStock(items, -1);
    }
    dbWrite(K.invoices, list);

    // Payment method "چک" on a sale invoice → automatically log the received check in چک‌ها
    if (paymentMethod === 'check' && paymentDetails.dueDate) {
        const checks = dbRead(K.checks);
        const already = checks.find(c => c.linkedInvoiceId === savedId);
        const chkData = {
            who: customer ? customer.name : 'مشتری نقدی', direction: 'receive', amount: total,
            number: paymentDetails.checkNumber, bank: paymentDetails.bank, accountNo: paymentDetails.accountNo,
            sayadNo: paymentDetails.sayadNo, dueDate: paymentDetails.dueDate, status: 'pending', linkedInvoiceId: savedId
        };
        if (already) Object.assign(already, chkData); else checks.push(Object.assign({ id: uid('chk') }, chkData));
        dbWrite(K.checks, checks);
    }

    autoBackupTick();
    showToast(invoiceType === 'proforma' ? 'پیش‌فاکتور ثبت شد' : 'فاکتور با موفقیت ثبت شد', 'success');
    switchView('invoices');
}
window.saveInvoice = saveInvoice;

function deleteInvoice(id) {
    if (!confirmAction('آیا از حذف این فاکتور مطمئن هستید؟ موجودی کالاها بازگردانده می‌شود.')) return;
    const list = dbRead(K.invoices);
    const inv = list.find(i => i.id === id);
    if (inv && inv.invoiceType !== 'proforma') adjustStock(inv.items, +1);
    dbWrite(K.invoices, list.filter(i => i.id !== id));
    autoBackupTick();
    closeModal();
    showToast('فاکتور حذف شد', 'success');
    switchView('invoices');
}
window.deleteInvoice = deleteInvoice;

function openInvoiceView(id) {
    const inv = dbRead(K.invoices).find(i => i.id === id);
    if (!inv) return;
    const statusBadge = inv.status === 'paid' ? '<span class="badge badge-emerald">پرداخت‌شده</span>' : inv.status === 'partial' ? '<span class="badge badge-amber">پرداخت جزئی</span>' : '<span class="badge badge-rose">پرداخت‌نشده</span>';
    const pmLabel = (PAYMENT_METHODS.find(p => p[0] === inv.paymentMethod) || [, 'نقدی'])[1];
    const html = `
        <div class="list-item-row" style="margin-bottom:14px;">
            <div><div class="txt-h2">${inv.invoiceType === 'proforma' ? 'پیش‌فاکتور' : 'فاکتور'} #${inv.number}</div><div class="txt-caption">${fmtDate(inv.date)} · ${esc(inv.customerNameSnapshot)} · ${esc(pmLabel)}</div></div>
            <div>${statusBadge}</div>
        </div>
        <table class="report-table" style="margin-bottom:10px;">
            <thead><tr><th>کالا</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th>${dbRead(K.partners).length ? '<th>شراکت</th>' : ''}</tr></thead>
            <tbody>${inv.items.map(it => `<tr><td>${it.isConsignment ? '★ ' : ''}${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(it.qty * it.price)}</td>${dbRead(K.partners).length ? `<td>${it.excludeFromPartnership ? '🚫 مستثنای دستی' : '🤖 خودکار (بر اساس تاریخ)'}</td>` : ''}</tr>`).join('')}</tbody>
            ${dbRead(K.partners).length ? `<caption class="txt-caption" style="text-align:right; caption-side:bottom; padding-top:6px;">حالت «خودکار» یعنی سود این قلم بر اساس تاریخ ورود کالا به انبار نسبت به تاریخ عضویت هر شریک تقسیم می‌شود.</caption>` : ''}
        </table>
        <div class="totals-box">${invoiceTotalsHtml(inv.items.reduce((s, it) => s + it.qty * it.price, 0), inv.discountTotal, inv.taxAmount, inv.total, inv.paidAmount)}</div>
        ${inv.note ? `<div class="input-group" style="margin-top:12px;"><label>یادداشت</label><div class="txt-body">${esc(inv.note)}</div></div>` : ''}
        <div class="action-grid" style="margin-top:16px;">
            <button class="btn-action" onclick="closeModal(); openInvoiceEditor('${inv.id}')">ویرایش</button>
            <button class="btn-action" onclick="printInvoice('${inv.id}')">🖨 چاپ فاکتور</button>
        </div>
        <button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteInvoice('${inv.id}')">حذف فاکتور</button>
    `;
    openModal('جزئیات فاکتور', html);
}
window.openInvoiceView = openInvoiceView;

/* -------- Print engine (bill templates, orientation, logo, digit style) -------- */
function digitize(strOrNum) {
    const s = String(strOrNum);
    return (getSettings().digitStyle === 'en') ? s : s;
}
function billHeaderHtml(docTitleFa) {
    const s = getSettings();
    const logo = s.logoDataUrl ? `<img src="${s.logoDataUrl}" alt="لوگو" style="width:52px;height:52px;border-radius:10px;object-fit:cover;margin:0 auto 6px;display:block;">` : '';
    return `
        <div class="bill-header">
            ${logo}
            <div class="receipt-store-name">${esc(s.storeName || 'فروشگاه')}</div>
            <div class="receipt-meta-line">${esc(s.address || '')}${s.phone ? ' · تلفن: ' + esc(s.phone) : ''}</div>
            <div style="font-weight:800; margin-top:6px;">${esc(docTitleFa)}</div>
        </div>`;
}
function billTemplateClass() { return 'tpl-' + ((getSettings().printTemplate) || 'modern'); }
function billTemplateOpenTag() {
    const s = getSettings();
    let styleAttr = '';
    if ((s.printTemplate || 'modern') === 'watermark') {
        const wm = s.watermark || {};
        const text = (wm.text || 'حسابداری پلاس').replace(/"/g, '\u201c');
        const size = num(wm.fontSize) || 42;
        const opacity = (wm.opacity !== undefined && wm.opacity !== null) ? wm.opacity : 0.06;
        const angle = (wm.angle !== undefined && wm.angle !== null) ? wm.angle : -30;
        const top = (wm.top !== undefined && wm.top !== null) ? wm.top : 50;
        const left = (wm.left !== undefined && wm.left !== null) ? wm.left : 50;
        styleAttr = ` style="--wm-text:'${esc(text)}'; --wm-size:${size}px; --wm-opacity:${opacity}; --wm-angle:${angle}deg; --wm-top:${top}%; --wm-left:${left}%;"`;
    } else if ((s.printTemplate || 'modern') === 'custom') {
        styleAttr = customTemplateStyleAttr();
    }
    return `<div class="bill-template ${billTemplateClass()}" id="printArea"${styleAttr}>`;
}
function printFooterButton() {
    return `<button class="calc-btn no-print" style="margin-top:14px;" onclick="doPrint()">🖨 چاپ</button>`;
}
function doPrint() {
    applyPrintOrientationOverride();
    window.print();
}
window.doPrint = doPrint;
function applyPrintOrientationOverride() {
    let styleTag = document.getElementById('printOrientationStyle');
    if (!styleTag) { styleTag = document.createElement('style'); styleTag.id = 'printOrientationStyle'; document.head.appendChild(styleTag); }
    const s = getSettings();
    const paper = s.paperSize || 'A4';
    let sizeRule;
    if (paper === '80mm') sizeRule = '80mm auto';
    else if (paper === '58mm') sizeRule = '58mm auto';
    else sizeRule = `${paper} ${s.printOrientation || 'portrait'}`;
    styleTag.textContent = `@page { size: ${sizeRule}; margin: ${paper === '80mm' || paper === '58mm' ? '2mm' : '10mm'}; }
        ${paper === '80mm' || paper === '58mm' ? '.bill-template { max-width: ' + (paper === '80mm' ? '76mm' : '54mm') + '; font-size: 11px; } .signatures-container { display:none; }' : ''}`;
}

function printInvoice(id) {
    const inv = dbRead(K.invoices).find(i => i.id === id);
    if (!inv) return;
    const remain = Math.max(0, num(inv.total) - num(inv.paidAmount));
    const pmLabel = (PAYMENT_METHODS.find(p => p[0] === inv.paymentMethod) || [, 'نقدی'])[1];
    const html = `
    ${billTemplateOpenTag()}
        ${billHeaderHtml(inv.invoiceType === 'proforma' ? 'پیش‌فاکتور' : 'فاکتور فروش')}
        <div class="bill-info-container">
            <div class="bill-info-grid">
                <div><strong>شماره:</strong> ${inv.number}</div>
                <div><strong>تاریخ:</strong> ${fmtDate(inv.date)}</div>
                <div><strong>خریدار:</strong> ${esc(inv.customerNameSnapshot || 'مشتری نقدی')}</div>
                <div><strong>روش پرداخت:</strong> ${esc(pmLabel)}</div>
                <div><strong>وضعیت:</strong> ${inv.status === 'paid' ? 'پرداخت‌شده' : inv.status === 'partial' ? 'پرداخت جزئی' : 'پرداخت‌نشده'}</div>
            </div>
        </div>
        <table class="bill-table">
            <thead><tr><th>ردیف</th><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد</th><th>مبلغ کل</th></tr></thead>
            <tbody>
                ${inv.items.map((it, i) => `<tr><td>${(i + 1).toLocaleString(localeForDigits())}</td><td class="text-cell">${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(it.qty * it.price)}</td></tr>`).join('')}
            </tbody>
        </table>
        <div class="bill-totals">
            <div class="totals-row"><span>جمع کل کالاها</span><span>${moneyPlain(inv.items.reduce((s2, it) => s2 + it.qty * it.price, 0))} ${esc(currencyLabel())}</span></div>
            ${inv.discountTotal ? `<div class="totals-row"><span>تخفیف</span><span>−${moneyPlain(inv.discountTotal)}</span></div>` : ''}
            ${inv.taxAmount ? `<div class="totals-row"><span>مالیات</span><span>${moneyPlain(inv.taxAmount)}</span></div>` : ''}
            ${inv.interestAmount ? `<div class="totals-row"><span>سود نسیه/چک (${esc((inv.paymentDetails && inv.paymentDetails.monthlyPercent) || 0)}٪ در ماه)</span><span>${moneyPlain(inv.interestAmount)}</span></div>` : ''}
            <div class="totals-row grand"><span>مبلغ نهایی قابل پرداخت</span><span>${moneyPlain(inv.total)} ${esc(currencyLabel())}</span></div>
            <div class="totals-row"><span>پرداخت‌شده</span><span>${moneyPlain(inv.paidAmount)}</span></div>
            <div class="totals-row"><span>مانده حساب</span><span>${moneyPlain(remain)}</span></div>
        </div>
        ${(inv.paymentMethod === 'check' && inv.paymentDetails) ? `<p class="txt-caption">مشخصات چک: ${inv.paymentDetails.bank ? 'بانک ' + esc(inv.paymentDetails.bank) + ' — ' : ''}${inv.paymentDetails.checkNumber ? 'شماره ' + esc(inv.paymentDetails.checkNumber) + ' — ' : ''}سررسید ${fmtDate(inv.paymentDetails.dueDate)}</p>` : ''}
        ${(inv.paymentMethod === 'credit' && inv.paymentDetails) ? `<p class="txt-caption">نسیه — موعد تسویه: ${fmtDate(inv.paymentDetails.dueDate)} · سود ${esc(inv.paymentDetails.monthlyPercent || 0)}٪ در ماه${inv.paymentDetails.compound ? ' (مرکب)' : ''}</p>` : ''}
        <div class="signatures-container">
            <div class="signature-card"><div class="signature-card-name">امضای فروشنده</div><div class="signature-space"></div></div>
            <div class="signature-card"><div class="signature-card-name">امضای خریدار</div><div class="signature-space"></div></div>
        </div>
    </div>
    ${printFooterButton()}
    `;
    openModal('پیش‌نمایش چاپ #' + inv.number, html);
}
window.printInvoice = printInvoice;


/* ---------------------------------------------------------------------------
   Purchases (from suppliers)
   ------------------------------------------------------------------------- */
let draftPurchase = null;
let purchaseSearchTerm = '';

let purchaseOpenFolders = new Set();
function togglePurchaseFolder(name) {
    if (purchaseOpenFolders.has(name)) purchaseOpenFolders.delete(name); else purchaseOpenFolders.add(name);
    rerenderIfActive('purchases');
}
window.togglePurchaseFolder = togglePurchaseFolder;
function purchaseItemHtml(p) {
    const remain = Math.max(0, num(p.total) - num(p.paidAmount));
    return `
        <div class="list-item" style="cursor:pointer;" onclick="openPurchaseEditor('${p.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(p.supplier)} <span class="txt-caption">#${p.number}</span></div><div class="list-item-sub">${fmtDate(p.date)} · ${p.items.length.toLocaleString(localeForDigits())} قلم${p.checkDeduction ? ' · ' + moneyPlain(p.checkDeduction.amount) + ' با چک تسویه شد' : ''}</div></div>
                <div style="text-align:left;"><div class="list-item-title">${money(p.total)}</div>${remain > 0 ? `<span class="badge badge-rose">بدهی ${moneyPlain(remain)}</span>` : `<span class="badge badge-emerald">تسویه</span>`}</div>
            </div>
        </div>`;
}
function renderPurchases() {
    const all = dbRead(K.purchases).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const term = purchaseSearchTerm.trim();
    const list = term ? all.filter(p => (p.supplier + String(p.number)).includes(term)) : all;
    const totalPayable = all.reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0);

    const header = viewHeader('خرید', 'خرید از تأمین‌کننده', `${all.length.toLocaleString(localeForDigits())} فاکتور خرید · بدهی به تأمین‌کنندگان: ${money(totalPayable)}`, `<button class="nav-btn" onclick="openListPrintOptions('purchases')" title="چاپ لیست خرید"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);
    const searchBar = `
    <div class="search-bar">
        <input type="text" placeholder="جستجوی تأمین‌کننده یا شماره..." value="${esc(purchaseSearchTerm)}" oninput="purchaseSearchTerm=this.value; rerenderIfActive('purchases')">
        <button class="fab-add" onclick="openPurchaseEditor()" title="خرید جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>`;

    if (term) {
        return header + searchBar + (list.length ? list.map(purchaseItemHtml).join('') : `<div class="empty-state">خریدی یافت نشد.</div>`);
    }
    // Accordion grouped by supplier — matches the category-folder pattern used for کالا و انبار
    const bySupplier = {};
    all.forEach(p => { (bySupplier[p.supplier || 'نامشخص'] = bySupplier[p.supplier || 'نامشخص'] || []).push(p); });
    const names = Object.keys(bySupplier).sort((a, b) => a.localeCompare(b, 'fa'));
    return header + searchBar + (names.length ? names.map(name => {
        const open = purchaseOpenFolders.has(name);
        const items = bySupplier[name];
        const debt = items.reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0);
        return `<div class="accordion-item">
            <div class="list-item" style="cursor:pointer;" onclick="togglePurchaseFolder('${esc(name).replace(/'/g, "\\'")}')">
                <div class="list-item-row"><div class="list-item-title">📁 ${esc(name)}</div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${debt > 0 ? `<span class="badge badge-rose">بدهی ${moneyPlain(debt)}</span>` : ''}
                    <div class="badge badge-cyan">${items.length.toLocaleString(localeForDigits())}</div>
                    <span style="display:inline-block; transform:rotate(${open ? '180deg' : '0deg'});">▾</span>
                </div></div>
            </div>
            ${open ? `<div class="accordion-body">${monthGroupedListHtml(items, p => p.date, purchaseItemHtml)}</div>` : ''}
        </div>`;
    }).join('') : `<div class="empty-state">خریدی ثبت نشده است.</div>`);
}
VIEW_RENDERERS.purchases = renderPurchases;

function openPurchaseEditor(id) {
    const existing = id ? dbRead(K.purchases).find(x => x.id === id) : null;
    draftPurchase = existing ? JSON.parse(JSON.stringify(existing)) : {
        id: null, number: (dbRead(K.purchases).reduce((m, p) => Math.max(m, num(p.number)), 500) + 1),
        date: todayISO(), supplier: '', items: [], total: 0, paidAmount: 0, status: 'unpaid', paymentMethod: 'cash'
    };
    if (!draftPurchase.items.length) draftPurchase.items.push({ productId: '', name: '', qty: 1, price: 0 });
    switchView('purchaseNew');
}
window.openPurchaseEditor = openPurchaseEditor;

function renderPurchaseEditorPage() {
    if (!draftPurchase) { switchView('purchases'); return ''; }
    const d = draftPurchase;
    const itemRows = d.items.map((it, idx) => `
        <div class="item-row ${it.isConsignment ? 'consignment-row' : ''}">
            <button class="item-pick-btn" onclick="openItemPicker('purchase', ${idx})" type="button">
                ${it.isConsignment ? '<span class="badge badge-amber" style="margin-inline-end:4px;">★ امانی</span>' : ''}${esc(it.name) || '— انتخاب کالا —'}
            </button>
            <input type="text" inputmode="numeric" value="${num(it.qty)}" title="تعداد" oninput="dpUpdate(${idx},'qty',this.value)">
            <input type="text" inputmode="numeric" value="${num(it.price)}" title="قیمت خرید واحد" oninput="dpUpdate(${idx},'price',this.value)">
            <input type="text" value="${moneyPlain(num(it.qty) * num(it.price))}" disabled>
            <button class="item-remove" onclick="dpRemoveRow(${idx})" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');
    const rawTotal = d.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const interestAmount = d.paymentMethod === 'credit' || (d && d.paymentMethod === 'check') ? creditInterestAmount(rawTotal, d.paymentDetails) : 0;
    const total = rawTotal + interestAmount;

    return `
    ${viewHeader('خرید', d.id ? `ویرایش خرید #${d.number}` : 'ثبت خرید جدید', 'خرید از تأمین‌کننده یا همکار', `<button class="nav-btn" onclick="switchView('purchases')" title="بازگشت"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>`)}
    <div class="section-box">
        <div class="mini-form-grid">
            <div class="input-group"><label>نام تأمین‌کننده *</label>
                <input type="text" id="pf_supplier" list="pf_supplier_list" value="${esc(d.supplier)}" placeholder="نام فروشنده/عمده‌فروش" ondblclick="openSupplierPicker()">
                <datalist id="pf_supplier_list">${Array.from(new Set(dbRead(K.purchases).map(p => p.supplier).filter(Boolean))).map(s => `<option value="${esc(s)}">`).join('')}</datalist>
                <div class="field-hint">💡 روی فیلد دوبار کلیک کنید تا لیست تأمین‌کنندگان قبلی برای انتخاب باز شود</div>
            </div>
            ${jalaliDateField('pf_date', d.date || todayISO(), 'تاریخ خرید')}
        </div>
        <div class="input-group"><label>روش پرداخت</label>
            <select id="pf_paymethod" onchange="dpOnPaymentMethodChange()">${PAYMENT_METHODS.map(([v, l]) => `<option value="${v}" ${(d.paymentMethod || 'cash') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        </div>
        <div id="pf_paymentDetailsBox">${paymentDetailsHtml('pf', d.paymentMethod || 'cash', d.paymentDetails, true, 'out')}</div>
    </div>
    <div class="section-box">
        <div class="item-row-head"><span>کالا</span><span>تعداد</span><span>قیمت خرید</span><span>جمع</span></div>
        <div id="purchRowsWrap">${itemRows}</div>
        <button class="btn-action" style="width:100%;" onclick="dpAddRow()" type="button">+ افزودن ردیف کالا</button>
    </div>
    <div class="section-box">
        <div class="input-group"><label>مبلغ پرداخت‌شده</label><input type="text" inputmode="numeric" id="pf_paid" value="${num(d.paidAmount)}" oninput="dpRecalc()"></div>
        ${dbRead(K.partners).length ? `
        <div class="settings-row" style="padding-inline:0;">
            <div>
                <div class="settings-row-label">🚫 این خرید با شرکا مشترک نیست</div>
                <div class="settings-row-sub">هزینه این خرید فقط برای صاحب فروشگاه حساب می‌شود، نه شرکا</div>
            </div>
            <label class="switch"><input type="checkbox" id="pf_excludePartner" ${d.excludeFromPartnership ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <p class="txt-caption">توجه: هزینه خرید در سود شرکا از طریق «بهای تمام‌شده کالای فروخته‌شده» در فاکتور فروش لحاظ می‌شود، نه مستقیماً اینجا؛ این گزینه بیشتر برای گزارش‌گیری و شفافیت است.</p>` : ''}
        <div class="totals-box" id="purchaseTotalsBox">${purchaseTotalsHtml(total, num(d.paidAmount), interestAmount)}</div>
    </div>
    <button class="calc-btn" onclick="savePurchase()" type="button">${d.id ? 'ذخیره تغییرات' : 'ثبت خرید'}</button>
    ${d.id ? `<div class="action-grid" style="margin-top:8px;">
        <button class="btn-action" onclick="printPurchase('${d.id}')" type="button">🖨 چاپ سند خرید</button>
        <button class="btn-action" style="color:var(--accent-rose);" onclick="deletePurchase('${d.id}')" type="button">حذف خرید</button>
    </div>` : ''}
    `;
}
VIEW_RENDERERS.purchaseNew = renderPurchaseEditorPage;

function purchaseTotalsHtml(total, paid, interest) {
    interest = num(interest) || 0;
    const remain = Math.max(0, total - paid);
    return `
        ${interest ? `<div class="totals-row"><span>سود نسیه</span><span>${moneyPlain(interest)}</span></div>` : ''}
        <div class="totals-row grand"><span>جمع کل خرید</span><span>${moneyPlain(total)} ${esc(currencyLabel())}</span></div>
        <div class="totals-row"><span>پرداخت‌شده</span><span>${moneyPlain(paid)}</span></div>
        <div class="totals-row" style="color:${remain > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)'}"><span>مانده بدهی</span><span>${moneyPlain(remain)}</span></div>
    `;
}
function dpCurrentInterest() {
    const rawTotal = draftPurchase.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const methodEl = document.getElementById('pf_paymethod');
    const method = methodEl ? methodEl.value : (draftPurchase.paymentMethod || 'cash');
    const pd = (method === 'credit' || method === 'check') ? paymentDetailsCollect('pf', method) : null;
    const infoEl = document.getElementById('pf_crInfo');
    if (infoEl && method === 'credit') infoEl.textContent = creditInterestBreakdownText(pd);
    return (method === 'credit' || method === 'check') ? creditInterestAmount(rawTotal, pd) : 0;
}
function dpUpdate(idx, field, value) {
    draftPurchase.items[idx][field] = (field === 'qty' || field === 'price') ? num(value) : value;
    dpApplyAutoPaid();
    const rawTotal = draftPurchase.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const interest = dpCurrentInterest();
    const paidEl = document.getElementById('pf_paid');
    const box = document.getElementById('purchaseTotalsBox');
    if (box) box.innerHTML = purchaseTotalsHtml(rawTotal + interest, num(paidEl ? paidEl.value : 0), interest);
    document.querySelectorAll('#purchRowsWrap .item-row').forEach((row, i) => {
        const it = draftPurchase.items[i]; if (!it) return;
        const cell = row.querySelectorAll('input')[2];
        if (cell) cell.value = moneyPlain(num(it.qty) * num(it.price));
    });
}
window.dpUpdate = dpUpdate;
function dpAddRow() { syncPurchaseDraftFromDom(); draftPurchase.items.push({ productId: '', name: '', qty: 1, price: 0 }); rerenderIfActive('purchaseNew'); }
window.dpAddRow = dpAddRow;
function dpRemoveRow(idx) {
    syncPurchaseDraftFromDom();
    draftPurchase.items.splice(idx, 1);
    if (!draftPurchase.items.length) draftPurchase.items.push({ productId: '', name: '', qty: 1, price: 0 });
    rerenderIfActive('purchaseNew');
}
window.dpRemoveRow = dpRemoveRow;
function dpRecalc() {
    const rawTotal = draftPurchase.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const interest = dpCurrentInterest();
    const box = document.getElementById('purchaseTotalsBox');
    if (box) box.innerHTML = purchaseTotalsHtml(rawTotal + interest, num(document.getElementById('pf_paid').value), interest);
}
window.dpRecalc = dpRecalc;
function dpOnPaymentMethodChange() {
    const method = document.getElementById('pf_paymethod').value;
    const box = document.getElementById('pf_paymentDetailsBox');
    if (box) box.innerHTML = paymentDetailsHtml('pf', method, method === draftPurchase.paymentMethod ? draftPurchase.paymentDetails : {}, true, 'out');
    dpRecalc();
    dpApplyAutoPaid();
}
window.dpOnPaymentMethodChange = dpOnPaymentMethodChange;
function dpApplyAutoPaid() {
    const methodEl = document.getElementById('pf_paymethod');
    const paidEl = document.getElementById('pf_paid');
    if (!methodEl || !paidEl) return;
    const method = methodEl.value;
    if (method === 'cash' || method === 'card') {
        const rawTotal = draftPurchase.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
        paidEl.value = rawTotal;
        paidEl.readOnly = true;
        paidEl.title = 'در پرداخت نقدی/کارتی، مبلغ به‌طور کامل و همان لحظه پرداخت می‌شود';
        dpRecalc();
    } else if (method === 'check') {
        const sourceEl = document.getElementById('pf_ckSource');
        const existingIdEl = document.getElementById('pf_ckExistingId');
        if (sourceEl && sourceEl.value === 'existing' && existingIdEl && existingIdEl.value) {
            const chk = dbRead(K.checks).find(c => c.id === existingIdEl.value);
            if (chk) {
                paidEl.value = num(chk.amount);
                paidEl.readOnly = true;
                paidEl.title = `این مبلغ از چک دریافتیِ «${chk.who}» کسر و بابت این خرید واگذار می‌شود`;
                dpRecalc();
                return;
            }
        }
        paidEl.readOnly = false;
        paidEl.title = '';
    } else {
        paidEl.readOnly = false;
        paidEl.title = '';
    }
}
window.dpApplyAutoPaid = dpApplyAutoPaid;
function openSupplierPicker() {
    const suppliers = Array.from(new Set(dbRead(K.purchases).map(p => p.supplier).filter(Boolean))).sort();
    const html = suppliers.length ? suppliers.map(s => `<div class="list-item" style="cursor:pointer;" onclick="pickSupplier('${esc(s).replace(/'/g, "\\'")}')">${esc(s)}</div>`).join('') : `<div class="empty-state">هنوز تأمین‌کننده‌ای ثبت نشده؛ برای اولین بار نام را تایپ کنید.</div>`;
    openModal('انتخاب تأمین‌کننده', html);
}
window.openSupplierPicker = openSupplierPicker;
function pickSupplier(name) {
    const el = document.getElementById('pf_supplier');
    if (el) el.value = name;
    closeModal();
}
window.pickSupplier = pickSupplier;

function adjustStockByName(items, sign) {
    const products = dbRead(K.products);
    let changed = false;
    items.forEach(it => {
        if (!it.productId || it.isConsignment) return;
        const p = products.find(x => x.id === it.productId);
        if (p) { p.qty = num(p.qty) + sign * num(it.qty); changed = true; }
    });
    if (changed) dbWrite(K.products, products);
}

function savePurchase() {
    const supplier = document.getElementById('pf_supplier').value.trim();
    if (!supplier) { showToast('نام تأمین‌کننده را وارد کنید', 'error'); return; }
    const paymentMethod = document.getElementById('pf_paymethod').value;
    const paymentDetails = paymentDetailsCollect('pf', paymentMethod);
    const items = draftPurchase.items.filter(it => (it.name || it.productId) && num(it.qty) > 0);
    if (!items.length) { showToast('حداقل یک ردیف کالا وارد کنید', 'error'); return; }
    const rawTotal = items.reduce((s, it) => s + num(it.qty) * num(it.price), 0);
    const interestAmount = paymentMethod === 'credit' || paymentMethod === 'check' ? creditInterestAmount(rawTotal, paymentDetails) : 0;
    const total = rawTotal + interestAmount;
    const paidAmount = Math.min(total, num(document.getElementById('pf_paid').value));
    const status = paidAmount >= total && total > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');
    const date = getJalaliInputISO('pf_date') || draftPurchase.date || todayISO();
    let checkDeduction = null;
    if (paymentMethod === 'check' && paymentDetails.source === 'existing' && paymentDetails.existingCheckId) {
        const chk = dbRead(K.checks).find(c => c.id === paymentDetails.existingCheckId);
        if (chk) checkDeduction = { checkId: chk.id, who: chk.who, number: chk.number, amount: chk.amount };
    }
    const excludeFromPartnership = !!(document.getElementById('pf_excludePartner') || {}).checked;

    const list = dbRead(K.purchases);
    let savedId = draftPurchase.id;
    if (draftPurchase.id) {
        const old = list.find(p => p.id === draftPurchase.id);
        if (old) adjustStockByName(old.items, -1);
        const idx = list.findIndex(p => p.id === draftPurchase.id);
        list[idx] = Object.assign(list[idx], { supplier, items, interestAmount, total, paidAmount, status, paymentMethod, paymentDetails, checkDeduction, excludeFromPartnership, date });
        adjustStockByName(items, +1);
    } else {
        savedId = uid('pur');
        list.push({ id: savedId, number: draftPurchase.number, date, supplier, items, interestAmount, total, paidAmount, status, paymentMethod, paymentDetails, checkDeduction, excludeFromPartnership });
        adjustStockByName(items, +1);
    }
    dbWrite(K.purchases, list);

    // Payment method "چک" on a purchase → either endorse/spend an existing received check, or log a new issued check
    if (paymentMethod === 'check') {
        const checks = dbRead(K.checks);
        if (paymentDetails.source === 'existing' && paymentDetails.existingCheckId) {
            const idx = checks.findIndex(c => c.id === paymentDetails.existingCheckId);
            if (idx > -1) { checks[idx].endorsedTo = supplier; checks[idx].endorsedDate = todayISO(); checks[idx].note = (checks[idx].note ? checks[idx].note + ' — ' : '') + `واگذار شده بابت خرید #${draftPurchase.number || ''} به ${supplier}`; }
            dbWrite(K.checks, checks);
        } else if (paymentDetails.dueDate) {
            const already = checks.find(c => c.linkedPurchaseId === savedId);
            const chkData = {
                who: supplier, direction: 'pay', amount: total,
                number: paymentDetails.checkNumber, bank: paymentDetails.bank, accountNo: paymentDetails.accountNo,
                sayadNo: paymentDetails.sayadNo, dueDate: paymentDetails.dueDate, status: 'pending', linkedPurchaseId: savedId
            };
            if (already) Object.assign(already, chkData); else checks.push(Object.assign({ id: uid('chk') }, chkData));
            dbWrite(K.checks, checks);
        }
    }

    autoBackupTick();
    showToast('خرید با موفقیت ثبت شد', 'success');
    switchView('purchases');
}
window.savePurchase = savePurchase;

function deletePurchase(id) {
    if (!confirmAction('آیا از حذف این خرید مطمئن هستید؟ موجودی کالاها اصلاح می‌شود.')) return;
    const list = dbRead(K.purchases);
    const p = list.find(x => x.id === id);
    if (p) adjustStockByName(p.items, -1);
    dbWrite(K.purchases, list.filter(x => x.id !== id));
    autoBackupTick();
    showToast('خرید حذف شد', 'success');
    switchView('purchases');
}
window.deletePurchase = deletePurchase;

/* -------- Generic "print this list" for products / customers / invoices / purchases / expenses -------- */
function openListPrintOptions(kind) {
    let body = '';
    if (kind === 'products') {
        const cats = Array.from(new Set(dbRead(K.products).map(p => p.category || 'بدون دسته'))).sort((a, b) => a.localeCompare(b, 'fa'));
        const products = dbRead(K.products).slice().sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        body = `
        <div class="input-group"><label>کالای خاص (اختیاری)</label>
            <select id="lp_item"><option value="">همه کالاها</option>${products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        </div>
        <div class="input-group"><label>دسته‌بندی</label>
            <select id="lp_cat"><option value="">همه دسته‌ها</option>${cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="input-group"><label>مرتب‌سازی</label>
            <select id="lp_sort">
                <option value="name">بر اساس نام (الفبا)</option>
                <option value="priceDesc">گران‌ترین تا ارزان‌ترین</option>
                <option value="priceAsc">ارزان‌ترین تا گران‌ترین</option>
                <option value="bestSeller">پرفروش‌ترین</option>
                <option value="lowStock">کمترین موجودی در انبار</option>
                <option value="highStock">بیشترین موجودی در انبار</option>
            </select>
        </div>`;
    } else if (kind === 'customers') {
        const customers = dbRead(K.customers).slice().sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        body = `
        <div class="input-group"><label>مشتری خاص (اختیاری)</label>
            <select id="lp_item"><option value="">همه مشتریان</option>${customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="input-group"><label>مرتب‌سازی</label>
            <select id="lp_sort">
                <option value="name">بر اساس نام (الفبا)</option>
                <option value="purchaseDesc">بیشترین خرید</option>
                <option value="purchaseAsc">کمترین خرید</option>
                <option value="profitDesc">پرسودترین مشتری</option>
                <option value="profitAsc">کم‌سودترین مشتری</option>
                <option value="debtDesc">بیشترین بدهی</option>
            </select>
        </div>`;
    } else if (kind === 'invoices') {
        const customers = dbRead(K.customers).slice().sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        body = `
        <div class="input-group"><label>مشتری خاص (اختیاری)</label>
            <select id="lp_item"><option value="">همه مشتریان</option>${customers.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="mini-form-grid">
            ${jalaliDateField('lp_from', '', 'از تاریخ (اختیاری)')}
            ${jalaliDateField('lp_to', '', 'تا تاریخ (اختیاری)')}
        </div>
        <div class="input-group"><label>مرتب‌سازی</label>
            <select id="lp_sort">
                <option value="dateDesc">تاریخ: جدیدترین اول</option>
                <option value="dateAsc">تاریخ: قدیمی‌ترین اول</option>
                <option value="customerName">بر اساس نام مشتری</option>
                <option value="amountDesc">بیشترین خرید تا کمترین</option>
                <option value="amountAsc">کمترین خرید تا بیشترین</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">نمایش ریز اقلام هر فاکتور</div>
            <label class="switch"><input type="checkbox" id="lp_detail"><span class="switch-slider"></span></label>
        </div>`;
    } else if (kind === 'purchases') {
        const suppliers = Array.from(new Set(dbRead(K.purchases).map(p => p.supplier))).sort((a, b) => a.localeCompare(b, 'fa'));
        body = `
        <div class="input-group"><label>تأمین‌کننده خاص (اختیاری)</label>
            <select id="lp_item"><option value="">همه تأمین‌کنندگان</option>${suppliers.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>
        </div>
        <div class="mini-form-grid">
            ${jalaliDateField('lp_from', '', 'از تاریخ (اختیاری)')}
            ${jalaliDateField('lp_to', '', 'تا تاریخ (اختیاری)')}
        </div>
        <div class="input-group"><label>مرتب‌سازی</label>
            <select id="lp_sort">
                <option value="name">بر اساس نام</option>
                <option value="amountDesc">بیشترین خرید</option>
                <option value="amountAsc">کمترین خرید</option>
                <option value="debtDesc">بیشترین بدهی</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">مقایسه قیمت کالاهای مشابه بین تأمین‌کنندگان</div>
            <label class="switch"><input type="checkbox" id="lp_compare"><span class="switch-slider"></span></label>
        </div>
        <p class="txt-caption">با فعال کردن این گزینه، برای هر کالا نشان داده می‌شود کدام تأمین‌کننده ارزان‌تر فروخته است.</p>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">نمایش ریز اقلام هر فاکتور خرید</div>
            <label class="switch"><input type="checkbox" id="lp_detail"><span class="switch-slider"></span></label>
        </div>`;
    } else if (kind === 'expenses') {
        const cats = getExpenseCategories();
        const years = Array.from(new Set(dbRead(K.expenses).map(e => isoToJalaliParts(e.date).jy))).sort((a, b) => b - a);
        const titles = Array.from(new Set(dbRead(K.expenses).map(e => e.title))).sort((a, b) => a.localeCompare(b, 'fa'));
        body = `
        <div class="input-group"><label>سال (اختیاری)</label>
            <select id="lp_year"><option value="">همه سال‌ها</option>${years.map(y => `<option value="${y}">${String(y).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])}</option>`).join('')}</select>
        </div>
        <div class="input-group"><label>دسته‌بندی (اختیاری)</label>
            <select id="lp_cat"><option value="">همه دسته‌ها</option>${cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="input-group"><label>عنوان هزینه خاص (اختیاری)</label>
            <select id="lp_item"><option value="">همه عناوین</option>${titles.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
        </div>
        <div class="mini-form-grid">
            ${jalaliDateField('lp_from', '', 'از تاریخ (اختیاری)')}
            ${jalaliDateField('lp_to', '', 'تا تاریخ (اختیاری)')}
        </div>
        <div class="input-group"><label>مرتب‌سازی</label>
            <select id="lp_sort">
                <option value="dateDesc">تاریخ: جدیدترین اول</option>
                <option value="dateAsc">تاریخ: قدیمی‌ترین اول</option>
                <option value="amountDesc">بیشترین مبلغ</option>
                <option value="amountAsc">کمترین مبلغ</option>
                <option value="category">بر اساس دسته‌بندی</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">تفکیک و جمع جزء به تفکیک دسته‌بندی</div>
            <label class="switch"><input type="checkbox" id="lp_groupByCat" checked><span class="switch-slider"></span></label>
        </div>`;
    } else {
        printListGeneric(kind);
        return;
    }
    openModal('انتخاب و مرتب‌سازی برای چاپ', `${body}<button class="calc-btn" style="width:100%; margin-top:10px;" onclick="printListGenericFinal('${kind}')">🖨 چاپ</button>`);
}
window.openListPrintOptions = openListPrintOptions;

function printListGenericFinal(kind) {
    const itemFilter = (document.getElementById('lp_item') || {}).value || '';
    const sort = (document.getElementById('lp_sort') || {}).value || '';
    let title = '', rows = '', headCols = [], extraHtml = '';

    if (kind === 'products') {
        const cat = (document.getElementById('lp_cat') || {}).value || '';
        let list = dbRead(K.products);
        if (itemFilter) list = list.filter(p => p.id === itemFilter);
        else if (cat) list = list.filter(p => (p.category || 'بدون دسته') === cat);
        const sold = {};
        dbRead(K.invoices).forEach(inv => inv.items.forEach(it => { if (it.productId) sold[it.productId] = (sold[it.productId] || 0) + num(it.qty); }));
        if (sort === 'priceDesc') list.sort((a, b) => num(b.sellPrice) - num(a.sellPrice));
        else if (sort === 'priceAsc') list.sort((a, b) => num(a.sellPrice) - num(b.sellPrice));
        else if (sort === 'bestSeller') list.sort((a, b) => (sold[b.id] || 0) - (sold[a.id] || 0));
        else if (sort === 'lowStock') list.sort((a, b) => num(a.qty) - num(b.qty));
        else if (sort === 'highStock') list.sort((a, b) => num(b.qty) - num(a.qty));
        else list.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        title = 'لیست کالا و انبار';
        headCols = ['نام کالا', 'دسته', 'موجودی', 'قیمت خرید', 'قیمت فروش', 'تعداد فروش رفته'];
        rows = list.map(p => `<tr><td class="text-cell">${esc(p.name)}</td><td>${esc(p.category || '-')}</td><td>${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit)}</td><td>${moneyPlain(p.buyPrice)}</td><td>${moneyPlain(p.sellPrice)}</td><td>${(sold[p.id] || 0).toLocaleString(localeForDigits())}</td></tr>`).join('');
    } else if (kind === 'customers') {
        let list = dbRead(K.customers);
        if (itemFilter) list = list.filter(c => c.id === itemFilter);
        const stats = {};
        dbRead(K.invoices).forEach(inv => {
            if (!inv.customerId) return;
            if (!stats[inv.customerId]) stats[inv.customerId] = { sales: 0, profit: 0 };
            const products = dbRead(K.products);
            const cost = inv.items.reduce((s, it) => { const p = products.find(x => x.id === it.productId); return s + (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty); }, 0);
            stats[inv.customerId].sales += num(inv.total);
            stats[inv.customerId].profit += num(inv.total) - cost;
        });
        const statFor = (id) => stats[id] || { sales: 0, profit: 0 };
        if (sort === 'purchaseDesc') list.sort((a, b) => statFor(b.id).sales - statFor(a.id).sales);
        else if (sort === 'purchaseAsc') list.sort((a, b) => statFor(a.id).sales - statFor(b.id).sales);
        else if (sort === 'profitDesc') list.sort((a, b) => statFor(b.id).profit - statFor(a.id).profit);
        else if (sort === 'profitAsc') list.sort((a, b) => statFor(a.id).profit - statFor(b.id).profit);
        else if (sort === 'debtDesc') list.sort((a, b) => customerBalance(b.id) - customerBalance(a.id));
        else list.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        title = 'لیست مشتریان';
        headCols = ['نام', 'تلفن', 'استان/شهر', 'جمع خرید', 'سود از این مشتری', 'مانده بدهی'];
        rows = list.map(c => `<tr><td class="text-cell">${esc(c.name)}</td><td>${esc(c.phone || '-')}</td><td>${esc(c.province || '-')} / ${esc(c.city || '-')}</td><td>${moneyPlain(statFor(c.id).sales)}</td><td>${moneyPlain(statFor(c.id).profit)}</td><td>${moneyPlain(customerBalance(c.id))}</td></tr>`).join('');
    } else if (kind === 'invoices') {
        let list = dbRead(K.invoices).slice();
        if (itemFilter) list = list.filter(i => (i.customerNameSnapshot || '') === itemFilter);
        const from = getJalaliInputISO('lp_from'), to = getJalaliInputISO('lp_to');
        if (from) list = list.filter(i => new Date(i.date) >= new Date(from));
        if (to) list = list.filter(i => new Date(i.date) <= new Date(to));
        if (sort === 'dateAsc') list.sort((a, b) => new Date(a.date) - new Date(b.date));
        else if (sort === 'customerName') list.sort((a, b) => (a.customerNameSnapshot || '').localeCompare(b.customerNameSnapshot || '', 'fa'));
        else if (sort === 'amountDesc') list.sort((a, b) => num(b.total) - num(a.total));
        else if (sort === 'amountAsc') list.sort((a, b) => num(a.total) - num(b.total));
        else list.sort((a, b) => new Date(b.date) - new Date(a.date));
        const total = list.reduce((s, i) => s + num(i.total), 0);
        title = 'لیست فاکتورهای فروش';
        headCols = ['شماره', 'تاریخ', 'مشتری', 'مبلغ کل', 'وضعیت'];
        if ((document.getElementById('lp_detail') || {}).checked) {
            rows = list.map(i => `<tr><td>${i.number}</td><td>${fmtDate(i.date)}</td><td class="text-cell">${esc(i.customerNameSnapshot || 'نقدی')}</td><td>${moneyPlain(i.total)}</td><td>${i.status === 'paid' ? 'پرداخت‌شده' : i.status === 'partial' ? 'جزئی' : 'پرداخت‌نشده'}</td></tr>
                <tr><td colspan="5" style="padding:0;"><table class="bill-table" style="margin:4px 0 10px;"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th></tr></thead><tbody>
                    ${i.items.map(it => `<tr><td class="text-cell">${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(num(it.qty) * num(it.price))}</td></tr>`).join('')}
                </tbody></table></td></tr>`).join('');
        } else {
            rows = list.map(i => `<tr><td>${i.number}</td><td>${fmtDate(i.date)}</td><td class="text-cell">${esc(i.customerNameSnapshot || 'نقدی')}</td><td>${moneyPlain(i.total)}</td><td>${i.status === 'paid' ? 'پرداخت‌شده' : i.status === 'partial' ? 'جزئی' : 'پرداخت‌نشده'}</td></tr>`).join('');
        }
        extraHtml = `<div class="totals-row grand" style="margin-top:8px;"><span>جمع کل (${list.length.toLocaleString(localeForDigits())} فاکتور)</span><span>${moneyPlain(total)}</span></div>`;
    } else if (kind === 'purchases') {
        let list = dbRead(K.purchases).slice();
        if (itemFilter) list = list.filter(p => p.supplier === itemFilter);
        const pFrom = getJalaliInputISO('lp_from'), pTo = getJalaliInputISO('lp_to');
        if (pFrom) list = list.filter(p => new Date(p.date) >= new Date(pFrom));
        if (pTo) list = list.filter(p => new Date(p.date) <= new Date(pTo));
        if (sort === 'amountDesc') list.sort((a, b) => num(b.total) - num(a.total));
        else if (sort === 'amountAsc') list.sort((a, b) => num(a.total) - num(b.total));
        else if (sort === 'debtDesc') list.sort((a, b) => (num(b.total) - num(b.paidAmount)) - (num(a.total) - num(a.paidAmount)));
        else list.sort((a, b) => a.supplier.localeCompare(b.supplier, 'fa'));
        title = 'لیست خریدها';
        headCols = ['شماره', 'تاریخ', 'تأمین‌کننده', 'مبلغ کل', 'مانده بدهی'];
        if ((document.getElementById('lp_detail') || {}).checked) {
            rows = list.map(p => `<tr><td>${p.number}</td><td>${fmtDate(p.date)}</td><td class="text-cell">${esc(p.supplier)}</td><td>${moneyPlain(p.total)}</td><td>${moneyPlain(Math.max(0, p.total - p.paidAmount))}</td></tr>
                <tr><td colspan="5" style="padding:0;"><table class="bill-table" style="margin:4px 0 10px;"><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th></tr></thead><tbody>
                    ${p.items.map(it => `<tr><td class="text-cell">${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(num(it.qty) * num(it.price))}</td></tr>`).join('')}
                </tbody></table></td></tr>`).join('');
        } else {
            rows = list.map(p => `<tr><td>${p.number}</td><td>${fmtDate(p.date)}</td><td class="text-cell">${esc(p.supplier)}</td><td>${moneyPlain(p.total)}</td><td>${moneyPlain(Math.max(0, p.total - p.paidAmount))}</td></tr>`).join('');
        }
        if ((document.getElementById('lp_compare') || {}).checked) {
            const byItem = {};
            dbRead(K.purchases).forEach(p => p.items.forEach(it => {
                const key = it.name; if (!byItem[key]) byItem[key] = [];
                byItem[key].push({ supplier: p.supplier, price: num(it.price) });
            }));
            const compareRows = Object.entries(byItem).filter(([, arr]) => arr.length > 1).map(([name, arr]) => {
                const cheapest = arr.slice().sort((a, b) => a.price - b.price)[0];
                return `<tr><td class="text-cell">${esc(name)}</td><td class="text-cell">${esc(cheapest.supplier)}</td><td>${moneyPlain(cheapest.price)}</td></tr>`;
            }).join('');
            extraHtml = `<h4 style="margin-top:16px;">ارزان‌ترین تأمین‌کننده برای هر کالا</h4><table class="bill-table"><thead><tr><th>کالا</th><th>ارزان‌ترین تأمین‌کننده</th><th>قیمت</th></tr></thead><tbody>${compareRows || '<tr><td colspan="3">کالای مشترکی بین تأمین‌کنندگان یافت نشد</td></tr>'}</tbody></table>`;
        }
    } else if (kind === 'expenses') {
        let list = dbRead(K.expenses).slice();
        const year = (document.getElementById('lp_year') || {}).value;
        const cat = (document.getElementById('lp_cat') || {}).value;
        if (year) list = list.filter(e => String(isoToJalaliParts(e.date).jy) === year);
        if (cat) list = list.filter(e => e.category === cat);
        if (itemFilter) list = list.filter(e => e.title === itemFilter);
        const from = getJalaliInputISO('lp_from'), to = getJalaliInputISO('lp_to');
        if (from) list = list.filter(e => new Date(e.date) >= new Date(from));
        if (to) list = list.filter(e => new Date(e.date) <= new Date(to));
        if (sort === 'dateAsc') list.sort((a, b) => new Date(a.date) - new Date(b.date));
        else if (sort === 'amountDesc') list.sort((a, b) => num(b.amount) - num(a.amount));
        else if (sort === 'amountAsc') list.sort((a, b) => num(a.amount) - num(b.amount));
        else if (sort === 'category') list.sort((a, b) => (a.category || '').localeCompare(b.category || '', 'fa'));
        else list.sort((a, b) => new Date(b.date) - new Date(a.date));
        title = 'لیست هزینه‌ها';
        headCols = ['عنوان', 'دسته', 'تاریخ', 'مبلغ'];
        const total = list.reduce((s, e) => s + num(e.amount), 0);
        if ((document.getElementById('lp_groupByCat') || {}).checked) {
            const byCat = {};
            list.forEach(e => { const k = e.category || 'بدون دسته'; (byCat[k] = byCat[k] || []).push(e); });
            rows = Object.entries(byCat).map(([catName, items]) => {
                const catTotal = items.reduce((s, e) => s + num(e.amount), 0);
                const itemRows = items.map(e => `<tr><td class="text-cell">${esc(e.title)}</td><td>${esc(e.category || '-')}</td><td>${fmtDate(e.date)}</td><td>${moneyPlain(e.amount)}</td></tr>`).join('');
                return `<tr><td colspan="4" style="font-weight:800; background:var(--surface-2);">📁 ${esc(catName)} (جمع: ${moneyPlain(catTotal)})</td></tr>${itemRows}`;
            }).join('');
        } else {
            rows = list.map(e => `<tr><td class="text-cell">${esc(e.title)}</td><td>${esc(e.category || '-')}</td><td>${fmtDate(e.date)}</td><td>${moneyPlain(e.amount)}</td></tr>`).join('');
        }
        extraHtml = `<div class="totals-row grand" style="margin-top:8px;"><span>جمع کل (${list.length.toLocaleString(localeForDigits())} مورد)</span><span>${moneyPlain(total)}</span></div>`;
    }

    const html = `${billTemplateOpenTag()}${billHeaderHtml(title)}
        <table class="bill-table"><thead><tr>${headCols.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headCols.length}">داده‌ای موجود نیست</td></tr>`}</tbody></table>
        ${extraHtml}
        <div class="txt-caption" style="margin-top:10px;">تاریخ چاپ: ${fmtDateTime(todayISO())}</div>
    </div>${printFooterButton()}`;
    closeModal();
    openModal('پیش‌نمایش چاپ', html);
}
window.printListGenericFinal = printListGenericFinal;

function printListGeneric(kind) {
    let title = '', rows = '', headCols = [];
    if (kind === 'products') {
        title = 'لیست کالا و انبار';
        headCols = ['نام کالا', 'دسته', 'موجودی', 'قیمت خرید', 'قیمت فروش'];
        rows = dbRead(K.products).map(p => `<tr><td class="text-cell">${esc(p.name)}</td><td>${esc(p.category || '-')}</td><td>${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit)}</td><td>${moneyPlain(p.buyPrice)}</td><td>${moneyPlain(p.sellPrice)}</td></tr>`).join('');
    } else if (kind === 'customers') {
        title = 'لیست مشتریان';
        headCols = ['نام', 'تلفن', 'استان/شهر', 'مانده بدهی'];
        rows = dbRead(K.customers).map(c => `<tr><td class="text-cell">${esc(c.name)}</td><td>${esc(c.phone || '-')}</td><td>${esc(c.province || '-')} / ${esc(c.city || '-')}</td><td>${moneyPlain(customerBalance(c.id))}</td></tr>`).join('');
    } else if (kind === 'invoices') {
        title = 'لیست فاکتورهای فروش';
        headCols = ['شماره', 'تاریخ', 'مشتری', 'مبلغ کل', 'وضعیت'];
        rows = dbRead(K.invoices).slice().sort((a, b) => new Date(b.date) - new Date(a.date)).map(i => `<tr><td>${i.number}</td><td>${fmtDate(i.date)}</td><td class="text-cell">${esc(i.customerNameSnapshot || 'نقدی')}</td><td>${moneyPlain(i.total)}</td><td>${i.status === 'paid' ? 'پرداخت‌شده' : i.status === 'partial' ? 'جزئی' : 'پرداخت‌نشده'}</td></tr>`).join('');
    } else if (kind === 'purchases') {
        title = 'لیست خریدها';
        headCols = ['شماره', 'تاریخ', 'تأمین‌کننده', 'مبلغ کل', 'مانده بدهی'];
        rows = dbRead(K.purchases).slice().sort((a, b) => new Date(b.date) - new Date(a.date)).map(p => `<tr><td>${p.number}</td><td>${fmtDate(p.date)}</td><td class="text-cell">${esc(p.supplier)}</td><td>${moneyPlain(p.total)}</td><td>${moneyPlain(Math.max(0, p.total - p.paidAmount))}</td></tr>`).join('');
    } else if (kind === 'expenses') {
        title = 'لیست هزینه‌ها';
        headCols = ['عنوان', 'دسته', 'تاریخ', 'مبلغ'];
        rows = dbRead(K.expenses).slice().sort((a, b) => new Date(b.date) - new Date(a.date)).map(e => `<tr><td class="text-cell">${esc(e.title)}</td><td>${esc(e.category || '-')}</td><td>${fmtDate(e.date)}</td><td>${moneyPlain(e.amount)}</td></tr>`).join('');
    }
    const html = `
    ${billTemplateOpenTag()}
        ${billHeaderHtml(title)}
        <table class="bill-table"><thead><tr>${headCols.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headCols.length}">داده‌ای موجود نیست</td></tr>`}</tbody></table>
        <div class="txt-caption" style="margin-top:10px;">تاریخ چاپ: ${fmtDateTime(todayISO())}</div>
    </div>
    ${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ — ' + title, html);
}
window.printListGeneric = printListGeneric;

function printPurchase(id) {
    const p = dbRead(K.purchases).find(x => x.id === id);
    if (!p) return;
    const remain = Math.max(0, num(p.total) - num(p.paidAmount));
    const html = `
    ${billTemplateOpenTag()}
        ${billHeaderHtml('سند خرید از تأمین‌کننده')}
        <div class="bill-info-container">
            <div class="bill-info-grid">
                <div><strong>شماره:</strong> ${p.number}</div>
                <div><strong>تاریخ:</strong> ${fmtDate(p.date)}</div>
                <div><strong>تأمین‌کننده:</strong> ${esc(p.supplier)}</div>
            </div>
        </div>
        <table class="bill-table">
            <thead><tr><th>ردیف</th><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد</th><th>مبلغ کل</th></tr></thead>
            <tbody>${p.items.map((it, i) => `<tr><td>${(i + 1).toLocaleString(localeForDigits())}</td><td class="text-cell">${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(it.qty * it.price)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="bill-totals">
            <div class="totals-row grand"><span>جمع کل</span><span>${moneyPlain(p.total)} ${esc(currencyLabel())}</span></div>
            ${p.checkDeduction ? `<div class="totals-row"><span>کسر بابت چک دریافتی (${esc(p.checkDeduction.who)}${p.checkDeduction.number ? ' — #' + esc(p.checkDeduction.number) : ''})</span><span>−${moneyPlain(p.checkDeduction.amount)}</span></div>` : ''}
            ${p.interestAmount ? `<div class="totals-row"><span>سود نسیه/چک</span><span>${moneyPlain(p.interestAmount)}</span></div>` : ''}
            <div class="totals-row"><span>پرداخت‌شده</span><span>${moneyPlain(p.paidAmount)}</span></div>
            <div class="totals-row"><span>مانده بدهی</span><span>${moneyPlain(remain)}</span></div>
        </div>
        <div class="signatures-container">
            <div class="signature-card"><div class="signature-card-name">امضای خریدار</div><div class="signature-space"></div></div>
            <div class="signature-card"><div class="signature-card-name">امضای تأمین‌کننده</div><div class="signature-space"></div></div>
        </div>
    </div>
    ${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ خرید #' + p.number, html);
}
window.printPurchase = printPurchase;


/* ---------------------------------------------------------------------------
   Expenses
   ------------------------------------------------------------------------- */
function renderExpenses() {
    const all = dbRead(K.expenses).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const total = all.reduce((s, e) => s + num(e.amount), 0);
    return `
    ${viewHeader('مالی', 'هزینه‌ها', `${all.length.toLocaleString(localeForDigits())} ثبت · جمع کل: ${money(total)}`, `<button class="nav-btn" onclick="openListPrintOptions('expenses')" title="چاپ لیست هزینه‌ها"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="search-bar">
        <div></div>
        <button class="fab-add" onclick="openExpenseEditor()" title="هزینه جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>
    ${all.length ? all.map(e => `
        <div class="list-item" style="cursor:pointer;" onclick="openExpenseEditor('${e.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(e.title)}</div><div class="list-item-sub">${fmtDate(e.date)} · ${esc(e.category || '')}</div></div>
                <div class="list-item-title" style="color:var(--accent-rose);">−${moneyPlain(e.amount)}</div>
            </div>
        </div>`).join('') : `<div class="empty-state">هزینه‌ای ثبت نشده است.</div>`}`;
}
VIEW_RENDERERS.expenses = renderExpenses;

/* ---------------------------------------------------------------------------
   Payroll (حقوق و دستمزد پرسنل)
   ------------------------------------------------------------------------- */
function employeePaidTotal(empId) {
    return dbRead(K.payroll).filter(p => p.employeeId === empId).reduce((s, p) => s + num(p.amount), 0);
}
function renderPayroll() {
    const employees = dbRead(K.employees);
    const payments = dbRead(K.payroll).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const totalPaidThisMonthAll = payments.reduce((s, p) => s + num(p.amount), 0);
    return `
    ${viewHeader('مالی', 'حقوق پرسنل', `${employees.length.toLocaleString(localeForDigits())} نفر · جمع کل پرداختی: ${money(totalPaidThisMonthAll)}`, `<button class="nav-btn" onclick="printPayrollList()" title="چاپ لیست حقوق"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="search-bar">
        <div></div>
        <button class="fab-add" onclick="openEmployeeEditor()" title="نیروی جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>
    ${employees.length ? employees.map(e => `
        <div class="list-item">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(e.name)}</div><div class="list-item-sub">${esc(e.role || '-')}${e.baseSalary ? ' · حقوق پایه: ' + moneyPlain(e.baseSalary) : ''}${e.hireDate ? ' · تاریخ ورود: ' + fmtDate(e.hireDate) : ''}</div></div>
                <div style="text-align:left;"><div class="list-item-title">${moneyPlain(employeePaidTotal(e.id))}</div><div class="txt-caption">جمع پرداختی</div></div>
            </div>
            <div class="action-grid" style="margin-top:8px;">
                <button class="btn-action" onclick="openPayrollPayment('${e.id}')">💳 ثبت پرداخت</button>
                <button class="btn-action" onclick="openEmployeeEditor('${e.id}')">ویرایش</button>
                <button class="btn-action" style="color:var(--accent-rose);" onclick="deleteEmployee('${e.id}')">حذف</button>
            </div>
        </div>`).join('') : `<div class="empty-state">هنوز پرسنلی ثبت نشده است.</div>`}

    <div class="section-title" style="margin-top:16px;">تاریخچه پرداخت‌های حقوق</div>
    ${payments.length ? payments.slice(0, 60).map(p => {
        const emp = employees.find(e => e.id === p.employeeId);
        return `<div class="list-item"><div class="list-item-row">
            <div><div class="list-item-title">${esc(emp ? emp.name : 'حذف‌شده')}</div><div class="list-item-sub">${fmtDate(p.date)} · ${p.method === 'cash' ? 'از صندوق نقدی' : 'با چک'}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
            <div class="list-item-title" style="color:var(--accent-rose);">−${moneyPlain(p.amount)}</div>
        </div></div>`;
    }).join('') : `<div class="empty-state">هنوز پرداختی ثبت نشده است.</div>`}
    `;
}
VIEW_RENDERERS.payroll = renderPayroll;

function openEmployeeEditor(id) {
    const e = id ? dbRead(K.employees).find(x => x.id === id) : null;
    const html = `
        <div class="input-group"><label>نام و نام خانوادگی *</label><input type="text" id="emp_name" value="${esc(e ? e.name : '')}"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>سمت / نقش</label><input type="text" id="emp_role" value="${esc(e ? e.role || '' : '')}" placeholder="مثلاً فروشنده"></div>
            <div class="input-group"><label>شماره تماس</label><input type="text" id="emp_phone" value="${esc(e ? e.phone || '' : '')}"></div>
        </div>
        <div class="input-group"><label>حقوق پایه ماهانه</label><input type="text" inputmode="numeric" id="emp_salary" value="${e ? num(e.baseSalary) : ''}" placeholder="0"></div>
        ${jalaliDateField('emp_hireDate', e ? e.hireDate : todayISO(), 'تاریخ ورود به مجموعه (استخدام)')}
        <div class="input-group"><label>یادداشت</label><textarea id="emp_note">${esc(e ? e.note || '' : '')}</textarea></div>
        <button class="calc-btn" onclick="saveEmployee('${id || ''}')">${e ? 'ذخیره تغییرات' : 'ثبت پرسنل'}</button>
        ${e ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteEmployee('${id}')">حذف پرسنل</button>` : ''}
    `;
    openModal(e ? 'ویرایش پرسنل' : 'پرسنل جدید', html);
}
window.openEmployeeEditor = openEmployeeEditor;
function saveEmployee(id) {
    const name = document.getElementById('emp_name').value.trim();
    if (!name) { showToast('نام پرسنل را وارد کنید', 'error'); return; }
    const list = dbRead(K.employees);
    const data = {
        name, role: document.getElementById('emp_role').value.trim(), phone: document.getElementById('emp_phone').value.trim(),
        baseSalary: num(document.getElementById('emp_salary').value), hireDate: getJalaliInputISO('emp_hireDate') || todayISO(), note: document.getElementById('emp_note').value.trim()
    };
    if (id) { const idx = list.findIndex(x => x.id === id); if (idx > -1) list[idx] = Object.assign(list[idx], data); }
    else list.push(Object.assign({ id: uid('emp') }, data));
    dbWrite(K.employees, list);
    autoBackupTick();
    closeModal(); showToast('اطلاعات پرسنل ذخیره شد', 'success'); switchView('payroll');
}
window.saveEmployee = saveEmployee;
function deleteEmployee(id) {
    if (!confirmAction('حذف این پرسنل؟ تاریخچه پرداخت‌های قبلی حذف نمی‌شود.')) return;
    dbWrite(K.employees, dbRead(K.employees).filter(x => x.id !== id));
    autoBackupTick();
    closeModal(); showToast('پرسنل حذف شد', 'success'); switchView('payroll');
}
window.deleteEmployee = deleteEmployee;

function openPayrollPayment(employeeId) {
    const emp = dbRead(K.employees).find(x => x.id === employeeId);
    if (!emp) return;
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">پرداخت به: <strong>${esc(emp.name)}</strong></p>
        <div class="input-group"><label>مبلغ *</label><input type="text" inputmode="numeric" id="pp_amount" placeholder="0" value="${emp.baseSalary ? num(emp.baseSalary) : ''}"></div>
        ${jalaliDateField('pp_date', todayISO(), 'تاریخ پرداخت')}
        <div class="input-group"><label>روش پرداخت</label>
            <select id="pp_method" onchange="document.getElementById('pp_checkBox').style.display=(this.value==='check')?'block':'none';">
                <option value="cash">از صندوق نقدی</option>
                <option value="check">با چک</option>
            </select>
        </div>
        <div id="pp_checkBox" style="display:none;">${paymentDetailsHtml('pp', 'check', {})}</div>
        <div class="input-group"><label>بابت / یادداشت</label><input type="text" id="pp_note" placeholder="مثلاً: حقوق مرداد ماه"></div>
        <button class="calc-btn" onclick="savePayrollPayment('${employeeId}')">ثبت پرداخت</button>
    `;
    openModal('پرداخت حقوق', html);
}
window.openPayrollPayment = openPayrollPayment;
function savePayrollPayment(employeeId) {
    const emp = dbRead(K.employees).find(x => x.id === employeeId);
    const amount = num(document.getElementById('pp_amount').value);
    if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
    const method = document.getElementById('pp_method').value;
    const date = getJalaliInputISO('pp_date') || todayISO();
    const note = document.getElementById('pp_note').value.trim() || 'حقوق پرسنل';
    let checkId = null;

    if (method === 'cash') {
        const tx = dbRead(K.cashtx);
        tx.push({ id: uid('tx'), date, type: 'out', amount, desc: `پرداخت حقوق: ${emp ? emp.name : ''} (${note})` });
        dbWrite(K.cashtx, tx);
    } else {
        const pd = paymentDetailsCollect('pp', 'check');
        const checks = dbRead(K.checks);
        if (pd.source === 'existing' && pd.existingCheckId) {
            const idx = checks.findIndex(c => c.id === pd.existingCheckId);
            if (idx > -1) { checks[idx].endorsedTo = emp ? emp.name : ''; checks[idx].endorsedDate = todayISO(); checks[idx].note = (checks[idx].note ? checks[idx].note + ' — ' : '') + `واگذار شده بابت حقوق: ${note}`; checkId = checks[idx].id; }
            dbWrite(K.checks, checks);
        } else {
            checkId = uid('chk');
            checks.push({
                id: checkId, who: emp ? emp.name : '', direction: 'pay', amount,
                number: pd.checkNumber, bank: pd.bank, accountNo: pd.accountNo, sayadNo: pd.sayadNo,
                dueDate: pd.dueDate || date, status: 'pending', note: 'پرداخت حقوق: ' + note
            });
            dbWrite(K.checks, checks);
        }
    }

    const payroll = dbRead(K.payroll);
    payroll.push({ id: uid('pay'), employeeId, date, amount, method, checkId, note });
    dbWrite(K.payroll, payroll);
    autoBackupTick();
    closeModal();
    showToast('پرداخت حقوق ثبت شد', 'success');
    switchView('payroll');
}
window.savePayrollPayment = savePayrollPayment;

function printPayrollList() {
    const employees = dbRead(K.employees);
    const payments = dbRead(K.payroll).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const rows = payments.map(p => { const emp = employees.find(e => e.id === p.employeeId); return `<tr><td class="text-cell">${esc(emp ? emp.name : '-')}</td><td>${fmtDate(p.date)}</td><td>${p.method === 'cash' ? 'نقدی' : 'چک'}</td><td>${moneyPlain(p.amount)}</td><td class="text-cell">${esc(p.note || '')}</td></tr>`; }).join('');
    const html = `${billTemplateOpenTag()}${billHeaderHtml('گزارش حقوق پرسنل')}
        <table class="bill-table"><thead><tr><th>نام</th><th>تاریخ</th><th>روش</th><th>مبلغ</th><th>یادداشت</th></tr></thead><tbody>${rows || '<tr><td colspan="5">-</td></tr>'}</tbody></table>
    </div>${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ — حقوق پرسنل', html);
}
window.printPayrollList = printPayrollList;

function openExpenseEditor(id) {
    const e = id ? dbRead(K.expenses).find(x => x.id === id) : null;
    const employees = dbRead(K.employees);
    const showEmp = e ? (e.category === 'حقوق پرسنل' || e.category === 'بیمه پرسنل') : false;
    const html = `
        <div class="input-group"><label>عنوان هزینه *</label><input type="text" id="ef_title" value="${esc(e ? e.title : '')}" placeholder="مثلاً: قبض برق مغازه"></div>
        <div class="input-group"><label>دسته‌بندی / موضوع</label>
            <select id="ef_category" onchange="efOnCategoryChange()">
                ${getExpenseCategories().map(c => `<option value="${esc(c)}" ${e && e.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                <option value="__new__">+ موضوع جدید…</option>
            </select>
        </div>
        <div class="input-group" id="ef_newCatWrap" style="display:none;"><label>عنوان موضوع جدید</label><input type="text" id="ef_newCat" placeholder="مثلاً: هزینه بسته‌بندی"></div>
        <div class="input-group" id="ef_empWrap" style="display:${showEmp ? 'block' : 'none'};">
            <label>پرسنل مربوطه</label>
            <select id="ef_employee">
                <option value="">— انتخاب نشده —</option>
                ${employees.map(emp => `<option value="${emp.id}" ${e && e.employeeId === emp.id ? 'selected' : ''}>${esc(emp.name)}</option>`).join('')}
            </select>
            ${!employees.length ? `<p class="txt-caption">هنوز پرسنلی ثبت نشده؛ از منوی «حقوق پرسنل» اضافه کنید.</p>` : ''}
        </div>
        <div class="input-group" id="ef_insTypeWrap" style="display:${(e && e.category === 'بیمه پرسنل') ? 'block' : 'none'};">
            <label>نوع بیمه</label>
            <select id="ef_insType">
                <option value="تأمین اجتماعی" ${e && e.insuranceType === 'تأمین اجتماعی' ? 'selected' : ''}>تأمین اجتماعی</option>
                <option value="بیمه تکمیلی" ${e && e.insuranceType === 'بیمه تکمیلی' ? 'selected' : ''}>بیمه تکمیلی</option>
                <option value="بیمه عمر" ${e && e.insuranceType === 'بیمه عمر' ? 'selected' : ''}>بیمه عمر</option>
                <option value="سایر" ${e && e.insuranceType === 'سایر' ? 'selected' : ''}>سایر</option>
            </select>
        </div>
        ${jalaliDateField('ef_date', e ? e.date : todayISO(), 'تاریخ')}
        <div class="input-group"><label>مبلغ *</label><input type="text" inputmode="numeric" id="ef_amount" value="${e ? num(e.amount) : ''}" placeholder="0"></div>
        <div class="input-group"><label>یادداشت</label><textarea id="ef_note">${esc(e ? e.note : '')}</textarea></div>
        <button class="calc-btn" onclick="saveExpense('${id || ''}')">${e ? 'ذخیره تغییرات' : 'ثبت هزینه'}</button>
        ${e ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteExpense('${id}')">حذف هزینه</button>` : ''}
    `;
    openModal(e ? 'ویرایش هزینه' : 'هزینه جدید', html);
}
window.openExpenseEditor = openExpenseEditor;
function efOnCategoryChange() {
    const val = document.getElementById('ef_category').value;
    document.getElementById('ef_newCatWrap').style.display = (val === '__new__') ? 'block' : 'none';
    document.getElementById('ef_empWrap').style.display = (val === 'حقوق پرسنل' || val === 'بیمه پرسنل') ? 'block' : 'none';
    document.getElementById('ef_insTypeWrap').style.display = (val === 'بیمه پرسنل') ? 'block' : 'none';
}
window.efOnCategoryChange = efOnCategoryChange;

function saveExpense(id) {
    const title = document.getElementById('ef_title').value.trim();
    const amount = num(document.getElementById('ef_amount').value);
    if (!title || !amount) { showToast('عنوان و مبلغ را کامل وارد کنید', 'error'); return; }
    let category = document.getElementById('ef_category').value;
    if (category === '__new__') {
        category = document.getElementById('ef_newCat').value.trim();
        if (!category) { showToast('عنوان موضوع جدید را وارد کنید', 'error'); return; }
        addExpenseCategory(category);
    }
    const employeeId = (category === 'حقوق پرسنل' || category === 'بیمه پرسنل') ? (document.getElementById('ef_employee').value || null) : null;
    const insuranceType = (category === 'بیمه پرسنل') ? document.getElementById('ef_insType').value : null;
    const list = dbRead(K.expenses);
    const date = getJalaliInputISO('ef_date') || todayISO();
    const data = { title, category, amount, date, employeeId, insuranceType, note: document.getElementById('ef_note').value.trim() };
    if (id) { const idx = list.findIndex(x => x.id === id); if (idx > -1) list[idx] = Object.assign(list[idx], data); }
    else list.push(Object.assign({ id: uid('exp'), date: todayISO() }, data));
    dbWrite(K.expenses, list);
    autoBackupTick();
    closeModal();
    showToast('هزینه ذخیره شد', 'success');
    switchView('expenses');
}
window.saveExpense = saveExpense;
function deleteExpense(id) {
    if (!confirmAction('حذف این هزینه؟')) return;
    dbWrite(K.expenses, dbRead(K.expenses).filter(x => x.id !== id));
    autoBackupTick();
    closeModal(); showToast('هزینه حذف شد', 'success'); switchView('expenses');
}
window.deleteExpense = deleteExpense;

/* ---------------------------------------------------------------------------
   Treasury (Cash & Bank ledger)
   ------------------------------------------------------------------------- */
function treasuryLedger() {
    const invoices = dbRead(K.invoices).filter(i => num(i.paidAmount) > 0).map(i => ({ date: i.date, type: 'in', amount: i.paidAmount, desc: `دریافت فاکتور فروش #${i.number} (${i.customerNameSnapshot || 'مشتری نقدی'})` }));
    const purchases = dbRead(K.purchases).filter(p => num(p.paidAmount) > 0).map(p => ({ date: p.date, type: 'out', amount: p.paidAmount, desc: `پرداخت خرید #${p.number} (${p.supplier})` }));
    // NOTE: expense line-items are intentionally NOT mixed into this feed anymore — per request,
    // هزینه‌ها only appear in their own "هزینه‌ها" page/report, not inside صندوق و بانک.
    const manual = dbRead(K.cashtx).map(t => ({ date: t.date, type: t.type, amount: t.amount, desc: t.desc, manualId: t.id }));
    return [...invoices, ...purchases, ...manual].sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* ---------------------------------------------------------------------------
   Cloud sync — Google sign-in (Firebase Authentication) + Firestore.
   One document per user (backups/{uid}) holds the entire app-state JSON,
   the same shape used by the local backup export/import above.
   ------------------------------------------------------------------------- */
const firebaseConfig = {
    apiKey: "AIzaSyAumvXdT_RUB8QipBkyFPW8JNQHiGG_ScM",
    authDomain: "hesabdari-plus-3e851.firebaseapp.com",
    projectId: "hesabdari-plus-3e851",
    storageBucket: "hesabdari-plus-3e851.firebasestorage.app",
    messagingSenderId: "628322433832",
    appId: "1:628322433832:web:0cc23e30381d72f91c6e1d",
    measurementId: "G-8SX1KVXR5R"
};
let fbAuth = null, fbDb = null, fbUser = null, _cloudSyncTimer = null;
let _stlDirection = 'in';
function initFirebase() {
    try {
        if (typeof firebase === 'undefined') { setCloudStatus('signedout'); return; } // CDN blocked/offline — app still fully works locally
        firebase.initializeApp(firebaseConfig);
        fbAuth = firebase.auth();
        fbDb = firebase.firestore();
        fbAuth.onAuthStateChanged(onCloudAuthChange);
        window.addEventListener('online', () => { if (fbUser) setCloudStatus('synced'); });
        window.addEventListener('offline', () => { if (fbUser) setCloudStatus('error'); });
    } catch (e) { setCloudStatus('signedout'); }
}
function onCloudAuthChange(user) {
    const wasSignedOut = !fbUser;
    fbUser = user;
    refreshCloudStatusChip();
    if (currentView === 'settings' || currentView === 'backup') rerenderIfActive(currentView);
    if (user && wasSignedOut) autoReconcileCloud();
}
let _driveAccessToken = null;
function signInWithGoogle() {
    if (!fbAuth) { showToast('اتصال به گوگل برقرار نشد؛ اتصال اینترنت را بررسی کنید', 'error'); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive.file'); // only for the optional "backup to Google Drive" button — لازم برای آپلود فایل پشتیبان
    setCloudStatus('syncing');
    fbAuth.signInWithPopup(provider).then((result) => {
        const cred = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
        if (cred && cred.accessToken) _driveAccessToken = cred.accessToken;
    }).catch((e) => { setCloudStatus('error'); showToast('ورود ناموفق بود: ' + (e.message || ''), 'error'); });
}
window.signInWithGoogle = signInWithGoogle;
async function ensureDriveAccessToken() {
    if (_driveAccessToken) return _driveAccessToken;
    // The Drive-scoped access token only lives in memory for this tab session (Firebase doesn't
    // persist raw Google OAuth tokens across reloads) — if we've lost it, silently re-prompt once.
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    const result = await fbAuth.signInWithPopup(provider);
    const cred = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
    _driveAccessToken = cred && cred.accessToken;
    return _driveAccessToken;
}
async function backupToGoogleDrive() {
    if (!fbUser) { showToast('ابتدا با گوگل وارد شوید', 'error'); return; }
    showToast('در حال آماده‌سازی و آپلود فایل...', 'success');
    try {
        const token = await ensureDriveAccessToken();
        if (!token) { showToast('اجازه دسترسی به گوگل‌درایو داده نشد', 'error'); return; }
        const data = collectFullExportData();
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `پشتیبان-حسابداری-${stamp}.json`;
        const metadata = { name: filename, mimeType: 'application/json' };
        const boundary = 'apboundary' + Date.now();
        const body =
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
        if (!res.ok) throw new Error('Drive upload failed: ' + res.status);
        showToast('فایل پشتیبان با موفقیت در گوگل‌درایو شما آپلود شد', 'success');
    } catch (e) {
        showToast('آپلود به گوگل‌درایو ناموفق بود؛ دوباره تلاش کنید', 'error');
    }
}
window.backupToGoogleDrive = backupToGoogleDrive;
function signOutCloud() {
    if (fbAuth) fbAuth.signOut();
    showToast('از حساب گوگل خارج شدید (اطلاعات همین دستگاه دست‌نخورده باقی ماند)', 'success');
}
window.signOutCloud = signOutCloud;
function collectFullExportData() {
    const data = {};
    Object.entries(K).forEach(([name, key]) => { data[name] = JSON.parse(localStorage.getItem(key) || 'null'); });
    data.exportedAt = todayISO();
    data.app = 'حسابداری پلاس';
    return data;
}
function applyImportedData(data) {
    Object.entries(K).forEach(([name, key]) => { if (data[name] !== undefined) localStorage.setItem(key, JSON.stringify(data[name])); });
}
function cloudDocRef() { return fbDb.collection('backups').doc(fbUser.uid); }
function pullFromCloudConfirmed() {
    cloudDocRef().get().then((snap) => {
        if (!snap.exists) return;
        try {
            const data = JSON.parse((snap.data() || {}).data || '{}');
            applyImportedData(data);
            const cloudUpdated = (snap.data() || {}).updatedAt;
            localStorage.setItem('ap_local_last_modified', cloudUpdated || todayISO());
            localStorage.setItem('ap_last_cloud_sync', todayISO());
            closeModal();
            showToast('اطلاعات از حساب گوگل دریافت شد', 'success');
            setTimeout(() => location.reload(), 700);
        } catch (e) { showToast('خطا در دریافت اطلاعات ابری', 'error'); }
    });
}
window.pullFromCloudConfirmed = pullFromCloudConfirmed;
function pushToCloudConfirmed() {
    pushToCloud().then(() => { closeModal(); showToast('این نسخه با موفقیت روی حساب گوگل ذخیره شد', 'success'); });
}
window.pushToCloudConfirmed = pushToCloudConfirmed;

function pushToCloud() {
    if (!fbUser || !fbDb) return Promise.resolve();
    setCloudStatus('syncing');
    const data = collectFullExportData();
    const nowIso = todayISO();
    return cloudDocRef().set({ data: JSON.stringify(data), updatedAt: nowIso, email: fbUser.email })
        .then(() => { localStorage.setItem('ap_last_cloud_sync', nowIso); setCloudStatus('synced'); })
        .catch(() => { setCloudStatus('error'); });
}
/* No-questions-asked reconciliation on sign-in: whichever copy (local device vs cloud) was
   modified more recently automatically wins — no prompt, exactly as requested. A brand-new
   device (no local data yet) will always have an older/blank local timestamp, so it correctly
   pulls the cloud copy right away with zero clicks. */
function autoReconcileCloud() {
    // Defense-in-depth against any reconciliation loop: only auto-reconcile once per browser
    // tab session. sessionStorage survives a location.reload() (only cleared when the tab/window
    // actually closes), so even if something else goes wrong this guarantees we never get stuck
    // repeatedly pulling + reloading.
    if (sessionStorage.getItem('ap_reconciled_this_session')) { setCloudStatus('synced'); return; }
    sessionStorage.setItem('ap_reconciled_this_session', '1');
    setCloudStatus('syncing');

    // If the person just manually restored a backup file on this device (see importBackup()),
    // don't silently auto-pick — ask which copy to keep, since they made a deliberate choice.
    if (localStorage.getItem('ap_manual_restore_pending_reconcile')) {
        cloudDocRef().get().then((snap) => {
            localStorage.removeItem('ap_manual_restore_pending_reconcile');
            if (!snap.exists) { pushToCloud(); return; }
            const cloudUpdated = (snap.data() || {}).updatedAt;
            const html = `
                <p class="txt-body" style="color:var(--text-secondary); line-height:1.9; margin-bottom:14px;">
                    شما اخیراً یک فایل پشتیبان را دستی روی این دستگاه بازیابی کردید، و هم‌زمان یک نسخه دیگر هم روی حساب گوگل شما ذخیره شده (آخرین به‌روزرسانی: ${cloudUpdated ? fmtDateTime(cloudUpdated) : '-'}). کدام نسخه را نگه می‌دارید؟
                </p>
                <div class="action-grid">
                    <button class="btn-action" onclick="pullFromCloudConfirmed()">⬇ نسخه گوگل‌درایو<br><span class="txt-caption">اطلاعات این دستگاه (فایل بازیابی‌شده) با نسخه ابری جایگزین می‌شود</span></button>
                    <button class="calc-btn" onclick="pushToCloudConfirmed()">⬆ همین فایل بازیابی‌شده<br><span class="txt-caption">نسخه ابری با همین فایلی که الان بازیابی کردید جایگزین می‌شود</span></button>
                </div>`;
            openModal('کدام نسخه پشتیبان معتبر است؟', html);
            setCloudStatus('synced');
        }).catch(() => setCloudStatus('error'));
        return;
    }

    cloudDocRef().get().then((snap) => {
        if (!snap.exists) { pushToCloud(); return; }
        const cloudUpdated = (snap.data() || {}).updatedAt;
        const localUpdated = localStorage.getItem('ap_local_last_modified') || '1970-01-01T00:00:00.000Z';
        if (cloudUpdated && new Date(cloudUpdated) > new Date(localUpdated)) {
            try {
                const data = JSON.parse((snap.data() || {}).data || '{}');
                applyImportedData(data);
                // Root-cause fix: this write must also bump ap_local_last_modified, otherwise it
                // stays at its old (stale) value and every reload after this would see the cloud
                // copy as "still newer" and pull-and-reload again — an infinite loop (this was the
                // exact freeze/hang seen in the bug report).
                const stamp = (cloudUpdated && new Date(cloudUpdated) > new Date()) ? cloudUpdated : todayISO();
                localStorage.setItem('ap_local_last_modified', stamp);
                localStorage.setItem('ap_last_cloud_sync', todayISO());
                showToast('اطلاعات از حساب گوگل شما دریافت شد', 'success');
                setCloudStatus('synced');
                setTimeout(() => location.reload(), 700);
            } catch (e) { setCloudStatus('error'); }
        } else {
            pushToCloud();
        }
    }).catch(() => setCloudStatus('error'));
}
function cloudSyncTick() {
    try { localStorage.setItem('ap_local_last_modified', todayISO()); } catch (e) {}
    if (!fbUser) return;
    setCloudStatus('syncing');
    clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(() => { pushToCloud(); }, 1500);
}
function manualCloudSync() {
    if (!fbUser) { showToast('ابتدا با گوگل وارد شوید', 'error'); return; }
    pushToCloud().then(() => showToast('همگام‌سازی انجام شد', 'success'));
}
window.manualCloudSync = manualCloudSync;

/* Cloud status chip in the top nav — always visible: shows sign-in button when signed out,
   or the user's photo + a colored dot (green = synced, purple blinking = syncing, red = offline/error). */
function setCloudStatus(status) {
    const chip = document.getElementById('cloudStatusChip');
    if (!chip) return;
    chip.setAttribute('data-status', status);
    const label = document.getElementById('cloudStatusLabel');
    if (label) label.textContent = status === 'signedout' ? 'ورود با گوگل' : status === 'syncing' ? 'در حال همگام‌سازی…' : status === 'error' ? 'قطع ارتباط' : 'همگام‌سازی‌شده';
}
function refreshCloudStatusChip() {
    const avatar = document.getElementById('cloudUserAvatar');
    const label = document.getElementById('cloudStatusLabel');
    if (!avatar || !label) return;
    if (fbUser) {
        if (fbUser.photoURL) { avatar.src = fbUser.photoURL; avatar.style.display = 'block'; } else { avatar.style.display = 'none'; }
        setCloudStatus(navigator.onLine === false ? 'error' : 'synced');
    } else {
        avatar.style.display = 'none';
        setCloudStatus('signedout');
    }
}
function onCloudChipClick() {
    if (!fbUser) { signInWithGoogle(); return; }
    switchView('settings');
}
window.onCloudChipClick = onCloudChipClick;
window.manualCloudSync = manualCloudSync;

/* ---------------------------------------------------------------------------
   Simple / Pro mode — lets a small home/shop user hide advanced features
   (partnership & profit-sharing today; the supply-chain module later) so the
   menu doesn't feel overwhelming. Switching modes only changes what's shown;
   no data is ever deleted.
   ------------------------------------------------------------------------- */
const PRO_ONLY_VIEWS = ['partners'];
function isProMode() { return (getSettings().appMode || 'pro') !== 'simple'; }
function applyAppModeVisibility() {
    const pro = isProMode();
    PRO_ONLY_VIEWS.forEach(v => {
        document.querySelectorAll(`.bn-item[data-view="${v}"]`).forEach(el => { el.style.display = pro ? '' : 'none'; });
    });
    if (!pro && PRO_ONLY_VIEWS.includes(currentView)) switchView('home');
}
function setAppMode(mode) {
    saveSettings({ appMode: mode });
    applyAppModeVisibility();
    if (currentView === 'settings') rerenderIfActive('settings');
    showToast(mode === 'simple' ? 'حالت ساده فعال شد' : 'حالت حرفه‌ای فعال شد', 'success');
}
window.setAppMode = setAppMode;

const CASHBOX_TYPES = [['cash', 'صندوق نقدی مغازه'], ['pos', 'دستگاه کارت‌خوان'], ['bank', 'حساب بانکی'], ['check', 'چک']];
const CURRENCY_LIST = [['تومان', 'تومان (واحد اصلی صندوق)'], ['دلار', 'دلار آمریکا (USD)'], ['یورو', 'یورو (EUR)'], ['پوند', 'پوند انگلیس (GBP)'], ['درهم', 'درهم امارات (AED)'], ['دینار عراق', 'دینار عراق (IQD)'], ['لیر ترکیه', 'لیر ترکیه (TRY)'], ['یوان', 'یوان چین (CNY)'], ['روبل', 'روبل روسیه (RUB)'], ['__custom__', 'ارز دلخواه…']];
function renderTreasury() {
    const ledger = treasuryLedger();
    const balance = ledger.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
    const banks = dbRead(K.bankAccounts);
    const assets = dbRead(K.otherAssets);
    return `
    ${viewHeader('مالی', 'صندوق و بانک', 'گردش کامل وجوه نقد فروشگاه', `<button class="nav-btn" onclick="printLedgerList()" title="چاپ گردش صندوق"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="stat-grid" style="grid-template-columns:1fr;">
        <div class="stat-card"><div class="stat-val" style="color:${balance >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${money(balance)}</div><div class="stat-label">موجودی فعلی صندوق نقدی (${esc(currencyLabel())})</div></div>
    </div>
    <button class="calc-btn" style="width:100%; margin-bottom:14px;" onclick="openCashCapitalEntry()">💰 ثبت سرمایه اولیه / واریز (نقدی، ارز، طلا و نقره)</button>

    ${assets.length ? `<div class="section-box">
        <div class="section-title">دارایی‌های ارزی و طلا/نقره</div>
        <p class="txt-caption" style="margin-bottom:10px;">این موارد جدا از موجودی نقدی بالا نگه‌داری می‌شوند و در جمع صندوق ریالی محاسبه نمی‌شوند.</p>
        ${assets.map(a => `
        <div class="bank-account-card">
            <div><div class="bac-name">${esc(assetLabel(a))}</div><div class="bac-sub">${fmtDate(a.date)}${a.note ? ' · ' + esc(a.note) : ''}</div></div>
            <button class="btn-action" style="color:var(--accent-rose);" onclick="deleteOtherAsset('${a.id}')">حذف</button>
        </div>`).join('')}
    </div>` : ''}

    <div class="section-box">
        <div class="section-title">حساب‌های بانکی و دستگاه‌های کارت‌خوان</div>
        <p class="txt-caption" style="margin-bottom:10px;">این حساب‌ها هنگام ثبت پرداخت کارتی در فاکتور فروش/خرید برای انتخاب نمایش داده می‌شوند.</p>
        ${banks.length ? banks.map(b => `
        <div class="bank-account-card">
            <div><div class="bac-name">${esc(b.bankName)} — ${esc(b.title)}</div><div class="bac-sub">${esc(b.accountNo || '')}${b.cardNo ? ' · کارت: ' + esc(b.cardNo) : ''}</div></div>
            <div style="display:flex; gap:6px;">
                <button class="btn-action" onclick="openBankAccountEditor('${b.id}')">ویرایش</button>
                <button class="btn-action" style="color:var(--accent-rose);" onclick="deleteBankAccount('${b.id}')">حذف</button>
            </div>
        </div>`).join('') : `<div class="empty-state">هنوز حساب بانکی ثبت نشده است.</div>`}
        <button class="btn-action" style="width:100%; margin-top:6px;" onclick="openBankAccountEditor()">+ افزودن حساب بانکی</button>
    </div>

    <div class="search-bar">
        <div></div>
        <button class="fab-add" onclick="openCashTxEditor()" title="ثبت تراکنش دستی">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>
    ${ledger.length ? monthGroupedListHtml(ledger, t => t.date, t => `
        <div class="list-item">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(t.desc)}</div><div class="list-item-sub">${fmtDate(t.date)}</div></div>
                <div class="list-item-title" style="color:${t.type === 'in' ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${t.type === 'in' ? '+' : '−'}${moneyPlain(t.amount)}</div>
            </div>
        </div>`) : `<div class="empty-state">هنوز تراکنشی ثبت نشده است.</div>`}`;
}

function assetLabel(a) {
    if (a.type === 'currency') return `${num(a.amount).toLocaleString(localeForDigits())} ${esc(a.currency)}${a.rate ? ` (نرخ ثبت: ${moneyPlain(a.rate)})` : ''}`;
    if (a.type === 'gold') {
        if (a.goldType === 'coin') return `سکه ${esc(a.coinEra)} ${esc(a.coinSize)} — ${num(a.qty).toLocaleString(localeForDigits())} عدد (هر عدد ${moneyPlain(a.unitPrice)})`;
        if (a.goldType === 'melted') return `طلای آب‌شده — ${num(a.grams).toLocaleString(localeForDigits())} گرم (هر گرم ${moneyPlain(a.pricePerGram)})`;
        if (a.goldType === 'silver') return `نقره — ${num(a.grams).toLocaleString(localeForDigits())} گرم (هر گرم ${moneyPlain(a.pricePerGram)})`;
        return `${esc(a.customLabel || 'دارایی دلخواه')} — ${moneyPlain(a.customValue)}`;
    }
    return '-';
}

function openCashCapitalEntry() {
    const html = `
        <div class="input-group"><label>نوع دارایی</label>
            <select id="cap_type" onchange="capOnTypeChange()">
                <option value="currency">وجه نقد (تومان / ارز خارجی)</option>
                <option value="gold">طلا / سکه / نقره</option>
            </select>
        </div>
        <div id="cap_box"></div>
        ${jalaliDateField('cap_date', todayISO(), 'تاریخ')}
        <div class="input-group"><label>توضیحات</label><input type="text" id="cap_note" placeholder="مثلاً: سرمایه اولیه راه‌اندازی مغازه"></div>
        <button class="calc-btn" onclick="saveCashCapitalEntry()">ثبت</button>
    `;
    openModal('ثبت سرمایه / دارایی', html);
    setTimeout(capOnTypeChange, 20);
}
window.openCashCapitalEntry = openCashCapitalEntry;
function capOnTypeChange() {
    const type = document.getElementById('cap_type').value;
    const box = document.getElementById('cap_box');
    if (type === 'currency') {
        box.innerHTML = `
            <div class="input-group"><label>مبلغ *</label><input type="text" inputmode="numeric" id="cap_amount" placeholder="0"></div>
            <div class="input-group"><label>واحد پول</label>
                <select id="cap_currency" onchange="capOnCurrencyChange()">
                    ${CURRENCY_LIST.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
                </select>
            </div>
            <div class="input-group" id="cap_customCurWrap" style="display:none;"><label>نام ارز دلخواه</label><input type="text" id="cap_customCur" placeholder="مثلاً: درهم قطر"></div>
            <div id="cap_rateBox" style="display:none;">
                <div class="input-group"><label>نرخ برابری امروز (هر واحد چند تومان است؟)</label><input type="text" inputmode="numeric" id="cap_rate" placeholder="مثلاً 60000" oninput="capUpdateConvertedPreview()"></div>
                <div class="settings-row" style="padding-inline:0;">
                    <div class="settings-row-label">تبدیل به تومان و افزودن مستقیم به صندوق نقدی</div>
                    <label class="switch"><input type="checkbox" id="cap_convertToCash" onchange="capUpdateConvertedPreview()"><span class="switch-slider"></span></label>
                </div>
                <p class="txt-caption" id="cap_convertedPreview"></p>
            </div>
            <p class="txt-caption" id="cap_defaultNote">اگر واحد، تومان باشد مستقیماً به موجودی صندوق نقدی اضافه می‌شود؛ در غیر این صورت به‌عنوان دارایی ارزی جدا نگه‌داری می‌شود (مگر این‌که گزینه تبدیل خودکار بالا را فعال کنید).</p>
        `;
    } else {
        box.innerHTML = `
            <div class="input-group"><label>نوع</label>
                <select id="cap_goldType" onchange="capOnGoldTypeChange()">
                    <option value="coin">سکه</option>
                    <option value="melted">طلای آب‌شده / شمش</option>
                    <option value="silver">نقره</option>
                    <option value="custom">دلخواه</option>
                </select>
            </div>
            <div id="cap_goldBox"></div>
        `;
        setTimeout(capOnGoldTypeChange, 20);
    }
}
window.capOnTypeChange = capOnTypeChange;
function capOnCurrencyChange() {
    const val = document.getElementById('cap_currency').value;
    document.getElementById('cap_customCurWrap').style.display = (val === '__custom__') ? 'block' : 'none';
    document.getElementById('cap_rateBox').style.display = (val === 'تومان') ? 'none' : 'block';
    document.getElementById('cap_defaultNote').style.display = (val === 'تومان') ? 'block' : 'none';
    capUpdateConvertedPreview();
}
window.capOnCurrencyChange = capOnCurrencyChange;
function capUpdateConvertedPreview() {
    const preview = document.getElementById('cap_convertedPreview');
    if (!preview) return;
    const amount = num(document.getElementById('cap_amount').value);
    const rate = num(document.getElementById('cap_rate').value);
    const converted = amount * rate;
    const convertOn = document.getElementById('cap_convertToCash').checked;
    preview.textContent = converted ? `معادل تومانی: ${moneyPlain(converted)}${convertOn ? ' — این مبلغ مستقیماً به صندوق نقدی اضافه می‌شود' : ' — به‌عنوان دارایی ارزی جدا نگه‌داری می‌شود'}` : '';
}
window.capUpdateConvertedPreview = capUpdateConvertedPreview;
function capOnGoldTypeChange() {
    const type = document.getElementById('cap_goldType').value;
    const box = document.getElementById('cap_goldBox');
    if (type === 'coin') {
        box.innerHTML = `
            <div class="mini-form-grid">
                <div class="input-group"><label>قدیم / جدید</label>
                    <select id="cap_coinEra"><option value="جدید">جدید</option><option value="قدیم">قدیم</option></select>
                </div>
                <div class="input-group"><label>اندازه سکه</label>
                    <select id="cap_coinSize"><option value="تمام">تمام</option><option value="نیم">نیم</option><option value="ربع">ربع</option><option value="گرمی">گرمی</option></select>
                </div>
            </div>
            <div class="mini-form-grid">
                <div class="input-group"><label>تعداد</label><input type="text" inputmode="numeric" id="cap_qty" value="1"></div>
                <div class="input-group"><label>قیمت هر عدد</label><input type="text" inputmode="numeric" id="cap_unitPrice" placeholder="0"></div>
            </div>
        `;
    } else if (type === 'melted' || type === 'silver') {
        box.innerHTML = `
            <div class="mini-form-grid">
                <div class="input-group"><label>وزن (گرم)</label><input type="text" inputmode="numeric" id="cap_grams" placeholder="0"></div>
                <div class="input-group"><label>قیمت هر گرم</label><input type="text" inputmode="numeric" id="cap_pricePerGram" placeholder="0"></div>
            </div>
        `;
    } else {
        box.innerHTML = `
            <div class="input-group"><label>عنوان دارایی</label><input type="text" id="cap_customLabel" placeholder="مثلاً: جواهرات خانوادگی"></div>
            <div class="input-group"><label>ارزش تخمینی</label><input type="text" inputmode="numeric" id="cap_customValue" placeholder="0"></div>
        `;
    }
}
window.capOnGoldTypeChange = capOnGoldTypeChange;
function saveCashCapitalEntry() {
    const type = document.getElementById('cap_type').value;
    const date = getJalaliInputISO('cap_date') || todayISO();
    const note = document.getElementById('cap_note').value.trim();
    if (type === 'currency') {
        const amount = num(document.getElementById('cap_amount').value);
        if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
        let currency = document.getElementById('cap_currency').value;
        if (currency === '__custom__') currency = document.getElementById('cap_customCur').value.trim() || 'ارز دلخواه';
        if (currency === 'تومان') {
            const tx = dbRead(K.cashtx);
            tx.push({ id: uid('tx'), date, type: 'in', amount, desc: 'سرمایه/واریز نقدی' + (note ? ': ' + note : '') });
            dbWrite(K.cashtx, tx);
        } else {
            const rate = num((document.getElementById('cap_rate') || {}).value);
            const convertToCash = !!(document.getElementById('cap_convertToCash') || {}).checked;
            if (convertToCash && rate) {
                const converted = Math.round(amount * rate);
                const tx = dbRead(K.cashtx);
                tx.push({ id: uid('tx'), date, type: 'in', amount: converted, desc: `تبدیل ${num(amount).toLocaleString(localeForDigits())} ${esc(currency)} به نرخ ${num(rate).toLocaleString(localeForDigits())} تومان و افزودن به صندوق` + (note ? ': ' + note : '') });
                dbWrite(K.cashtx, tx);
            } else {
                const assets = dbRead(K.otherAssets);
                assets.push({ id: uid('ast'), type: 'currency', currency, amount, rate: rate || null, date, note });
                dbWrite(K.otherAssets, assets);
            }
        }
    } else {
        const goldType = document.getElementById('cap_goldType').value;
        const assets = dbRead(K.otherAssets);
        const entry = { id: uid('ast'), type: 'gold', goldType, date, note };
        if (goldType === 'coin') {
            entry.coinEra = document.getElementById('cap_coinEra').value;
            entry.coinSize = document.getElementById('cap_coinSize').value;
            entry.qty = num(document.getElementById('cap_qty').value) || 1;
            entry.unitPrice = num(document.getElementById('cap_unitPrice').value);
        } else if (goldType === 'melted' || goldType === 'silver') {
            entry.grams = num(document.getElementById('cap_grams').value);
            entry.pricePerGram = num(document.getElementById('cap_pricePerGram').value);
        } else {
            entry.customLabel = document.getElementById('cap_customLabel').value.trim();
            entry.customValue = num(document.getElementById('cap_customValue').value);
        }
        assets.push(entry);
        dbWrite(K.otherAssets, assets);
    }
    autoBackupTick();
    closeModal();
    showToast('ثبت شد', 'success');
    switchView('treasury');
}
window.saveCashCapitalEntry = saveCashCapitalEntry;
function deleteOtherAsset(id) {
    if (!confirmAction('حذف این مورد؟')) return;
    dbWrite(K.otherAssets, dbRead(K.otherAssets).filter(x => x.id !== id));
    autoBackupTick();
    switchView('treasury');
}
window.deleteOtherAsset = deleteOtherAsset;

function openBankAccountEditor(id) {
    const b = id ? dbRead(K.bankAccounts).find(x => x.id === id) : null;
    const html = `
        <div class="input-group"><label>نام بانک *</label><input type="text" id="ba_bank" value="${esc(b ? b.bankName : '')}" placeholder="مثلاً: ملت"></div>
        <div class="input-group"><label>عنوان حساب / صاحب حساب *</label><input type="text" id="ba_title" value="${esc(b ? b.title : '')}" placeholder="مثلاً: حساب اصلی فروشگاه"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>شماره حساب</label><input type="text" id="ba_accno" value="${esc(b ? b.accountNo || '' : '')}"></div>
            <div class="input-group"><label>شماره کارت</label><input type="text" inputmode="numeric" id="ba_cardno" value="${esc(b ? b.cardNo || '' : '')}"></div>
        </div>
        <div class="input-group"><label>شماره شبا</label><input type="text" id="ba_iban" value="${esc(b ? b.iban || '' : '')}" placeholder="IR..."></div>
        <button class="calc-btn" onclick="saveBankAccount('${id || ''}')">${b ? 'ذخیره تغییرات' : 'ثبت حساب'}</button>
        ${b ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteBankAccount('${id}')">حذف حساب</button>` : ''}
    `;
    openModal(b ? 'ویرایش حساب بانکی' : 'حساب بانکی جدید', html);
}
window.openBankAccountEditor = openBankAccountEditor;
function saveBankAccount(id) {
    const bankName = document.getElementById('ba_bank').value.trim();
    const title = document.getElementById('ba_title').value.trim();
    if (!bankName || !title) { showToast('نام بانک و عنوان حساب الزامی است', 'error'); return; }
    const list = dbRead(K.bankAccounts);
    const data = { bankName, title, accountNo: document.getElementById('ba_accno').value.trim(), cardNo: document.getElementById('ba_cardno').value.trim(), iban: document.getElementById('ba_iban').value.trim() };
    if (id) { const idx = list.findIndex(x => x.id === id); if (idx > -1) list[idx] = Object.assign(list[idx], data); }
    else list.push(Object.assign({ id: uid('bank') }, data));
    dbWrite(K.bankAccounts, list);
    autoBackupTick();
    closeModal(); showToast('حساب بانکی ذخیره شد', 'success'); switchView('treasury');
}
window.saveBankAccount = saveBankAccount;
function deleteBankAccount(id) {
    if (!confirmAction('حذف این حساب بانکی؟')) return;
    dbWrite(K.bankAccounts, dbRead(K.bankAccounts).filter(x => x.id !== id));
    autoBackupTick();
    closeModal(); showToast('حساب حذف شد', 'success'); switchView('treasury');
}
window.deleteBankAccount = deleteBankAccount;

function printLedgerList() {
    const ledger = treasuryLedger();
    const balance = ledger.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
    const rows = ledger.map(t => `<tr><td>${fmtDate(t.date)}</td><td class="text-cell">${esc(t.desc)}</td><td>${t.type === 'in' ? 'واریز' : 'برداشت'}</td><td>${moneyPlain(t.amount)}</td></tr>`).join('');
    const html = `
    ${billTemplateOpenTag()}
        ${billHeaderHtml('گردش صندوق و بانک')}
        <table class="bill-table"><thead><tr><th>تاریخ</th><th>شرح</th><th>نوع</th><th>مبلغ</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="bill-totals"><div class="totals-row grand"><span>موجودی فعلی صندوق</span><span>${moneyPlain(balance)} ${esc(currencyLabel())}</span></div></div>
    </div>
    ${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ — گردش صندوق', html);
}
window.printLedgerList = printLedgerList;

/* ---------------------------------------------------------------------------
   Checks (چک) tracking with due-date reminders
   ------------------------------------------------------------------------- */
function renderChecks() {
    const all = dbRead(K.checks).slice().sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const soon = all.filter(c => c.status === 'pending' && (new Date(c.dueDate) - new Date()) / 86400000 <= 5);
    return `
    ${viewHeader('مالی', 'چک‌ها', `${all.length.toLocaleString(localeForDigits())} چک ثبت‌شده`, `<button class="nav-btn" onclick="printChecksList()" title="چاپ لیست چک‌ها"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    ${soon.length ? `<div class="section-box" style="border-color:var(--accent-rose);">
        <div class="section-title" style="color:var(--accent-rose);">⏰ یادآوری: ${soon.length.toLocaleString(localeForDigits())} چک نزدیک به سررسید</div>
        ${soon.map(c => `<div class="txt-caption">${esc(c.who)} — ${moneyPlain(c.amount)} — سررسید ${fmtDate(c.dueDate)}</div>`).join('')}
    </div>` : ''}
    <div class="search-bar">
        <div></div>
        <button class="fab-add" onclick="openCheckEditor()" title="ثبت چک جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>
    ${all.length ? all.map(c => `
        <div class="list-item" style="cursor:pointer;" onclick="openCheckEditor('${c.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(c.who)}</div><div class="list-item-sub">سررسید: ${fmtDate(c.dueDate)} · ${c.direction === 'receive' ? 'دریافتی' : 'پرداختی'}${c.bank ? ' · بانک ' + esc(c.bank) : ''}${c.number ? ' · چک ' + esc(c.number) : ''}${c.endorsedTo ? ' · واگذار به ' + esc(c.endorsedTo) : ''}</div></div>
                <div style="text-align:left;"><div class="list-item-title">${moneyPlain(c.amount)}${num(c.interestPercent) ? ` <span class="txt-caption">(+سود ${moneyPlain(c.interestAmount)})</span>` : ''}</div>
                    ${c.status === 'pending' ? '<span class="badge badge-amber">در انتظار وصول</span>' : c.status === 'cashed' ? '<span class="badge badge-emerald">وصول‌شده</span>' : '<span class="badge badge-rose">برگشتی</span>'}
                </div>
            </div>
        </div>`).join('') : `<div class="empty-state">چکی ثبت نشده است.</div>`}`;
}
VIEW_RENDERERS.checks = renderChecks;

function openCheckEditor(id) {
    const c = id ? dbRead(K.checks).find(x => x.id === id) : null;
    const html = `
        <div class="input-group"><label>طرف حساب *</label><input type="text" id="ck_who" value="${esc(c ? c.who : '')}" placeholder="نام مشتری یا تأمین‌کننده"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>نوع چک</label><select id="ck_dir"><option value="receive" ${c && c.direction === 'receive' ? 'selected' : ''}>دریافتی</option><option value="pay" ${c && c.direction === 'pay' ? 'selected' : ''}>پرداختی</option></select></div>
            <div class="input-group"><label>مبلغ *</label><input type="text" inputmode="numeric" id="ck_amount" value="${c ? num(c.amount) : ''}" placeholder="0"></div>
        </div>
        <div class="input-group"><label>شماره چک</label><input type="text" id="ck_number" value="${esc(c ? c.number : '')}" placeholder="اختیاری"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>بانک</label><input type="text" id="ck_bank" value="${esc(c ? c.bank || '' : '')}" placeholder="مثلاً ملت"></div>
            <div class="input-group"><label>شماره حساب</label><input type="text" id="ck_accno" value="${esc(c ? c.accountNo || '' : '')}" placeholder="اختیاری"></div>
        </div>
        <div class="input-group"><label>شماره صیادی (۱۶ رقمی)</label><input type="text" inputmode="numeric" id="ck_sayad" value="${esc(c ? c.sayadNo || '' : '')}" placeholder="اختیاری"></div>
        ${jalaliDateField('ck_due', c ? c.dueDate : '', 'تاریخ سررسید', true)}
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">این چک بابت نسیه است و سود ماهانه دارد</div>
            <label class="switch"><input type="checkbox" id="ck_hasInterest" ${c && num(c.interestPercent) ? 'checked' : ''} onchange="ckToggleInterestBox()"><span class="switch-slider"></span></label>
        </div>
        <div class="pm-detail-box" id="ck_interestBox" style="display:${c && num(c.interestPercent) ? 'block' : 'none'};">
            <div class="input-group"><label>سود نسیه (٪ در ماه)</label><input type="text" inputmode="numeric" id="ck_interestPercent" value="${esc(num(c ? c.interestPercent : 0) || 0)}" oninput="ckRecalcInterest()"></div>
            <div class="input-group"><label>گرد کردن مدت</label>
                <select id="ck_roundMode" onchange="ckRecalcInterest()">
                    <option value="none" ${(!c || !c.roundMode || c.roundMode === 'none') ? 'selected' : ''}>بدون گرد کردن (دقیق به روز)</option>
                    <option value="up" ${c && c.roundMode === 'up' ? 'selected' : ''}>گرد به بالا</option>
                    <option value="down" ${c && c.roundMode === 'down' ? 'selected' : ''}>گرد به پایین</option>
                </select>
            </div>
            <div class="settings-row" style="padding-inline:0;">
                <div class="settings-row-label">سود مرکب</div>
                <label class="switch"><input type="checkbox" id="ck_compound" ${c && c.compound ? 'checked' : ''} onchange="ckRecalcInterest()"><span class="switch-slider"></span></label>
            </div>
            <p class="txt-caption" id="ck_interestInfo"></p>
        </div>
        <div class="input-group"><label>وضعیت</label>
            <select id="ck_status">
                <option value="pending" ${!c || c.status === 'pending' ? 'selected' : ''}>در انتظار وصول</option>
                <option value="cashed" ${c && c.status === 'cashed' ? 'selected' : ''}>وصول‌شده</option>
                <option value="bounced" ${c && c.status === 'bounced' ? 'selected' : ''}>برگشتی</option>
            </select>
        </div>
        <div class="input-group"><label>توضیحات</label><textarea id="ck_note" placeholder="اختیاری">${esc(c ? c.note || '' : '')}</textarea></div>
        <button class="calc-btn" onclick="saveCheck('${id || ''}')">${c ? 'ذخیره تغییرات' : 'ثبت چک'}</button>
        ${c ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteCheck('${id}')">حذف چک</button>` : ''}
    `;
    openModal(c ? 'ویرایش چک' : 'ثبت چک جدید', html);
    setTimeout(ckRecalcInterest, 20);
}
window.openCheckEditor = openCheckEditor;
function ckToggleInterestBox() {
    document.getElementById('ck_interestBox').style.display = document.getElementById('ck_hasInterest').checked ? 'block' : 'none';
    ckRecalcInterest();
}
window.ckToggleInterestBox = ckToggleInterestBox;
function ckRecalcInterest() {
    const info = document.getElementById('ck_interestInfo');
    if (!info || !document.getElementById('ck_hasInterest').checked) return;
    const pd = {
        dueDate: getJalaliInputISO('ck_due'),
        monthlyPercent: num(document.getElementById('ck_interestPercent').value),
        roundMode: document.getElementById('ck_roundMode').value,
        compound: document.getElementById('ck_compound').checked
    };
    const base = num(document.getElementById('ck_amount').value);
    const interest = creditInterestAmount(base, pd);
    info.textContent = creditInterestBreakdownText(pd) + (interest ? ` مبلغ سود: ${moneyPlain(interest)} (جمع با اصل مبلغ: ${moneyPlain(base + interest)})` : '');
}
window.ckRecalcInterest = ckRecalcInterest;

function saveCheck(id) {
    const who = document.getElementById('ck_who').value.trim();
    const amount = num(document.getElementById('ck_amount').value);
    const dueDate = getJalaliInputISO('ck_due');
    if (!who || !amount || !dueDate) { showToast('طرف حساب، مبلغ و تاریخ سررسید الزامی است', 'error'); return; }
    const hasInterest = document.getElementById('ck_hasInterest').checked;
    const interestPercent = hasInterest ? num(document.getElementById('ck_interestPercent').value) : 0;
    const roundMode = hasInterest ? document.getElementById('ck_roundMode').value : 'none';
    const compound = hasInterest ? document.getElementById('ck_compound').checked : false;
    const interestAmount = hasInterest ? creditInterestAmount(amount, { dueDate, monthlyPercent: interestPercent, roundMode, compound }) : 0;
    const list = dbRead(K.checks);
    const data = {
        who, direction: document.getElementById('ck_dir').value, amount,
        number: document.getElementById('ck_number').value.trim(),
        bank: document.getElementById('ck_bank').value.trim(),
        accountNo: document.getElementById('ck_accno').value.trim(),
        sayadNo: document.getElementById('ck_sayad').value.trim(),
        note: document.getElementById('ck_note').value.trim(),
        interestPercent, roundMode, compound, interestAmount,
        dueDate, status: document.getElementById('ck_status').value
    };
    if (id) { const idx = list.findIndex(x => x.id === id); if (idx > -1) list[idx] = Object.assign(list[idx], data); }
    else list.push(Object.assign({ id: uid('chk') }, data));
    dbWrite(K.checks, list);
    autoBackupTick();
    closeModal();
    showToast('چک ذخیره شد', 'success');
    switchView('checks');
}
window.saveCheck = saveCheck;
function deleteCheck(id) {
    if (!confirmAction('حذف این چک؟')) return;
    dbWrite(K.checks, dbRead(K.checks).filter(x => x.id !== id));
    autoBackupTick();
    closeModal(); showToast('چک حذف شد', 'success'); switchView('checks');
}
window.deleteCheck = deleteCheck;

function printChecksList() {
    const whos = Array.from(new Set(dbRead(K.checks).map(c => c.who).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fa'));
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">وضعیت‌ها و جهت چک‌هایی که می‌خواهید چاپ شوند را انتخاب کنید.</p>
        <div class="input-group"><label>طرف حساب خاص (اختیاری)</label>
            <select id="pcl_who"><option value="">همه</option>${whos.map(w => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}</select>
        </div>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">در انتظار وصول</div><label class="switch"><input type="checkbox" id="pcl_pending" checked><span class="switch-slider"></span></label></div>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">وصول‌شده</div><label class="switch"><input type="checkbox" id="pcl_cashed" checked><span class="switch-slider"></span></label></div>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">برگشتی</div><label class="switch"><input type="checkbox" id="pcl_bounced" checked><span class="switch-slider"></span></label></div>
        <div class="input-group" style="margin-top:10px;"><label>جهت چک</label>
            <select id="pcl_dir"><option value="all">همه (دریافتی و پرداختی)</option><option value="receive">فقط دریافتی</option><option value="pay">فقط پرداختی</option></select>
        </div>
        <div class="input-group"><label>مرتب‌سازی</label>
            <select id="pcl_sort"><option value="due">بر اساس نزدیک‌ترین سررسید</option><option value="amountDesc">بیشترین مبلغ تا کمترین</option><option value="amountAsc">کمترین مبلغ تا بیشترین</option></select>
        </div>
        <button class="calc-btn" style="width:100%; margin-top:10px;" onclick="printChecksListFinal()">🖨 چاپ</button>
    `;
    openModal('انتخاب چک‌ها برای چاپ', html);
}
window.printChecksList = printChecksList;
function printChecksListFinal() {
    const statuses = [];
    if (document.getElementById('pcl_pending').checked) statuses.push('pending');
    if (document.getElementById('pcl_cashed').checked) statuses.push('cashed');
    if (document.getElementById('pcl_bounced').checked) statuses.push('bounced');
    const dir = document.getElementById('pcl_dir').value;
    const sort = document.getElementById('pcl_sort').value;
    const who = document.getElementById('pcl_who').value;
    let all = dbRead(K.checks).filter(c => statuses.includes(c.status) && (dir === 'all' || c.direction === dir) && (!who || c.who === who));
    if (sort === 'due') all.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    else if (sort === 'amountDesc') all.sort((a, b) => num(b.amount) - num(a.amount));
    else all.sort((a, b) => num(a.amount) - num(b.amount));
    const total = all.reduce((s, c) => s + num(c.amount), 0);
    const rows = all.map(c => `<tr><td class="text-cell">${esc(c.who)}</td><td>${c.direction === 'receive' ? 'دریافتی' : 'پرداختی'}</td><td>${moneyPlain(c.amount)}</td><td>${fmtDate(c.dueDate)}</td><td>${c.status === 'pending' ? 'در انتظار' : c.status === 'cashed' ? 'وصول‌شده' : 'برگشتی'}</td></tr>`).join('');
    const html = `${billTemplateOpenTag()}${billHeaderHtml('لیست چک‌ها')}
        <table class="bill-table"><thead><tr><th>طرف حساب</th><th>نوع</th><th>مبلغ</th><th>سررسید</th><th>وضعیت</th></tr></thead><tbody>${rows || '<tr><td colspan="5">موردی یافت نشد</td></tr>'}</tbody></table>
        <div class="totals-row grand" style="margin-top:10px;"><span>جمع کل</span><span>${moneyPlain(total)}</span></div>
        </div>${printFooterButton()}`;
    closeModal();
    openModal('پیش‌نمایش چاپ — لیست چک‌ها', html);
}
window.printChecksListFinal = printChecksListFinal;
VIEW_RENDERERS.treasury = renderTreasury;

function openCashTxEditor() {
    const html = `
        <div class="input-group"><label>نوع تراکنش</label>
            <select id="tf_type"><option value="in">واریز به صندوق</option><option value="out">برداشت از صندوق</option></select>
        </div>
        <div class="input-group"><label>مبلغ *</label><input type="text" inputmode="numeric" id="tf_amount" placeholder="0"></div>
        <div class="input-group"><label>شرح</label><input type="text" id="tf_desc" placeholder="مثلاً: واریز سرمایه، برداشت شخصی و..."></div>
        <button class="calc-btn" onclick="saveCashTx()">ثبت تراکنش</button>
    `;
    openModal('تراکنش دستی صندوق', html);
}
window.openCashTxEditor = openCashTxEditor;
function saveCashTx() {
    const amount = num(document.getElementById('tf_amount').value);
    if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
    const list = dbRead(K.cashtx);
    list.push({ id: uid('tx'), date: todayISO(), type: document.getElementById('tf_type').value, amount, desc: document.getElementById('tf_desc').value.trim() || 'تراکنش دستی' });
    dbWrite(K.cashtx, list);
    autoBackupTick();
    closeModal(); showToast('تراکنش ثبت شد', 'success'); switchView('treasury');
}
window.saveCashTx = saveCashTx;

/* ---------------------------------------------------------------------------
   Reports
   ------------------------------------------------------------------------- */
function calcInflationProfit() {
    const s = getSettings();
    const todayRate = num(document.getElementById('fx_todayRate').value);
    if (!todayRate) { showToast('نرخ امروز ارز را وارد کنید', 'error'); return; }
    const ledger = treasuryLedger();
    const cashBalance = ledger.reduce((sum, t) => sum + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
    const assets = dbRead(K.otherAssets);
    const goldValue = assets.filter(a => a.type === 'gold').reduce((sum, a) => {
        if (a.goldType === 'coin') return sum + num(a.qty) * num(a.unitPrice);
        if (a.goldType === 'melted' || a.goldType === 'silver') return sum + num(a.grams) * num(a.pricePerGram);
        return sum + num(a.customValue);
    }, 0);
    // other foreign-currency assets that match the base currency are valued at today's rate; others are listed but not converted (no live rate available for them here)
    const sameCurrencyAssetsToman = assets.filter(a => a.type === 'currency' && a.currency === s.capitalBaseCurrency).reduce((sum, a) => sum + num(a.amount) * todayRate, 0);
    const otherCurrencyAssets = assets.filter(a => a.type === 'currency' && a.currency !== s.capitalBaseCurrency);

    const totalNetWorthToman = cashBalance + goldValue + sameCurrencyAssetsToman;
    const initialCapitalToman = num(s.capitalBaseAmount) * num(s.capitalBaseRate);
    const profitLossToman = totalNetWorthToman - initialCapitalToman;

    const netWorthInBaseCurrencyToday = totalNetWorthToman / todayRate;
    const profitLossInBaseCurrency = netWorthInBaseCurrencyToday - num(s.capitalBaseAmount);

    const tomanIsProfit = profitLossToman >= 0;
    const currencyIsProfit = profitLossInBaseCurrency >= 0;
    const conflict = tomanIsProfit !== currencyIsProfit;

    document.getElementById('fx_result').innerHTML = `
        <div class="report-detail-grid">
            <div class="report-detail-card ${tomanIsProfit ? 'good' : 'bad'}">
                <div class="rdc-label">سود/زیان به تومان</div>
                <div class="rdc-val">${tomanIsProfit ? '+' : ''}${moneyPlain(profitLossToman)}</div>
            </div>
            <div class="report-detail-card ${currencyIsProfit ? 'good' : 'bad'}">
                <div class="rdc-label">سود/زیان واقعی (به ${esc(s.capitalBaseCurrency)})</div>
                <div class="rdc-val">${currencyIsProfit ? '+' : ''}${num(Math.round(profitLossInBaseCurrency)).toLocaleString(localeForDigits())} ${esc(s.capitalBaseCurrency)}</div>
            </div>
        </div>
        ${conflict ? `<p class="txt-body" style="color:var(--accent-amber); margin-top:10px; line-height:1.9;">⚠️ توجه: با این‌که به تومان در ${tomanIsProfit ? 'سود' : 'زیان'} هستید، اما با احتساب تغییر نرخ ارز (تورم/افت ارزش پول ملی)، سرمایه شما به ${esc(s.capitalBaseCurrency)} در واقع در ${currencyIsProfit ? 'سود' : 'زیان'} است.</p>` : ''}
        ${otherCurrencyAssets.length ? `<p class="txt-caption" style="margin-top:10px;">توجه: ${otherCurrencyAssets.length.toLocaleString(localeForDigits())} دارایی ارزی با واحد دیگر (غیر از ${esc(s.capitalBaseCurrency)}) در این محاسبه لحاظ نشده؛ چون نرخ روز آن‌ها وارد نشده است.</p>` : ''}
    `;
}
window.calcInflationProfit = calcInflationProfit;

let reportsFromDate = '', reportsToDate = '';
function reportsApplyDateRange() {
    reportsFromDate = getJalaliInputISO('rp_from') || '';
    reportsToDate = getJalaliInputISO('rp_to') || '';
    rerenderIfActive('reports');
}
window.reportsApplyDateRange = reportsApplyDateRange;
function reportsClearDateRange() {
    reportsFromDate = ''; reportsToDate = '';
    rerenderIfActive('reports');
}
window.reportsClearDateRange = reportsClearDateRange;
function renderReports() {
    const inRange = (d) => (!reportsFromDate || new Date(d) >= new Date(reportsFromDate)) && (!reportsToDate || new Date(d) <= new Date(reportsToDate));
    const invoices = dbRead(K.invoices).filter(i => inRange(i.date));
    const purchases = dbRead(K.purchases).filter(p => inRange(p.date));
    const expenses = dbRead(K.expenses).filter(e => inRange(e.date));
    const products = dbRead(K.products);
    const settings = getSettings();
    const invoiceCogs = (inv) => inv.items.reduce((s2, it) => { const p = products.find(x => x.id === it.productId); return s2 + (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty); }, 0);

    const totalSales = invoices.reduce((s, i) => s + num(i.total), 0);
    const totalCOGS = invoices.reduce((s, i) => s + invoiceCogs(i), 0);
    const totalExpenses = expenses.reduce((s, e) => s + num(e.amount), 0);
    const totalPayroll = dbRead(K.payroll).filter(p => inRange(p.date)).reduce((s, p) => s + num(p.amount), 0);
    const stocktakeImpact = stocktakeProfitImpact(reportsFromDate || null, reportsToDate ? new Date(new Date(reportsToDate).getTime() + 86400000).toISOString() : null);
    const grossProfit = totalSales - totalCOGS;
    const netProfit = grossProfit - totalExpenses - totalPayroll + stocktakeImpact;
    const avgSale = invoices.length ? totalSales / invoices.length : 0;

    // Monthly sales (last 6 months)
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setMonth(d.getMonth() - i);
        const label = d.toLocaleDateString('fa-IR', { month: 'long' });
        const monthTotal = invoices.filter(inv => { const id = new Date(inv.date); return id.getFullYear() === d.getFullYear() && id.getMonth() === d.getMonth(); }).reduce((s, inv) => s + num(inv.total), 0);
        months.push({ label, total: monthTotal });
    }
    const maxMonth = Math.max(1, ...months.map(m => m.total));

    // Per-customer profit + payment-behavior stats
    const custStats = {};
    invoices.forEach(inv => {
        const key = inv.customerNameSnapshot || 'مشتری نقدی';
        if (!custStats[key]) custStats[key] = { sales: 0, cost: 0, profit: 0, count: 0, overdueDays: 0, unpaid: 0 };
        const cost = invoiceCogs(inv);
        const remain = Math.max(0, num(inv.total) - num(inv.paidAmount));
        custStats[key].sales += num(inv.total); custStats[key].cost += cost; custStats[key].profit += num(inv.total) - cost; custStats[key].count += 1;
        if (remain > 0) { custStats[key].overdueDays += Math.max(0, Math.round((new Date() - new Date(inv.date)) / 86400000)); custStats[key].unpaid += remain; }
    });
    const custArr = Object.entries(custStats).map(([name, s]) => Object.assign({ name }, s));
    const bestCustomer = custArr.slice().sort((a, b) => b.profit - a.profit)[0];
    const worstCustomer = custArr.filter(c => c.count).slice().sort((a, b) => a.profit - b.profit)[0];
    const worstPayer = custArr.filter(c => c.unpaid > 0).sort((a, b) => b.overdueDays - a.overdueDays)[0];

    // Per-product profit stats
    const prodStats = {};
    invoices.forEach(inv => inv.items.forEach(it => {
        const key = it.name; const p = products.find(x => x.id === it.productId);
        const cost = (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty);
        if (!prodStats[key]) prodStats[key] = { sales: 0, cost: 0, profit: 0, qty: 0 };
        prodStats[key].sales += num(it.qty) * num(it.price); prodStats[key].cost += cost; prodStats[key].profit += num(it.qty) * num(it.price) - cost; prodStats[key].qty += num(it.qty);
    }));
    const prodArr = Object.entries(prodStats).map(([name, s]) => Object.assign({ name }, s));
    const bestProduct = prodArr.slice().sort((a, b) => b.profit - a.profit)[0];
    const worstProduct = prodArr.filter(p => p.qty > 0).slice().sort((a, b) => a.profit - b.profit)[0];

    const topProducts = prodArr.slice().sort((a, b) => b.sales - a.sales).slice(0, 6).map(p => [p.name, p.sales]);
    const topCustomers = custArr.slice().sort((a, b) => b.sales - a.sales).slice(0, 6).map(c => [c.name, c.sales]);

    return `
    ${viewHeader('مالی', 'گزارش‌ها', 'تحلیل فروش، سود و عملکرد فروشگاه')}

    <div class="section-box">
        <div class="section-title">بازه زمانی گزارش</div>
        <div class="mini-form-grid">
            ${jalaliDateField('rp_from', reportsFromDate, 'از تاریخ')}
            ${jalaliDateField('rp_to', reportsToDate, 'تا تاریخ')}
        </div>
        <div class="action-grid">
            <button class="btn-action" onclick="reportsApplyDateRange()">اعمال بازه</button>
            <button class="btn-action" onclick="reportsClearDateRange()">پاک کردن (همه‌ی زمان‌ها)</button>
        </div>
        ${(reportsFromDate || reportsToDate) ? `<p class="txt-caption" style="margin-top:8px;">در حال نمایش: ${reportsFromDate ? 'از ' + fmtDate(reportsFromDate) : 'از ابتدا'} ${reportsToDate ? 'تا ' + fmtDate(reportsToDate) : 'تا امروز'}</p>` : ''}
    </div>

    <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${money(totalSales)}</div><div class="stat-label">جمع کل فروش</div></div>
        <div class="stat-card"><div class="stat-val" style="color:var(--accent-rose)">${money(totalExpenses + totalPayroll)}</div><div class="stat-label">جمع هزینه‌ها + حقوق</div></div>
        <div class="stat-card"><div class="stat-val" style="color:var(--accent-cyan)">${money(grossProfit)}</div><div class="stat-label">سود ناخالص</div></div>
        <div class="stat-card"><div class="stat-val" style="color:${netProfit >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${money(netProfit)}</div><div class="stat-label">سود خالص تخمینی</div></div>
    </div>

    <div class="section-box">
        <div class="section-title">روند فروش ۶ ماه اخیر</div>
        ${months.map(m => `
        <div class="bar-chart-row">
            <span class="bar-chart-label">${esc(m.label)}</span>
            <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.max(3, Math.round(m.total / maxMonth * 100))}%"></div></div>
            <span class="bar-chart-val">${moneyPlain(m.total)}</span>
        </div>`).join('')}
    </div>

    <div class="section-box">
        <div class="section-title">سود و زیان تفصیلی</div>
        <div class="report-detail-grid">
            <div class="report-detail-card good"><div class="rdc-label">بیشترین سود از مشتری</div><div class="rdc-name">${bestCustomer ? esc(bestCustomer.name) : '-'}</div><div class="rdc-val">${bestCustomer ? money(bestCustomer.profit) : '-'}</div></div>
            <div class="report-detail-card bad"><div class="rdc-label">کمترین سود / بدترین مشتری</div><div class="rdc-name">${worstCustomer ? esc(worstCustomer.name) : '-'}</div><div class="rdc-val">${worstCustomer ? money(worstCustomer.profit) : '-'}</div></div>
            <div class="report-detail-card bad"><div class="rdc-label">بدحساب‌ترین مشتری (بیشترین تأخیر)</div><div class="rdc-name">${worstPayer ? esc(worstPayer.name) : '-'}</div><div class="rdc-val">${worstPayer ? worstPayer.overdueDays.toLocaleString(localeForDigits()) + ' روز میانگین تأخیر' : '-'}</div></div>
            <div class="report-detail-card good"><div class="rdc-label">پرسودترین کالا</div><div class="rdc-name">${bestProduct ? esc(bestProduct.name) : '-'}</div><div class="rdc-val">${bestProduct ? money(bestProduct.profit) : '-'}</div></div>
            <div class="report-detail-card bad"><div class="rdc-label">کم‌سودترین کالا</div><div class="rdc-name">${worstProduct ? esc(worstProduct.name) : '-'}</div><div class="rdc-val">${worstProduct ? money(worstProduct.profit) : '-'}</div></div>
            <div class="report-detail-card"><div class="rdc-label">میانگین مبلغ هر فاکتور</div><div class="rdc-name">&nbsp;</div><div class="rdc-val">${money(Math.round(avgSale))}</div></div>
        </div>
        <table class="report-table" style="margin-top:14px;"><thead><tr><th>مشتری</th><th>تعداد فاکتور</th><th>جمع فروش</th><th>سود</th><th>مانده بدهی</th></tr></thead>
        <tbody>${custArr.sort((a, b) => b.sales - a.sales).map(c => `<tr><td>${esc(c.name)}</td><td>${c.count.toLocaleString(localeForDigits())}</td><td>${moneyPlain(c.sales)}</td><td style="color:${c.profit >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${moneyPlain(c.profit)}</td><td>${moneyPlain(c.unpaid)}</td></tr>`).join('') || '<tr><td colspan="5">داده‌ای موجود نیست</td></tr>'}</tbody></table>
    </div>

    <div class="section-box">
        <div class="section-title">پرفروش‌ترین کالاها</div>
        ${topProducts.length ? `<table class="report-table"><thead><tr><th>کالا</th><th>مبلغ فروش</th></tr></thead><tbody>
            ${topProducts.map(([name, amt]) => `<tr><td>${esc(name)}</td><td>${moneyPlain(amt)}</td></tr>`).join('')}
        </tbody></table>` : `<div class="empty-state">داده‌ای موجود نیست.</div>`}
    </div>

    <div class="section-box">
        <div class="section-title">مشتریان برتر</div>
        ${topCustomers.length ? `<table class="report-table"><thead><tr><th>مشتری</th><th>مبلغ خرید</th></tr></thead><tbody>
            ${topCustomers.map(([name, amt]) => `<tr><td>${esc(name)}</td><td>${moneyPlain(amt)}</td></tr>`).join('')}
        </tbody></table>` : `<div class="empty-state">داده‌ای موجود نیست.</div>`}
    </div>

    <div class="section-box">
        <div class="section-title">خلاصه خرید از تأمین‌کنندگان</div>
        <div class="totals-row"><span>جمع کل خرید</span><span>${moneyPlain(purchases.reduce((s, p) => s + num(p.total), 0))}</span></div>
        <div class="totals-row"><span>بدهی باقی‌مانده به تأمین‌کنندگان</span><span>${moneyPlain(purchases.reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0))}</span></div>
    </div>

    <div class="section-box">
        <div class="section-title">📦 اثر انبارگردانی بر سود و زیان</div>
        ${dbRead(K.stocktakes).length ? `
        <div class="totals-row grand"><span>مجموع اثر همه انبارگردانی‌ها</span><span style="color:${stocktakeProfitImpact() >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${moneyPlain(stocktakeProfitImpact())}</span></div>
        ${dbRead(K.stocktakes).slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5).map(t => {
            const impact = (t.diffs || []).reduce((s, d) => s + num(d.valueImpact), 0);
            return `<div class="list-item"><div class="list-item-row">
                <div><div class="list-item-title">انبارگردانی ${fmtDate(t.date)}</div><div class="list-item-sub">${(t.diffs || []).length.toLocaleString(localeForDigits())} کالا اصلاح شد</div></div>
                <div class="list-item-title" style="color:${impact >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${impact >= 0 ? '+' : ''}${moneyPlain(impact)}</div>
            </div></div>`;
        }).join('')}
        ` : `<div class="empty-state">هنوز انبارگردانی‌ای ثبت نشده است.</div>`}
    </div>

    <div class="section-box">
        <div class="section-title">💱 سود و زیان ارزی (تعدیل‌شده با تورم)</div>
        ${settings.capitalBaseCurrency && settings.capitalBaseAmount && settings.capitalBaseRate ? `
        <p class="txt-caption" style="margin-bottom:10px;">سرمایه پایه شما: ${num(settings.capitalBaseAmount).toLocaleString(localeForDigits())} ${esc(settings.capitalBaseCurrency)} (به نرخ ${moneyPlain(settings.capitalBaseRate)} در روز سرمایه‌گذاری)</p>
        <div class="input-group"><label>نرخ امروز این ارز (تومان)</label><input type="text" inputmode="numeric" id="fx_todayRate" placeholder="مثلاً 95000"></div>
        <button class="btn-action" style="width:100%;" onclick="calcInflationProfit()">محاسبه سود/زیان واقعی</button>
        <div id="fx_result" style="margin-top:12px;"></div>
        ` : `<p class="txt-body" style="color:var(--text-secondary);">برای استفاده از این بخش، ابتدا از «تنظیمات ← سرمایه پایه» ارز، مبلغ و نرخ روز سرمایه‌گذاری را ثبت کنید.</p>
        <button class="btn-action" style="width:100%;" onclick="switchView('settings')">رفتن به تنظیمات</button>`}
    </div>

    <div class="section-box">
        <div class="section-title">🤝 شرکا و سهم سود</div>
        <p class="txt-caption" style="margin-bottom:10px;">اگر فروشگاه با چند نفر شریک اداره می‌شود، سهم هرکس را از منوی «شرکا» مدیریت کنید.</p>
        <button class="btn-action" style="width:100%;" onclick="switchView('partners')">مدیریت شرکا و سهم سود</button>
    </div>

    <div class="action-grid">
        <button class="btn-action" onclick="exportReportCsv()">⬇ خروجی CSV</button>
        <button class="btn-action" onclick="openReportPrintOptions()">🖨 چاپ گزارش (انتخابی)</button>
    </div>
    `;
}
VIEW_RENDERERS.reports = renderReports;

const REPORT_PRINT_SECTIONS = [
    ['summary', 'خلاصه کلی (فروش/هزینه/سود)'], ['trend', 'روند فروش ماهانه'], ['detail', 'سود و زیان تفصیلی (مشتری/کالا)'],
    ['topProducts', 'پرفروش‌ترین کالاها'], ['topCustomers', 'مشتریان برتر'], ['suppliers', 'خلاصه خرید از تأمین‌کنندگان']
];
function openReportPrintOptions() {
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">بخش‌هایی که می‌خواهید در چاپ گزارش نمایش داده شود را انتخاب کنید.</p>
        ${REPORT_PRINT_SECTIONS.map(([id, label]) => `
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">${esc(label)}</div>
            <label class="switch"><input type="checkbox" id="rps_${id}" checked><span class="switch-slider"></span></label>
        </div>`).join('')}
        <button class="calc-btn" style="width:100%; margin-top:12px;" onclick="printReportSummary()">🖨 چاپ گزارش انتخاب‌شده</button>
    `;
    openModal('انتخاب بخش‌های گزارش برای چاپ', html);
}
window.openReportPrintOptions = openReportPrintOptions;

function printReportSummary() {
    const invoices = dbRead(K.invoices), expenses = dbRead(K.expenses), products = dbRead(K.products), purchases = dbRead(K.purchases);
    const sec = (id) => { const el = document.getElementById('rps_' + id); return !el || el.checked; }; // if the options modal wasn't used, include everything
    const invoiceCogs = (inv) => inv.items.reduce((s2, it) => { const p = products.find(x => x.id === it.productId); return s2 + (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty); }, 0);
    const totalSales = invoices.reduce((s, i) => s + num(i.total), 0);
    const totalExpenses = expenses.reduce((s, e) => s + num(e.amount), 0);
    const totalCOGS = invoices.reduce((s, i) => s + invoiceCogs(i), 0);
    const netProfit = totalSales - totalCOGS - totalExpenses;

    let body = '';
    if (sec('summary')) {
        body += `<div class="bill-totals">
            <div class="totals-row"><span>جمع کل فروش</span><span>${moneyPlain(totalSales)}</span></div>
            <div class="totals-row"><span>جمع کل هزینه‌ها</span><span>${moneyPlain(totalExpenses)}</span></div>
            <div class="totals-row grand"><span>سود خالص تخمینی</span><span>${moneyPlain(netProfit)} ${esc(currencyLabel())}</span></div>
        </div>`;
    }
    if (sec('trend')) {
        const months = [];
        for (let i = 5; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); const label = d.toLocaleDateString('fa-IR', { month: 'long' }); const t = invoices.filter(inv => { const id = new Date(inv.date); return id.getFullYear() === d.getFullYear() && id.getMonth() === d.getMonth(); }).reduce((s, inv) => s + num(inv.total), 0); months.push([label, t]); }
        body += `<h4 style="margin-top:16px;">روند فروش ۶ ماه اخیر</h4><table class="bill-table"><thead><tr><th>ماه</th><th>مبلغ فروش</th></tr></thead><tbody>${months.map(([l, t]) => `<tr><td>${esc(l)}</td><td>${moneyPlain(t)}</td></tr>`).join('')}</tbody></table>`;
    }
    if (sec('detail')) {
        const custStats = {};
        invoices.forEach(inv => { const key = inv.customerNameSnapshot || 'مشتری نقدی'; if (!custStats[key]) custStats[key] = { sales: 0, profit: 0, count: 0 }; const cost = invoiceCogs(inv); custStats[key].sales += num(inv.total); custStats[key].profit += num(inv.total) - cost; custStats[key].count += 1; });
        const rows = Object.entries(custStats).sort((a, b) => b[1].sales - a[1].sales).map(([name, s]) => `<tr><td>${esc(name)}</td><td>${s.count.toLocaleString(localeForDigits())}</td><td>${moneyPlain(s.sales)}</td><td>${moneyPlain(s.profit)}</td></tr>`).join('');
        body += `<h4 style="margin-top:16px;">سود و زیان به تفکیک مشتری</h4><table class="bill-table"><thead><tr><th>مشتری</th><th>تعداد فاکتور</th><th>فروش</th><th>سود</th></tr></thead><tbody>${rows || '<tr><td colspan="4">-</td></tr>'}</tbody></table>`;
    }
    if (sec('topProducts')) {
        const productSales = {}; invoices.forEach(inv => inv.items.forEach(it => { productSales[it.name] = (productSales[it.name] || 0) + num(it.qty) * num(it.price); }));
        const rows = Object.entries(productSales).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, a]) => `<tr><td>${esc(n)}</td><td>${moneyPlain(a)}</td></tr>`).join('');
        body += `<h4 style="margin-top:16px;">پرفروش‌ترین کالاها</h4><table class="bill-table"><thead><tr><th>کالا</th><th>مبلغ فروش</th></tr></thead><tbody>${rows || '<tr><td colspan="2">-</td></tr>'}</tbody></table>`;
    }
    if (sec('topCustomers')) {
        const custSales = {}; invoices.forEach(inv => { const key = inv.customerNameSnapshot || 'مشتری نقدی'; custSales[key] = (custSales[key] || 0) + num(inv.total); });
        const rows = Object.entries(custSales).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, a]) => `<tr><td>${esc(n)}</td><td>${moneyPlain(a)}</td></tr>`).join('');
        body += `<h4 style="margin-top:16px;">مشتریان برتر</h4><table class="bill-table"><thead><tr><th>مشتری</th><th>مبلغ خرید</th></tr></thead><tbody>${rows || '<tr><td colspan="2">-</td></tr>'}</tbody></table>`;
    }
    if (sec('suppliers')) {
        body += `<h4 style="margin-top:16px;">خلاصه خرید از تأمین‌کنندگان</h4><div class="totals-row"><span>جمع کل خرید</span><span>${moneyPlain(purchases.reduce((s, p) => s + num(p.total), 0))}</span></div><div class="totals-row"><span>بدهی باقی‌مانده</span><span>${moneyPlain(purchases.reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0))}</span></div>`;
    }

    const html = `${billTemplateOpenTag()}${billHeaderHtml('گزارش خلاصه مالی')}
        ${body}
        <div class="txt-caption" style="margin-top:10px;">تاریخ چاپ: ${fmtDateTime(todayISO())}</div>
    </div>${printFooterButton()}`;
    closeModal();
    openModal('پیش‌نمایش چاپ — گزارش', html);
}
window.printReportSummary = printReportSummary;

/* ---------------------------------------------------------------------------
   Debts & receivables (بدهکاران و طلبکاران)
   ------------------------------------------------------------------------- */
let settlementCityFilter = '';
function renderSettlements() {
    const customers = dbRead(K.customers).map(c => ({ id: c.id, name: c.name, phone: c.phone, city: c.city || '', bal: customerBalance(c.id) })).filter(c => c.bal > 0).sort((a, b) => b.bal - a.bal);
    const suppliers = {};
    dbRead(K.purchases).forEach(p => { const r = Math.max(0, num(p.total) - num(p.paidAmount)); if (r > 0) suppliers[p.supplier] = (suppliers[p.supplier] || 0) + r; });
    const supplierList = Object.entries(suppliers).sort((a, b) => b[1] - a[1]);
    const totalReceivable = customers.reduce((s, c) => s + c.bal, 0);
    const totalPayable = supplierList.reduce((s, [, v]) => s + v, 0);
    const cities = Array.from(new Set(customers.map(c => c.city).filter(Boolean))).sort();
    const visibleCustomers = settlementCityFilter ? customers.filter(c => c.city === settlementCityFilter) : customers;

    return `
    ${viewHeader('مالی', 'بدهکاران و طلبکاران', 'خلاصه مطالبات از مشتریان و بدهی به تأمین‌کنندگان', `<button class="nav-btn" onclick="printSettlements()" title="چاپ"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="stat-grid">
        <div class="stat-card"><div class="stat-val" style="color:var(--accent-rose)">${money(totalReceivable)}</div><div class="stat-label">جمع مطالبات از مشتریان</div></div>
        <div class="stat-card"><div class="stat-val" style="color:var(--accent-amber)">${money(totalPayable)}</div><div class="stat-label">جمع بدهی به تأمین‌کنندگان</div></div>
    </div>
    <div class="section-title">مشتریان بدهکار</div>
    ${cities.length ? `<div class="chip-row">
        <span class="chip ${!settlementCityFilter ? 'active' : ''}" onclick="settlementCityFilter=''; rerenderIfActive('settlements')">همه شهرها</span>
        ${cities.map(c => `<span class="chip ${settlementCityFilter === c ? 'active' : ''}" onclick="settlementCityFilter='${esc(c).replace(/'/g, "\\'")}'; rerenderIfActive('settlements')">📍 ${esc(c)}</span>`).join('')}
    </div>` : ''}
    ${visibleCustomers.length ? visibleCustomers.map(c => `
        <div class="list-item">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(c.name)}</div><div class="list-item-sub">${esc(c.phone || '-')}${c.city ? ' · ' + esc(c.city) : ''}</div></div>
                <div class="list-item-title" style="color:var(--accent-rose);">${moneyPlain(c.bal)}</div>
            </div>
            <button class="btn-action" style="width:100%; margin-top:8px;" onclick="openSettleCustomer('${c.id}')">💰 ثبت دریافت / تسویه حساب</button>
        </div>`).join('') : `<div class="empty-state">مشتری بدهکاری وجود ندارد.</div>`}
    <div class="section-title" style="margin-top:16px;">بدهی به تأمین‌کنندگان</div>
    ${supplierList.length ? supplierList.map(([name, amt]) => `
        <div class="list-item">
            <div class="list-item-row"><div class="list-item-title">${esc(name)}</div><div class="list-item-title" style="color:var(--accent-amber);">${moneyPlain(amt)}</div></div>
            <button class="btn-action" style="width:100%; margin-top:8px;" onclick="openSettleSupplier('${esc(name).replace(/'/g, "\\'")}')">💸 ثبت پرداخت / تسویه حساب</button>
        </div>`).join('') : `<div class="empty-state">بدهی به تأمین‌کننده‌ای وجود ندارد.</div>`}
    `;
}
VIEW_RENDERERS.settlements = renderSettlements;

/* ---------------------------------------------------------------------------
   Partners (شرکا) — multiple people co-own the store with different capital
   contributions; each partner's profit share is proportional to their share
   of total capital.
   ------------------------------------------------------------------------- */
function computeStoreNetProfit(fromDate, toDate) {
    const invoices = dbRead(K.invoices), expenses = dbRead(K.expenses), products = dbRead(K.products);
    const inRange = (d) => (!fromDate || new Date(d) >= new Date(fromDate)) && (!toDate || new Date(d) < new Date(toDate));
    const invoiceCogs = (inv) => inv.items.reduce((s2, it) => { const p = products.find(x => x.id === it.productId); return s2 + (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty); }, 0);
    const invIn = invoices.filter(i => inRange(i.date));
    const expIn = expenses.filter(e => inRange(e.date));
    const payIn = dbRead(K.payroll).filter(p => inRange(p.date));
    const totalSales = invIn.reduce((s, i) => s + num(i.total), 0);
    const totalCOGS = invIn.reduce((s, i) => s + invoiceCogs(i), 0);
    const totalExpenses = expIn.reduce((s, e) => s + num(e.amount), 0);
    const totalPayroll = payIn.reduce((s, p) => s + num(p.amount), 0);
    const stocktakeImpact = stocktakeProfitImpact(fromDate, toDate);
    return totalSales - totalCOGS - totalExpenses - totalPayroll + stocktakeImpact;
}
function earliestActivityDate() {
    const dates = [];
    dbRead(K.invoices).forEach(i => dates.push(i.date));
    dbRead(K.purchases).forEach(p => dates.push(p.date));
    dbRead(K.expenses).forEach(e => dates.push(e.date));
    dbRead(K.cashtx).forEach(t => dates.push(t.date));
    if (!dates.length) { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString(); }
    return dates.sort((a, b) => new Date(a) - new Date(b))[0];
}
/* Per-transaction profit split: by default each invoice/expense/payroll entry is split among
   whichever partners had already joined by that record's date (so a partner only shares in
   activity from their own join date onward). Any individual record can also be explicitly
   marked "excludeFromPartnership" (e.g. old stock a new partner declined to share in) — in that
   case its full profit/cost goes to the owner alone instead of being split. */
function computePartnerShares() {
    const partners = dbRead(K.partners);
    const shares = {};
    partners.forEach(p => { shares[p.id] = 0; });
    if (!partners.length) return shares;
    const owner = partners.find(p => p.isOwner) || null;
    const s = getSettings();
    const mode = s.partnershipMode || 'auto';
    const products = dbRead(K.products);

    function activePartnersAt(date) { return partners.filter(p => new Date(p.joinDate) <= new Date(date)); }
    function distribute(amount, date, excluded) {
        if (!amount) return;
        if (excluded) { if (owner) shares[owner.id] += amount; return; }
        const active = activePartnersAt(date);
        if (!active.length) return;
        let weights;
        if (mode === 'manual') {
            const sum = active.reduce((s2, p) => s2 + num(p.percentManual), 0);
            weights = sum ? active.map(p => num(p.percentManual) / sum) : active.map(() => 1 / active.length);
        } else {
            const sum = active.reduce((s2, p) => s2 + num(p.capitalToman), 0);
            weights = sum ? active.map(p => num(p.capitalToman) / sum) : active.map(() => 1 / active.length);
        }
        active.forEach((p, idx) => { shares[p.id] += amount * weights[idx]; });
    }

    // Invoices are split per line-item (not per whole invoice), since a single invoice can mix
    // pre-partnership stock with post-partnership stock. For each item we automatically detect
    // which "side" it belongs to using the product's own stocking date (createdAt) — i.e. was
    // this item already in inventory before a given partner joined, or was it brought in after?
    // That auto-detected date (not the invoice date) is what era-matches it against each partner's
    // join date. The manual 🚫 toggle remains available only as an explicit override for the rare
    // exception that isn't captured by stocking date (fully excludes that item from every partner).
    dbRead(K.invoices).forEach(inv => {
        inv.items.forEach(it => {
            const p = products.find(x => x.id === it.productId);
            const cost = (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty);
            const itemProfit = num(it.qty) * num(it.price) - cost;
            const stockDate = (p && p.createdAt) ? p.createdAt : (p ? earliestActivityDate() : inv.date); // catalogued products with no recorded stocking date are treated conservatively as pre-existing stock; free-text items fall back to the invoice date
            distribute(itemProfit, stockDate, it.excludeFromPartnership);
        });
        // discount and any credit/check interest are invoice-level adjustments, applied using the
        // invoice's own date and its overall flag (true only when every item on it is excluded)
        const adjustment = num(inv.interestAmount) - num(inv.discountTotal);
        if (adjustment) distribute(adjustment, inv.date, inv.excludeFromPartnership);
    });
    dbRead(K.expenses).forEach(e => distribute(-num(e.amount), e.date, e.excludeFromPartnership));
    dbRead(K.payroll).forEach(p => distribute(-num(p.amount), p.date, p.excludeFromPartnership));
    dbRead(K.stocktakes).forEach(t => distribute((t.diffs || []).reduce((s, d) => s + num(d.valueImpact), 0), t.date, false));
    return shares;
}
function partnerPercentDisplay(p, partners) {
    const s = getSettings();
    const mode = s.partnershipMode || 'auto';
    if (mode === 'manual') return num(p.percentManual);
    const sum = partners.reduce((s2, x) => s2 + num(x.capitalToman), 0);
    return sum ? (num(p.capitalToman) / sum * 100) : 0;
}
function renderPartners() {
    const partners = dbRead(K.partners);
    const totalCapital = partners.reduce((s, p) => s + num(p.capitalToman), 0);
    const netProfit = computeStoreNetProfit();
    const shares = computePartnerShares();
    const s = getSettings();
    return `
    ${viewHeader('مالی', 'شرکا و سهم سود', `${partners.length.toLocaleString(localeForDigits())} شریک · جمع کل سرمایه: ${money(totalCapital)}`, `<button class="nav-btn" onclick="printPartnersList()" title="چاپ"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="stat-grid" style="grid-template-columns:1fr;">
        <div class="stat-card"><div class="stat-val" style="color:${netProfit >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${money(netProfit)}</div><div class="stat-label">سود خالص کل فروشگاه تا امروز</div></div>
    </div>
    <div class="input-group">
        <label>نحوه محاسبه درصد سهم</label>
        <select id="pt_mode" onchange="savePartnershipMode(this.value)">
            <option value="auto" ${(s.partnershipMode || 'auto') === 'auto' ? 'selected' : ''}>خودکار بر اساس مبلغ سرمایه هرکس</option>
            <option value="manual" ${s.partnershipMode === 'manual' ? 'selected' : ''}>دستی — خودم درصد هرکس را مشخص می‌کنم</option>
        </select>
    </div>
    <p class="txt-caption" style="margin-bottom:10px;">هر شریک فقط در سود/زیانی که از «تاریخ ورود» خودش به بعد ایجاد شده سهیم است. برای فاکتورهای فروش، این کار به‌طور <strong>خودکار در سطح هر قلم کالا</strong> انجام می‌شود: سیستم تاریخ ثبت هر کالا در انبار را با تاریخ عضویت هر شریک مقایسه می‌کند — پس یک فاکتور می‌تواند هم‌زمان شامل کالای قدیمی (قبل از شراکت) و کالای جدید (بعد از شراکت) باشد و سود هرکدام جدا حساب شود، بدون نیاز به کار دستی. اگر مورد خاصی باشد که این تشخیص خودکار برایش صدق نکند، از دکمه کنار همان ردیف کالا در فرم فاکتور می‌توانید آن را به‌طور کامل و دستی از شراکت مستثنا کنید.</p>
    <p class="txt-caption" style="margin-bottom:10px; color:var(--text-secondary);">⚠️ نکته: این تشخیص خودکار بر اساس «تاریخ اولین ثبت کالا در انبار» است، نه تاریخ هر بار شارژ مجدد موجودی؛ اگر کالایی را که از قبل در انبار داشتید، بعد از ورود شریک دوباره خرید و شارژ کردید، آن خرید جدید هنوز به‌طور خودکار به‌عنوان «بعد از شراکت» شناسایی نمی‌شود و باید با همان دکمه دستی مدیریت شود.</p>
    ${!dbRead(K.partners).some(p => p.isOwner) ? `<p class="txt-caption" style="color:var(--accent-amber); margin-bottom:10px;">⚠️ چون هنوز هیچ شریکی با علامت «صاحب فروشگاه» ثبت نشده، فاکتورهایی که «مستثنا از شراکت» علامت بخورند، سهم‌شان به هیچ‌کس اختصاص داده نمی‌شود (فقط از جمع سود شرکا کسر می‌شود). برای رفع این موضوع، از دکمه + یک شریک با گزینه «افزودن شریک» جدید بسازید تا صاحب فروشگاه هم به‌طور خودکار ثبت شود.</p>` : ''}
    <div class="search-bar">
        <div></div>
        <button class="fab-add" onclick="openAddPartnerWizard()" title="افزودن شریک">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>
    ${partners.length ? partners.map(p => {
        const pct = partnerPercentDisplay(p, partners);
        const share = shares[p.id] || 0;
        return `
        <div class="list-item">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(p.name)}${p.isOwner ? ' <span class="txt-caption">(صاحب فروشگاه)</span>' : ''}</div><div class="list-item-sub">سرمایه: ${moneyPlain(p.capitalToman)} · سهم: ${pct.toFixed(1).replace(/[0-9.]/g, (c) => c === '.' ? '.' : '۰۱۲۳۴۵۶۷۸۹'[c])}٪ · عضو از ${fmtDate(p.joinDate)}</div></div>
                <div style="text-align:left;"><div class="list-item-title" style="color:${share >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${moneyPlain(share)}</div><div class="txt-caption">سهم سود/زیان (از تاریخ ورود)</div></div>
            </div>
            <div class="action-grid" style="margin-top:8px;">
                <button class="btn-action" onclick="openPartnerEditor('${p.id}')">ویرایش</button>
                <button class="btn-action" style="color:var(--accent-rose);" onclick="deletePartner('${p.id}')">حذف</button>
            </div>
        </div>`;
    }).join('') : `<div class="empty-state">هنوز شریکی ثبت نشده است.</div>`}
    `;
}
VIEW_RENDERERS.partners = renderPartners;
function savePartnershipMode(mode) {
    saveSettings({ partnershipMode: mode });
    rerenderIfActive('partners');
}
window.savePartnershipMode = savePartnershipMode;

function openPartnerEditor(id) {
    const p = id ? dbRead(K.partners).find(x => x.id === id) : null;
    const mode = getSettings().partnershipMode || 'auto';
    const html = `
        <div class="input-group"><label>نام شریک *</label><input type="text" id="pt_name" value="${esc(p ? p.name : '')}"></div>
        ${mode === 'manual'
            ? `<div class="input-group"><label>درصد سهم (٪) *</label><input type="text" inputmode="numeric" id="pt_percent" value="${p ? num(p.percentManual) : ''}" placeholder="0"></div>`
            : `<div class="input-group"><label>مبلغ سرمایه (تومان) *</label><input type="text" inputmode="numeric" id="pt_capital" value="${p ? num(p.capitalToman) : ''}" placeholder="0"></div>`}
        ${jalaliDateField('pt_date', p ? p.joinDate : todayISO(), 'تاریخ ورود به شراکت (سود از این تاریخ به بعد حساب می‌شود)')}
        <div class="input-group"><label>یادداشت</label><textarea id="pt_note">${esc(p ? p.note || '' : '')}</textarea></div>
        <button class="calc-btn" onclick="savePartner('${id || ''}')">${p ? 'ذخیره تغییرات' : 'ثبت شریک'}</button>
        ${p ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deletePartner('${id}')">حذف شریک</button>` : ''}
    `;
    openModal(p ? 'ویرایش شریک' : 'شریک جدید', html);
}
window.openPartnerEditor = openPartnerEditor;
function savePartner(id) {
    const name = document.getElementById('pt_name').value.trim();
    const mode = getSettings().partnershipMode || 'auto';
    const capitalToman = mode === 'manual' ? 0 : num(document.getElementById('pt_capital').value);
    const percentManual = mode === 'manual' ? num(document.getElementById('pt_percent').value) : null;
    if (!name || (mode === 'manual' ? !percentManual : !capitalToman)) { showToast('نام و مقدار سرمایه/درصد را وارد کنید', 'error'); return; }
    const list = dbRead(K.partners);
    const data = { name, capitalToman, percentManual, joinDate: getJalaliInputISO('pt_date') || todayISO(), note: document.getElementById('pt_note').value.trim() };
    if (id) { const idx = list.findIndex(x => x.id === id); if (idx > -1) list[idx] = Object.assign(list[idx], data); }
    else list.push(Object.assign({ id: uid('ptn') }, data));
    dbWrite(K.partners, list);
    autoBackupTick();
    closeModal(); showToast('اطلاعات شریک ذخیره شد', 'success'); switchView('partners');
}
window.savePartner = savePartner;
function deletePartner(id) {
    if (!confirmAction('حذف این شریک؟')) return;
    dbWrite(K.partners, dbRead(K.partners).filter(x => x.id !== id));
    autoBackupTick();
    closeModal(); showToast('شریک حذف شد', 'success'); switchView('partners');
}
window.deletePartner = deletePartner;
function printPartnersList() {
    const partners = dbRead(K.partners);
    const netProfit = computeStoreNetProfit();
    const shares = computePartnerShares();
    const rows = partners.map(p => {
        const pct = partnerPercentDisplay(p, partners);
        const share = shares[p.id] || 0;
        return `<tr><td class="text-cell">${esc(p.name)}</td><td>${moneyPlain(p.capitalToman)}</td><td>${pct.toFixed(1)}٪</td><td>${fmtDate(p.joinDate)}</td><td>${moneyPlain(share)}</td></tr>`;
    }).join('');
    const html = `${billTemplateOpenTag()}${billHeaderHtml('شرکا و سهم سود')}
        <table class="bill-table"><thead><tr><th>شریک</th><th>سرمایه</th><th>درصد سهم</th><th>تاریخ ورود</th><th>سهم سود/زیان</th></tr></thead><tbody>${rows || '<tr><td colspan="5">-</td></tr>'}</tbody></table>
        <div class="totals-row grand" style="margin-top:8px;"><span>سود خالص کل فروشگاه</span><span>${moneyPlain(netProfit)}</span></div>
    </div>${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ — شرکا', html);
}
window.printPartnersList = printPartnersList;

/* ---------------------------------------------------------------------------
   Add-partner wizard: when a solo owner brings in a partner after already
   trading for a while, we first need to capture the owner's current capital
   (so era-splitting above has something to anchor the pre-partnership period
   to), then collect the new partner's contribution in the same cash/currency/
   gold format used for the store's own initial-capital entry.
   ------------------------------------------------------------------------- */
function openAddPartnerWizard() {
    const hasOwner = dbRead(K.partners).some(p => p.isOwner);
    if (!hasOwner) renderOwnerCapitalStep(); else renderNewPartnerCapitalStep();
}
window.openAddPartnerWizard = openAddPartnerWizard;

function renderOwnerCapitalStep() {
    const ledger = treasuryLedger();
    const cashBalance = ledger.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
    const inventoryValue = dbRead(K.products).reduce((s, p) => s + num(p.qty) * num(p.buyPrice), 0);
    const receivables = dbRead(K.customers).reduce((s, c) => s + customerBalance(c.id), 0);
    const payables = dbRead(K.purchases).reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0);
    const assets = dbRead(K.otherAssets);
    const html = `
        <p class="txt-body" style="color:var(--text-secondary); margin-bottom:12px; line-height:1.9;">پیش از افزودن اولین شریک، لازم است سرمایه فعلی صاحب فروشگاه محاسبه شود (تا سود دوره‌های قبل از شراکت، فقط سهم او باشد). موارد مورد نظر برای احتساب در سرمایه را انتخاب کنید:</p>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">موجودی صندوق نقدی (${moneyPlain(cashBalance)})</div><label class="switch"><input type="checkbox" class="ow-cap-item" data-val="${cashBalance}" checked><span class="switch-slider"></span></label></div>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">ارزش کالای انبار به قیمت خرید (${moneyPlain(inventoryValue)})</div><label class="switch"><input type="checkbox" class="ow-cap-item" data-val="${inventoryValue}" checked><span class="switch-slider"></span></label></div>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">مطالبات از مشتریان (${moneyPlain(receivables)})</div><label class="switch"><input type="checkbox" class="ow-cap-item" data-val="${receivables}" checked><span class="switch-slider"></span></label></div>
        <div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">کسر بدهی به تأمین‌کنندگان (−${moneyPlain(payables)})</div><label class="switch"><input type="checkbox" class="ow-cap-item" data-val="${-payables}" checked><span class="switch-slider"></span></label></div>
        ${assets.map(a => `<div class="settings-row" style="padding-inline:0;"><div class="settings-row-label">${esc(assetLabel(a))}</div><label class="switch"><input type="checkbox" class="ow-cap-item" data-val="${assetToTomanValue(a)}"><span class="switch-slider"></span></label></div>`).join('')}
        <div class="totals-box" style="margin-top:12px;"><div class="totals-row grand" id="ow_capTotal"><span>جمع سرمایه صاحب فروشگاه</span><span>0</span></div></div>
        <button class="calc-btn" style="width:100%; margin-top:10px;" onclick="confirmOwnerCapital()">تأیید و افزودن شریک</button>
    `;
    openModal('محاسبه سرمایه فعلی صاحب فروشگاه', html);
    setTimeout(() => {
        document.querySelectorAll('.ow-cap-item').forEach(el => el.addEventListener('change', refreshOwnerCapTotal));
        refreshOwnerCapTotal();
    }, 20);
}
function assetToTomanValue(a) {
    if (a.type === 'currency') return a.rate ? num(a.amount) * num(a.rate) : 0;
    if (a.type === 'gold') {
        if (a.goldType === 'coin') return num(a.qty) * num(a.unitPrice);
        if (a.goldType === 'melted' || a.goldType === 'silver') return num(a.grams) * num(a.pricePerGram);
        return num(a.customValue);
    }
    return 0;
}
function refreshOwnerCapTotal() {
    const total = Array.from(document.querySelectorAll('.ow-cap-item:checked')).reduce((s, el) => s + num(el.dataset.val), 0);
    const row = document.getElementById('ow_capTotal');
    if (row) row.innerHTML = `<span>جمع سرمایه صاحب فروشگاه</span><span>${moneyPlain(total)}</span>`;
}
window.refreshOwnerCapTotal = refreshOwnerCapTotal;
function confirmOwnerCapital() {
    const total = Array.from(document.querySelectorAll('.ow-cap-item:checked')).reduce((s, el) => s + num(el.dataset.val), 0);
    const list = dbRead(K.partners);
    list.push({ id: uid('ptn'), name: getSettings().ownerName || 'صاحب فروشگاه', capitalToman: total, percentManual: null, joinDate: earliestActivityDate(), isOwner: true, note: 'محاسبه‌شده خودکار از دارایی‌های موجود' });
    dbWrite(K.partners, list);
    autoBackupTick();
    renderNewPartnerCapitalStep();
}
window.confirmOwnerCapital = confirmOwnerCapital;
function renderNewPartnerCapitalStep() {
    const html = `
        <div class="input-group"><label>نام شریک جدید *</label><input type="text" id="np_name" placeholder="نام و نام‌خانوادگی"></div>
        <div class="input-group"><label>نوع سرمایه‌ای که وارد می‌کند</label>
            <select id="cap_type" onchange="capOnTypeChange()">
                <option value="currency">وجه نقد (تومان / ارز خارجی)</option>
                <option value="gold">طلا / سکه / نقره</option>
            </select>
        </div>
        <div id="cap_box"></div>
        ${jalaliDateField('np_date', todayISO(), 'تاریخ ورود به شراکت')}
        <div class="input-group"><label>یادداشت</label><textarea id="np_note"></textarea></div>
        <button class="calc-btn" style="margin-top:10px;" onclick="saveNewPartnerFromWizard()">ثبت شریک جدید</button>
    `;
    openModal('سرمایه شریک جدید', html);
    setTimeout(capOnTypeChange, 20);
}
function computeCapitalEntryTomanValue() {
    const type = (document.getElementById('cap_type') || {}).value;
    if (type === 'gold') {
        const goldType = (document.getElementById('cap_goldType') || {}).value;
        if (goldType === 'coin') return num((document.getElementById('cap_qty') || {}).value) * num((document.getElementById('cap_unitPrice') || {}).value);
        if (goldType === 'melted' || goldType === 'silver') return num((document.getElementById('cap_grams') || {}).value) * num((document.getElementById('cap_pricePerGram') || {}).value);
        return num((document.getElementById('cap_customValue') || {}).value);
    }
    // currency
    const amount = num((document.getElementById('cap_amount') || {}).value);
    let currency = (document.getElementById('cap_currency') || {}).value;
    if (currency === '__custom__') currency = (document.getElementById('cap_customCur') || {}).value || 'ارز دلخواه';
    if (currency === 'تومان') return amount;
    const rate = num((document.getElementById('cap_rate') || {}).value);
    return rate ? amount * rate : 0;
}
function saveNewPartnerFromWizard() {
    const name = document.getElementById('np_name').value.trim();
    if (!name) { showToast('نام شریک را وارد کنید', 'error'); return; }
    const capitalToman = computeCapitalEntryTomanValue();
    if (!capitalToman) { showToast('مبلغ/ارزش سرمایه را کامل وارد کنید (برای ارز، نرخ روز هم لازم است)', 'error'); return; }
    const list = dbRead(K.partners);
    list.push({ id: uid('ptn'), name, capitalToman, percentManual: null, joinDate: getJalaliInputISO('np_date') || todayISO(), note: document.getElementById('np_note').value.trim() });
    dbWrite(K.partners, list);
    autoBackupTick();
    closeModal();
    showToast('شریک جدید اضافه شد', 'success');
    switchView('partners');
}
window.saveNewPartnerFromWizard = saveNewPartnerFromWizard;

function openSettleCustomer(customerId) {
    _stlDirection = 'in';
    const c = dbRead(K.customers).find(x => x.id === customerId);
    if (!c) return;
    const bal = customerBalance(customerId);
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">مانده بدهی فعلی <strong>${esc(c.name)}</strong>: ${money(bal)}</p>
        <div class="input-group"><label>مبلغ دریافتی *</label><input type="text" inputmode="numeric" id="stl_amount" value="${bal}"></div>
        ${jalaliDateField('stl_date', todayISO(), 'تاریخ')}
        <div class="input-group"><label>روش دریافت</label>
            <select id="stl_method" onchange="stlOnMethodChange()">
                <option value="cash">نقدی (صندوق)</option>
                <option value="card">کارت‌خوان / کارت به کارت</option>
                <option value="check">چک</option>
            </select>
        </div>
        <div id="stl_detailBox"></div>
        <div class="input-group"><label>توضیحات</label><input type="text" id="stl_note" placeholder="مثلاً: پرداخت نقدی حضوری"></div>
        <button class="calc-btn" onclick="settleCustomer('${customerId}')">ثبت دریافت و تسویه</button>
    `;
    openModal('تسویه حساب مشتری', html);
    setTimeout(stlOnMethodChange, 20);
}
window.openSettleCustomer = openSettleCustomer;
function stlOnMethodChange() {
    const method = document.getElementById('stl_method').value;
    const box = document.getElementById('stl_detailBox');
    box.innerHTML = (method === 'cash') ? '' : paymentDetailsHtml('stl', method, {}, false, _stlDirection);
}
window.stlOnMethodChange = stlOnMethodChange;
function settleCustomer(customerId) {
    let amount = num(document.getElementById('stl_amount').value);
    if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
    const date = getJalaliInputISO('stl_date') || todayISO();
    const note = document.getElementById('stl_note').value.trim();
    const method = document.getElementById('stl_method').value;
    const customerName = dbRead(K.customers).find(c => c.id === customerId)?.name || '';
    const invoices = dbRead(K.invoices).filter(i => i.customerId === customerId && num(i.total) - num(i.paidAmount) > 0).sort((a, b) => new Date(a.date) - new Date(b.date));
    const allInvoices = dbRead(K.invoices);
    let remaining = amount;
    invoices.forEach(inv => {
        if (remaining <= 0) return;
        const due = num(inv.total) - num(inv.paidAmount);
        const applied = Math.min(due, remaining);
        const idx = allInvoices.findIndex(x => x.id === inv.id);
        allInvoices[idx].paidAmount = num(allInvoices[idx].paidAmount) + applied;
        allInvoices[idx].status = num(allInvoices[idx].paidAmount) >= num(allInvoices[idx].total) ? 'paid' : 'partial';
        remaining -= applied;
    });
    dbWrite(K.invoices, allInvoices);

    if (method === 'check') {
        const pd = paymentDetailsCollect('stl', 'check');
        if (!pd.dueDate) { showToast('تاریخ سررسید چک را وارد کنید', 'error'); return; }
        const checks = dbRead(K.checks);
        checks.push({ id: uid('chk'), who: customerName, direction: 'receive', amount, number: pd.checkNumber, bank: pd.bank, accountNo: pd.accountNo, sayadNo: pd.sayadNo, dueDate: pd.dueDate, status: 'pending', note: 'تسویه حساب مشتری' + (note ? ': ' + note : '') });
        dbWrite(K.checks, checks);
    } else {
        // cash and card both increase the cash/bank ledger immediately
        const pd = method === 'card' ? paymentDetailsCollect('stl', 'card') : null;
        const bankNote = pd && pd.bankAccountId ? (dbRead(K.bankAccounts).find(b => b.id === pd.bankAccountId) || {}).bankName : '';
        const tx = dbRead(K.cashtx);
        tx.push({ id: uid('tx'), date, type: 'in', amount, desc: `تسویه حساب مشتری: ${customerName}${method === 'card' ? ' (کارتی' + (bankNote ? ' — ' + bankNote : '') + ')' : ''}${note ? ' — ' + note : ''}` });
        dbWrite(K.cashtx, tx);
    }
    autoBackupTick();
    closeModal();
    showToast('تسویه حساب ثبت شد', 'success');
    switchView('settlements');
}
window.settleCustomer = settleCustomer;

function openSettleSupplier(name) {
    _stlDirection = 'out';
    const suppliers = {};
    dbRead(K.purchases).forEach(p => { const r = Math.max(0, num(p.total) - num(p.paidAmount)); if (p.supplier === name && r > 0) suppliers[name] = (suppliers[name] || 0) + r; });
    const bal = suppliers[name] || 0;
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">مانده بدهی فعلی به <strong>${esc(name)}</strong>: ${money(bal)}</p>
        <div class="input-group"><label>مبلغ پرداختی *</label><input type="text" inputmode="numeric" id="stl_amount" value="${bal}"></div>
        ${jalaliDateField('stl_date', todayISO(), 'تاریخ')}
        <div class="input-group"><label>روش پرداخت</label>
            <select id="stl_method" onchange="stlOnMethodChange()">
                <option value="cash">نقدی (صندوق)</option>
                <option value="card">کارت‌خوان / کارت به کارت</option>
                <option value="check">چک</option>
            </select>
        </div>
        <div id="stl_detailBox"></div>
        <div class="input-group"><label>توضیحات</label><input type="text" id="stl_note"></div>
        <button class="calc-btn" onclick="settleSupplier('${esc(name).replace(/'/g, "\\'")}')">ثبت پرداخت و تسویه</button>
    `;
    openModal('تسویه حساب تأمین‌کننده', html);
    setTimeout(stlOnMethodChange, 20);
}
window.openSettleSupplier = openSettleSupplier;
function settleSupplier(name) {
    let amount = num(document.getElementById('stl_amount').value);
    if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
    const date = getJalaliInputISO('stl_date') || todayISO();
    const note = document.getElementById('stl_note').value.trim();
    const method = document.getElementById('stl_method').value;
    const allPurchases = dbRead(K.purchases);
    const unpaid = allPurchases.filter(p => p.supplier === name && num(p.total) - num(p.paidAmount) > 0).sort((a, b) => new Date(a.date) - new Date(b.date));
    let remaining = amount;
    unpaid.forEach(p => {
        if (remaining <= 0) return;
        const due = num(p.total) - num(p.paidAmount);
        const applied = Math.min(due, remaining);
        const idx = allPurchases.findIndex(x => x.id === p.id);
        allPurchases[idx].paidAmount = num(allPurchases[idx].paidAmount) + applied;
        allPurchases[idx].status = num(allPurchases[idx].paidAmount) >= num(allPurchases[idx].total) ? 'paid' : 'partial';
        remaining -= applied;
    });
    dbWrite(K.purchases, allPurchases);

    if (method === 'check') {
        const pd = paymentDetailsCollect('stl', 'check');
        if (!pd.dueDate && pd.source !== 'existing') { showToast('تاریخ سررسید چک را وارد کنید', 'error'); return; }
        const checks = dbRead(K.checks);
        if (pd.source === 'existing' && pd.existingCheckId) {
            const idx = checks.findIndex(c => c.id === pd.existingCheckId);
            if (idx > -1) { checks[idx].endorsedTo = name; checks[idx].endorsedDate = todayISO(); checks[idx].note = (checks[idx].note ? checks[idx].note + ' — ' : '') + `واگذار شده بابت تسویه حساب ${name}`; }
            dbWrite(K.checks, checks);
        } else {
            checks.push({ id: uid('chk'), who: name, direction: 'pay', amount, number: pd.checkNumber, bank: pd.bank, accountNo: pd.accountNo, sayadNo: pd.sayadNo, dueDate: pd.dueDate, status: 'pending', note: 'تسویه حساب تأمین‌کننده' + (note ? ': ' + note : '') });
            dbWrite(K.checks, checks);
        }
    } else {
        const pd = method === 'card' ? paymentDetailsCollect('stl', 'card') : null;
        const bankNote = pd && pd.bankAccountId ? (dbRead(K.bankAccounts).find(b => b.id === pd.bankAccountId) || {}).bankName : '';
        const tx = dbRead(K.cashtx);
        tx.push({ id: uid('tx'), date, type: 'out', amount, desc: `تسویه حساب تأمین‌کننده: ${name}${method === 'card' ? ' (کارتی' + (bankNote ? ' — ' + bankNote : '') + ')' : ''}${note ? ' — ' + note : ''}` });
        dbWrite(K.cashtx, tx);
    }
    autoBackupTick();
    closeModal();
    showToast('تسویه حساب ثبت شد', 'success');
    switchView('settlements');
}
window.settleSupplier = settleSupplier;

function printSettlements() {
    const html = `
        <div class="input-group"><label>مرتب‌سازی مشتریان بدهکار</label>
            <select id="ps_custSort">
                <option value="amountDesc">بیشترین بدهی</option>
                <option value="amountAsc">کمترین بدهی</option>
                <option value="name">بر اساس نام</option>
            </select>
        </div>
        <div class="input-group"><label>مرتب‌سازی تأمین‌کنندگان</label>
            <select id="ps_supSort">
                <option value="amountDesc">بیشترین بدهی</option>
                <option value="amountAsc">کمترین بدهی</option>
                <option value="name">بر اساس نام</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div class="settings-row-label">ریز فاکتورهای هر مشتری/تأمین‌کننده (جزء‌به‌جزء)</div>
            <label class="switch"><input type="checkbox" id="ps_detail" checked><span class="switch-slider"></span></label>
        </div>
        <button class="calc-btn" style="width:100%; margin-top:10px;" onclick="printSettlementsFinal()">🖨 چاپ</button>
    `;
    openModal('تنظیمات چاپ بدهکاران و طلبکاران', html);
}
window.printSettlements = printSettlements;
function printSettlementsFinal() {
    const custSort = document.getElementById('ps_custSort').value;
    const supSort = document.getElementById('ps_supSort').value;
    const detail = document.getElementById('ps_detail').checked;

    let customers = dbRead(K.customers).map(c => ({ id: c.id, name: c.name, phone: c.phone, bal: customerBalance(c.id) })).filter(c => c.bal > 0);
    if (custSort === 'amountAsc') customers.sort((a, b) => a.bal - b.bal);
    else if (custSort === 'name') customers.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    else customers.sort((a, b) => b.bal - a.bal);

    const custRows = customers.map(c => {
        const head = `<tr><td class="text-cell" style="font-weight:800;">${esc(c.name)}</td><td>${esc(c.phone || '-')}</td><td>${moneyPlain(c.bal)}</td></tr>`;
        if (!detail) return head;
        const unpaidInvoices = dbRead(K.invoices).filter(i => i.customerId === c.id && num(i.total) - num(i.paidAmount) > 0).sort((a, b) => new Date(a.date) - new Date(b.date));
        const detailRows = unpaidInvoices.map(i => `<tr><td colspan="2" class="text-cell" style="padding-inline-start:20px; color:var(--text-secondary);">فاکتور #${i.number} — ${fmtDate(i.date)} — کل: ${moneyPlain(i.total)} — پرداخت‌شده: ${moneyPlain(i.paidAmount)}</td><td>${moneyPlain(num(i.total) - num(i.paidAmount))}</td></tr>`).join('');
        return head + detailRows;
    }).join('');
    const custTotal = customers.reduce((s, c) => s + c.bal, 0);

    const suppliers = {};
    dbRead(K.purchases).forEach(p => { const r = Math.max(0, num(p.total) - num(p.paidAmount)); if (r > 0) { suppliers[p.supplier] = suppliers[p.supplier] || { total: 0, items: [] }; suppliers[p.supplier].total += r; suppliers[p.supplier].items.push(p); } });
    let supplierList = Object.entries(suppliers);
    if (supSort === 'amountAsc') supplierList.sort((a, b) => a[1].total - b[1].total);
    else if (supSort === 'name') supplierList.sort((a, b) => a[0].localeCompare(b[0], 'fa'));
    else supplierList.sort((a, b) => b[1].total - a[1].total);

    const supRows = supplierList.map(([name, info]) => {
        const head = `<tr><td class="text-cell" style="font-weight:800;">${esc(name)}</td><td>${moneyPlain(info.total)}</td></tr>`;
        if (!detail) return head;
        const detailRows = info.items.filter(p => num(p.total) - num(p.paidAmount) > 0).sort((a, b) => new Date(a.date) - new Date(b.date))
            .map(p => `<tr><td class="text-cell" style="padding-inline-start:20px; color:var(--text-secondary);">خرید #${p.number} — ${fmtDate(p.date)} — کل: ${moneyPlain(p.total)} — پرداخت‌شده: ${moneyPlain(p.paidAmount)}</td><td>${moneyPlain(num(p.total) - num(p.paidAmount))}</td></tr>`).join('');
        return head + detailRows;
    }).join('');
    const supTotal = supplierList.reduce((s, [, info]) => s + info.total, 0);

    const html = `${billTemplateOpenTag()}${billHeaderHtml('گزارش بدهکاران و طلبکاران')}
        <div class="section-title">مشتریان بدهکار</div>
        <table class="bill-table"><thead><tr><th>مشتری</th><th>تلفن</th><th>مانده بدهی</th></tr></thead><tbody>${custRows || '<tr><td colspan="3">-</td></tr>'}</tbody></table>
        <div class="totals-row grand" style="margin-top:6px;"><span>جمع کل مطالبات</span><span>${moneyPlain(custTotal)}</span></div>
        <div class="section-title" style="margin-top:18px;">بدهی به تأمین‌کنندگان</div>
        <table class="bill-table"><thead><tr><th>تأمین‌کننده</th><th>مانده بدهی</th></tr></thead><tbody>${supRows || '<tr><td colspan="2">-</td></tr>'}</tbody></table>
        <div class="totals-row grand" style="margin-top:6px;"><span>جمع کل بدهی به تأمین‌کنندگان</span><span>${moneyPlain(supTotal)}</span></div>
        <div class="txt-caption" style="margin-top:10px;">تاریخ چاپ: ${fmtDateTime(todayISO())}</div>
    </div>${printFooterButton()}`;
    closeModal();
    openModal('پیش‌نمایش چاپ — بدهکاران و طلبکاران', html);
}
window.printSettlementsFinal = printSettlementsFinal;

/* ---------------------------------------------------------------------------
   Warehousing / physical stock count (انبارگردانی)
   ------------------------------------------------------------------------- */
let stocktakeOpenFolders = new Set();
function toggleStocktakeFolder(cat) {
    if (stocktakeOpenFolders.has(cat)) stocktakeOpenFolders.delete(cat); else stocktakeOpenFolders.add(cat);
    rerenderIfActive('stocktake');
}
window.toggleStocktakeFolder = toggleStocktakeFolder;
function renderStocktake() {
    const products = dbRead(K.products);
    const cats = {};
    products.forEach(p => { const c = p.category || 'بدون دسته'; (cats[c] = cats[c] || []).push(p); });
    const catNames = Object.keys(cats).sort((a, b) => a.localeCompare(b, 'fa'));
    const rowHtml = (p) => `
        <div class="mini-form-grid" style="align-items:end; margin-bottom:8px;">
            <div class="input-group" style="grid-column:span 2;"><label>${esc(p.name)}</label><div class="txt-caption">موجودی سیستم: ${num(p.qty).toLocaleString(localeForDigits())} ${esc(p.unit)}</div></div>
            <div class="input-group"><label>شمارش واقعی</label><input type="text" inputmode="numeric" id="st_${p.id}" value="${num(p.qty)}"></div>
        </div>`;
    return `
    ${viewHeader('انبار', 'انبارگردانی', 'شمارش فیزیکی موجودی و اصلاح انبار، به ترتیب دسته‌بندی')}
    <p class="txt-caption" style="margin-bottom:12px;">موجودی شمارش‌شده واقعی هر کالا را وارد کنید؛ با ثبت، موجودی سیستم با شمارش شما اصلاح می‌شود.</p>
    ${catNames.length ? catNames.map(c => {
        const open = stocktakeOpenFolders.has(c);
        const items = cats[c].slice().sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        return `<div class="accordion-item section-box" style="margin-bottom:10px;">
            <div class="list-item" style="cursor:pointer; margin:-4px -4px 0;" onclick="toggleStocktakeFolder('${esc(c).replace(/'/g, "\\'")}')">
                <div class="list-item-row"><div class="list-item-title">📁 ${esc(c)}</div>
                <div style="display:flex; align-items:center; gap:8px;"><div class="badge badge-cyan">${items.length.toLocaleString(localeForDigits())} کالا</div><span style="transform:rotate(${open ? '180deg' : '0deg'}); display:inline-block;">▾</span></div></div>
            </div>
            ${open ? `<div class="accordion-body" style="margin-top:10px;">${items.map(rowHtml).join('')}</div>` : ''}
        </div>`;
    }).join('') : `<div class="empty-state">کالایی برای انبارگردانی وجود ندارد.</div>`}
    ${products.length ? `<button class="calc-btn" onclick="applyStocktake()">ثبت انبارگردانی و اصلاح موجودی</button>` : ''}
    `;
}
VIEW_RENDERERS.stocktake = renderStocktake;

function applyStocktake() {
    const products = dbRead(K.products);
    const diffs = [];
    products.forEach(p => {
        const el = document.getElementById('st_' + p.id);
        if (!el) return;
        const counted = num(el.value);
        if (counted !== num(p.qty)) diffs.push({ name: p.name, before: p.qty, after: counted, buyPrice: num(p.buyPrice), valueImpact: (counted - num(p.qty)) * num(p.buyPrice) });
        p.qty = counted;
    });
    dbWrite(K.products, products);
    const takes = dbRead(K.stocktakes);
    takes.push({ id: uid('stk'), date: todayISO(), diffs });
    dbWrite(K.stocktakes, takes);
    autoBackupTick();
    const netImpact = diffs.reduce((s, d) => s + d.valueImpact, 0);
    showToast(`انبارگردانی ثبت شد (${diffs.length.toLocaleString(localeForDigits())} مورد اصلاح شد، اثر بر سود: ${moneyPlain(netImpact)})`, 'success');
    switchView('products');
}
window.applyStocktake = applyStocktake;
/* Sum of all stocktake (shrinkage/overage) value-adjustments within an optional date range —
   feeds into the profit/loss report so a shortage found during a physical count actually shows
   up as a loss (and a surplus as a gain), not just silently corrects the qty on record. */
function stocktakeProfitImpact(fromDate, toDate) {
    const inRange = (d) => (!fromDate || new Date(d) >= new Date(fromDate)) && (!toDate || new Date(d) < new Date(toDate));
    return dbRead(K.stocktakes).filter(t => inRange(t.date)).reduce((s, t) => s + (t.diffs || []).reduce((s2, d) => s2 + num(d.valueImpact), 0), 0);
}

function exportReportCsv() {
    const invoices = dbRead(K.invoices);
    let csv = '\uFEFF' + ['شماره فاکتور', 'تاریخ', 'مشتری', 'جمع کالاها', 'تخفیف', 'مالیات', 'مبلغ نهایی', 'پرداخت‌شده', 'وضعیت'].join(',') + '\n';
    invoices.forEach(inv => {
        const subtotal = inv.items.reduce((s, it) => s + it.qty * it.price, 0);
        csv += [inv.number, fmtDate(inv.date), inv.customerNameSnapshot, subtotal, inv.discountTotal, inv.taxAmount, inv.total, inv.paidAmount, inv.status].join(',') + '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'گزارش-فروش.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('فایل CSV دانلود شد', 'success');
}
window.exportReportCsv = exportReportCsv;

/* ---------------------------------------------------------------------------
   Settings
   ------------------------------------------------------------------------- */
const COLOR_THEMES = [
    ['default', 'بنفش (پیش‌فرض)'], ['emerald', 'زمردی'], ['rosegold', 'رزگلد'], ['slate', 'خاکستری'],
    ['ocean', 'اقیانوسی'], ['sunset', 'غروب'], ['violet', 'یاسی'], ['forest', 'جنگلی'], ['crimson', 'زرشکی'], ['graphite', 'گرافیتی']
];

function renderSettings() {
    const s = getSettings();
    return `
    ${viewHeader('سیستم', 'تنظیمات', 'اطلاعات فروشگاه، ظاهر برنامه و مالیات')}

    <div class="section-box">
        <div class="section-title">حساب گوگل و همگام‌سازی ابری</div>
        ${fbUser ? `
            <div class="bank-account-card">
                <div><div class="bac-name">${esc(fbUser.displayName || fbUser.email)}</div><div class="bac-sub">${esc(fbUser.email)}${localStorage.getItem('ap_last_cloud_sync') ? ' · آخرین همگام‌سازی: ' + fmtDateTime(localStorage.getItem('ap_last_cloud_sync')) : ''}</div></div>
                <button class="btn-action" onclick="signOutCloud()">خروج</button>
            </div>
            <button class="btn-action" style="width:100%; margin-top:8px;" onclick="manualCloudSync()">🔄 همگام‌سازی الان</button>
        ` : `
            <p class="txt-body" style="color:var(--text-secondary); margin-bottom:10px;">با ورود با حساب گوگل، اطلاعات شما علاوه بر این دستگاه، در سرور هم ذخیره می‌شود و می‌توانید از دستگاه دیگری هم به آن دسترسی داشته باشید.</p>
            <button class="calc-btn" style="width:100%;" onclick="signInWithGoogle()">
                <svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:-3px; margin-inline-end:6px;"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.28 1.48-1.13 2.73-2.4 3.58v2.98h3.88c2.27-2.09 3.54-5.17 3.54-8.8z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-2.98c-1.08.72-2.45 1.15-4.05 1.15-3.11 0-5.75-2.1-6.69-4.93H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.31 14.33c-.24-.72-.38-1.49-.38-2.28s.14-1.56.38-2.28V6.68H1.29A11.96 11.96 0 000 12.05c0 1.93.46 3.76 1.29 5.37l4.02-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.68l4.02 3.09c.94-2.83 3.58-4.93 6.69-4.93z"/></svg>
                ورود با گوگل
            </button>
        `}
    </div>

    <div class="section-box">
        <div class="section-title">حالت نمایش برنامه</div>
        <p class="txt-caption" style="margin-bottom:10px;">در حالت ساده، بخش‌های پیشرفته (شرکا و سهم سود، و در آینده ماژول زنجیره تأمین) از منو مخفی می‌شوند تا محیط شلوغ نشود. اطلاعات ثبت‌شده در هیچ حالتی حذف نمی‌شود.</p>
        <div class="biz-type-grid" style="grid-template-columns:repeat(2,1fr);">
            <div class="biz-type-card ${!isProMode() ? 'active' : ''}" onclick="setAppMode('simple')">
                <div class="biz-type-emoji">🏠</div><div class="biz-type-label">ساده</div>
            </div>
            <div class="biz-type-card ${isProMode() ? 'active' : ''}" onclick="setAppMode('pro')">
                <div class="biz-type-emoji">🏢</div><div class="biz-type-label">حرفه‌ای</div>
            </div>
        </div>
    </div>

    <div class="section-box">
        <div class="section-title">سرمایه پایه (برای محاسبه سود/زیان ارزی)</div>
        <p class="txt-caption" style="margin-bottom:10px;">اگر سرمایه اولیه فروشگاه شما در واقع بر پایه یک ارز خارجی بوده (مثلاً دلار)، این‌جا ثبت کنید تا در گزارش «سود و زیان ارزی» بتوانیم با توجه به نرخ روز، سود/زیان واقعی را محاسبه کنیم.</p>
        <div class="mini-form-grid">
            <div class="input-group"><label>ارز پایه سرمایه</label>
                <select id="st_capCurrency">
                    <option value="">— غیرفعال —</option>
                    ${CURRENCY_LIST.filter(([v]) => v !== 'تومان' && v !== '__custom__').map(([v, l]) => `<option value="${esc(v)}" ${s.capitalBaseCurrency === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
                </select>
            </div>
            <div class="input-group"><label>مبلغ سرمایه به این ارز</label><input type="text" inputmode="numeric" id="st_capAmount" value="${s.capitalBaseAmount ? num(s.capitalBaseAmount) : ''}"></div>
        </div>
        <div class="input-group"><label>نرخ تومان به این ارز، در روزی که این سرمایه وارد شد</label><input type="text" inputmode="numeric" id="st_capRate" value="${s.capitalBaseRate ? num(s.capitalBaseRate) : ''}" placeholder="مثلاً 60000"></div>
        <button class="calc-btn" onclick="saveCapitalBaseSettings()">ذخیره سرمایه پایه</button>
    </div>

    <div class="section-box">
        <div class="section-title">اطلاعات فروشگاه</div>
        <div class="input-group"><label>نام فروشگاه</label><input type="text" id="st_storeName" value="${esc(s.storeName || '')}"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>نام مدیر</label><input type="text" id="st_ownerName" value="${esc(s.ownerName || '')}"></div>
            <div class="input-group"><label>شماره تماس</label><input type="text" id="st_phone" value="${esc(s.phone || '')}"></div>
        </div>
        <div class="input-group"><label>صنف</label>
            <select id="st_businessType">${BUSINESS_TYPES.map(b => `<option value="${b.id}" ${s.businessType === b.id ? 'selected' : ''}>${b.emoji} ${esc(b.label)}</option>`).join('')}</select>
        </div>
        <div class="input-group"><label>آدرس (روی فاکتور چاپ می‌شود)</label><textarea id="st_address">${esc(s.address || '')}</textarea></div>
        <button class="calc-btn" onclick="saveStoreSettings()">ذخیره اطلاعات فروشگاه</button>
    </div>

    <div class="section-box">
        <div class="section-title">مالی</div>
        <div class="input-group"><label>واحد پول</label>
            <select id="st_currency">
                <option value="تومان" ${s.currency === 'تومان' || !s.currency ? 'selected' : ''}>تومان</option>
                <option value="ریال" ${s.currency === 'ریال' ? 'selected' : ''}>ریال</option>
            </select>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div><div class="settings-row-label">مالیات بر ارزش افزوده</div><div class="settings-row-sub">محاسبه خودکار روی فاکتورهای فروش جدید</div></div>
            <label class="switch"><input type="checkbox" id="st_taxEnabled" ${s.taxEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="input-group" style="margin-top:10px;"><label>درصد مالیات</label><input type="text" inputmode="numeric" id="st_taxPercent" value="${esc(num(s.taxPercent) || 9)}"></div>
        <button class="calc-btn" onclick="saveFinanceSettings()">ذخیره تنظیمات مالی</button>
    </div>

    <div class="section-box">
        <div class="section-title">ظاهر برنامه</div>
        <div class="settings-row" style="padding-inline:0;">
            <div><div class="settings-row-label">تم تاریک</div><div class="settings-row-sub">حالت شب برای چشم راحت‌تر</div></div>
            <label class="switch"><input type="checkbox" onchange="toggleTheme()" ${!document.body.classList.contains('light-mode') ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="input-group" style="margin-top:10px;">
            <label>رنگ زمینه برنامه</label>
            <div class="biz-type-grid" style="grid-template-columns:repeat(5,1fr);">
                ${COLOR_THEMES.map(([id, label]) => `
                    <div class="select-card ${((s.colorTheme || 'default') === id) ? 'active' : ''}" style="padding:8px 2px;" onclick="setColorTheme('${id}')" title="${esc(label)}">
                        <div style="width:20px;height:20px;border-radius:50%;margin:0 auto;background:${themeSwatch(id)};"></div>
                    </div>`).join('')}
            </div>
        </div>
        <div class="mini-form-grid" style="margin-top:10px;">
            <div class="input-group"><label>فونت برنامه</label>
                <select id="st_fontFamily" onchange="applyAppearanceLive()">
                    ${FONT_FAMILIES.map(([id, label]) => `<option value="${id}" ${(s.fontFamily || 'vazirmatn') === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
                </select>
            </div>
            <div class="input-group"><label>اندازه فونت</label>
                <select id="st_fontSize" onchange="applyAppearanceLive()">
                    ${FONT_SIZES.map(([id, label]) => `<option value="${id}" ${(s.fontSize || 'medium') === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
                </select>
            </div>
            <div class="input-group"><label>تراکم چیدمان</label>
                <select id="st_density" onchange="applyAppearanceLive()">
                    <option value="comfortable" ${(s.density || 'comfortable') === 'comfortable' ? 'selected' : ''}>راحت (فاصله بیشتر)</option>
                    <option value="compact" ${s.density === 'compact' ? 'selected' : ''}>فشرده (فاصله کمتر)</option>
                </select>
            </div>
            <div class="input-group"><label>ارقام</label>
                <select id="st_digitStyle" onchange="applyAppearanceLive()">
                    <option value="fa" ${(s.digitStyle || 'fa') === 'fa' ? 'selected' : ''}>فارسی ۰۱۲۳</option>
                    <option value="en" ${s.digitStyle === 'en' ? 'selected' : ''}>انگلیسی 0123</option>
                </select>
            </div>
        </div>
        <div class="settings-row" style="padding-inline:0; margin-top:6px;">
            <div><div class="settings-row-label">کنتراست بالا</div><div class="settings-row-sub">خطوط و مرزها پررنگ‌تر نمایش داده شود</div></div>
            <label class="switch"><input type="checkbox" id="st_highContrast" onchange="applyAppearanceLive()" ${s.highContrast ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div><div class="settings-row-label">افکت‌ها و انیمیشن</div><div class="settings-row-sub">انیمیشن‌های ظریف رابط کاربری فعال باشد</div></div>
            <label class="switch"><input type="checkbox" id="st_animations" onchange="applyAppearanceLive()" ${s.animationsEnabled !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="settings-row" style="padding-inline:0;">
            <div><div class="settings-row-label">جلوگیری از پاک‌سازی تصادفی</div><div class="settings-row-sub">قبل از حذف یا پاک‌سازی، تأیید بگیرد</div></div>
            <label class="switch"><input type="checkbox" id="st_confirmDelete" onchange="applyAppearanceLive()" ${s.confirmBeforeDelete !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
    </div>

    <div class="section-box">
        <div class="section-title">چاپ و فاکتور</div>
        <p class="txt-caption" style="margin-bottom:10px;">این تنظیمات روی همه‌ی چاپ‌های برنامه (فاکتور، پیش‌فاکتور، لیست‌ها، گزارش‌ها) اعمال می‌شود.</p>
        <div class="input-group">
            <label>قالب چاپ فاکتور</label>
            <select id="st_printTemplate" onchange="onPrintTemplateChange(this.value)">
                ${PRINT_TEMPLATES.map(([id, label]) => `<option value="${id}" ${((s.printTemplate || 'modern') === id) ? 'selected' : ''}>${esc(label)}</option>`).join('')}
                <option value="custom" ${(s.printTemplate === 'custom') ? 'selected' : ''}>🎨 طراحی سفارشی من — خودتان طراحی و ذخیره کنید</option>
            </select>
            <div class="print-template-preview" id="printTemplatePreview">${printTemplatePreviewHtml(s.printTemplate || 'modern')}</div>
            ${(s.printTemplate === 'custom') ? `<button class="btn-action" style="width:100%; margin-top:8px;" onclick="openCustomTemplateDesigner()">✏️ ویرایش طراحی سفارشی</button>` : ''}
        </div>
        <div class="mini-form-grid">
            <div class="input-group"><label>اندازه کاغذ</label>
                <select id="st_paperSize" onchange="applyAppearanceLive()">
                    <option value="A4" ${(s.paperSize || 'A4') === 'A4' ? 'selected' : ''}>A4</option>
                    <option value="A5" ${s.paperSize === 'A5' ? 'selected' : ''}>A5</option>
                    <option value="80mm" ${s.paperSize === '80mm' ? 'selected' : ''}>رول ۸۰mm (پرینتر حرارتی)</option>
                    <option value="58mm" ${s.paperSize === '58mm' ? 'selected' : ''}>رول ۵۸mm (پرینتر حرارتی)</option>
                </select>
            </div>
            <div class="input-group"><label>جهت کاغذ</label>
                <select id="st_printOrientation" onchange="applyAppearanceLive()">
                    <option value="portrait" ${(s.printOrientation || 'portrait') === 'portrait' ? 'selected' : ''}>عمودی</option>
                    <option value="landscape" ${s.printOrientation === 'landscape' ? 'selected' : ''}>افقی</option>
                </select>
            </div>
        </div>
        <div class="input-group">
            <label>لوگوی فروشگاه (روی فاکتور و منو نمایش داده می‌شود)</label>
            <input type="file" id="st_logoFile" accept="image/*" onchange="onLogoFileChange(this)">
            ${s.logoDataUrl ? `<div style="margin-top:8px; display:flex; align-items:center; gap:10px;"><img src="${s.logoDataUrl}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;"><button class="btn-action" onclick="clearLogo()">حذف لوگو</button></div>` : ''}
        </div>
    </div>

    <div class="section-box">
        <div class="section-title">داده‌ها</div>
        <button class="btn-action" style="width:100%; margin-bottom:8px;" onclick="switchView('backup')">رفتن به پشتیبان‌گیری و بازیابی</button>
        <button class="btn-action" style="width:100%; margin-bottom:8px;" onclick="switchView('help')">راهنمای کامل برنامه</button>
        <button class="btn-action" style="width:100%; color:var(--accent-rose);" onclick="resetAllData()">پاک کردن همه اطلاعات و شروع مجدد</button>
    </div>
    `;
}
VIEW_RENDERERS.settings = renderSettings;

function themeSwatch(id) {
    const map = {
        default: 'linear-gradient(135deg,#6366f1,#22b8cf)', emerald: 'linear-gradient(135deg,#059669,#10b981)',
        rosegold: 'linear-gradient(135deg,#e11d48,#d97706)', slate: 'linear-gradient(135deg,#475569,#64748b)',
        ocean: 'linear-gradient(135deg,#0284c7,#06b6d4)', sunset: 'linear-gradient(135deg,#ea580c,#f59e0b)',
        violet: 'linear-gradient(135deg,#7c3aed,#a855f7)', forest: 'linear-gradient(135deg,#16a34a,#65a30d)',
        crimson: 'linear-gradient(135deg,#b91c1c,#dc2626)', graphite: 'linear-gradient(135deg,#52525b,#71717a)'
    };
    return map[id] || map.default;
}

function saveCapitalBaseSettings() {
    saveSettings({
        capitalBaseCurrency: document.getElementById('st_capCurrency').value,
        capitalBaseAmount: num(document.getElementById('st_capAmount').value),
        capitalBaseRate: num(document.getElementById('st_capRate').value)
    });
    showToast('سرمایه پایه ذخیره شد', 'success');
    switchView('settings');
}
window.saveCapitalBaseSettings = saveCapitalBaseSettings;

function saveStoreSettings() {
    saveSettings({
        storeName: document.getElementById('st_storeName').value.trim() || 'فروشگاه من',
        ownerName: document.getElementById('st_ownerName').value.trim(),
        phone: document.getElementById('st_phone').value.trim(),
        businessType: document.getElementById('st_businessType').value,
        address: document.getElementById('st_address').value.trim()
    });
    refreshBrandChip();
    showToast('اطلاعات فروشگاه ذخیره شد', 'success');
}
window.saveStoreSettings = saveStoreSettings;

function saveFinanceSettings() {
    saveSettings({
        currency: document.getElementById('st_currency').value,
        taxEnabled: document.getElementById('st_taxEnabled').checked,
        taxPercent: num(document.getElementById('st_taxPercent').value) || 0
    });
    showToast('تنظیمات مالی ذخیره شد', 'success');
}
window.saveFinanceSettings = saveFinanceSettings;

function resetAllData() {
    if (!confirm('همه اطلاعات (مشتریان، کالاها، فاکتورها، هزینه‌ها، شرکا و ...) برای همیشه حذف می‌شود. ادامه می‌دهید؟')) return;
    if (!confirm('این عمل غیرقابل بازگشت است. برای تأیید نهایی دوباره تأیید کنید.')) return;
    if (fbUser) {
        // sign out first so the (now-empty) local state never gets auto-synced up and overwrites real cloud data
        try { fbAuth.signOut(); } catch (e) {}
    }
    Object.values(K).forEach(k => localStorage.removeItem(k));
    ['ap_last_backup_time', 'ap_local_last_modified', 'ap_last_cloud_sync', 'ap_backup_folder_name', 'ap_expense_categories'].forEach(k => localStorage.removeItem(k));
    indexedDB.deleteDatabase(BACKUP_DB_NAME);
    location.reload();
}
window.resetAllData = resetAllData;

/* ---------------------------------------------------------------------------
   Backup / restore
   ------------------------------------------------------------------------- */
const BACKUP_RETENTION_OPTIONS = [[14, '۱۴ روز'], [30, '۱ ماه'], [90, '۳ ماه'], [180, '۶ ماه'], [365, '۱ سال']];
function renderBackup() {
    const lastTime = localStorage.getItem('ap_last_backup_time');
    const hasFsSupport = !!window.showDirectoryPicker;
    const folderLinked = !!window._apBackupDirHandle;
    const savedFolderName = localStorage.getItem('ap_backup_folder_name');
    const log = _backupLogCache;
    const s = getSettings();
    const retentionDays = num(s.backupRetentionDays) || 365;
    return `
    ${viewHeader('سیستم', 'پشتیبان‌گیری و بازیابی', 'اطلاعات شما فقط روی همین مرورگر ذخیره می‌شود — برای انتقال به دستگاه دیگر یا نگهداری امن، فایل پشتیبان بگیرید.')}

    <div class="section-box">
        <div class="section-title">پشتیبان‌گیری خودکار</div>
        <p class="txt-body" style="margin-bottom:10px; color:var(--text-secondary);">با هر تغییر (ثبت فاکتور، کالا، هزینه و ...) به‌صورت خودکار یک نسخه پشتیبان کامل ذخیره می‌شود؛ این کار در همه مرورگرها (حتی سافاری و فایرفاکس) انجام می‌شود و نیازی به تنظیم اضافه ندارد. یک نسخه‌ی جداگانه هم برای هر روز نگه‌داری می‌شود.</p>
        <p class="txt-caption" style="margin-bottom:10px;">📍 محل ذخیره این پشتیبان خودکار: <strong>داخل حافظه مرورگر (IndexedDB)</strong> است، نه یک فایل قابل‌مشاهده روی سیستم شما — برای گرفتن یک فایل واقعی قابل‌مشاهده، از دکمه «دانلود» در تاریخچه پایین همین صفحه یا «دانلود فایل پشتیبان» زیر استفاده کنید.</p>
        ${lastTime ? `<p class="txt-caption" style="margin-bottom:10px;">آخرین پشتیبان خودکار: ${fmtDateTime(lastTime)}</p>` : ''}
        <div class="input-group">
            <label>مدت نگهداری پشتیبان‌های روزانه</label>
            <select id="st_backupRetention" onchange="saveBackupRetention()">
                ${BACKUP_RETENTION_OPTIONS.map(([d, l]) => `<option value="${d}" ${retentionDays === d ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
        </div>
        <p class="txt-body" style="margin:10px 0; color:var(--text-secondary);">علاوه بر این، در مرورگرهای مبتنی بر Chromium (Chrome، Edge، Brave) می‌توانید یک پوشه واقعی روی سیستم خود انتخاب کنید تا یک فایل پشتیبان به‌طور خودکار و بی‌صدا در همان پوشه هم به‌روزرسانی شود — این یک قابلیت اضافه و اختیاری است، نه جایگزین پشتیبان خودکار داخلی بالا.</p>
        <div class="build-stamp" style="border-color:var(--accent-amber);">
            💡 <strong>پیشنهاد محل ذخیره:</strong> ترجیحاً پوشه‌ای مثل <code>D:\Hesabdari-plus</code> — یعنی روی یک درایو غیر از درایوی که ویندوز/سیستم‌عامل روی آن نصب است — انتخاب کنید (نه پوشه‌ای داخل درایو C). این‌طور اگر روزی سیستم‌عامل از بین برود یا نیاز به نصب مجدد ویندوز باشد، فایل پشتیبان شما دست‌نخورده باقی می‌ماند. توجه: مرورگر به دلایل امنیتی اجازه انتخاب برخی پوشه‌های سیستمی (مثل خود درایو C یا پوشه Windows/System32) را نمی‌دهد؛ اگر پوشه‌ای که انتخاب کردید قبول نشد یا خطا داد، یعنی همان پوشه سیستمی بوده — یک پوشه دیگر (ترجیحاً روی درایو دیگر) انتخاب کنید. <br>📱 در نسخه موبایل/گوشی، پوشه <code>Download</code> دستگاه به‌طور طبیعی محل ذخیره فایل‌های دانلودی خواهد بود.
        </div>
        ${hasFsSupport ? `
            ${savedFolderName ? `<p class="txt-caption" style="margin-bottom:8px;">📁 پوشه انتخاب‌شده: <strong>${esc(savedFolderName)}</strong>${!folderLinked ? ' — برای فعال‌سازی مجدد در این جلسه، دوباره متصل کنید' : ''}</p>` : ''}
            <button class="btn-action" style="width:100%;" onclick="linkBackupFolder()">${folderLinked ? '✓ پوشه پشتیبان‌گیری متصل است — تغییر پوشه' : '📁 انتخاب پوشه پشتیبان‌گیری خودکار (اختیاری)'}</button>
        ` : `<p class="txt-caption">این مرورگر خاص از اتصال مستقیم به یک پوشه روی سیستم پشتیبانی نمی‌کند (این محدودیت خود مرورگر است)؛ پشتیبان خودکار داخلی بالا در این مرورگر هم به‌طور کامل فعال است، فقط برای گرفتن فایل از دکمه دانلود دستی زیر استفاده کنید.</p>`}
    </div>

    <div class="section-box">
        <div class="section-title">☁️ پشتیبان‌گیری روی گوگل‌درایو</div>
        ${fbUser ? `
            <p class="txt-body" style="color:var(--text-secondary); margin-bottom:10px;">یک فایل پشتیبان JSON مستقیماً در حساب گوگل‌درایو شما (${esc(fbUser.email)}) آپلود می‌شود — جدا و اضافه بر همگام‌سازی خودکار اطلاعات که از قبل فعال است.</p>
            <button class="btn-action" style="width:100%;" onclick="backupToGoogleDrive()">⬆ آپلود نسخه پشتیبان به گوگل‌درایو</button>
        ` : `<p class="txt-caption">برای استفاده از این گزینه، ابتدا از بالای صفحه یا تنظیمات، با حساب گوگل وارد شوید.</p>`}
    </div>

    <div class="section-box">
        <div class="section-title">دریافت فایل پشتیبان</div>
        <p class="txt-body" style="margin-bottom:12px; color:var(--text-secondary);">یک فایل JSON شامل تمام مشتریان، کالاها، فاکتورها، خریدها و هزینه‌های شما دانلود می‌شود.</p>
        <button class="calc-btn" onclick="exportBackup()">⬇ دانلود فایل پشتیبان</button>
    </div>

    <div class="section-box">
        <div class="section-title">بازیابی از فایل پشتیبان</div>
        <p class="txt-body" style="margin-bottom:12px; color:var(--text-secondary);">با انتخاب فایل، اطلاعات فعلی این دستگاه با محتوای فایل جایگزین می‌شود.</p>
        <input type="file" id="restoreFile" accept="application/json" style="margin-bottom:10px;">
        <button class="btn-action" style="width:100%;" onclick="importBackup()">⬆ بازیابی از فایل</button>
    </div>

    <div class="section-box">
        <div class="section-title">تاریخچه پشتیبان روزانه (${log.length.toLocaleString(localeForDigits())} از ${retentionDays.toLocaleString(localeForDigits())} روز مجاز)</div>
        ${log.length ? log.map(l => `<div class="list-item"><div class="list-item-row"><div class="list-item-title">${esc(l.jalaliLabel || l.date)}</div><button class="btn-action" onclick="downloadBackupLogEntry('${esc(l.date)}')">⬇ دانلود</button></div></div>`).join('') : `<div class="empty-state">هنوز نسخه پشتیبان روزانه‌ای ثبت نشده؛ بعد از اولین ثبت اطلاعات ساخته می‌شود.</div>`}
    </div>
    `;
}
VIEW_RENDERERS.backup = renderBackup;

function saveBackupRetention() {
    const el = document.getElementById('st_backupRetention');
    saveSettings({ backupRetentionDays: num(el.value) || 365 });
    backupLogTrim().then(refreshBackupLogCache);
    showToast('مدت نگهداری پشتیبان به‌روزرسانی شد', 'success');
}
window.saveBackupRetention = saveBackupRetention;

function downloadBackupLogEntry(date) {
    backupLogGet(date).then(entry => {
        if (!entry) return;
        saveJsonFile(`پشتیبان-${entry.jalaliLabel || date}.json`, entry.json);
    });
}
window.downloadBackupLogEntry = downloadBackupLogEntry;

async function saveJsonFile(filename, jsonText) {
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
            const writable = await handle.createWritable();
            await writable.write(jsonText);
            await writable.close();
            showToast(`فایل در «${handle.name}» ذخیره شد`, 'success');
            return;
        } catch (e) {
            if (e && e.name === 'AbortError') return; // user cancelled the picker
            // fall through to the plain-download fallback below
        }
    }
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('فایل در پوشه دانلود پیش‌فرض مرورگر ذخیره شد', 'success');
}

async function linkBackupFolder() {
    if (!window.showDirectoryPicker) { showToast('مرورگر شما از این قابلیت پشتیبانی نمی‌کند', 'error'); return; }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        window._apBackupDirHandle = handle;
        localStorage.setItem('ap_backup_folder_name', handle.name);
        showToast('پوشه پشتیبان‌گیری متصل شد: ' + handle.name, 'success');
        autoBackupTick();
        switchView('backup');
    } catch (e) {
        // user cancelled the picker — no error toast needed
    }
}
window.linkBackupFolder = linkBackupFolder;

function exportBackup() {
    const data = {};
    Object.entries(K).forEach(([name, key]) => { data[name] = JSON.parse(localStorage.getItem(key) || 'null'); });
    data.exportedAt = todayISO();
    data.app = 'حسابداری پلاس';
    const stamp = new Date().toISOString().slice(0, 10);
    saveJsonFile(`پشتیبان-حسابداری-${stamp}.json`, JSON.stringify(data, null, 2));
}
window.exportBackup = exportBackup;

function importBackup() {
    const fileInput = document.getElementById('restoreFile');
    const file = fileInput.files[0];
    if (!file) { showToast('یک فایل انتخاب کنید', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            Object.entries(K).forEach(([name, key]) => {
                if (data[name] !== undefined) localStorage.setItem(key, JSON.stringify(data[name]));
            });
            // Flag this so that if Google sign-in happens right after, autoReconcileCloud() asks
            // which copy to keep instead of silently auto-picking — since the person just made a
            // deliberate choice by restoring this specific file, we shouldn't silently overwrite it.
            localStorage.setItem('ap_manual_restore_pending_reconcile', '1');
            showToast('اطلاعات با موفقیت بازیابی شد', 'success');
            setTimeout(() => location.reload(), 900);
        } catch (err) {
            showToast('فایل پشتیبان معتبر نیست', 'error');
        }
    };
    reader.readAsText(file);
}
window.importBackup = importBackup;

/* ---------------------------------------------------------------------------
   Home (quick menu + fast invoice access) — this is the default opening page
   ------------------------------------------------------------------------- */
function renderHome() {
    const s = getSettings();
    const st = computeStats();
    return `
    ${viewHeader('خانه', 'خوش آمدید', (s.storeName || 'فروشگاه من') + ' — یکی از گزینه‌های زیر را انتخاب کنید')}
    <button class="calc-btn" style="margin-bottom:16px; font-size:1rem; padding:18px;" onclick="openInvoiceEditor()">🧾 فاکتور فروش جدید</button>
    <div class="qa-grid">
        <div class="qa-item" onclick="switchView('dashboard')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
            <span>داشبورد</span>
        </div>
        <div class="qa-item" onclick="openProductEditor()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>
            <span>کالای جدید</span>
        </div>
        <div class="qa-item" onclick="openCustomerEditor()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            <span>مشتری جدید</span>
        </div>
        <div class="qa-item" onclick="openPurchaseEditor()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
            <span>خرید جدید</span>
        </div>
        <div class="qa-item" onclick="switchView('invoices')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            <span>لیست فاکتورها</span>
        </div>
        <div class="qa-item" onclick="switchView('treasury')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg>
            <span>صندوق و بانک</span>
        </div>
        <div class="qa-item" onclick="switchView('checks')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            <span>چک‌ها</span>
        </div>
        <div class="qa-item" onclick="switchView('help')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>راهنما</span>
        </div>
    </div>
    <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${money(st.todaySales)}</div><div class="stat-label">فروش امروز</div></div>
        <div class="stat-card"><div class="stat-val" style="color:${st.cashBalance >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${money(st.cashBalance)}</div><div class="stat-label">موجودی صندوق</div></div>
    </div>
    `;
}
VIEW_RENDERERS.home = renderHome;

/* ---------------------------------------------------------------------------
   Help / Guide — full walkthrough for a first-time user
   ------------------------------------------------------------------------- */
const HELP_SECTIONS = [
    ['شروع کار', `وقتی برنامه را برای اولین بار باز می‌کنید، چند سؤال کوتاه درباره فروشگاه‌تان (نام فروشگاه، صنف، آدرس، مالیات) پرسیده می‌شود. این اطلاعات هر زمان از مسیر «تنظیمات» قابل ویرایش است. اگر «داده‌های نمونه» را فعال کنید، چند مشتری، کالا و فاکتور نمونه برای آشنایی با محیط برنامه ساخته می‌شود که هر زمان می‌توانید از «تنظیمات ← پاک کردن همه اطلاعات» حذف‌شان کنید.`],
    ['صفحه خانه', `اولین صفحه‌ای که باز می‌شود «خانه» است؛ یک منوی سریع برای ثبت فاکتور جدید و دسترسی به بخش‌های پرکاربرد. برای دیدن آمار و نمودارها به «داشبورد» بروید.`],
    ['ثبت فاکتور فروش', `از خانه یا از «فاکتورهای فروش ← دکمه +» وارد فرم فاکتور می‌شوید. ابتدا نوع سند (فاکتور رسمی یا پیش‌فاکتور) و روش پرداخت را انتخاب کنید. برای هر ردیف کالا، دکمه «انتخاب کالا» را بزنید تا پنجره‌ی دسته‌بندی‌شده (فولدری) با قابلیت جستجو باز شود. اگر کالا در انبار شما نیست و از یک همکار امانت گرفته‌اید، گزینه «★ کالای امانی از همکار» را بزنید و مشخصات را وارد کنید؛ این نوع کالا در انبار شما ثبت نمی‌شود و در فاکتور با علامت ★ مشخص می‌شود. در پایان تخفیف و مبلغ پرداختی را وارد و فاکتور را ثبت کنید. برای چاپ، دکمه «چاپ فاکتور» را بزنید.`],
    ['کالا و انبار', `کالاها به‌صورت خودکار بر اساس دسته‌بندی، در فولدرهایی گروه‌بندی می‌شوند. برای افزودن کالای جدید، دسته‌بندی را تایپ کنید — اگر دسته جدید باشد خودکار به لیست دسته‌ها اضافه می‌شود. کالاهایی که موجودی‌شان از «حداقل موجودی هشدار» کمتر شود، با برچسب قرمز «کم موجود» مشخص می‌شوند.`],
    ['مشتریان', `مشتریان بر اساس استان و شهر در فولدر گروه‌بندی می‌شوند. برای هر مشتری می‌توانید صورت‌حساب کامل (تاریخچه فاکتورها و مانده بدهی) را مشاهده و چاپ کنید.`],
    ['خرید از تأمین‌کننده', `مشابه فاکتور فروش، اما موجودی انبار شما را افزایش می‌دهد. کالای امانی از همکار در اینجا هم قابل ثبت است.`],
    ['صندوق و بانک', `تمام واریزها (از فاکتورهای فروش) و برداشت‌ها (خرید و هزینه‌ها) به‌صورت خودکار در این بخش نمایش داده می‌شوند. برای ثبت واریز/برداشت دستی (مثلاً سرمایه اولیه) از دکمه + استفاده کنید.`],
    ['چک‌ها', `چک‌های دریافتی و پرداختی را با تاریخ سررسید ثبت کنید؛ اگر سررسید چکی نزدیک باشد (۵ روز یا کمتر)، یادآوری در بالای صفحه نمایش داده می‌شود.`],
    ['انبارگردانی', `از مسیر «کالا و انبار ← بیشتر ← انبارگردانی» می‌توانید موجودی واقعی شمارش‌شده هر کالا را وارد کنید تا موجودی سیستم با آن اصلاح شود.`],
    ['بدهکاران و طلبکاران', `خلاصه‌ای از مشتریانی که به شما بدهکارند و تأمین‌کنندگانی که به آن‌ها بدهکارید، همراه با امکان چاپ.`],
    ['گزارش‌ها', `روند فروش ۶ ماه اخیر، پرفروش‌ترین کالاها، مشتریان برتر و سود خالص تخمینی. خروجی CSV و چاپ در دسترس است.`],
    ['چاپ و ظاهر برنامه', `از «تنظیمات ← چاپ و فاکتور» می‌توانید قالب چاپ (۹ طرح مختلف)، اندازه کاغذ (A4 / A5 / رول حرارتی ۸۰ و ۵۸ میلی‌متر)، جهت کاغذ و لوگوی فروشگاه را تنظیم کنید. از «تنظیمات ← ظاهر برنامه» فونت، اندازه فونت، تراکم چیدمان، حالت ارقام فارسی/انگلیسی، کنتراست بالا و فعال/غیرفعال بودن انیمیشن‌ها قابل تغییر است.`],
    ['پشتیبان‌گیری', `برنامه بعد از هر تغییر، خودکار یک نسخه پشتیبان در حافظه مرورگر نگه می‌دارد و هر روز یک نسخه پایان‌روز جداگانه می‌سازد (تا ۱۴ روز). برای اطمینان کامل، از «پشتیبان‌گیری ← دانلود فایل پشتیبان» به‌صورت دوره‌ای فایل JSON دانلود کنید یا (در Chrome/Edge) یک پوشه روی سیستم خود متصل کنید تا فایل به‌طور خودکار در همان پوشه به‌روزرسانی شود.`],
    ['نکته مهم درباره ذخیره‌سازی', `این نرم‌افزار کاملاً محلی (client-side) است و اطلاعات فقط در همان مرورگر/دستگاه شما ذخیره می‌شود؛ هیچ سروری اطلاعات شما را دریافت نمی‌کند. برای همگام‌سازی بین چند دستگاه یا دسترسی چندکاربره آنلاین، نیاز به افزودن یک سرویس بک‌اند (مانند Firebase) دارد که در نسخه فعلی پیاده‌سازی نشده است.`]
];

const APP_BUILD_LABEL = 'نسخه ۹ — بروزرسانی ۱۴ شهریور ۱۴۰۵ (باگ‌های بخش ۱ + حالت ساده/حرفه‌ای)';
function renderHelp() {
    return `
    ${viewHeader('سیستم', 'راهنمای کامل برنامه', 'آموزش گام‌به‌گام استفاده از حسابداری پلاس برای کاربران تازه‌کار')}
    <div class="build-stamp">🔖 ${esc(APP_BUILD_LABEL)} — اگر بعد از بروزرسانی، این عدد در برنامه‌تان همین را نشان نمی‌دهد، یعنی نسخه جدید هنوز روی گیت‌هاب/مرورگرتان جایگزین نشده؛ فایل‌ها را دوباره جایگزین و صفحه را کامل رفرش (Ctrl+Shift+R) کنید.</div>
    <button class="calc-btn" style="width:100%; margin-bottom:10px;" onclick="startAppTour()">🎯 شروع تور آموزشی نمایشی</button>
    <div class="section-box">
        ${HELP_SECTIONS.map((s, i) => `
        <div class="accordion-item">
            <div class="accordion-header" onclick="toggleHelpSection(${i})" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center; padding:12px 4px;">
                <strong>${i + 1}. ${esc(s[0])}</strong>
                <span id="helpChevron${i}">▾</span>
            </div>
            <div id="helpBody${i}" class="txt-body" style="display:none; padding:0 4px 12px; color:var(--text-secondary); line-height:1.9;">${esc(s[1])}</div>
        </div>`).join('')}
    </div>
    <button class="btn-action" style="width:100%;" onclick="switchView('about')">درباره برنامه</button>
    `;
}
VIEW_RENDERERS.help = renderHelp;

/* ---------------------------------------------------------------------------
   Guided demo tour — walks the user through every main section of the app
   with a step-by-step popup ("بعدی" / "پایان آموزش").
   ------------------------------------------------------------------------- */
const APP_TOUR_STEPS = [
    { view: 'dashboard', title: 'داشبورد', text: 'خلاصه وضعیت فروش، صندوق و هشدارهای مهم روزانه شما همیشه اینجا نمایش داده می‌شود.' },
    { view: 'invoices', title: 'فاکتور فروش', text: 'از این بخش فاکتور یا پیش‌فاکتور جدید ثبت می‌کنید؛ روش پرداخت (نقدی/کارت/چک/نسیه/حساب باز) هم همین‌جا انتخاب می‌شود.' },
    { view: 'products', title: 'کالاها و انبار', text: 'کالاها را دسته‌بندی‌شده (فولدری) مدیریت کنید و موجودی انبار را زیر نظر داشته باشید.' },
    { view: 'purchases', title: 'خرید از تأمین‌کننده', text: 'خریدهای خود از تأمین‌کنندگان را با همان روش‌های پرداخت متنوع ثبت کنید.' },
    { view: 'treasury', title: 'صندوق و بانک', text: 'موجودی نقدی، حساب‌های بانکی و کل گردش مالی فروشگاه از این‌جا کنترل می‌شود.' },
    { view: 'checks', title: 'چک‌ها', text: 'چک‌های دریافتی و پرداختی را با مشخصات کامل (بانک، شماره صیادی، سررسید) پیگیری کنید.' },
    { view: 'expenses', title: 'هزینه‌ها', text: 'هزینه‌های جاری فروشگاه را ثبت کنید؛ در صورت نیاز موضوع/دسته‌بندی جدید هم می‌توانید اضافه کنید.' },
    { view: 'payroll', title: 'حقوق پرسنل', text: 'پرسنل خود را ثبت کرده و حقوق آن‌ها را از صندوق نقدی یا با چک پرداخت کنید.' },
    { view: 'settlements', title: 'بدهکاران و طلبکاران', text: 'مشتریان بدهکار و بدهی به تأمین‌کنندگان را ببینید و تسویه حساب را مستقیماً از همین‌جا ثبت کنید.' },
    { view: 'reports', title: 'گزارش‌ها', text: 'گزارش‌های فروش، سود و زیان و تحلیل مشتریان و کالاها را با جزئیات کامل مشاهده و چاپ کنید.' },
    { view: 'settings', title: 'تنظیمات', text: 'قالب چاپ فاکتور، ظاهر برنامه، واحد پول و اطلاعات فروشگاه از همین بخش قابل تنظیم است.' },
    { view: 'backup', title: 'پشتیبان‌گیری', text: 'اطلاعات شما به‌طور خودکار پشتیبان‌گیری می‌شود؛ از این‌جا می‌توانید فایل پشتیبان دانلود یا بازیابی کنید.' }
];
let _tourStep = 0;
function startAppTour() { _tourStep = 0; showTourStep(); }
window.startAppTour = startAppTour;
function showTourStep() {
    const step = APP_TOUR_STEPS[_tourStep];
    if (!step) { endAppTour(); return; }
    switchView(step.view);
    setTimeout(() => renderTourPopup(step), 150);
}
function renderTourPopup(step) {
    let box = document.getElementById('tourPopup');
    if (!box) { box = document.createElement('div'); box.id = 'tourPopup'; box.className = 'tour-popup'; document.body.appendChild(box); }
    const isLast = _tourStep >= APP_TOUR_STEPS.length - 1;
    box.innerHTML = `
        <div class="tour-popup-progress">مرحله ${(_tourStep + 1).toLocaleString(localeForDigits())} از ${APP_TOUR_STEPS.length.toLocaleString(localeForDigits())}</div>
        <div class="tour-popup-title">${esc(step.title)}</div>
        <div class="tour-popup-text">${esc(step.text)}</div>
        <div class="tour-popup-actions">
            <button class="btn-action" onclick="endAppTour()">پایان آموزش</button>
            <button class="calc-btn" onclick="nextTourStep()">${isLast ? 'پایان ✓' : 'بعدی ›'}</button>
        </div>`;
}
function nextTourStep() { _tourStep += 1; showTourStep(); }
window.nextTourStep = nextTourStep;
function endAppTour() { const box = document.getElementById('tourPopup'); if (box) box.remove(); }
window.endAppTour = endAppTour;
function toggleHelpSection(i) {
    const body = document.getElementById('helpBody' + i);
    const chev = document.getElementById('helpChevron' + i);
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    if (chev) chev.textContent = open ? '▾' : '▴';
}
window.toggleHelpSection = toggleHelpSection;

/* ---------------------------------------------------------------------------
   About
   ------------------------------------------------------------------------- */
function renderAbout() {
    return `
    ${viewHeader('سیستم', 'درباره برنامه', '')}
    <div class="section-box" style="text-align:center;">
        <div class="onboard-logo" style="margin:0 auto 14px;"><img src="icons/icon-192.png" alt="لوگو"></div>
        <div class="txt-h2">حسابداری پلاس</div>
        <p class="txt-body" style="color:var(--text-secondary); margin:10px 0 18px;">نرم‌افزار حسابداری آنلاین فروشگاهی — مدیریت مشتریان، انبار، فاکتور، خرید، صندوق و گزارش‌های مالی.</p>
        <div class="totals-box" style="text-align:right;">
            <div class="totals-row"><span>ساخته‌شده توسط</span><span>مهرداد آزادگان</span></div>
            <div class="totals-row"><span>ایمیل</span><span dir="ltr">mehrdad2200@gmail.com</span></div>
            <div class="totals-row"><span>کانال تلگرام</span><span dir="ltr">t.me/favme</span></div>
        </div>
        <div class="action-grid" style="margin-top:16px;">
            <a class="btn-action" href="mailto:mehrdad2200@gmail.com" style="text-decoration:none; text-align:center;">✉ ارسال ایمیل</a>
            <a class="btn-action" href="https://t.me/favme" target="_blank" rel="noopener" style="text-decoration:none; text-align:center;">📣 کانال تلگرام</a>
        </div>
    </div>
    `;
}
VIEW_RENDERERS.about = renderAbout;

/* ---------------------------------------------------------------------------
   Bootstrap
   ------------------------------------------------------------------------- */
window.onload = function () {
    applySavedAppearance();
    refreshBrandChip();
    const s = getSettings();
    if (!s.onboarded) {
        startOnboarding();
    } else {
        switchView('home');
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    refreshBackupLogCache();
    initFullscreenButton();
    refreshCloudStatusChip();
    applyAppModeVisibility();
    initFirebase();
};
