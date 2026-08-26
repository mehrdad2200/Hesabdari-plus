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
    supplierPayments: 'ap_supplierpayments'
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
    openModal('انتخاب تاریخ', html);
}
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
    closeModal();
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

function openMoreMenu() {
    const items = [
        ['home', 'خانه'], ['dashboard', 'داشبورد'], ['invoices', 'فاکتور فروش'], ['products', 'کالا و انبار'],
        ['customers', 'مشتریان'], ['purchases', 'خرید از تأمین‌کننده'], ['treasury', 'صندوق و بانک'],
        ['checks', 'چک‌ها'], ['expenses', 'هزینه‌ها'], ['payroll', 'حقوق پرسنل'], ['settlements', 'بدهکاران و طلبکاران'],
        ['stocktake', 'انبارگردانی'], ['reports', 'گزارش‌ها'], ['backup', 'پشتیبان‌گیری'],
        ['help', 'راهنما'], ['about', 'درباره برنامه'], ['settings', 'تنظیمات']
    ];
    const html = items.map(([v, l]) => `
        <button class="btn-action" style="width:100%; justify-content:flex-start; margin-bottom:8px;" onclick="closeMoreMenu(); switchView('${v}')">${esc(l)}</button>
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
const EXPENSE_CATEGORIES_DEFAULT = ['اجاره مغازه', 'قبض برق', 'قبض آب و گاز', 'حقوق پرسنل', 'تبلیغات', 'تعمیر و نگهداری', 'حمل و نقل', 'متفرقه'];
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
let onboardState = { step: 1, storeName: '', ownerName: '', businessType: 'clothing', phone: '', address: '', currency: 'تومان', taxEnabled: false, taxPercent: 9, loadDemo: true };

function startOnboarding() {
    onboardState = { step: 1, storeName: '', ownerName: '', businessType: 'clothing', phone: '', address: '', currency: 'تومان', taxEnabled: false, taxPercent: 9, loadDemo: true };
    const overlay = document.getElementById('onboardOverlay');
    overlay.hidden = false;
    renderOnboard();
}

function renderOnboard() {
    const overlay = document.getElementById('onboardOverlay');
    const dots = [1, 2, 3].map(n => `<span class="onboard-dot ${n <= onboardState.step ? 'active' : ''}"></span>`).join('');
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
        <div class="settings-row" style="padding-inline:0;">
            <div>
                <div class="settings-row-label">بارگذاری داده‌های نمونه</div>
                <div class="settings-row-sub">چند مشتری، کالا و فاکتور نمونه برای آشنایی با برنامه اضافه شود</div>
            </div>
            <label class="switch"><input type="checkbox" id="ob_loadDemo" ${onboardState.loadDemo ? 'checked' : ''}><span class="switch-slider"></span></label>
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
            <button class="calc-btn" onclick="obNext()">${onboardState.step < 3 ? 'ادامه' : 'شروع کار با برنامه'}</button>
        </div>
    </div>`;
}

function obSelectBiz(id) { onboardState.businessType = id; renderOnboard(); }
window.obSelectBiz = obSelectBiz;

function obCollectStep() {
    if (onboardState.step === 1) {
        onboardState.storeName = document.getElementById('ob_storeName').value.trim();
        onboardState.ownerName = document.getElementById('ob_ownerName').value.trim();
        onboardState.phone = document.getElementById('ob_phone').value.trim();
    } else if (onboardState.step === 2) {
        onboardState.address = document.getElementById('ob_address').value.trim();
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
    if (onboardState.step < 3) {
        onboardState.step++;
        renderOnboard();
        return;
    }
    finishOnboarding();
}
function obPrev() {
    obCollectStep();
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
        onboarded: true
    });
    if (onboardState.loadDemo) {
        generateSeedData(onboardState.businessType);
    } else {
        dbWrite(K.products, []); dbWrite(K.customers, []); dbWrite(K.invoices, []);
        dbWrite(K.purchases, []); dbWrite(K.expenses, []); dbWrite(K.cashtx, []);
    }
    document.getElementById('onboardOverlay').hidden = true;
    refreshBrandChip();
    switchView('home');
    showToast('فروشگاه شما آماده شد!', 'success');
}

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
        `<button class="nav-btn" onclick="printListGeneric('customers')" title="چاپ لیست مشتریان"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);
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

function openCustomerEditor(id) {
    const c = id ? dbRead(K.customers).find(x => x.id === id) : null;
    const provNames = Object.keys(IRAN_PROVINCES);
    const html = `
        <div class="input-group"><label>نام مشتری *</label><input type="text" id="cf_name" value="${esc(c ? c.name : '')}" placeholder="نام و نام‌خانوادگی"></div>
        <div class="input-group"><label>شماره تماس</label><input type="text" id="cf_phone" value="${esc(c ? c.phone : '')}" placeholder="09xxxxxxxxx"></div>
        <div class="mini-form-grid">
            <div class="input-group"><label>استان</label>
                <select id="cf_province" onchange="cfRefreshCities()">
                    ${provNames.map(p => `<option value="${esc(p)}" ${c && c.province === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
                </select>
            </div>
            <div class="input-group"><label>شهر</label>
                <select id="cf_city"></select>
            </div>
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
    const cities = IRAN_PROVINCES[provSel.value] || [];
    citySel.innerHTML = cities.map(c => `<option value="${esc(c)}" ${presetCity === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
}
window.cfRefreshCities = cfRefreshCities;

function saveCustomer(id) {
    const name = document.getElementById('cf_name').value.trim();
    if (!name) { showToast('نام مشتری الزامی است', 'error'); return; }
    const list = dbRead(K.customers);
    const data = {
        name, phone: document.getElementById('cf_phone').value.trim(),
        province: document.getElementById('cf_province').value,
        city: document.getElementById('cf_city').value,
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
        `<button class="nav-btn" onclick="printListGeneric('products')" title="چاپ لیست انبار"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);

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
            </div>
            <div class="input-group"><label>واحد شمارش</label><input type="text" id="pf_unit" value="${esc(p ? p.unit : 'عدد')}" placeholder="عدد / کیلوگرم / بسته"></div>
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
    if (id) {
        const idx = list.findIndex(p => p.id === id);
        if (idx > -1) list[idx] = Object.assign(list[idx], data);
    } else {
        list.push(Object.assign({ id: uid('p'), createdAt: todayISO() }, data));
    }
    dbWrite(K.products, list);
    autoBackupTick();
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
                <div class="list-item-title">${inv.invoiceType === 'proforma' ? '<span class="badge badge-cyan" style="margin-inline-end:4px;">پیش‌فاکتور</span>' : ''}${esc(inv.customerNameSnapshot || 'مشتری نقدی')} <span class="txt-caption">#${inv.number}</span></div>
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
        `<button class="nav-btn" onclick="printListGeneric('invoices')" title="چاپ لیست فاکتورها"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`);

    const controls = `
    <div class="chip-row">
        <span class="chip ${invoiceFilter === 'all' ? 'active' : ''}" onclick="invoiceFilter='all'; rerenderIfActive('invoices')">همه</span>
        <span class="chip ${invoiceFilter === 'paid' ? 'active' : ''}" onclick="invoiceFilter='paid'; rerenderIfActive('invoices')">پرداخت‌شده</span>
        <span class="chip ${invoiceFilter === 'partial' ? 'active' : ''}" onclick="invoiceFilter='partial'; rerenderIfActive('invoices')">جزئی</span>
        <span class="chip ${invoiceFilter === 'unpaid' ? 'active' : ''}" onclick="invoiceFilter='unpaid'; rerenderIfActive('invoices')">پرداخت‌نشده</span>
    </div>
    <div class="search-bar">
        <input type="text" placeholder="جستجوی شماره فاکتور یا نام مشتری..." value="${esc(invoiceSearchTerm)}" oninput="invoiceSearchTerm=this.value; rerenderIfActive('invoices')">
        <button class="fab-add" onclick="openInvoiceEditor()" title="فاکتور جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>`;

    if (!list.length) return header + controls + `<div class="empty-state">فاکتوری یافت نشد.</div>`;
    return header + controls + `<div id="invoiceListWrap"></div><div style="display:none" id="invoiceFlatData">${esc(JSON.stringify(list.map(i => i.id)))}</div>`;
}
VIEW_RENDERERS.invoices = renderInvoices;

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

    const itemRows = d.items.map((it, idx) => `
        <div class="item-row ${it.isConsignment ? 'consignment-row' : ''}">
            <button class="item-pick-btn" onclick="openItemPicker('sale', ${idx})" type="button">
                ${it.isConsignment ? '<span class="badge badge-amber" style="margin-inline-end:4px;">★ امانی</span>' : ''}${esc(it.name) || '— انتخاب کالا —'}
            </button>
            <input type="text" inputmode="numeric" value="${num(it.qty)}" title="تعداد" oninput="diUpdate(${idx},'qty',this.value)">
            <input type="text" inputmode="numeric" value="${num(it.price)}" title="قیمت واحد" oninput="diUpdate(${idx},'price',this.value)">
            <input type="text" value="${moneyPlain(num(it.qty) * num(it.price))}" title="جمع" disabled>
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
    const interestAmount = d.paymentMethod === 'credit' ? creditInterestAmount(afterDiscount + taxAmount, d.paymentDetails) : 0;
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
        <div id="if_paymentDetailsBox">${paymentDetailsHtml('if', d.paymentMethod || 'cash', d.paymentDetails)}</div>
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

function diSetType(t) { draftInvoice.invoiceType = t; rerenderIfActive('invoiceNew'); }
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
function paymentDetailsHtml(prefix, method, pd) {
    pd = pd || {};
    const banks = dbRead(K.bankAccounts);
    if (method === 'cash') {
        return `<div class="pm-detail-box"><span class="badge badge-emerald">💵 از صندوق نقدی مغازه پرداخت/دریافت می‌شود</span></div>`;
    }
    if (method === 'card') {
        return `<div class="pm-detail-box">
            <div class="input-group"><label>نوع</label>
                <select id="${prefix}_cardType">
                    <option value="pos" ${pd.cardType !== 'transfer' ? 'selected' : ''}>دستگاه کارت‌خوان</option>
                    <option value="transfer" ${pd.cardType === 'transfer' ? 'selected' : ''}>کارت به کارت</option>
                </select>
            </div>
            <div class="input-group"><label>واریز به حساب</label>
                <select id="${prefix}_bankId">
                    <option value="">— انتخاب نشده —</option>
                    ${banks.map(b => `<option value="${b.id}" ${pd.bankAccountId === b.id ? 'selected' : ''}>${esc(b.bankName)} — ${esc(b.title)}</option>`).join('')}
                </select>
            </div>
            ${!banks.length ? `<p class="txt-caption">هنوز حسابی ثبت نشده؛ از «صندوق و بانک ← افزودن حساب بانکی» اضافه کنید.</p>` : ''}
        </div>`;
    }
    if (method === 'check') {
        return `<div class="pm-detail-box">
            <div class="mini-form-grid">
                <div class="input-group"><label>شماره چک</label><input type="text" id="${prefix}_ckNumber" value="${esc(pd.checkNumber || '')}"></div>
                <div class="input-group"><label>بانک</label><input type="text" id="${prefix}_ckBank" value="${esc(pd.bank || '')}"></div>
            </div>
            <div class="mini-form-grid">
                <div class="input-group"><label>شماره حساب</label><input type="text" id="${prefix}_ckAccNo" value="${esc(pd.accountNo || '')}"></div>
                <div class="input-group"><label>شماره صیادی</label><input type="text" inputmode="numeric" id="${prefix}_ckSayad" value="${esc(pd.sayadNo || '')}"></div>
            </div>
            ${jalaliDateField(prefix + '_ckDue', pd.dueDate || '', 'تاریخ سررسید چک')}
        </div>`;
    }
    if (method === 'credit') {
        return `<div class="pm-detail-box">
            ${jalaliDateField(prefix + '_crDue', pd.dueDate || '', 'موعد تسویه نسیه')}
            <div class="input-group"><label>سود نسیه (٪ در ماه)</label><input type="text" inputmode="numeric" id="${prefix}_crPercent" value="${esc(num(pd.monthlyPercent) || 0)}" oninput="${prefix === 'if' ? 'diRecalc()' : 'dpRecalc()'}" placeholder="مثلاً 4"></div>
            <p class="txt-caption">با تعیین موعد و درصد، مبلغ سود به‌صورت خودکار به جمع فاکتور اضافه می‌شود.</p>
        </div>`;
    }
    if (method === 'openaccount') {
        return `<div class="pm-detail-box">
            <div class="input-group"><label>توضیحات حساب باز</label><textarea id="${prefix}_oaNote" placeholder="توضیحات دلخواه">${esc(pd.note || '')}</textarea></div>
        </div>`;
    }
    return '';
}
function paymentDetailsCollect(prefix, method) {
    if (method === 'card') {
        return { cardType: (document.getElementById(prefix + '_cardType') || {}).value || 'pos', bankAccountId: (document.getElementById(prefix + '_bankId') || {}).value || '' };
    }
    if (method === 'check') {
        return {
            checkNumber: ((document.getElementById(prefix + '_ckNumber') || {}).value || '').trim(),
            bank: ((document.getElementById(prefix + '_ckBank') || {}).value || '').trim(),
            accountNo: ((document.getElementById(prefix + '_ckAccNo') || {}).value || '').trim(),
            sayadNo: ((document.getElementById(prefix + '_ckSayad') || {}).value || '').trim(),
            dueDate: getJalaliInputISO(prefix + '_ckDue')
        };
    }
    if (method === 'credit') {
        return { dueDate: getJalaliInputISO(prefix + '_crDue'), monthlyPercent: num((document.getElementById(prefix + '_crPercent') || {}).value) };
    }
    if (method === 'openaccount') {
        return { note: ((document.getElementById(prefix + '_oaNote') || {}).value || '').trim() };
    }
    return {};
}
function creditInterestAmount(baseAmount, pd) {
    if (!pd || !pd.dueDate || !num(pd.monthlyPercent)) return 0;
    const days = Math.max(0, Math.round((new Date(pd.dueDate) - new Date()) / 86400000));
    const months = Math.max(1, Math.ceil(days / 30));
    return Math.round(baseAmount * (num(pd.monthlyPercent) / 100) * months);
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
            <button class="btn-action" onclick="openConsignmentForm()" type="button">★ کالای امانی از همکار</button>
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
        closeModal(); rerenderIfActive('invoiceNew');
    } else {
        draftPurchase.items[pickerState.idx] = { productId: prod.id, name: prod.name, qty: draftPurchase.items[pickerState.idx].qty || 1, price: prod.buyPrice };
        closeModal(); rerenderIfActive('purchaseNew');
    }
}
window.pickerChoose = pickerChoose;

function pickerFreeText() {
    const name = prompt('نام کالا را وارد کنید:');
    if (!name) return;
    if (pickerState.kind === 'sale') {
        draftInvoice.items[pickerState.idx] = Object.assign(draftInvoice.items[pickerState.idx] || {}, { productId: '', name, isConsignment: false });
        closeModal(); rerenderIfActive('invoiceNew');
    } else {
        draftPurchase.items[pickerState.idx] = Object.assign(draftPurchase.items[pickerState.idx] || {}, { productId: '', name, isConsignment: false });
        closeModal(); rerenderIfActive('purchaseNew');
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
    if (pickerState.kind === 'sale') { draftInvoice.items[pickerState.idx] = item; closeModal(); rerenderIfActive('invoiceNew'); }
    else { draftPurchase.items[pickerState.idx] = item; closeModal(); rerenderIfActive('purchaseNew'); }
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
}
window.diUpdate = diUpdate;

function diAddRow() { draftInvoice.items.push({ productId: '', name: '', qty: 1, price: 0, discount: 0 }); rerenderIfActive('invoiceNew'); }
window.diAddRow = diAddRow;
function diRemoveRow(idx) {
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
    const pd = method === 'credit' ? paymentDetailsCollect('if', 'credit') : null;
    const interest = method === 'credit' ? creditInterestAmount(afterDiscount + tax, pd) : 0;
    const total = afterDiscount + tax + interest;
    const box = document.getElementById('invoiceTotalsBox');
    if (box) box.innerHTML = invoiceTotalsHtml(subtotal, discount, tax, total, paid, interest);
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
    if (box) box.innerHTML = paymentDetailsHtml('if', method, method === draftInvoice.paymentMethod ? draftInvoice.paymentDetails : {});
    diRecalc();
}
window.diOnPaymentMethodChange = diOnPaymentMethodChange;

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
    const interestAmount = paymentMethod === 'credit' ? creditInterestAmount(afterDiscount + taxAmount, paymentDetails) : 0;
    const total = afterDiscount + taxAmount + interestAmount;
    const paidAmount = Math.min(total, num(document.getElementById('if_paid').value));
    const status = paidAmount >= total && total > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');
    const note = document.getElementById('if_note').value.trim();
    const invoiceType = draftInvoice.invoiceType || 'invoice';
    const date = getJalaliInputISO('if_date') || draftInvoice.date || todayISO();

    const list = dbRead(K.invoices);
    let savedId = draftInvoice.id;
    if (draftInvoice.id) {
        const old = list.find(i => i.id === draftInvoice.id);
        if (old) adjustStock(old.items, +1);
        const idx = list.findIndex(i => i.id === draftInvoice.id);
        list[idx] = Object.assign(list[idx], {
            customerId, customerNameSnapshot: customer ? customer.name : 'مشتری نقدی',
            items, discountTotal, taxAmount, interestAmount, total, paidAmount, status, note, invoiceType, paymentMethod, paymentDetails, date
        });
        if (invoiceType !== 'proforma') adjustStock(items, -1);
    } else {
        savedId = uid('inv');
        list.push({
            id: savedId, number: draftInvoice.number, date, customerId,
            customerNameSnapshot: customer ? customer.name : 'مشتری نقدی', items, discountTotal, taxAmount, interestAmount, total,
            paidAmount, status, note, invoiceType, paymentMethod, paymentDetails
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
            <thead><tr><th>کالا</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th></tr></thead>
            <tbody>${inv.items.map(it => `<tr><td>${it.isConsignment ? '★ ' : ''}${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(it.qty * it.price)}</td></tr>`).join('')}</tbody>
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
                ${inv.items.map((it, i) => `<tr><td>${(i + 1).toLocaleString(localeForDigits())}</td><td class="text-cell">${it.isConsignment ? '★ ' : ''}${esc(it.name)}</td><td>${num(it.qty).toLocaleString(localeForDigits())}</td><td>${moneyPlain(it.price)}</td><td>${moneyPlain(it.qty * it.price)}</td></tr>`).join('')}
            </tbody>
        </table>
        ${inv.items.some(it => it.isConsignment) ? `<div class="txt-caption">★ کالای امانی از همکار</div>` : ''}
        <div class="bill-totals">
            <div class="totals-row"><span>جمع کل</span><span>${moneyPlain(inv.items.reduce((s2, it) => s2 + it.qty * it.price, 0))} ${esc(currencyLabel())}</span></div>
            ${inv.discountTotal ? `<div class="totals-row"><span>تخفیف</span><span>−${moneyPlain(inv.discountTotal)}</span></div>` : ''}
            ${inv.taxAmount ? `<div class="totals-row"><span>مالیات</span><span>${moneyPlain(inv.taxAmount)}</span></div>` : ''}
            <div class="totals-row grand"><span>مبلغ نهایی</span><span>${moneyPlain(inv.total)} ${esc(currencyLabel())}</span></div>
            <div class="totals-row"><span>پرداخت‌شده</span><span>${moneyPlain(inv.paidAmount)}</span></div>
            <div class="totals-row"><span>مانده حساب</span><span>${moneyPlain(remain)}</span></div>
        </div>
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

function renderPurchases() {
    const all = dbRead(K.purchases).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const term = purchaseSearchTerm.trim();
    const list = term ? all.filter(p => (p.supplier + String(p.number)).includes(term)) : all;
    const totalPayable = all.reduce((s, p) => s + Math.max(0, num(p.total) - num(p.paidAmount)), 0);

    return `
    ${viewHeader('خرید', 'خرید از تأمین‌کننده', `${all.length.toLocaleString(localeForDigits())} فاکتور خرید · بدهی به تأمین‌کنندگان: ${money(totalPayable)}`, `<button class="nav-btn" onclick="printListGeneric('purchases')" title="چاپ لیست خرید"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="search-bar">
        <input type="text" placeholder="جستجوی تأمین‌کننده یا شماره..." value="${esc(purchaseSearchTerm)}" oninput="purchaseSearchTerm=this.value; rerenderIfActive('purchases')">
        <button class="fab-add" onclick="openPurchaseEditor()" title="خرید جدید">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
    </div>
    ${list.length ? list.map(p => {
        const remain = Math.max(0, num(p.total) - num(p.paidAmount));
        return `
        <div class="list-item" style="cursor:pointer;" onclick="openPurchaseEditor('${p.id}')">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(p.supplier)} <span class="txt-caption">#${p.number}</span></div><div class="list-item-sub">${fmtDate(p.date)} · ${p.items.length.toLocaleString(localeForDigits())} قلم</div></div>
                <div style="text-align:left;"><div class="list-item-title">${money(p.total)}</div>${remain > 0 ? `<span class="badge badge-rose">بدهی ${moneyPlain(remain)}</span>` : `<span class="badge badge-emerald">تسویه</span>`}</div>
            </div>
        </div>`;
    }).join('') : `<div class="empty-state">خریدی ثبت نشده است.</div>`}`;
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
    const interestAmount = d.paymentMethod === 'credit' ? creditInterestAmount(rawTotal, d.paymentDetails) : 0;
    const total = rawTotal + interestAmount;

    return `
    ${viewHeader('خرید', d.id ? `ویرایش خرید #${d.number}` : 'ثبت خرید جدید', 'خرید از تأمین‌کننده یا همکار', `<button class="nav-btn" onclick="switchView('purchases')" title="بازگشت"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>`)}
    <div class="section-box">
        <div class="mini-form-grid">
            <div class="input-group"><label>نام تأمین‌کننده *</label>
                <input type="text" id="pf_supplier" list="pf_supplier_list" value="${esc(d.supplier)}" placeholder="نام فروشنده/عمده‌فروش" ondblclick="openSupplierPicker()">
                <datalist id="pf_supplier_list">${Array.from(new Set(dbRead(K.purchases).map(p => p.supplier).filter(Boolean))).map(s => `<option value="${esc(s)}">`).join('')}</datalist>
            </div>
            ${jalaliDateField('pf_date', d.date || todayISO(), 'تاریخ خرید')}
        </div>
        <div class="input-group"><label>روش پرداخت</label>
            <select id="pf_paymethod" onchange="dpOnPaymentMethodChange()">${PAYMENT_METHODS.map(([v, l]) => `<option value="${v}" ${(d.paymentMethod || 'cash') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        </div>
        <div id="pf_paymentDetailsBox">${paymentDetailsHtml('pf', d.paymentMethod || 'cash', d.paymentDetails)}</div>
    </div>
    <div class="section-box">
        <div class="item-row-head"><span>کالا</span><span>تعداد</span><span>قیمت خرید</span><span>جمع</span></div>
        <div id="purchRowsWrap">${itemRows}</div>
        <button class="btn-action" style="width:100%;" onclick="dpAddRow()" type="button">+ افزودن ردیف کالا</button>
    </div>
    <div class="section-box">
        <div class="input-group"><label>مبلغ پرداخت‌شده</label><input type="text" inputmode="numeric" id="pf_paid" value="${num(d.paidAmount)}" oninput="dpRecalc()"></div>
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
    return method === 'credit' ? creditInterestAmount(rawTotal, paymentDetailsCollect('pf', 'credit')) : 0;
}
function dpUpdate(idx, field, value) {
    draftPurchase.items[idx][field] = (field === 'qty' || field === 'price') ? num(value) : value;
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
function dpAddRow() { draftPurchase.items.push({ productId: '', name: '', qty: 1, price: 0 }); rerenderIfActive('purchaseNew'); }
window.dpAddRow = dpAddRow;
function dpRemoveRow(idx) {
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
    if (box) box.innerHTML = paymentDetailsHtml('pf', method, method === draftPurchase.paymentMethod ? draftPurchase.paymentDetails : {});
    dpRecalc();
}
window.dpOnPaymentMethodChange = dpOnPaymentMethodChange;
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
    const interestAmount = paymentMethod === 'credit' ? creditInterestAmount(rawTotal, paymentDetails) : 0;
    const total = rawTotal + interestAmount;
    const paidAmount = Math.min(total, num(document.getElementById('pf_paid').value));
    const status = paidAmount >= total && total > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');
    const date = getJalaliInputISO('pf_date') || draftPurchase.date || todayISO();

    const list = dbRead(K.purchases);
    let savedId = draftPurchase.id;
    if (draftPurchase.id) {
        const old = list.find(p => p.id === draftPurchase.id);
        if (old) adjustStockByName(old.items, -1);
        const idx = list.findIndex(p => p.id === draftPurchase.id);
        list[idx] = Object.assign(list[idx], { supplier, items, interestAmount, total, paidAmount, status, paymentMethod, paymentDetails, date });
        adjustStockByName(items, +1);
    } else {
        savedId = uid('pur');
        list.push({ id: savedId, number: draftPurchase.number, date, supplier, items, interestAmount, total, paidAmount, status, paymentMethod, paymentDetails });
        adjustStockByName(items, +1);
    }
    dbWrite(K.purchases, list);

    // Payment method "چک" on a purchase → automatically log the issued check in چک‌ها
    if (paymentMethod === 'check' && paymentDetails.dueDate) {
        const checks = dbRead(K.checks);
        const already = checks.find(c => c.linkedPurchaseId === savedId);
        const chkData = {
            who: supplier, direction: 'pay', amount: total,
            number: paymentDetails.checkNumber, bank: paymentDetails.bank, accountNo: paymentDetails.accountNo,
            sayadNo: paymentDetails.sayadNo, dueDate: paymentDetails.dueDate, status: 'pending', linkedPurchaseId: savedId
        };
        if (already) Object.assign(already, chkData); else checks.push(Object.assign({ id: uid('chk') }, chkData));
        dbWrite(K.checks, checks);
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
    ${viewHeader('مالی', 'هزینه‌ها', `${all.length.toLocaleString(localeForDigits())} ثبت · جمع کل: ${money(total)}`, `<button class="nav-btn" onclick="printListGeneric('expenses')" title="چاپ لیست هزینه‌ها"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
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
                <div><div class="list-item-title">${esc(e.name)}</div><div class="list-item-sub">${esc(e.role || '-')}${e.baseSalary ? ' · حقوق پایه: ' + moneyPlain(e.baseSalary) : ''}</div></div>
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
        baseSalary: num(document.getElementById('emp_salary').value), note: document.getElementById('emp_note').value.trim()
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
        <div id="pp_checkBox" style="display:none;" class="pm-detail-box">
            <div class="mini-form-grid">
                <div class="input-group"><label>شماره چک</label><input type="text" id="pp_ckNumber"></div>
                <div class="input-group"><label>بانک</label><input type="text" id="pp_ckBank"></div>
            </div>
            ${jalaliDateField('pp_ckDue', '', 'تاریخ سررسید چک')}
        </div>
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
        const dueDate = getJalaliInputISO('pp_ckDue') || date;
        const checks = dbRead(K.checks);
        checkId = uid('chk');
        checks.push({
            id: checkId, who: emp ? emp.name : '', direction: 'pay', amount,
            number: document.getElementById('pp_ckNumber').value.trim(), bank: document.getElementById('pp_ckBank').value.trim(),
            dueDate, status: 'pending', note: 'پرداخت حقوق: ' + note
        });
        dbWrite(K.checks, checks);
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
    const html = `
        <div class="input-group"><label>عنوان هزینه *</label><input type="text" id="ef_title" value="${esc(e ? e.title : '')}" placeholder="مثلاً: قبض برق مغازه"></div>
        <div class="input-group"><label>دسته‌بندی / موضوع</label>
            <select id="ef_category" onchange="if(this.value==='__new__'){document.getElementById('ef_newCatWrap').style.display='block';}else{document.getElementById('ef_newCatWrap').style.display='none';}">
                ${getExpenseCategories().map(c => `<option value="${esc(c)}" ${e && e.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                <option value="__new__">+ موضوع جدید…</option>
            </select>
        </div>
        <div class="input-group" id="ef_newCatWrap" style="display:none;"><label>عنوان موضوع جدید</label><input type="text" id="ef_newCat" placeholder="مثلاً: هزینه بسته‌بندی"></div>
        ${jalaliDateField('ef_date', e ? e.date : todayISO(), 'تاریخ')}
        <div class="input-group"><label>مبلغ *</label><input type="text" inputmode="numeric" id="ef_amount" value="${e ? num(e.amount) : ''}" placeholder="0"></div>
        <div class="input-group"><label>یادداشت</label><textarea id="ef_note">${esc(e ? e.note : '')}</textarea></div>
        <button class="calc-btn" onclick="saveExpense('${id || ''}')">${e ? 'ذخیره تغییرات' : 'ثبت هزینه'}</button>
        ${e ? `<button class="btn-action" style="width:100%; margin-top:8px; color:var(--accent-rose);" onclick="deleteExpense('${id}')">حذف هزینه</button>` : ''}
    `;
    openModal(e ? 'ویرایش هزینه' : 'هزینه جدید', html);
}
window.openExpenseEditor = openExpenseEditor;

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
    const list = dbRead(K.expenses);
    const date = getJalaliInputISO('ef_date') || todayISO();
    const data = { title, category, amount, date, note: document.getElementById('ef_note').value.trim() };
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
    const expenses = dbRead(K.expenses).map(e => ({ date: e.date, type: 'out', amount: e.amount, desc: 'هزینه: ' + e.title }));
    const manual = dbRead(K.cashtx).map(t => ({ date: t.date, type: t.type, amount: t.amount, desc: t.desc, manualId: t.id }));
    return [...invoices, ...purchases, ...expenses, ...manual].sort((a, b) => new Date(b.date) - new Date(a.date));
}

const CASHBOX_TYPES = [['cash', 'صندوق نقدی مغازه'], ['pos', 'دستگاه کارت‌خوان'], ['bank', 'حساب بانکی'], ['check', 'چک']];
function renderTreasury() {
    const ledger = treasuryLedger();
    const balance = ledger.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
    const banks = dbRead(K.bankAccounts);
    return `
    ${viewHeader('مالی', 'صندوق و بانک', 'گردش کامل وجوه نقد فروشگاه', `<button class="nav-btn" onclick="printLedgerList()" title="چاپ گردش صندوق"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>`)}
    <div class="stat-grid" style="grid-template-columns:1fr;">
        <div class="stat-card"><div class="stat-val" style="color:${balance >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${money(balance)}</div><div class="stat-label">موجودی فعلی صندوق نقدی</div></div>
    </div>

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
    ${ledger.length ? ledger.slice(0, 80).map(t => `
        <div class="list-item">
            <div class="list-item-row">
                <div><div class="list-item-title">${esc(t.desc)}</div><div class="list-item-sub">${fmtDate(t.date)}</div></div>
                <div class="list-item-title" style="color:${t.type === 'in' ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${t.type === 'in' ? '+' : '−'}${moneyPlain(t.amount)}</div>
            </div>
        </div>`).join('') : `<div class="empty-state">هنوز تراکنشی ثبت نشده است.</div>`}`;
}

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
                <div><div class="list-item-title">${esc(c.who)}</div><div class="list-item-sub">سررسید: ${fmtDate(c.dueDate)} · ${c.direction === 'receive' ? 'دریافتی' : 'پرداختی'}${c.bank ? ' · بانک ' + esc(c.bank) : ''}${c.number ? ' · چک ' + esc(c.number) : ''}</div></div>
                <div style="text-align:left;"><div class="list-item-title">${moneyPlain(c.amount)}</div>
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
}
window.openCheckEditor = openCheckEditor;

function saveCheck(id) {
    const who = document.getElementById('ck_who').value.trim();
    const amount = num(document.getElementById('ck_amount').value);
    const dueDate = getJalaliInputISO('ck_due');
    if (!who || !amount || !dueDate) { showToast('طرف حساب، مبلغ و تاریخ سررسید الزامی است', 'error'); return; }
    const list = dbRead(K.checks);
    const data = {
        who, direction: document.getElementById('ck_dir').value, amount,
        number: document.getElementById('ck_number').value.trim(),
        bank: document.getElementById('ck_bank').value.trim(),
        accountNo: document.getElementById('ck_accno').value.trim(),
        sayadNo: document.getElementById('ck_sayad').value.trim(),
        note: document.getElementById('ck_note').value.trim(),
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
    const all = dbRead(K.checks).slice().sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const rows = all.map(c => `<tr><td class="text-cell">${esc(c.who)}</td><td>${c.direction === 'receive' ? 'دریافتی' : 'پرداختی'}</td><td>${moneyPlain(c.amount)}</td><td>${fmtDate(c.dueDate)}</td><td>${c.status === 'pending' ? 'در انتظار' : c.status === 'cashed' ? 'وصول‌شده' : 'برگشتی'}</td></tr>`).join('');
    const html = `${billTemplateOpenTag()}${billHeaderHtml('لیست چک‌ها')}
        <table class="bill-table"><thead><tr><th>طرف حساب</th><th>نوع</th><th>مبلغ</th><th>سررسید</th><th>وضعیت</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ — لیست چک‌ها', html);
}
window.printChecksList = printChecksList;
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
function renderReports() {
    const invoices = dbRead(K.invoices);
    const purchases = dbRead(K.purchases);
    const expenses = dbRead(K.expenses);
    const products = dbRead(K.products);
    const invoiceCogs = (inv) => inv.items.reduce((s2, it) => { const p = products.find(x => x.id === it.productId); return s2 + (p ? num(p.buyPrice) : num(it.price) * 0.7) * num(it.qty); }, 0);

    const totalSales = invoices.reduce((s, i) => s + num(i.total), 0);
    const totalCOGS = invoices.reduce((s, i) => s + invoiceCogs(i), 0);
    const totalExpenses = expenses.reduce((s, e) => s + num(e.amount), 0);
    const totalPayroll = dbRead(K.payroll).reduce((s, p) => s + num(p.amount), 0);
    const grossProfit = totalSales - totalCOGS;
    const netProfit = grossProfit - totalExpenses - totalPayroll;
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

function openSettleCustomer(customerId) {
    const c = dbRead(K.customers).find(x => x.id === customerId);
    if (!c) return;
    const bal = customerBalance(customerId);
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">مانده بدهی فعلی <strong>${esc(c.name)}</strong>: ${money(bal)}</p>
        <div class="input-group"><label>مبلغ دریافتی *</label><input type="text" inputmode="numeric" id="stl_amount" value="${bal}"></div>
        ${jalaliDateField('stl_date', todayISO(), 'تاریخ')}
        <div class="input-group"><label>توضیحات</label><input type="text" id="stl_note" placeholder="مثلاً: پرداخت نقدی حضوری"></div>
        <button class="calc-btn" onclick="settleCustomer('${customerId}')">ثبت دریافت و تسویه</button>
    `;
    openModal('تسویه حساب مشتری', html);
}
window.openSettleCustomer = openSettleCustomer;
function settleCustomer(customerId) {
    let amount = num(document.getElementById('stl_amount').value);
    if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
    const date = getJalaliInputISO('stl_date') || todayISO();
    const note = document.getElementById('stl_note').value.trim();
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
    // any leftover beyond outstanding invoices is still logged as a manual cash-in so the treasury balance stays accurate
    const applied = amount - remaining;
    const tx = dbRead(K.cashtx);
    tx.push({ id: uid('tx'), date, type: 'in', amount, desc: `تسویه حساب مشتری: ${dbRead(K.customers).find(c => c.id === customerId)?.name || ''}${note ? ' — ' + note : ''}` });
    dbWrite(K.cashtx, tx);
    autoBackupTick();
    closeModal();
    showToast('تسویه حساب ثبت شد', 'success');
    switchView('settlements');
}
window.settleCustomer = settleCustomer;

function openSettleSupplier(name) {
    const suppliers = {};
    dbRead(K.purchases).forEach(p => { const r = Math.max(0, num(p.total) - num(p.paidAmount)); if (p.supplier === name && r > 0) suppliers[name] = (suppliers[name] || 0) + r; });
    const bal = suppliers[name] || 0;
    const html = `
        <p class="txt-caption" style="margin-bottom:10px;">مانده بدهی فعلی به <strong>${esc(name)}</strong>: ${money(bal)}</p>
        <div class="input-group"><label>مبلغ پرداختی *</label><input type="text" inputmode="numeric" id="stl_amount" value="${bal}"></div>
        ${jalaliDateField('stl_date', todayISO(), 'تاریخ')}
        <div class="input-group"><label>توضیحات</label><input type="text" id="stl_note"></div>
        <button class="calc-btn" onclick="settleSupplier('${esc(name).replace(/'/g, "\\'")}')">ثبت پرداخت و تسویه</button>
    `;
    openModal('تسویه حساب تأمین‌کننده', html);
}
window.openSettleSupplier = openSettleSupplier;
function settleSupplier(name) {
    let amount = num(document.getElementById('stl_amount').value);
    if (!amount) { showToast('مبلغ را وارد کنید', 'error'); return; }
    const date = getJalaliInputISO('stl_date') || todayISO();
    const note = document.getElementById('stl_note').value.trim();
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
    const tx = dbRead(K.cashtx);
    tx.push({ id: uid('tx'), date, type: 'out', amount, desc: `تسویه حساب تأمین‌کننده: ${name}${note ? ' — ' + note : ''}` });
    dbWrite(K.cashtx, tx);
    autoBackupTick();
    closeModal();
    showToast('تسویه حساب ثبت شد', 'success');
    switchView('settlements');
}
window.settleSupplier = settleSupplier;

function printSettlements() {
    const customers = dbRead(K.customers).map(c => ({ name: c.name, bal: customerBalance(c.id) })).filter(c => c.bal > 0).sort((a, b) => b.bal - a.bal);
    const suppliers = {};
    dbRead(K.purchases).forEach(p => { const r = Math.max(0, num(p.total) - num(p.paidAmount)); if (r > 0) suppliers[p.supplier] = (suppliers[p.supplier] || 0) + r; });
    const supplierList = Object.entries(suppliers).sort((a, b) => b[1] - a[1]);
    const html = `${billTemplateOpenTag()}${billHeaderHtml('گزارش بدهکاران و طلبکاران')}
        <div class="section-title">مشتریان بدهکار</div>
        <table class="bill-table"><thead><tr><th>مشتری</th><th>مانده بدهی</th></tr></thead><tbody>${customers.map(c => `<tr><td class="text-cell">${esc(c.name)}</td><td>${moneyPlain(c.bal)}</td></tr>`).join('') || '<tr><td colspan="2">-</td></tr>'}</tbody></table>
        <div class="section-title" style="margin-top:14px;">بدهی به تأمین‌کنندگان</div>
        <table class="bill-table"><thead><tr><th>تأمین‌کننده</th><th>مانده بدهی</th></tr></thead><tbody>${supplierList.map(([n, a]) => `<tr><td class="text-cell">${esc(n)}</td><td>${moneyPlain(a)}</td></tr>`).join('') || '<tr><td colspan="2">-</td></tr>'}</tbody></table>
    </div>${printFooterButton()}`;
    openModal('پیش‌نمایش چاپ — بدهکاران و طلبکاران', html);
}
window.printSettlements = printSettlements;

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
        if (counted !== num(p.qty)) diffs.push({ name: p.name, before: p.qty, after: counted });
        p.qty = counted;
    });
    dbWrite(K.products, products);
    const takes = dbRead(K.stocktakes);
    takes.push({ id: uid('stk'), date: todayISO(), diffs });
    dbWrite(K.stocktakes, takes);
    autoBackupTick();
    showToast(`انبارگردانی ثبت شد (${diffs.length.toLocaleString(localeForDigits())} مورد اصلاح شد)`, 'success');
    switchView('products');
}
window.applyStocktake = applyStocktake;

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
    if (!confirm('همه اطلاعات (مشتریان، کالاها، فاکتورها، هزینه‌ها) برای همیشه حذف می‌شود. ادامه می‌دهید؟')) return;
    if (!confirm('این عمل غیرقابل بازگشت است. برای تأیید نهایی دوباره تأیید کنید.')) return;
    Object.values(K).forEach(k => localStorage.removeItem(k));
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
    const log = _backupLogCache;
    const s = getSettings();
    const retentionDays = num(s.backupRetentionDays) || 365;
    return `
    ${viewHeader('سیستم', 'پشتیبان‌گیری و بازیابی', 'اطلاعات شما فقط روی همین مرورگر ذخیره می‌شود — برای انتقال به دستگاه دیگر یا نگهداری امن، فایل پشتیبان بگیرید.')}

    <div class="section-box">
        <div class="section-title">پشتیبان‌گیری خودکار</div>
        <p class="txt-body" style="margin-bottom:10px; color:var(--text-secondary);">با هر تغییر (ثبت فاکتور، کالا، هزینه و ...) به‌صورت خودکار یک نسخه پشتیبان کامل ذخیره می‌شود؛ این کار در همه مرورگرها (حتی سافاری و فایرفاکس) انجام می‌شود و نیازی به تنظیم اضافه ندارد. یک نسخه‌ی جداگانه هم برای هر روز نگه‌داری می‌شود.</p>
        ${lastTime ? `<p class="txt-caption" style="margin-bottom:10px;">آخرین پشتیبان خودکار: ${fmtDateTime(lastTime)}</p>` : ''}
        <div class="input-group">
            <label>مدت نگهداری پشتیبان‌های روزانه</label>
            <select id="st_backupRetention" onchange="saveBackupRetention()">
                ${BACKUP_RETENTION_OPTIONS.map(([d, l]) => `<option value="${d}" ${retentionDays === d ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
        </div>
        <p class="txt-body" style="margin:10px 0; color:var(--text-secondary);">علاوه بر این، در مرورگرهای مبتنی بر Chromium (Chrome، Edge، Brave) می‌توانید یک پوشه واقعی روی سیستم خود انتخاب کنید تا یک فایل پشتیبان به‌طور خودکار و بی‌صدا در همان پوشه هم به‌روزرسانی شود — این یک قابلیت اضافه و اختیاری است، نه جایگزین پشتیبان خودکار داخلی بالا.</p>
        ${hasFsSupport ? `
            <button class="btn-action" style="width:100%;" onclick="linkBackupFolder()">${folderLinked ? '✓ پوشه پشتیبان‌گیری متصل است — تغییر پوشه' : '📁 انتخاب پوشه پشتیبان‌گیری خودکار (اختیاری)'}</button>
        ` : `<p class="txt-caption">این مرورگر خاص از اتصال مستقیم به یک پوشه روی سیستم پشتیبانی نمی‌کند (این محدودیت خود مرورگر است)؛ پشتیبان خودکار داخلی بالا در این مرورگر هم به‌طور کامل فعال است، فقط برای گرفتن فایل از دکمه دانلود دستی زیر استفاده کنید.</p>`}
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

    <div class="section-box">
        <div class="section-title">اتصال آنلاین (گیت‌هاب + ورود با گوگل)</div>
        <p class="txt-body" style="color:var(--text-secondary);">این نسخه از برنامه کاملاً سمت کاربر (client-side) است و فقط روی همین مرورگر اطلاعات را ذخیره می‌کند. برای میزبانی روی گیت‌هاب و «ورود با گوگل» واقعی (که اطلاعات را بین دستگاه‌های مختلف همگام کند)، نیاز به یک سرویس بک‌اند و احراز هویت (مثل Firebase Authentication + Firestore) است که باید جداگانه و با اطلاعات پروژه/کلید شما تنظیم شود؛ این بخش در نسخه فعلی پیاده‌سازی نشده.</p>
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
        const blob = new Blob([entry.json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `پشتیبان-${entry.jalaliLabel || date}.json`; a.click();
        URL.revokeObjectURL(url);
    });
}
window.downloadBackupLogEntry = downloadBackupLogEntry;

async function linkBackupFolder() {
    if (!window.showDirectoryPicker) { showToast('مرورگر شما از این قابلیت پشتیبانی نمی‌کند', 'error'); return; }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        window._apBackupDirHandle = handle;
        showToast('پوشه پشتیبان‌گیری متصل شد', 'success');
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
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `پشتیبان-حسابداری-${stamp}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast('فایل پشتیبان دانلود شد', 'success');
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

function renderHelp() {
    return `
    ${viewHeader('سیستم', 'راهنمای کامل برنامه', 'آموزش گام‌به‌گام استفاده از حسابداری پلاس برای کاربران تازه‌کار')}
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
};
