// background.js v0.6 — 特権処理の集約（service worker / trusted context）。
//  (1) storage を TRUSTED_CONTEXTS にロック（content script から直接読めなくする）
//  (2) storage 仲介（store_get / store_set）: content script はここ経由でのみ storage に触る
//  (3) OpenRouter 呼び出し（APIキーはここでしか読まない）
//  (4) Google Calendar（任意）: launchWebAuthFlow + freebusy
//  (5) side panel / options を開く
//  (6) 申請キュー / 状態追跡 / 通知

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GCAL_FREEBUSY = 'https://www.googleapis.com/calendar/v3/freeBusy';
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const DEFAULT_MODEL = 'google/gemini-3.1-pro-preview';
const OPENROUTER_TIMEOUT_MS = 60000;

// --- storage を信頼コンテキスト限定に（ページ/コンテンツから秘密へ到達させない）---
async function lockStorage() {
  try { await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch (_) {}
}
lockStorage();
chrome.runtime.onInstalled.addListener(lockStorage);
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}

async function getSettings() { return (await chrome.storage.local.get('settings')).settings || {}; }
async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function isContentScript(sender) {
  return !!sender?.tab;
}

function stripContentSecrets(data) {
  if (!data?.settings || typeof data.settings !== 'object') return data;
  const { apiKey, gcalToken, gcalTokenExp, ...safeSettings } = data.settings;
  return { ...data, settings: safeSettings };
}

function canContentWrite(obj) {
  return Object.keys(obj || {}).every((key) => (
    key === 'sittingsCache'
    || key === 'applyQueue'
    || key === 'pendingApply'
    || key.startsWith('sitter:')
    || key.startsWith('sitterid:')
    || key.startsWith('memory:')
  ));
}

function normalizeKeys(keys) {
  if (Array.isArray(keys)) return keys;
  if (typeof keys === 'string') return [keys];
  if (keys && typeof keys === 'object') return Object.keys(keys);
  return [];
}

function canContentRead(keys) {
  const list = normalizeKeys(keys);
  return list.length > 0 && list.every((key) => (
    key === 'settings'
    || key === 'libraryMd'
    || key === 'schedulingMd'
    || key === 'sittingsCache'
    || key === 'applyQueue'
    || key === 'pendingApply'
    || key.startsWith('sitter:')
    || key.startsWith('sitterid:')
    || key.startsWith('memory:')
  ));
}

async function fetchWithTimeout(url, options, timeoutMs = OPENROUTER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function structuredOutputError(status, data) {
  const msg = String(data?.error?.message || data?.message || '');
  return status >= 400 && /response_format|json_schema|structured|schema/i.test(msg);
}

// --- OpenRouter ---
async function callOpenRouter({ messages, temperature, responseSchema, schemaName }) {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: 'APIキーが未設定です。side panel の「設定」タブでOpenRouterのキーを入力してください。' };
  const t = Number.parseFloat(temperature ?? s.temperature);
  const body = {
    model: s.model || DEFAULT_MODEL,
    messages,
    temperature: Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.5
  };
  if (responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: schemaName || 'poppins_reply',
        strict: true,
        schema: responseSchema
      }
    };
  }
  const request = async (requestBody) => {
    const res = await fetchWithTimeout(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${s.apiKey}`,
        'HTTP-Referer': 'https://smartsitter.jp/',
        'X-Title': 'Poppins Reply Assistant'
      },
      body: JSON.stringify(requestBody)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  try {
    let { res, data } = await request(body);
    if (!res.ok && body.response_format && structuredOutputError(res.status, data)) {
      const { response_format: _responseFormat, ...fallbackBody } = body;
      ({ res, data } = await request(fallbackBody));
    }
    if (!res.ok) return { ok: false, error: data?.error?.message || `OpenRouter エラー (${res.status})` };
    return { ok: true, text: data?.choices?.[0]?.message?.content ?? '', model: body.model };
  } catch (e) {
    const timeout = e?.name === 'AbortError' ? 'OpenRouterの応答がタイムアウトしました。時間をおいて再試行してください。' : null;
    return { ok: false, error: timeout || String(e?.message || e) };
  }
}

// --- Google Calendar (任意) ---
function redirectUrl() { return chrome.identity.getRedirectURL(); }
async function gcalConnect() {
  const s = await getSettings();
  if (!s.gcalClientId) return { ok: false, error: 'Google OAuth クライアントIDが未設定です。' };
  const url = 'https://accounts.google.com/o/oauth2/v2/auth'
    + `?client_id=${encodeURIComponent(s.gcalClientId)}&response_type=token`
    + `&redirect_uri=${encodeURIComponent(redirectUrl())}`
    + `&scope=${encodeURIComponent(GCAL_SCOPE)}&prompt=consent`;
  try {
    const resp = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    const p = new URLSearchParams((resp.split('#')[1] || ''));
    const token = p.get('access_token');
    if (!token) return { ok: false, error: 'アクセストークンを取得できませんでした。' };
    await patchSettings({ gcalToken: token, gcalTokenExp: Date.now() + (parseInt(p.get('expires_in') || '3600', 10) - 60) * 1000 });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
async function gcalFreebusy({ timeMin, timeMax, calendarId }) {
  const s = await getSettings();
  if (!s.gcalToken || !(s.gcalTokenExp > Date.now())) return { ok: false, needsAuth: true, error: '再接続が必要です。' };
  try {
    const res = await fetch(GCAL_FREEBUSY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.gcalToken}` },
      body: JSON.stringify({ timeMin, timeMax, timeZone: 'Asia/Tokyo', items: [{ id: calendarId || 'primary' }] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return res.status === 401 ? { ok: false, needsAuth: true } : { ok: false, error: data?.error?.message || `Calendar エラー (${res.status})` };
    return { ok: true, busy: (data.calendars?.[calendarId || 'primary'] || {}).busy || [] };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

// ===== 申請キュー / 状態追跡（Level 3）＋ 申請可能通知（Phase 2） =====
const APPLY_ALARM = 'poppins-apply-poll';
const ISSUE_LIST_URL = 'https://smartsitter.jp/parent/issues';

function tokyoTodayUtc() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addMonthsUtc(date, n) { const x = new Date(date); x.setUTCMonth(x.getUTCMonth() + n); return x; }
function jaDateToIso(s) {
  const m = (s || '').match(/(\d{4})年(\d{2})月(\d{2})日/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
const normName = (s) => (s || '').replace(/\s/g, '');

async function getQueue() { return (await chrome.storage.local.get('applyQueue')).applyQueue || []; }
async function setQueue(q) { await chrome.storage.local.set({ applyQueue: q }); }

// 一覧の status から内部状態を判定（キーワードはライブで要調整の可能性あり）
function classifyIssueStatus(it) {
  const s = `${it.status || ''} ${it.statusClass || ''}`;
  if (/canceled|キャンセル/.test(s)) return 'canceled';
  if (/要対応|見積もり確認|確定待ち/.test(s)) return 'needs_confirm';
  if (/確定|成立|booked|charged/.test(s)) return 'booked';
  if (/見積/.test(s)) return 'applied';
  return null;
}

function normTime(s) {
  return String(s || '').replace(/[^\d]/g, '').slice(0, 4);
}

function itemTimeMatches(issue, queued) {
  const range = String(issue.timeRange || '');
  const parts = range.match(/(\d{1,2})[:：]?(\d{2})/g) || [];
  if (parts.length < 2) return false;
  const start = normTime(parts[0]);
  const end = normTime(parts[1]);
  return start === normTime(queued.start || queued.startTime) && end === normTime(queued.end || queued.endTime);
}

// --- offscreen 文書でHTMLをパース（service workerにDOMParserが無いため）---
let creatingOffscreen = null;
async function ensureOffscreen() {
  try { if (await chrome.offscreen.hasDocument()) return; } catch (_) {}
  if (creatingOffscreen) { await creatingOffscreen; return; }
  try {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Parse SmartSitter issue-list HTML for application status tracking.'
    });
    await creatingOffscreen;
  } catch (_) {} finally { creatingOffscreen = null; }
}
async function parseIssuesHtml(html) {
  await ensureOffscreen();
  try {
    return (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse_issues', html })) || { ok: false, items: [] };
  } catch (e) { return { ok: false, error: String(e?.message || e), items: [] }; }
}
async function fetchIssuesItems() {
  try {
    const res = await fetch(ISSUE_LIST_URL, { credentials: 'include' });
    if (!res.ok) return { ok: false, items: [] };
    return await parseIssuesHtml(await res.text());
  } catch (e) { return { ok: false, error: String(e?.message || e), items: [] }; }
}

// queue を一覧パース結果と現在日で照合・更新。notify=true で通知。
async function reconcileQueue(items, { notify = false } = {}) {
  const q = await getQueue();
  if (!q.length) return q;
  const today = tokyoTodayUtc();
  const windowEnd = addMonthsUtc(today, 2);
  const becameReady = [];
  const needConfirm = [];

  for (const it of q) {
    if (it.status === 'deferred') {
      const d = it.date ? new Date(`${it.date}T00:00:00Z`) : null;
      if (d && d >= today && d <= windowEnd) {
        it.status = 'ready'; it.updatedAt = Date.now();
        if (!it.notifiedReady) { becameReady.push(it); it.notifiedReady = true; }
      }
    }
  }
  if (Array.isArray(items) && items.length) {
    for (const it of q) {
      if (it.status === 'booked' || it.status === 'canceled') continue;
      const matches = items.filter((x) => (
        normName(x.sitterName) === normName(it.sitterName)
        && jaDateToIso(x.date) === it.date
        && itemTimeMatches(x, it)
      ));
      const match = matches.length === 1 ? matches[0] : null;
      if (!match) continue;
      it.issueId = match.issueId || it.issueId;
      it.statusText = match.status || it.statusText;
      const cls = classifyIssueStatus(match);
      if (cls && cls !== it.status) { it.status = cls; it.updatedAt = Date.now(); }
      if (it.status === 'needs_confirm' && !it.notifiedConfirm) { needConfirm.push(it); it.notifiedConfirm = true; }
    }
  }
  await setQueue(q);
  if (notify) {
    if (becameReady.length) notifyApply('ready', becameReady);
    if (needConfirm.length) notifyApply('confirm', needConfirm);
  }
  return q;
}

async function runApplyPoll({ items, notify = false } = {}) {
  let list = items;
  if (!Array.isArray(list)) {
    const fetched = await fetchIssuesItems();
    if (!fetched.ok) return { ok: false, error: fetched.error || (fetched.login ? 'SmartSitterへのログインが必要です。' : '依頼一覧を取得できませんでした。'), queue: await getQueue() };
    list = fetched.items || [];
  }
  return { ok: true, queue: await reconcileQueue(list, { notify }) };
}

function notifyApply(kind, items) {
  const n = items.length;
  try {
    chrome.notifications.create(`poppins-${kind}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'assets/icon128.png',
      title: kind === 'ready' ? '申請可能になりました' : '依頼の確定が必要です',
      message: kind === 'ready'
        ? `${n}件が2か月以内に入りました。SmartSitterで申請できます。`
        : `${n}件の見積もりが届いています。24時間以内に依頼を確定してください。`,
      priority: 2
    });
  } catch (_) {}
}

function setupApplyAlarm() { try { chrome.alarms.create(APPLY_ALARM, { periodInMinutes: 360, delayInMinutes: 1 }); } catch (_) {} }
chrome.runtime.onInstalled.addListener(setupApplyAlarm);
chrome.runtime.onStartup.addListener(() => { setupApplyAlarm(); runApplyPoll({ notify: true }); });
try {
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === APPLY_ALARM) runApplyPoll({ notify: true }); });
  chrome.notifications.onClicked.addListener((id) => { if (String(id).startsWith('poppins-')) chrome.tabs.create({ url: ISSUE_LIST_URL }); });
} catch (_) {}

chrome.runtime.onMessage.addListener((req, sender, send) => {
  if (req?.target === 'offscreen') return false; // offscreen 文書が処理する
  (async () => {
    switch (req?.type) {
      case 'store_get': {
        if (isContentScript(sender) && !canContentRead(req.keys)) {
          return send({ ok: false, error: 'content script から読めないキーです。' });
        }
        const data = await chrome.storage.local.get(req.keys);
        return send({ ok: true, data: isContentScript(sender) ? stripContentSecrets(data) : data });
      }
      case 'store_set':
        if (isContentScript(sender) && !canContentWrite(req.obj)) {
          return send({ ok: false, error: 'content script から書き込めないキーです。' });
        }
        await chrome.storage.local.set(req.obj);
        return send({ ok: true });
      case 'llm': return send(await callOpenRouter(req.payload));
      case 'gcal_connect': return send(await gcalConnect());
      case 'gcal_freebusy': return send(await gcalFreebusy(req.payload || {}));
      case 'gcal_redirect': return send({ ok: true, redirect: redirectUrl() });
      case 'apply_poll': return send(await runApplyPoll({ items: req.payload?.items, notify: false }));
      case 'open_panel':
        try {
          if (sender?.tab?.id) await chrome.sidePanel.open({ tabId: sender.tab.id });
          else await chrome.runtime.openOptionsPage();
          return send({ ok: true });
        } catch (e) {
          await chrome.runtime.openOptionsPage();
          return send({ ok: false, error: String(e?.message || e) });
        }
      case 'open_options': chrome.runtime.openOptionsPage(); return send({ ok: true });
      default: return send({ ok: false, error: 'unknown message' });
    }
  })();
  return true;
});
