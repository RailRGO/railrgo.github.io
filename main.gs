// === CONFIG ===
const CONFIG = {
  BRAND_NAME: 'Онлайн‑уроки',
  CALENDAR_ID: '',
  SERVICE_TZ: 'Europe/Moscow',

  DEFAULT_DURATION_MIN: 50,
  SEND_INVITES: true,

  // Таблица со слотами
  SPREADSHEET_ID: '',
  SHEET_NAME: '',

  // Админ‑панель
  ADMIN_TOKEN: '',
  SITE_URL: '',
  WEBAPP_URL: '',

  // Окна времени и шаг
  DEFAULT_WK_START: '17:00',
  DEFAULT_WK_END:   '19:00',
  DEFAULT_WE_START: '8:00',
  DEFAULT_WE_END:   '13:00',
  DEFAULT_STEP_MIN: 60,

  // Telegram: админ и ученик — одним ботом
  TELEGRAM: {
    ENABLED: true,
    BOT_TOKEN: '',
    CHAT_ID: , // админ-уведомления
    PARSE_MODE: 'HTML',
    BOT_USERNAME: ''
  }
};

function ensureTelegramWebhook(force) {
  const cfg = CONFIG.TELEGRAM || {};
  if (!cfg.ENABLED || !cfg.BOT_TOKEN) return { ok:false, skipped:true, reason:'disabled' };

  const url = (getWebAppUrl() || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    return { ok:false, error:'Invalid Web App URL', url };
  }

  const props = PropertiesService.getScriptProperties();
  const keyUrl = 'tg_webhook_url';
  const keyTs  = 'tg_webhook_ts';
  const lastUrl = props.getProperty(keyUrl) || '';
  const lastTs  = parseInt(props.getProperty(keyTs) || '0', 10) || 0;

  // TTL 3 дня — чтобы зря не дёргать Telegram
  const ttlMs = 3 * 24 * 3600 * 1000;
  if (!force && lastUrl === url && (Date.now() - lastTs) < ttlMs) {
    return { ok:true, skipped:true, url };
  }

  const api = 'https://api.telegram.org/bot' + cfg.BOT_TOKEN + '/setWebhook';
  const res = UrlFetchApp.fetch(api, {
    method: 'post',
    payload: { url, drop_pending_updates: 'true' },
    muteHttpExceptions: true
  });
  const body = res.getContentText() || '';
  const ok = res.getResponseCode() === 200 && /"ok"\s*:\s*true/.test(body);
  if (ok) {
    props.setProperty(keyUrl, url);
    props.setProperty(keyTs, String(Date.now()));
  }
  return { ok, http: res.getResponseCode(), body, url };
}

function setTelegramWebhook(){ return ensureTelegramWebhook(true); }
function deleteTelegramWebhook(){
  const cfg = CONFIG.TELEGRAM || {};
  const api = 'https://api.telegram.org/bot'+cfg.BOT_TOKEN+'/deleteWebhook';
  const res = UrlFetchApp.fetch(api, { method:'post', muteHttpExceptions:true });
  Logger.log('deleteWebhook: %s', res.getContentText());
}
function getWebhookInfo(){
  const cfg = CONFIG.TELEGRAM || {};
  const api = 'https://api.telegram.org/bot'+cfg.BOT_TOKEN+'/getWebhookInfo';
  const res = UrlFetchApp.fetch(api, { method:'get', muteHttpExceptions:true });
  Logger.log('getWebhookInfo: %s', res.getContentText());
}

// ===== Handlers =====
function doGet(e) {
  const a = e && e.parameter && e.parameter.action;

  // Ленивая установка webhook (не чаще 1 раза/3 дня, либо при смене URL)
  try { ensureTelegramWebhook(false); } catch(_) {}

  try {
    if (a === 'slots')              return getSlotsApi((e.parameter.date || '').trim());
    if (a === 'nextOpenDate')       return getNextOpenDate();
    if (a === 'admin')              return adminPage(e);
    if (a === 'adminFreeSlot')      return adminFreeSlot(e);
    if (a === 'adminSetStatus')     return adminSetStatus(e);
    if (a === 'adminAddSlot')       return adminAddSlot(e);
    if (a === 'adminAddBulk')       return adminAddBulk(e);
    if (a === 'adminAddBulkPreset') return adminAddBulkPreset(e);
    if (a === 'adminClearRange')    return adminClearRange(e);
    if (a === 'exportCSV')          return exportCSV(e);
    if (a === 'debugSlot')          return debugSlot(e);
    if (a === 'debug')              return debugPing();
    if (a === 'ensureWebhook')      return ensureWebhookHandler(e);

    return ContentService
      .createTextOutput(JSON.stringify({ ok:true, service:'booking', version:20 }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return htmlError('doGet error', err);
  }
}

function ensureWebhookHandler(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);
  const res = ensureTelegramWebhook(true);
  const ok = !!res.ok || !!res.skipped;
  return htmlBox('Webhook: <pre style="white-space:pre-wrap">'+escapeHtml(JSON.stringify(res, null, 2))+'</pre>', !ok);
}

function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) throw new Error('Empty body');

    let data = {};
    try { data = JSON.parse(e.postData.contents); } catch(_){ data = {}; }

    // Ветка: Telegram webhook (update)
    if (data && (data.update_id || data.message || data.callback_query || data.my_chat_member)) {
      handleTelegramUpdate(data);
      return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
    }

    // Ветка: бронирование с сайта
    const name = (data.name || '').trim();
    const email = (data.email || '').trim();
    const subject = (data.subject || 'Математика/Физика').trim();
    const startIso = (data.startIso || '').trim();
    const channel = (data.channel || 'email').trim().toLowerCase();
    const phoneRaw = (data.phone || '').trim();
    const phoneE164 = channel === 'telegram' ? normalizePhoneE164(phoneRaw) : '';

    if (!name || !startIso) throw new Error('Не хватает полей: name/startIso');
    if (channel === 'email' && !email) return json({ ok:false, error:'email_required' });
    if (channel === 'telegram' && !phoneE164) return json({ ok:false, error:'phone_required' });

    const start = new Date(startIso); // UTC
    if (start.getTime() < Date.now() - 2*60000)
      return json({ ok:false, reason:'past', message:'Нельзя записаться на прошедшее время.' });

    // Компоненты в МСК
    const ymd = Utilities.formatDate(start, CONFIG.SERVICE_TZ, 'yyyy-MM-dd');
    const dmy = ymdToDmy(ymd);
    const timeHHmm = Utilities.formatDate(start, CONFIG.SERVICE_TZ, 'HH:mm');

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const lock = LockService.getScriptLock(); lock.tryLock(10000);

    // Поиск строки
    const all = sh.getDataRange().getValues();
    let idx = findSlotRowIndex(all, dmy, timeHHmm);
    if (idx < 1) {
      const y = +ymd.slice(0,4), m = +ymd.slice(5,7), d = +ymd.slice(8,10);
      const hh = +timeHHmm.slice(0,2), mm = +timeHHmm.slice(3,5);
      idx = findSlotRowIndexByInstant(all, makeZonedDate(y, m, d, hh, mm, CONFIG.SERVICE_TZ), CONFIG.SERVICE_TZ);
    }
    if (idx < 1) { try{lock.releaseLock();}catch(_){};
      return json({ ok:false, reason:'closed', message:'Слот не найден или недоступен.' }); }

    const row = all[idx];
    const status = (row[3] || '').toString().trim().toLowerCase();
    const duration = parseInt(row[2] || CONFIG.DEFAULT_DURATION_MIN, 10) || CONFIG.DEFAULT_DURATION_MIN;
    if (status !== 'open') { try{lock.releaseLock();}catch(_){};
      return json({ ok:false, reason:'busy', message:'Этот слот уже занят или закрыт.' }); }

    // Проверка в календаре
    const y = +ymd.slice(0,4), m = +ymd.slice(5,7), d = +ymd.slice(8,10);
    const hh = +timeHHmm.slice(0,2), mm = +timeHHmm.slice(3,5);
    const startMsk = makeZonedDate(y, m, d, hh, mm, CONFIG.SERVICE_TZ);
    const end = new Date(startMsk.getTime() + duration*60000);

    const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    if (!cal) { try{lock.releaseLock();}catch(_){};
      throw new Error('Календарь не найден по ID: ' + CONFIG.CALENDAR_ID); }
    if (cal.getEvents(startMsk, end).length > 0) { try{lock.releaseLock();}catch(_){};
      return json({ ok:false, reason:'busy', message:'Этот слот уже занят.' }); }

    // Создание события
    const title = `Урок (${subject}) — ${name}`;
    const description =
      `Бронирование со страницы (${CONFIG.BRAND_NAME})\n` +
      `Ученик: ${name} ${email ? `<${email}>` : ''}\n` +
      `Канал уведомлений: ${channel}${phoneE164 ? ' ' + phoneE164 : ''}\n` +
      `Предмет: ${subject}\n` +
      `Слот: ${dmy} ${timeHHmm} (МСК)\n` +
      `Длительность: ${duration} минут\n` +
      `Создано автоматически (Apps Script)`;

    const eventOptions = { description };
    if (channel === 'email' && email) {
      eventOptions.guests = email;
      eventOptions.sendInvites = CONFIG.SEND_INVITES;
    }
    const event = cal.createEvent(title, startMsk, end, eventOptions);
    try { event.addEmailReminder(24*60); event.addPopupReminder(10); } catch(_){}

    // Отметить бронь в таблице
    const nowStr = Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss');
    sh.getRange(idx+1, 4).setValue('booked');         // Status
    sh.getRange(idx+1, 5).setValue(event.getId());    // EventId
    sh.getRange(idx+1, 6).setValue(name);             // StudentName
    sh.getRange(idx+1, 7).setValue(email);            // StudentEmail
    sh.getRange(idx+1, 8).setValue(subject);          // Subject
    sh.getRange(idx+1, 9).setValue(nowStr);           // UpdatedAt

    try{lock.releaseLock();}catch(_){}

    // Админу в TG
    try {
      const adminUrl = getWebAppUrl() + '?action=admin&token=' + encodeURIComponent(CONFIG.ADMIN_TOKEN);
      const msg =
        '🧑‍🎓 <b>Новая запись</b>\n' +
        'Имя: <b>' + escapeHtml(name) + '</b>\n' +
        (email ? ('Email: <code>' + escapeHtml(email) + '</code>\n') : '') +
        (channel === 'telegram' && phoneE164 ? ('Тел.: <code>' + escapeHtml(phoneE164) + '</code>\n') : '') +
        'Предмет: <b>' + escapeHtml(subject) + '</b>\n' +
        'Время: <b>' + dmy + ' ' + timeHHmm + ' МСК</b>\n' +
        'Канал: <b>' + escapeHtml(channel) + '</b>\n' +
        '<a href="' + adminUrl + '">Открыть админку</a>';
      tgSendAdmin(msg);
    } catch(_) {}

    // Ученик в TG (если выбран Telegram)
    let tgInfo = null;
    if (channel === 'telegram' && phoneE164) {
      const whenLabel = `${dmy} ${timeHHmm} МСК`;
      const stuText = `✅ Вы записаны на ${whenLabel} (50 мин)\nПредмет: ${subject}\nЕсли нужно перенести — просто ответьте на это сообщение.`;
      tgInfo = notifyStudentTelegram(phoneE164, stuText);
    }

    return json({ ok:true, startIso: startMsk.toISOString(), endIso: end.toISOString(), channel, tg: tgInfo });

  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}

// ===== API: слоты и ближайшая дата =====
function getSlotsApi(ymd) {
  try {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return json({ ok:false, error:'Некорректная дата' });
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const all = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < all.length; i++) {
      const r = all[i];
      const dYmd = normalizeDateCellToYmd(r[0]);
      const tHHmm = normalizeTimeCellToHHmm(r[1]);
      const status = (r[3] || '').toString().trim().toLowerCase();
      if (dYmd === ymd && status === 'open' && tHHmm) {
        const y = +ymd.slice(0,4), m = +ymd.slice(5,7), d = +ymd.slice(8,10);
        const hh = +tHHmm.slice(0,2), mm = +tHHmm.slice(3,5);
        const dt = makeZonedDate(y,m,d,hh,mm,CONFIG.SERVICE_TZ);
        if (dt.getTime() > Date.now() + 2*60000)
          rows.push({ startIso: dt.toISOString(), label: `${tHHmm} МСК` });
      }
    }
    rows.sort((a,b) => a.startIso.localeCompare(b.startIso));
    return json({ ok:true, slots: rows });

  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}

function getNextOpenDate() {
  try {
    const now = new Date();
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const all = sh.getDataRange().getValues();
    let best = null;
    for (let i = 1; i < all.length; i++) {
      const r = all[i];
      if ((r[3] || '').toString().trim().toLowerCase() !== 'open') continue;
      const ymd = normalizeDateCellToYmd(r[0]);
      const hhmm = normalizeTimeCellToHHmm(r[1]);
      if (!ymd || !hhmm) continue;

      const y = +ymd.slice(0,4), m = +ymd.slice(5,7), d = +ymd.slice(8,10);
      const hh = +hhmm.slice(0,2), mm = +hhmm.slice(3,5);
      const dt = makeZonedDate(y,m,d,hh,mm,CONFIG.SERVICE_TZ);
      const ts = dt.getTime();
      if (ts <= now.getTime() + 2*60000) continue;
      if (!best || ts < best.ts) best = { dateYmd: ymd, ts };
    }
    return json({ ok:true, date: best ? best.dateYmd : null });

  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}

// ===== Admin page =====
function adminPage(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);

  const flashMsg = e.parameter.msg || '';
  const flashOk = (e.parameter.ok || '') === '1';
  const W = getWebAppUrl();

  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);
    const all = sh.getDataRange().getValues();

    const today = Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd');
    const until = Utilities.formatDate(new Date(Date.now() + 60*86400000), CONFIG.SERVICE_TZ, 'yyyy-MM-dd');

    const rows = [];
    for (let i = 1; i < all.length; i++) {
      const r = all[i];
      const ymd = normalizeDateCellToYmd(r[0]);
      const hhmm = normalizeTimeCellToHHmm(r[1]) || '00:00';
      if (!ymd || ymd < today || ymd > until) continue;
      rows.push({
        idx: i,
        ymd,
        dateDmy: ymdToDmy(ymd),
        time: hhmm,
        sortKey: `${ymd} ${hhmm}`,
        dur: r[2], status: r[3], eventId: r[4], name: r[5], email: r[6], subj: r[7]
      });
    }
    rows.sort((a,b) => a.sortKey.localeCompare(b.sortKey));

    const css =
      'body{font:16px system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;background:#0b1020;color:#e5e7eb}' +
      'a{color:#93c5fd;text-decoration:none} ' +
      'input{padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06);color:#e5e7eb}' +
      'label{margin-right:8px;display:inline-flex;gap:8px;align-items:center}' +
      '.row{margin:8px 0}' +
      '.tbl{border-collapse:collapse;width:100%;margin-top:12px}' +
      '.tbl td,.tbl th{border:1px solid rgba(255,255,255,.15);padding:8px}' +
      '.tbl th{background:rgba(255,255,255,.08)}' +
      '.muted{color:#9aa5b1}' +
      '.btn{display:inline-block;background:#4f46e5;color:#fff;padding:6px 10px;border-radius:8px;text-decoration:none;margin-right:6px}' +
      '.btn-warn{background:#ef4444}.btn-ok{background:#10b981}' +
      '.flash{padding:10px 12px;border-radius:10px;margin:10px 0;font-weight:600}' +
      '.flash.ok{background:#ecfdf5;color:#065f46}' +
      '.flash.err{background:#fef2f2;color:#991b1b}';

    const defWkS = inputTimeToHHmm(CONFIG.DEFAULT_WK_START);
    const defWkE = inputTimeToHHmm(CONFIG.DEFAULT_WK_END);
    const defWeS = inputTimeToHHmm(CONFIG.DEFAULT_WE_START);
    const defWeE = inputTimeToHHmm(CONFIG.DEFAULT_WE_END);
    const defDur = CONFIG.DEFAULT_DURATION_MIN;
    const defStep = CONFIG.DEFAULT_STEP_MIN;
    const tok = encodeURIComponent(token);

    let htmlStr = `<style>${css}</style>
      <h2>Админ — ${CONFIG.BRAND_NAME}</h2>
      <p class="muted">
        Управление слотами.
        <a href="${CONFIG.SITE_URL}" target="_blank">Открыть сайт</a> •
        <a href="${W}?action=admin&token=${tok}">Обновить</a> •
        <a href="${W}?action=ensureWebhook&token=${tok}">Починить webhook</a>
      </p>`;
    if (flashMsg) htmlStr += `<div class="flash ${flashOk ? 'ok' : 'err'}">${flashMsg}<div style="margin-top:6px"><a href="${W}?action=admin&token=${tok}">Назад</a></div></div>`;

    // Добавить слот
    htmlStr += `
      <h3>Добавить слот</h3>
      <form method="GET" action="${W}" class="row">
        <input type="hidden" name="action" value="adminAddSlot">
        <input type="hidden" name="token" value="${tok}">
        <label>Дата (ДД.ММ.ГГГГ): <input type="text" name="date" placeholder="22.08.2025" required></label>
        <label>Время (МСК, HH:mm): <input type="text" name="time" placeholder="18:00" required></label>
        <label>Длительность (мин): <input type="number" min="1" step="1" name="dur" value="${defDur}" required></label>
        <button class="btn btn-ok" type="submit">Добавить</button>
      </form>
    `;

    // Массово
    htmlStr += `
      <h3 style="margin-top:22px">Массово на диапазон</h3>
      <form method="GET" action="${W}">
        <input type="hidden" name="action" value="adminAddBulk">
        <input type="hidden" name="token" value="${tok}">
        <div class="row">
          <label>С даты: <input type="text" name="from" placeholder="22.08.2025" required></label>
          <label>По дату: <input type="text" name="to" placeholder="31.08.2025" required></label>
        </div>
        <div class="row">
          <label>Будни с: <input type="text" name="wkStart" value="${defWkS}"></label>
          <label>по: <input type="text" name="wkEnd" value="${defWkE}"></label>
          <span class="muted">Пн–Пт</span>
        </div>
        <div class="row">
          <label>Выходные с: <input type="text" name="weStart" value="${defWeS}"></label>
          <label>по: <input type="text" name="weEnd" value="${defWeE}"></label>
          <span class="muted">Сб–Вс</span>
        </div>
        <div class="row">
          <label>Длительность (мин): <input type="number" min="1" step="1" name="dur" value="${defDur}" required></label>
          <label>Шаг (мин): <input type="number" min="1" step="1" name="step" value="${defStep}" required></label>
          <label><input type="checkbox" name="skip" value="1" checked> Не изменять существующие</label>
        </div>
        <button class="btn btn-ok" type="submit">Сгенерировать слоты</button>
      </form>
    `;

    // Пресеты
    htmlStr += `
      <h3 style="margin-top:22px">Пресеты</h3>
      <div class="row">
        <a class="btn" href="${W}?action=adminAddBulkPreset&kind=nextWeek&token=${tok}">Следующая неделя (пн–вс)</a>
        <a class="btn" href="${W}?action=adminAddBulkPreset&kind=thisWeekend&token=${tok}">Ближайшие выходные</a>
        <a class="btn" href="${W}?action=adminAddBulkPreset&kind=next14&token=${tok}">Ближайшие 14 дней</a>
        <a class="btn" href="${W}?action=adminAddBulkPreset&kind=nextMonth&token=${tok}">Следующий месяц</a>
      </div>
    `;

    // Очистить диапазон
    htmlStr += `
      <h3 style="margin-top:22px">Очистить диапазон</h3>
      <form method="GET" action="${W}" class="row">
        <input type="hidden" name="action" value="adminClearRange">
        <input type="hidden" name="token" value="${tok}">
        <div class="row">
          <label>С даты: <input type="text" name="from" placeholder="22.08.2025" required></label>
          <label>По дату: <input type="text" name="to" placeholder="31.08.2025" required></label>
          <label><input type="radio" name="mode" value="close" checked> Закрыть open‑слоты</label>
          <label><input type="radio" name="mode" value="delete"> Удалить строки open‑слотов</label>
        </div>
        <button class="btn btn-warn" type="submit">Очистить</button>
      </form>
    `;

    // Экспорт CSV
    htmlStr += `
      <h3 style="margin-top:22px">Экспорт CSV</h3>
      <form method="GET" action="${W}" target="_blank" class="row">
        <input type="hidden" name="action" value="exportCSV">
        <input type="hidden" name="token" value="${tok}">
        <div class="row">
          <label>С даты: <input type="text" name="from" placeholder="22.08.2025" required></label>
          <label>По дату: <input type="text" name="to" placeholder="31.08.2025" required></label>
          <label><input type="checkbox" name="status" value="open" checked> open</label>
          <label><input type="checkbox" name="status" value="booked" checked> booked</label>
          <label><input type="checkbox" name="status" value="closed" checked> closed</label>
        </div>
        <button class="btn" type="submit">Скачать CSV</button>
      </form>
    `;

    // Таблица
    htmlStr += '<h3 style="margin-top:22px">Слоты на ближайшие 60 дней</h3>';
    htmlStr += '<table class="tbl"><tr><th>#</th><th>Дата</th><th>Время (МСК)</th><th>Длит.</th><th>Статус</th><th>Ученик</th><th>Email</th><th>Действие</th></tr>';
    for (const r of rows) {
      const idx = r.idx + 1;
      const st = (r.status || '').toString().toLowerCase();
      const action =
        st === 'booked' ? `<a class="btn btn-warn" href="${W}?action=adminFreeSlot&row=${idx}&token=${tok}">Освободить</a>` :
        st === 'open'   ? `<a class="btn btn-warn" href="${W}?action=adminSetStatus&row=${idx}&status=closed&token=${tok}">Закрыть</a>` :
        st === 'closed' ? `<a class="btn btn-ok"   href="${W}?action=adminSetStatus&row=${idx}&status=open&token=${tok}">Открыть</a>` :
                          `<span class="muted">—</span>`;
      htmlStr += `<tr>
        <td>${idx}</td><td>${r.dateDmy || ''}</td><td>${r.time || ''}</td><td>${r.dur || CONFIG.DEFAULT_DURATION_MIN}</td>
        <td>${r.status || ''}</td><td>${r.name || ''}</td><td>${r.email || ''}</td><td>${action}</td>
      </tr>`;
    }
    htmlStr += '</table>';

    return htmlDoc(htmlStr, 'Админ — ' + CONFIG.BRAND_NAME);
  } catch (err) {
    return htmlError('Admin error', err);
  }
}

// ===== Admin actions =====
function adminFreeSlot(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);
  const rowNum = parseInt(e.parameter.row || '0', 10);
  if (!rowNum || rowNum < 2) return adminPage({ parameter: { token, ok:'0', msg:'Некорректный номер строки.' } });

  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const r = sh.getRange(rowNum, 1, 1, 9).getValues()[0]; // до очистки
    const ymd = normalizeDateCellToYmd(r[0]);
    const hhmm = normalizeTimeCellToHHmm(r[1]);
    const humanWhen = (ymd && hhmm) ? (ymdToDmy(ymd) + ' ' + hhmm) : (String(r[0]) + ' ' + String(r[1]));
    const msgBefore = { name: r[5] || '', email: r[6] || '' };

    const status = (r[3] || '').toString().toLowerCase();
    const eventId = (r[4] || '').toString();

    if (status === 'booked' && eventId) {
      if (CONFIG.USE_ADVANCED_API) {
        const apiId = eventId.indexOf('@') > -1 ? eventId.split('@')[0] : eventId;
        Calendar.Events.remove(CONFIG.CALENDAR_ID, apiId, { sendUpdates: 'all' });
      } else {
        const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
        const ev = cal && cal.getEventById(eventId);
        if (ev) ev.deleteEvent();
      }
    }
    sh.getRange(rowNum, 4).setValue('open');
    sh.getRange(rowNum, 5, 1, 4).clearContent();
    sh.getRange(rowNum, 9).setValue(Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss'));

    try {
      const msg =
        '🗑 <b>Слот освобождён</b>\n' +
        'Время: <b>' + escapeHtml(humanWhen) + ' МСК</b>\n' +
        (msgBefore.name || msgBefore.email
          ? ('Была запись: ' + escapeHtml(msgBefore.name) + (msgBefore.email ? ' <code>'+escapeHtml(msgBefore.email)+'</code>' : '') + '\n')
          : '') +
        '<a href="' + getWebAppUrl() + '?action=admin&token=' + encodeURIComponent(CONFIG.ADMIN_TOKEN) + '">Админка</a>';
      tgSendAdmin(msg);
    } catch(_) {}

    return adminPage({ parameter: { token, ok:'1', msg:'Слот освобождён.' } });
  } catch (err) {
    return adminPage({ parameter: { token, ok:'0', msg:'Ошибка: ' + err } });
  }
}

function adminSetStatus(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);
  const rowNum = parseInt(e.parameter.row || '0', 10);
  const status = (e.parameter.status || '').trim().toLowerCase();
  if (!rowNum || rowNum < 2) return adminPage({ parameter: { token, ok:'0', msg:'Некорректный номер строки.' } });
  if (!['open','closed'].includes(status)) return adminPage({ parameter: { token, ok:'0', msg:'Некорректный статус.' } });

  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const r = sh.getRange(rowNum, 1, 1, 4).getValues()[0];
    const cur = (r[3] || '').toString().toLowerCase();
    if (cur === 'booked' && status === 'closed')
      return adminPage({ parameter: { token, ok:'0', msg:'Нельзя закрыть занятый слот. Сначала освободите его.' } });

    sh.getRange(rowNum, 4).setValue(status);
    if (status === 'open') sh.getRange(rowNum, 5, 1, 4).clearContent();
    sh.getRange(rowNum, 9).setValue(Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss'));

    try {
      const ymd = normalizeDateCellToYmd(r[0]);
      const hhmm = normalizeTimeCellToHHmm(r[1]);
      const when = (ymd && hhmm) ? (ymdToDmy(ymd) + ' ' + hhmm) : (String(r[0]) + ' ' + String(r[1]));
      const msg =
        '⚙️ <b>Статус изменён</b>\n' +
        'Время: <b>' + escapeHtml(when) + ' МСК</b>\n' +
        'Статус: <b>' + escapeHtml(status) + '</b>';
      tgSendAdmin(msg);
    } catch(_) {}

    return adminPage({ parameter: { token, ok:'1', msg:'Статус обновлён.' } });
  } catch (err) {
    return adminPage({ parameter: { token, ok:'0', msg:'Ошибка: ' + err } });
  }
}

function adminAddSlot(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);

  const ymd = inputDateToYmd((e.parameter.date || '').trim());
  const hhmm = inputTimeToHHmm((e.parameter.time || '').trim());
  const dur = parseInt(e.parameter.dur || CONFIG.DEFAULT_DURATION_MIN, 10) || CONFIG.DEFAULT_DURATION_MIN;
  if (!ymd)  return adminPage({ parameter: { token, ok:'0', msg:'Некорректная дата. Используйте ДД.ММ.ГГГГ.' } });
  if (!hhmm) return adminPage({ parameter: { token, ok:'0', msg:'Некорректное время. Используйте HH:mm.' } });

  try {
    const dmy = ymdToDmy(ymd);
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const lock = LockService.getScriptLock(); lock.tryLock(10000);

    const all = sh.getDataRange().getValues();
    let idx = -1;
    for (let i = 1; i < all.length; i++) {
      const ymdRow = normalizeDateCellToYmd(all[i][0]);
      const tRow = normalizeTimeCellToHHmm(all[i][1]);
      if (ymdRow === ymd && tRow === hhmm) { idx = i; break; }
    }

    if (idx >= 1) {
      const st = (all[idx][3] || '').toString().toLowerCase();
      if (st === 'booked') { try{lock.releaseLock();}catch(_){};
        return adminPage({ parameter: { token, ok:'0', msg:'Слот уже занят — изменить нельзя.' } }); }
      sh.getRange(idx+1, 1).setValue(dmy);
      sh.getRange(idx+1, 2).setValue(hhmm);
      sh.getRange(idx+1, 3).setValue(dur);
      sh.getRange(idx+1, 4).setValue('open');
      sh.getRange(idx+1, 5, 1, 4).clearContent();
      sh.getRange(idx+1, 9).setValue(Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss'));
      try{lock.releaseLock();}catch(_){}
      return adminPage({ parameter: { token, ok:'1', msg:'Слот обновлён и открыт.' } });
    } else {
      const last = sh.getLastRow();
      sh.getRange(last+1, 1, 1, 9).setValues([[ dmy, hhmm, dur, 'open', '', '', '', '', Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss') ]]);
      try{lock.releaseLock();}catch(_){}
      return adminPage({ parameter: { token, ok:'1', msg:'Слот добавлен и открыт.' } });
    }
  } catch (err) {
    return adminPage({ parameter: { token, ok:'0', msg:'Ошибка: ' + err } });
  }
}

function adminAddBulk(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);

  const params = {
    from: inputDateToYmd((e.parameter.from || '').trim()),
    to: inputDateToYmd((e.parameter.to || '').trim()),
    wkStart: inputTimeToHHmm((e.parameter.wkStart || CONFIG.DEFAULT_WK_START).trim()),
    wkEnd:   inputTimeToHHmm((e.parameter.wkEnd   || CONFIG.DEFAULT_WK_END).trim()),
    weStart: inputTimeToHHmm((e.parameter.weStart || CONFIG.DEFAULT_WE_START).trim()),
    weEnd:   inputTimeToHHmm((e.parameter.weEnd   || CONFIG.DEFAULT_WE_END).trim()),
    dur: Math.max(1, parseInt(e.parameter.dur || CONFIG.DEFAULT_DURATION_MIN, 10) || CONFIG.DEFAULT_DURATION_MIN),
    step: Math.max(1, parseInt(e.parameter.step || CONFIG.DEFAULT_STEP_MIN, 10) || CONFIG.DEFAULT_STEP_MIN),
    skipExisting: (e.parameter.skip || '') === '1' || (e.parameter.skip || '') === 'on'
  };

  if (!params.from || !params.to)   return adminPage({ parameter: { token, ok:'0', msg:'Некорректный диапазон дат.' } });
  if (!params.wkStart || !params.wkEnd || !params.weStart || !params.weEnd)
                                   return adminPage({ parameter: { token, ok:'0', msg:'Некорректные времена начала/окончания.' } });
  if (params.from > params.to)      return adminPage({ parameter: { token, ok:'0', msg:'Дата «с» позже даты «по».' } });

  try {
    const res = doAddBulk(params);
    const msg = `Готово. Новых: ${res.added}, открыто: ${res.opened}, пропущено (существ.): ${res.skippedExisting}, заняты: ${res.skippedBooked}.`;

    try {
      const human = `📅 Массовая генерация\nДиапазон: <b>${ymdToDmy(params.from)}—${ymdToDmy(params.to)}</b>\nДобавлено: <b>${res.added}</b>, открыто: <b>${res.opened}</b>, пропущено: <b>${res.skippedExisting}</b>, заняты: <b>${res.skippedBooked}</b>`;
      tgSendAdmin(human);
    } catch(_) {}

    return adminPage({ parameter: { token, ok:'1', msg } });
  } catch (err) {
    return adminPage({ parameter: { token, ok:'0', msg:'Ошибка генерации: ' + err } });
  }
}

function adminAddBulkPreset(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);

  try {
    const kind = (e.parameter.kind || '').trim();
    const tz = CONFIG.SERVICE_TZ;
    const todayYmd = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const dow = parseInt(Utilities.formatDate(new Date(), tz, 'u'), 10); // 1..7
    let from, to;

    if (kind === 'nextWeek') {
      const daysToNextMon = (dow === 1 ? 7 : (8 - dow));
      from = ymdAddDays(todayYmd, daysToNextMon); to = ymdAddDays(from, 6);
    } else if (kind === 'thisWeekend') {
      const daysToSat = (6 - dow + 7) % 7;
      from = ymdAddDays(todayYmd, daysToSat); to = ymdAddDays(from, 1);
    } else if (kind === 'next14') {
      from = ymdAddDays(todayYmd, 1); to = ymdAddDays(from, 13);
    } else if (kind === 'nextMonth') {
      const y = parseInt(Utilities.formatDate(new Date(), tz, 'yyyy'), 10);
      const m = parseInt(Utilities.formatDate(new Date(), tz, 'M'), 10);
      const ny = m === 12 ? (y + 1) : y; const nm = m === 12 ? 1 : (m + 1);
      const first = new Date(Date.UTC(ny, nm - 1, 1)), last = new Date(Date.UTC(ny, nm, 0));
      from = Utilities.formatDate(first, tz, 'yyyy-MM-dd'); to = Utilities.formatDate(last, tz, 'yyyy-MM-dd');
    } else {
      return adminPage({ parameter: { token, ok:'0', msg:'Неизвестный пресет.' } });
    }

    const params = {
      from, to,
      wkStart: inputTimeToHHmm(CONFIG.DEFAULT_WK_START),
      wkEnd:   inputTimeToHHmm(CONFIG.DEFAULT_WK_END),
      weStart: inputTimeToHHmm(CONFIG.DEFAULT_WE_START),
      weEnd:   inputTimeToHHmm(CONFIG.DEFAULT_WE_END),
      dur: CONFIG.DEFAULT_DURATION_MIN,
      step: CONFIG.DEFAULT_STEP_MIN,
      skipExisting: true
    };

    const res = doAddBulk(params);
    const msg = `Пресет «${kind}»: ${ymdToDmy(from)}—${ymdToDmy(to)}. Новых: ${res.added}, открыто: ${res.opened}, пропущено: ${res.skippedExisting}, заняты: ${res.skippedBooked}.`;

    try {
      tgSendAdmin(`🧰 Пресет <b>${escapeHtml(kind)}</b>\nДиапазон: <b>${ymdToDmy(from)}—${ymdToDmy(to)}</b>\nДобавлено: <b>${res.added}</b>, открыто: <b>${res.opened}</b>, пропущено: <b>${res.skippedExisting}</b>, заняты: <b>${res.skippedBooked}</b>`);
    } catch(_){}

    return adminPage({ parameter: { token, ok:'1', msg } });

  } catch (err) {
    return adminPage({ parameter: { token, ok:'0', msg:'Ошибка пресета: ' + err } });
  }
}

function adminClearRange(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);

  const from = inputDateToYmd((e.parameter.from || '').trim());
  const to   = inputDateToYmd((e.parameter.to || '').trim());
  const mode = (e.parameter.mode || 'close').trim(); // close | delete
  if (!from || !to) return adminPage({ parameter: { token, ok:'0', msg:'Некорректный диапазон дат.' } });
  if (from > to)     return adminPage({ parameter: { token, ok:'0', msg:'Дата «с» позже даты «по».' } });
  if (!['close','delete'].includes(mode)) return adminPage({ parameter: { token, ok:'0', msg:'Некорректный режим очистки.' } });

  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const lock = LockService.getScriptLock(); lock.tryLock(60000);

    let closed = 0, deleted = 0, skippedBooked = 0;
    for (let i = sh.getLastRow(); i >= 2; i--) {
      const r = sh.getRange(i, 1, 1, 9).getValues()[0];
      const ymd = normalizeDateCellToYmd(r[0]);
      const st = (r[3] || '').toString().toLowerCase();
      if (!ymd || ymd < from || ymd > to) continue;
      if (st === 'booked') { skippedBooked++; continue; }
      if (st !== 'open') continue;

      if (mode === 'delete') { sh.deleteRow(i); deleted++; }
      else {
        sh.getRange(i, 4).setValue('closed');
        sh.getRange(i, 5, 1, 4).clearContent();
        sh.getRange(i, 9).setValue(Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss'));
        closed++;
      }
    }
    try { lock.releaseLock(); } catch(_){}
    const msg = `Очистка: закрыто ${closed}, удалено ${deleted}, пропущено занятых ${skippedBooked}.`;

    try {
      tgSendAdmin('🧹 <b>Очистка диапазона</b>\n'+
                  'Диапазон: <b>'+ymdToDmy(from)+'—'+ymdToDmy(to)+'</b>\n'+
                  'Закрыто: <b>'+closed+'</b>, удалено: <b>'+deleted+'</b>, заняты: <b>'+skippedBooked+'</b>');
    } catch(_){}

    return adminPage({ parameter: { token, ok:'1', msg } });

  } catch (err) {
    return adminPage({ parameter: { token, ok:'0', msg:'Ошибка очистки: ' + err } });
  }
}

function exportCSV(e) {
  const token = (e.parameter.token || '').trim();
  if (token !== CONFIG.ADMIN_TOKEN) return htmlBox('Доступ запрещён', true);

  try {
    const from = inputDateToYmd((e.parameter.from || '').trim());
    const to   = inputDateToYmd((e.parameter.to || '').trim());
    if (!from || !to || from > to) {
      return ContentService.createTextOutput('Некорректный диапазон').setMimeType(ContentService.MimeType.TEXT);
    }

    let statuses = e.parameter.status;
    if (!statuses) statuses = ['open','booked','closed'];
    else if (typeof statuses === 'string') statuses = [statuses];
    statuses = new Set(statuses.map(s => (s || '').toLowerCase()));

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);

    const all = sh.getDataRange().getValues();
    const items = [];
    for (let i = 1; i < all.length; i++) {
      const r = all[i];
      const ymd = normalizeDateCellToYmd(r[0]);
      if (!ymd || ymd < from || ymd > to) continue;
      const hhmm = normalizeTimeCellToHHmm(r[1]);
      const status = (r[3] || '').toString().toLowerCase();
      if (!statuses.has(status)) continue;

      items.push({
        ymd, hhmm, dur: r[2], status,
        name: r[5] || '', email: r[6] || '', subject: r[7] || '',
        eventId: r[4] || '', updated: r[8] || ''
      });
    }

    items.sort((a,b) => (a.ymd + a.hhmm).localeCompare(b.ymd + b.hhmm));
    const rows = [['Date','Time','DurationMin','Status','StudentName','StudentEmail','Subject','EventId','UpdatedAt']];
    for (const r of items) rows.push([ ymdToDmy(r.ymd), r.hhmm, r.dur, r.status, r.name, r.email, r.subject, r.eventId, r.updated ]);

    const esc = v => `"${String(v).replace(/"/g,'""')}"`;
    const csv = '\uFEFF' + rows.map(r => r.map(esc).join(';')).join('\r\n');

    return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV);
  } catch (err) {
    return ContentService.createTextOutput('CSV error: '+String(err)).setMimeType(ContentService.MimeType.TEXT);
  }
}

// ===== Core bulk generator =====
function doAddBulk({ from, to, wkStart, wkEnd, weStart, weEnd, dur, step, skipExisting }) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  ensureHeader(sh);

  const lock = LockService.getScriptLock(); lock.tryLock(60000);

  const all = sh.getDataRange().getValues();
  const index = new Map(); // ymd|hhmm -> row(1-based)
  for (let i = 1; i < all.length; i++) {
    const ymd = normalizeDateCellToYmd(all[i][0]);
    const t = normalizeTimeCellToHHmm(all[i][1]);
    if (ymd && t) index.set(`${ymd}|${t}`, i+1);
  }

  let added = 0, opened = 0, skippedExisting = 0, skippedBooked = 0;

  for (let ymd = from; ymd <= to; ymd = ymdAddDays(ymd, 1)) {
    const dow = parseInt(Utilities.formatDate(makeZonedDate(
      parseInt(ymd.slice(0,4),10),
      parseInt(ymd.slice(5,7),10),
      parseInt(ymd.slice(8,10),10),
      12, 0, CONFIG.SERVICE_TZ
    ), CONFIG.SERVICE_TZ, 'u'), 10); // 1..7

    const isWeekend = (dow === 6 || dow === 7);
    const startT = isWeekend ? weStart : wkStart;
    const endT   = isWeekend ? weEnd   : wkEnd;

    const startMin = timeToMinutes(startT), endMin = timeToMinutes(endT);
    if (!isFinite(startMin) || !isFinite(endMin) || endMin <= startMin) continue;

    for (let t = startMin; t + dur <= endMin; t += step) {
      const hh = String(Math.floor(t/60)).padStart(2,'0'), mm = String(t%60).padStart(2,'0');
      const hhmm = `${hh}:${mm}`, key = `${ymd}|${hhmm}`, rowNum = index.get(key);

      if (rowNum) {
        const r = sh.getRange(rowNum, 1, 1, 9).getValues()[0];
        const curStatus = (r[3] || '').toString().toLowerCase();
        if (curStatus === 'booked') { skippedBooked++; continue; }
        if (skipExisting) { skippedExisting++; continue; }

        sh.getRange(rowNum, 1).setValue(ymdToDmy(ymd));
        sh.getRange(rowNum, 2).setValue(hhmm);
        sh.getRange(rowNum, 3).setValue(dur);
        sh.getRange(rowNum, 4).setValue('open');
        sh.getRange(rowNum, 5, 1, 4).clearContent();
        sh.getRange(rowNum, 9).setValue(Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss'));
        opened++;
      } else {
        const last = sh.getLastRow();
        sh.getRange(last+1, 1, 1, 9).setValues([[ ymdToDmy(ymd), hhmm, dur, 'open', '', '', '', '', Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss') ]]);
        index.set(key, last+1);
        added++;
      }
    }
  }

  try { lock.releaseLock(); } catch(_){}
  return { added, opened, skippedExisting, skippedBooked };
}

// ===== Users (Telegram): phoneE164 -> chatId =====
function ensureUsersSheet(){
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sh = ss.getSheetByName('Users');
  if (!sh) sh = ss.insertSheet('Users');
  const first = sh.getRange(1,1,1,8).getValues()[0];
  const empty = first.every(v => v === '' || v === null);
  if (empty) {
    sh.getRange(1,1,1,8).setValues([[
      'PhoneE164','ChatId','Username','FirstName','LastName','LinkedAt','LastSeen','Source'
    ]]);
  }
  return sh;
}
function normalizePhoneE164(s){
  s = String(s||'').trim();
  let d = s.replace(/\D/g,'');
  if (!d) return '';
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  return '+' + d;
}
function usersUpsertByPhone(phoneE164, info){
  if (!phoneE164) return;
  const sh = ensureUsersSheet();
  const all = sh.getDataRange().getValues();
  let row = -1;
  for (let i=1;i<all.length;i++){
    if ((all[i][0]||'').toString().trim() === phoneE164) { row = i+1; break; }
  }
  const now = Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss');
  const values = [
    phoneE164,
    info.chatId || '',
    info.username || '',
    info.firstName || '',
    info.lastName || '',
    (row === -1 ? now : (all[row-1][5] || now)), // LinkedAt
    now, // LastSeen
    info.source || ''
  ];
  if (row === -1) {
    sh.appendRow(values);
  } else {
    sh.getRange(row,1,1,8).setValues([values]);
  }
}
function usersFindChatByPhone(phoneE164){
  if (!phoneE164) return null;
  const sh = ensureUsersSheet();
  const all = sh.getDataRange().getValues();
  for (let i=1;i<all.length;i++){
    if ((all[i][0]||'').toString().trim() === phoneE164) {
      const chatId = all[i][1];
      if (chatId) return String(chatId);
    }
  }
  return null;
}

// Прислать ученику (или вернуть deep‑link, если нет chat_id)
function notifyStudentTelegram(phoneE164, text){
  const chatId = usersFindChatByPhone(phoneE164);
  if (chatId) {
    const res = tgSendToChat(chatId, escapeHtml(text));
    return { sent: !!res.ok, needStart: false };
  }
  const digits = phoneE164.replace(/\D/g,'');
  const deepLink = `https://t.me/${CONFIG.TELEGRAM.BOT_USERNAME}?start=bindp${digits}`;
  return { sent:false, needStart:true, deepLink };
}

// ===== Telegram: webhook updates =====
function handleTelegramUpdate(upd){
  try{
    const msg = upd.message || upd.edited_message || null;
    const mycm = upd.my_chat_member || null;

    if (msg) {
      const chatId = msg.chat && msg.chat.id;
      const from = msg.from || {};
      const username = from.username || '';
      const firstName = from.first_name || '';
      const lastName = from.last_name || '';

      // /start payload
      if (msg.text && /^\/start\b/.test(msg.text)) {
        const parts = msg.text.trim().split(/\s+/);
        const payload = parts[1] || '';
        let phoneE164 = '';
        if (/^bindp\d{7,}$/.test(payload)) {
          const digits = payload.replace(/[^\d]/g,'');
          phoneE164 = normalizePhoneE164('+'+digits);
          usersUpsertByPhone(phoneE164, { chatId, username, firstName, lastName, source:'start' });
          tgSendToChat(chatId, '✅ Готово! Вы будете получать уведомления о занятиях здесь. Если захотите отключить, напишите /unlink.');
        } else {
          // Предложим поделиться контактом
          const markup = {
            keyboard: [[{ text:'Поделиться номером', request_contact:true }]],
            resize_keyboard: true, one_time_keyboard: true
          };
          tgSendToChat(chatId, '👋 Привет! Нажмите «Поделиться номером», чтобы я мог присылать уведомления о занятиях.', { reply_markup: JSON.stringify(markup) });
        }
        return;
      }

      // Контакт
      if (msg.contact && msg.contact.phone_number) {
        const pn = msg.contact.phone_number;
        const phoneE164 = normalizePhoneE164(pn.startsWith('+') ? pn : '+'+pn);
        usersUpsertByPhone(phoneE164, { chatId, username, firstName, lastName, source:'contact' });
        tgSendToChat(chatId, '✅ Спасибо! Номер сохранён, уведомления включены.', { reply_markup: JSON.stringify({ remove_keyboard:true }) });
        return;
      }

      // Команды
      if (msg.text && msg.text.trim() === '/unlink') {
        const sh = ensureUsersSheet();
        const all = sh.getDataRange().getValues();
        for (let i=1;i<all.length;i++){
          if (String(all[i][1]||'') === String(chatId)) {
            sh.getRange(i+1,2).setValue(''); // ChatId пустой
            sh.getRange(i+1,7).setValue(Utilities.formatDate(new Date(), CONFIG.SERVICE_TZ, 'yyyy-MM-dd HH:mm:ss')); // LastSeen
          }
        }
        tgSendToChat(chatId, '🔕 Привязка удалена. Чтобы снова включить — /start.');
        return;
      }
      if (msg.text && msg.text.trim() === '/whoami') {
        tgSendToChat(chatId, `id: <code>${chatId}</code>\nuser: @${username||'-'}\nname: ${firstName} ${lastName}`); return;
      }
    }

    if (mycm) {
      // можно логировать изменения статуса
    }
  }catch(err){
    tgSendAdmin('❗️ Ошибка в handleTelegramUpdate:\n<code>'+escapeHtml(String(err))+'</code>');
  }
}

// ===== Telegram send helpers =====
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function tgSendAdmin(text, opts){
  const cfg = CONFIG.TELEGRAM || {};
  if (!cfg.ENABLED || !cfg.BOT_TOKEN || !cfg.CHAT_ID) return { ok:false, skipped:true };
  const url = 'https://api.telegram.org/bot' + cfg.BOT_TOKEN + '/sendMessage';
  const payload = {
    chat_id: cfg.CHAT_ID, text, parse_mode: cfg.PARSE_MODE || 'HTML', disable_web_page_preview: true, ...opts
  };
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json', payload: JSON.stringify(payload), muteHttpExceptions:true });
  return { ok: res.getResponseCode() === 200, http: res.getResponseCode(), body: res.getContentText() };
}
function tgSendToChat(chatId, text, opts){
  const cfg = CONFIG.TELEGRAM || {};
  if (!cfg.ENABLED || !cfg.BOT_TOKEN || !chatId) return { ok:false, skipped:true };
  const url = 'https://api.telegram.org/bot' + cfg.BOT_TOKEN + '/sendMessage';
  const payload = {
    chat_id: chatId, text, parse_mode: cfg.PARSE_MODE || 'HTML', disable_web_page_preview: true, ...opts
  };
  const res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json', payload: JSON.stringify(payload), muteHttpExceptions:true });
  return { ok: res.getResponseCode() === 200, http: res.getResponseCode(), body: res.getContentText() };
}

// ===== HTML/JSON helpers + debug =====
function htmlDoc(inner,title){
  const base = getWebAppUrl();
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base href="${base}" target="_top">${title?`<title>${title}</title>`:''}</head><body>${inner}</body></html>`;
  return HtmlService.createHtmlOutput(doc).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function htmlBox(msg,err){
  const css='body{font:16px system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;background:#0b1020;color:#e5e7eb}a{color:#93c5fd;text-decoration:none}'+(err?'.box{background:#fef2f2;color:#991b1b;padding:14px;border-radius:10px}':'.box{background:#ecfdf5;color:#065f46;padding:14px;border-radius:10px}');
  return htmlDoc(`<style>${css}</style><div class="box">${msg}</div>`,'Сообщение');
}
function htmlError(prefix,err){
  return htmlDoc(`<div style="font:14px system-ui;margin:24px;padding:16px;border-radius:10px;background:#fef2f2;color:#991b1b"><b>${prefix}:</b><br><pre style="white-space:pre-wrap">${String(err)}\n${err&&err.stack||''}</pre></div>`,'Ошибка');
}
function json(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function debugPing(){ return htmlDoc('<div style="font:16px Arial;padding:20px">OK from debugPing</div>','Debug'); }
function debugSlot(e){
  try{
    const startIso = (e.parameter.startIso||'').trim();
    if(!startIso) return json({ok:false,error:'no startIso'});
    const start = new Date(startIso);
    const ymd = Utilities.formatDate(start, CONFIG.SERVICE_TZ, 'yyyy-MM-dd');
    const hhmm = Utilities.formatDate(start, CONFIG.SERVICE_TZ, 'HH:mm');

    const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sh=ss.getSheetByName(CONFIG.SHEET_NAME)||ss.insertSheet(CONFIG.SHEET_NAME);
    ensureHeader(sh);
    const all=sh.getDataRange().getValues();

    const byText = findSlotRowIndex(all, ymdToDmy(ymd), hhmm);
    const y=+ymd.slice(0,4), m=+ymd.slice(5,7), d=+ymd.slice(8,10);
    const hh=+hhmm.slice(0,2), mm=+hhmm.slice(3,5);
    const byInstant = findSlotRowIndexByInstant(all, makeZonedDate(y,m,d,hh,mm,CONFIG.SERVICE_TZ), CONFIG.SERVICE_TZ);

    const sample=[];
    for(let i=1;i<Math.min(all.length,15);i++){
      sample.push({
        row:i+1, date: all[i][0], time: all[i][1],
        normDate: normalizeDateCellToYmd(all[i][0]),
        normTime: normalizeTimeCellToHHmm(all[i][1]),
        status: (all[i][3]||'').toString().trim().toLowerCase()
      });
    }
    return json({ok:true, ymd, hhmm, byText, byInstant, sample});
  }catch(err){
    return json({ok:false,error:String(err)});
  }
}

// ===== Slots sheet helpers =====
function ensureHeader(sh) {
  const first = sh.getRange(1,1,1,9).getValues()[0];
  const empty = first.every(v => v === '' || v === null);
  if (empty) {
    sh.getRange(1,1,1,9).setValues([[
      'Date (DD.MM.YYYY, МСК)','Start (HH:mm, МСК)','DurationMin','Status (open | booked | closed)','EventId','StudentName','StudentEmail','Subject','UpdatedAt'
    ]]);
  }
}
function normalizeDateCellToYmd(cell) {
  if (cell instanceof Date) return Utilities.formatDate(cell, CONFIG.SERVICE_TZ, 'yyyy-MM-dd');
  const s = (cell || '').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) { const [dd,mm,yyyy]=s.split('.'); return `${yyyy}-${mm}-${dd}`; }
  return '';
}
function normalizeTimeCellToHHmm(cell) {
  if (cell instanceof Date) return Utilities.formatDate(cell, CONFIG.SERVICE_TZ, 'HH:mm');
  if (typeof cell === 'number' && !isNaN(cell)) {
    const ms = Math.round((cell % 1) * 86400000), h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const s = (cell || '').toString().trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { const hh = String(Math.min(Math.max(parseInt(m[1],10),0),23)).padStart(2,'0'); return `${hh}:${m[2]}`; }
  return '';
}
function findSlotRowIndex(all, dmy, hhmm) {
  const ymdTarget = dmyToYmd(dmy);
  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    const ymd = normalizeDateCellToYmd(r[0]);
    const t = normalizeTimeCellToHHmm(r[1]);
    if (ymd && t && ymd === ymdTarget && t === hhmm) return i;
  }
  return -1;
}
function findSlotRowIndexByInstant(all, targetStart, tz) {
  const TARGET = targetStart.getTime();
  for (let i = 1; i < all.length; i++) {
    const ymd = normalizeDateCellToYmd(all[i][0]);
    const hhmm = normalizeTimeCellToHHmm(all[i][1]);
    if (!ymd || !hhmm) continue;
    const y = parseInt(ymd.slice(0,4),10);
    const m = parseInt(ymd.slice(5,7),10);
    const d = parseInt(ymd.slice(8,10),10);
    const hh = parseInt(hhmm.slice(0,2),10);
    const mm = parseInt(hhmm.slice(3,5),10);
    const start = makeZonedDate(y,m,d,hh,mm,tz).getTime();
    if (Math.abs(start - TARGET) <= 60000) return i;
  }
  return -1;
}
function dmyToYmd(dmy){ const m=(dmy||'').match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m?`${m[3]}-${m[2]}-${m[1]}`:''; }
function ymdToDmy(ymd){ const m=(ymd||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}.${m[2]}.${m[1]}`:''; }
function inputDateToYmd(s){
  s = (s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return dmyToYmd(s);
  return '';
}
function inputTimeToHHmm(s){ s=(s||'').trim(); const m=s.match(/^(\d{1,2}):(\d{2})$/); if(!m)return''; const hh=String(Math.min(Math.max(parseInt(m[1],10),0),23)).padStart(2,'0'); return `${hh}:${m[2]}`; }
function timeToMinutes(hhmm){ const [h,m]=hhmm.split(':').map(n=>parseInt(n,10)); return h*60+m; }
function ymdAddDays(ymd,add){ const y=parseInt(ymd.slice(0,4),10),m=parseInt(ymd.slice(5,7),10),d=parseInt(ymd.slice(8,10),10); const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+add); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`; }
function makeZonedDate(y,m,d,hh,mm,tz){
  let ms = Date.UTC(y, m-1, d, hh, mm, 0);
  for (let i=0;i<3;i++){
    const fmtY=+Utilities.formatDate(new Date(ms), tz, 'yyyy');
    const fmtM=+Utilities.formatDate(new Date(ms), tz, 'MM');
    const fmtD=+Utilities.formatDate(new Date(ms), tz, 'dd');
    const fmtH=+Utilities.formatDate(new Date(ms), tz, 'HH');
    const fmtN=+Utilities.formatDate(new Date(ms), tz, 'mm');
    const desired = Date.UTC(y, m-1, d, hh, mm, 0);
    const actual  = Date.UTC(fmtY, fmtM-1, fmtD, fmtH, fmtN, 0);
    const diff = desired - actual;
    if (diff === 0) break;
    ms += diff;
  }
  return new Date(ms);
}