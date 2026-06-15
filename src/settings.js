// settings.js — options / side panel 兼用UI。
// 作成・挿入・シッターメモ操作は、現在のSmartSitterタブにいるcontent scriptへ依頼する。
const DEFAULT_MODEL = 'google/gemini-3.1-pro-preview';
const DEFAULT_STYLE = '丁寧だが冗長すぎない敬語。要点を先に。相手の負担を増やさない。絵文字は使わない。';
const DEFAULT_SCHEDULING_MD = [
  '# スケジュール方針', '', '## 基本頻度',
  '- 基本は週2回：**火曜** と **土曜または日曜のどちらか**。',
  '- 火曜は定期枠を優先。土日はできれば毎週1回確保したい。', '',
  '## 優先順位（空き確認・打診はこの順）', '1. シッターA', '2. シッターB', '',
  '## 時間帯', '- 火曜: 基本 10:00-14:00', '- 土日: 基本 14:00-18:00（相手都合で 10:00-14:00 も可）',
  '- シッターごとの過去実績があればそちらを優先', '',
  '## 返信方針', '- まずお礼。相手の都合に配慮。',
  '- 確定できる日時は明確に書く。未確定なら「確認します」ではなく、判断に必要な情報を短く聞く。'
].join('\n');

const INTENTS = [
  ['お礼', 'thanks', '先日のシッティングへのお礼を伝えたい'],
  ['明日の確認', 'confirmTomorrow', '明日の予定の確認・前日のご挨拶をしたい'],
  ['日程OK', 'acceptSchedule', '提示された候補日時で問題ない旨を伝えたい'],
  ['日程相談', 'askAvailability', '今後の希望日（火 + 土/日）の空き状況を確認したい'],
  ['定期継続', 'followUp', '来月以降も定期でお願いしたい旨を伝え、継続可否を確認したい'],
  ['やわらかく断る', 'decline', '予定が合わない旨を丁寧にお断りしたい']
];

const $ = (id) => document.getElementById(id);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const flash = (node, msg) => { node.textContent = msg; setTimeout(() => { node.textContent = ''; }, 2500); };

let selectedShortcut = '';
let lastCandidates = [];
let currentBinding = null;
let lastResultBinding = null;
let refreshTimer = null;

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function makeBinding(tab, ctx) {
  return {
    tabId: tab.id,
    tabUrl: tab.url || '',
    ctx: {
      roomId: ctx?.roomId || '',
      sitterId: ctx?.sitterId || '',
      sitterName: ctx?.sitterName || ''
    }
  };
}

async function activeMessageRoomTab() {
  const tab = await activeTab();
  if (!tab?.id) throw new Error('現在のタブを取得できません。');
  if (!/^https:\/\/smartsitter\.jp\/parent\/message_rooms/.test(tab.url || '')) {
    throw new Error('SmartSitterのメッセージ室タブを開いてから使ってください。');
  }
  return tab;
}

async function sendToTab(tabId, type, payload = {}) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type, payload });
  } catch (e) {
    const raw = String(e?.message || e || '');
    if (/Could not establish connection|Receiving end does not exist/i.test(raw)) {
      throw new Error('このタブで拡張がまだ読み込まれていません。SmartSitterのメッセージ室を再読み込みしてください。');
    }
    throw e;
  }
  if (!res?.ok) throw new Error(res?.error || 'content scriptから応答がありません。拡張を再読み込みしてください。');
  return res;
}

function gcalStatusFromSettings(settings = {}) {
  if (!settings.gcalEnabled) return '未使用';
  if (settings.gcalToken && settings.gcalTokenExp > Date.now()) return '接続済み';
  return settings.gcalToken ? '要再接続' : '未接続';
}

function setBusy(busy) {
  ['generate', 'generateAuto', 'refreshState', 'updateMemory', 'saveSitter'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
}

function wireTabs() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    $$('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${tab.dataset.pane}`));
  }));
}

function wireChips() {
  INTENTS.forEach(([label, code, intent]) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      selectedShortcut = code;
      $('intent').value = intent;
      $$('.chip', $('chips')).forEach((x) => x.classList.toggle('active', x === btn));
    });
    $('chips').appendChild(btn);
  });
  $('intent').addEventListener('input', () => {
    selectedShortcut = '';
    $$('.chip', $('chips')).forEach((x) => x.classList.remove('active'));
  });
}

async function refreshState() {
  try {
    const tab = await activeMessageRoomTab();
    const res = await sendToTab(tab.id, 'assistant_state');
    const { ctx, sitter, memory } = res.data;
    const { settings = {} } = await chrome.storage.local.get('settings');
    const status = { ...(res.data.status || {}), gcal: gcalStatusFromSettings(settings) };
    currentBinding = makeBinding(tab, ctx);
    $('pageStatus').textContent = ctx.page === 'room'
      ? `返信先: ${ctx.sitterName || '不明'}（room ${ctx.roomId || '-'}）`
      : 'SmartSitterのメッセージ室ではありません。';
    $('sitterHead').textContent = ctx.sitterId ? `${ctx.sitterName}（ID: ${ctx.sitterId}）` : 'シッター未特定';
    $('honorific').value = sitter.honorific || '';
    $('priorityRank').value = sitter.priorityRank || '';
    $('sitterNote').value = sitter.note || '';
    $('memRoom').value = memory.roomSummary || '';
    $('memFacts').value = memory.sitterFacts || '';
    $('memPending').value = memory.pendingSchedule || '';
    $('memoryStatus').textContent = memory.updatedAt ? `最終更新 ${new Date(memory.updatedAt).toLocaleString('ja-JP')}` : '記憶 未作成';
    renderSignals(status, memory);
  } catch (e) {
    currentBinding = null;
    $('pageStatus').innerHTML = `<span class="err">${esc(e.message || e)}</span>`;
    $('sitterHead').textContent = 'シッター未特定';
    renderSignals({}, {});
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshState(); }, 250);
}

function wireTabRefresh() {
  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === 'complete' && /^https:\/\/smartsitter\.jp\/parent\/message_rooms/.test(tab.url || '')) {
      scheduleRefresh();
    }
  });
}

function setSignal(id, text, kind = '') {
  const el = $(id);
  const box = el.closest('.signal');
  el.textContent = text || '-';
  box.classList.toggle('ok', kind === 'ok');
  box.classList.toggle('warn-signal', kind === 'warn');
}

function renderStateWarnings(status = {}) {
  const warnings = [];
  if (status.sittingsWarnings?.length) {
    warnings.push(`履歴/予定の取得に警告があります（${status.sittingsWarnings.length}件）。必要なら文脈ステータスを確認してください。`);
  }
  if (status.gcal === '要再接続' || status.gcal === '未接続') {
    warnings.push('Google Calendar連携が未接続です。カレンダー文脈なしで生成するか、設定タブで接続してください。');
  }
  const box = $('stateWarnings');
  box.hidden = warnings.length === 0;
  box.textContent = warnings.join('\n');
}

function renderSignals(status, memory) {
  renderStateWarnings(status || {});
  setSignal('sigLastMessage', status.lastMessage || '-', status.lastMessage ? 'ok' : '');
  setSignal('sigDraft', status.hasDraft ? '入力済み（挿入時に置換/追記を選択）' : '空', status.hasDraft ? '' : 'ok');
  const sittingText = status.sittingsWarnings?.length
    ? `警告 ${status.sittingsWarnings.length}件`
    : (status.sittingsCacheAt ? `取得済み ${new Date(status.sittingsCacheAt).toLocaleTimeString('ja-JP')}` : '未取得');
  setSignal('sigSittings', sittingText, status.sittingsWarnings?.length ? 'warn' : (status.sittingsCacheAt ? 'ok' : ''));
  setSignal('sigGcal', status.gcal || '未使用', status.gcal === '接続済み' ? 'ok' : (status.gcal === '要再接続' || status.gcal === '未接続' ? 'warn' : ''));
  $('memoryStatus').textContent = memory.updatedAt ? `最終更新 ${new Date(memory.updatedAt).toLocaleString('ja-JP')}` : '記憶 未作成';
}

async function loadSettings() {
  const { settings = {}, libraryMd = '', schedulingMd = '' } = await chrome.storage.local.get(['settings', 'libraryMd', 'schedulingMd']);
  $('apiKey').value = settings.apiKey || '';
  $('model').value = settings.model || DEFAULT_MODEL;
  $('draftCount').value = settings.draftCount || 2;
  $('temperature').value = settings.temperature ?? 0.5;
  $('replyStyle').value = settings.replyStyle || DEFAULT_STYLE;
  $('signature').value = settings.signature || '';
  $('schedulingMd').value = schedulingMd || DEFAULT_SCHEDULING_MD;
  $('libraryMd').value = libraryMd || '';
  $('gcalEnabled').checked = !!settings.gcalEnabled;
  $('gcalClientId').value = settings.gcalClientId || '';
  $('gcalCalendarId').value = settings.gcalCalendarId || 'primary';
  $('gcalStatus').textContent = gcalStatusFromSettings(settings);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'gcal_redirect' });
    if (r?.ok) $('gcalRedirect').textContent = r.redirect;
  } catch (_) {}
}

async function saveSettings() {
  const cur = (await chrome.storage.local.get('settings')).settings || {};
  const t = Number.parseFloat($('temperature').value);
  const dc = parseInt($('draftCount').value, 10);
  await chrome.storage.local.set({
    settings: {
      ...cur,
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim() || DEFAULT_MODEL,
      draftCount: Math.min(Math.max(Number.isFinite(dc) ? dc : 2, 1), 3),
      temperature: Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.5,
      replyStyle: $('replyStyle').value,
      signature: $('signature').value.trim(),
      gcalEnabled: $('gcalEnabled').checked,
      gcalClientId: $('gcalClientId').value.trim(),
      gcalCalendarId: $('gcalCalendarId').value.trim() || 'primary'
    },
    schedulingMd: $('schedulingMd').value,
    libraryMd: $('libraryMd').value
  });
  flash($('saved'), '保存しました');
}

async function generate(shortcut) {
  setBusy(true);
  $('composeOut').innerHTML = '<span class="muted">生成中...</span>';
  try {
    const tab = await activeMessageRoomTab();
    const res = await sendToTab(tab.id, 'assistant_generate', { intent: $('intent').value, shortcut });
    lastResultBinding = makeBinding(tab, res.ctx);
    currentBinding = lastResultBinding;
    $('contextPreview').textContent = res.preview || '';
    renderResult(res.data, res.parseWarning, res.localWarnings || [], lastResultBinding);
  } catch (e) {
    renderError(e.message || e);
  } finally {
    setBusy(false);
  }
}

function renderError(message) {
  const m = String(message || '');
  const actions = [];
  if (/APIキー|OpenRouter|設定/.test(m)) actions.push('<button class="inline-btn" type="button" data-action="settings">設定タブへ</button>');
  if (/Google|Calendar|再接続/.test(m)) actions.push('<button class="inline-btn" type="button" data-action="gcal">Google再接続</button>');
  actions.push('<button class="inline-btn" type="button" data-action="refresh">再読込</button>');
  $('composeOut').innerHTML = `<div class="err">${esc(m)}</div><div>${actions.join('')}</div>`;
  $('composeOut').querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.action === 'settings') switchPane('settings');
    else if (btn.dataset.action === 'gcal') { switchPane('settings'); $('gcalConnect').focus(); }
    else refreshState();
  }));
}

function switchPane(name) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.pane === name));
  $$('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${name}`));
}

function renderResult(data, parseWarning, localWarnings, binding) {
  $('composeOut').innerHTML = '';
  lastCandidates = data?.memoryUpdateCandidates || [];
  if (binding?.ctx?.sitterName) {
    $('composeOut').insertAdjacentHTML('beforeend', `<div class="status">この下書きの宛先: ${esc(binding.ctx.sitterName)}（room ${esc(binding.ctx.roomId || '-')}）</div>`);
  }
  if (parseWarning) $('composeOut').insertAdjacentHTML('beforeend', `<div class="warn">${esc(parseWarning)}</div>`);
  (localWarnings || []).forEach((w) => $('composeOut').insertAdjacentHTML('beforeend', `<div class="warn">${esc(w)}</div>`));
  if (data?.situation?.summary) $('composeOut').insertAdjacentHTML('beforeend', `<div class="status">${esc(data.situation.summary)}</div>`);
  (data?.warnings || []).forEach((w) => $('composeOut').insertAdjacentHTML('beforeend', `<div class="warn">${esc(w)}</div>`));
  (data?.drafts || []).forEach((draft) => {
    const card = document.createElement('div');
    card.className = 'draft';
    card.innerHTML = `<div class="lbl">${esc(draft.label || '下書き')}</div>${draft.why ? `<div class="why">${esc(draft.why)}</div>` : ''}<div class="text"></div>`;
    card.querySelector('.text').textContent = draft.text || '';
    const insert = document.createElement('button');
    insert.className = 'inline-btn';
    insert.type = 'button';
    insert.textContent = '入力欄に挿入';
    insert.addEventListener('click', async () => {
      try {
        await sendToTab(binding.tabId, 'assistant_insert', { text: draft.text || '', expectedContext: binding.ctx });
        setCardStatus(card, `挿入済み: ${binding.ctx.sitterName || '宛先不明'}`);
      } catch (e) { setCardStatus(card, e.message || e, true); }
    });
    const copy = document.createElement('button');
    copy.className = 'inline-btn';
    copy.type = 'button';
    copy.textContent = 'コピー';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(draft.text || '');
      setCardStatus(card, 'コピー済み');
    });
    card.appendChild(insert);
    card.appendChild(copy);
    $('composeOut').appendChild(card);
  });
  if (lastCandidates.length) renderMemoryCandidates(lastCandidates, binding);
}

function setCardStatus(card, message, isError = false) {
  let node = card.querySelector('.card-status');
  if (!node) {
    node = document.createElement('div');
    node.className = 'card-status muted';
    node.style.marginTop = '8px';
    card.appendChild(node);
  }
  node.classList.toggle('err', !!isError);
  node.classList.toggle('muted', !isError);
  node.textContent = message;
}

function renderMemoryCandidates(candidates, binding) {
  const box = document.createElement('div');
  box.className = 'mem';
  box.innerHTML = '<h5>記憶に保存する候補（確認して選択）</h5><div class="muted">モデル由来の候補です。保存するものだけ選び、必要なら本文を編集してください。</div>';
  candidates.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'opt';
    row.innerHTML = `<input type="checkbox" data-i="${i}"> <div style="flex:1"><span>[${esc(c.type || 'room')}]</span><textarea data-text-i="${i}"></textarea></div>`;
    row.querySelector('textarea').value = c.text || '';
    box.appendChild(row);
  });
  const save = document.createElement('button');
  save.className = 'btn ghost';
  save.type = 'button';
  save.textContent = '選択を記憶に保存';
  save.addEventListener('click', async () => {
    const selected = $$('input[type=checkbox]', box).filter((cb) => cb.checked).map((cb) => {
      const i = +cb.dataset.i;
      return { ...candidates[i], text: box.querySelector(`textarea[data-text-i="${i}"]`)?.value.trim() || '' };
    }).filter((c) => c.text);
    try {
      if (!selected.length) throw new Error('保存する候補を選択してください。');
      const res = await sendToTab(binding.tabId, 'assistant_save_memory_candidates', {
        candidates: selected,
        selectedIndexes: selected.map((_, i) => i),
        expectedContext: binding.ctx
      });
      applyMemoryFields(res.memory || {});
      box.insertAdjacentHTML('beforeend', '<div class="muted" style="margin-top:8px">保存しました</div>');
    } catch (e) { alert(e.message || e); }
  });
  box.appendChild(save);
  $('composeOut').appendChild(box);
}

function applyMemoryFields(memory) {
  $('memRoom').value = memory.roomSummary || '';
  $('memFacts').value = memory.sitterFacts || '';
  $('memPending').value = memory.pendingSchedule || '';
}

async function updateMemory() {
  setBusy(true);
  $('memoryStatus').textContent = '更新中...';
  try {
    if (!currentBinding) await refreshState();
    if (!currentBinding) throw new Error('対象のメッセージ室を確認できません。');
    const res = await sendToTab(currentBinding.tabId, 'assistant_regenerate_memory', { expectedContext: currentBinding.ctx });
    applyMemoryFields(res.memory || {});
    $('memoryStatus').textContent = '記憶を更新しました';
  } catch (e) {
    $('memoryStatus').textContent = e.message || '失敗';
  } finally {
    setBusy(false);
  }
}

async function saveSitter() {
  try {
    if (!currentBinding) await refreshState();
    if (!currentBinding) throw new Error('対象のメッセージ室を確認できません。');
    const res = await sendToTab(currentBinding.tabId, 'assistant_save_sitter', {
      honorific: $('honorific').value,
      priorityRank: $('priorityRank').value,
      note: $('sitterNote').value,
      roomSummary: $('memRoom').value,
      sitterFacts: $('memFacts').value,
      pendingSchedule: $('memPending').value,
      expectedContext: currentBinding.ctx
    });
    applyMemoryFields(res.data?.memory || {});
    flash($('sitterInfo'), '保存しました');
  } catch (e) {
    flash($('sitterInfo'), e.message || '失敗');
  }
}

async function connectGcal() {
  await saveSettings();
  $('gcalStatus').textContent = '接続中...';
  const r = await chrome.runtime.sendMessage({ type: 'gcal_connect' });
  $('gcalStatus').textContent = r?.ok ? '接続済み' : (`失敗: ${r?.error || ''}`);
  refreshState();
}

// ===== 申請（システム依頼）タブ =====
function todayTokyo() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isoToUtc(iso) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
function addMonthsUtc(d, n) { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; }
function fmtSlash(d) { return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`; }
function fmtJp(d) { const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getUTCDay()]; return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${wd})`; }
const hhmmCompact = (t) => (t || '').replace(':', '');

function buildDescription(cand) {
  return [
    'いつもお世話になっております。',
    '下記の日程でお願いできますと幸いです。',
    `${cand.date} ${cand.startTime}〜${cand.endTime}`,
    'ご確認のほど、どうぞよろしくお願いいたします。'
  ].join('\n');
}

async function storedSitterId(profileId) {
  if (!profileId) return null;
  const key = `sitterid:${profileId}`;
  const got = await chrome.storage.local.get(key);
  return got[key]?.sitterId || null;
}

function classifyCandidate(cand, today, twoMonthEnd, existing) {
  const d = isoToUtc(cand.date);
  if (!d) return { group: 'excluded', reason: '日付を解釈できませんでした' };
  if (cand.decision === 'declined') return { group: 'excluded', reason: '見送り（チャットで除外）', d };
  if (cand.decision !== 'agreed') return { group: 'excluded', reason: `未確定（${cand.decision || 'unknown'}）`, d };
  const hit = (existing || []).find((e) => (
    e.date === cand.date
    && e.active
    && (!e.startTime || !e.endTime || (hhmmCompact(e.startTime) === hhmmCompact(cand.startTime) && hhmmCompact(e.endTime) === hhmmCompact(cand.endTime)))
  ));
  if (hit) return { group: 'already', reason: `既に依頼あり（${hit.status || '進行中'}）`, d };
  if (d < today) return { group: 'excluded', reason: '過去の日付', d };
  if (d <= twoMonthEnd) return { group: 'ready', d };
  return { group: 'deferred', d, availableFrom: addMonthsUtc(d, -2) };
}

async function runExtractApplications() {
  const out = $('applyOut');
  $('applyWarn').hidden = true;
  out.innerHTML = '<span class="muted">抽出中...</span>';
  $('extractApplications').disabled = true;
  try {
    const tab = await activeMessageRoomTab();
    const res = await sendToTab(tab.id, 'assistant_extract_applications');
    const binding = makeBinding(tab, res.ctx);
    $('applyHead').textContent = `対象: ${res.ctx.sitterName || '不明'}（room ${res.ctx.roomId || '-'}）`;
    if (res.sittingsWarnings?.length) {
      $('applyWarn').hidden = false;
      $('applyWarn').textContent = res.sittingsWarnings.join('\n');
    }
    renderApplications(res.candidates || [], res.existing || [], binding);
  } catch (e) {
    out.innerHTML = `<div class="err">${esc(e.message || e)}</div>`;
  } finally {
    $('extractApplications').disabled = false;
  }
}

function renderApplications(candidates, existing, binding) {
  const out = $('applyOut');
  out.innerHTML = '';
  const today = todayTokyo();
  const twoMonthEnd = addMonthsUtc(today, 2);
  const groups = { ready: [], deferred: [], already: [], excluded: [] };
  candidates.forEach((c) => {
    const cls = classifyCandidate(c, today, twoMonthEnd, existing);
    groups[cls.group].push({ c, cls });
  });

  if (!candidates.length) {
    out.innerHTML = '<div class="muted">申請候補は見つかりませんでした。</div>';
    return;
  }

  const section = (title, items, kind) => {
    if (!items.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'apply-group';
    const h = document.createElement('h4');
    h.textContent = `${title}（${items.length}）`;
    wrap.appendChild(h);
    items.forEach(({ c, cls }) => wrap.appendChild(renderApplyItem(c, cls, kind, binding)));
    out.appendChild(wrap);
  };
  section('要確認（2か月以内・申請可能）', groups.ready, 'ready');
  section('まだ申請不可（2か月超）', groups.deferred, 'deferred');
  section('既に依頼あり', groups.already, 'already');
  section('除外', groups.excluded, 'excluded');
}

function renderApplyItem(c, cls, kind, binding) {
  const item = document.createElement('div');
  item.className = 'apply-item' + (kind === 'excluded' ? ' excluded' : kind === 'deferred' ? ' deferred' : '');
  const when = cls.d ? `${fmtJp(cls.d)} ${c.startTime}〜${c.endTime}` : `${c.date} ${c.startTime}〜${c.endTime}`;
  item.innerHTML = `<div class="when">${esc(when)}</div>`
    + (c.evidence ? `<div class="ev">根拠: ${esc(c.evidence)}</div>` : '')
    + (cls.reason ? `<div class="meta">${esc(cls.reason)}</div>` : '')
    + (cls.availableFrom ? `<div class="meta">${esc(fmtSlash(cls.availableFrom))} から申請可能</div>` : '');

  if (kind === 'ready' || kind === 'deferred') {
    const btns = document.createElement('div');
    btns.className = 'row-btns';
    if (kind === 'ready') {
      const fill = document.createElement('button');
      fill.className = 'inline-btn';
      fill.type = 'button';
      fill.textContent = 'フォームに入力';
      fill.addEventListener('click', () => fillForm(c, binding, item, fill));
      btns.appendChild(fill);
    }
    const queueBtn = document.createElement('button');
    queueBtn.className = 'inline-btn';
    queueBtn.type = 'button';
    queueBtn.textContent = kind === 'ready' ? '追跡に追加' : '予約に入れる';
    queueBtn.addEventListener('click', async () => {
      await upsertQueueItem(specFromCandidate(c, binding), kind === 'ready' ? 'ready' : 'deferred');
      setCardStatus(item, kind === 'ready' ? '追跡キューに追加しました。' : '予約キューに入れました（申請可能日に通知）。');
      await renderQueue();
    });
    btns.appendChild(queueBtn);
    item.appendChild(btns);
  }
  return item;
}

function specFromCandidate(c, binding) {
  return {
    profileId: binding.ctx.sitterId,
    sitterName: binding.ctx.sitterName,
    date: c.date, startTime: c.startTime, endTime: c.endTime,
    decision: c.decision, evidence: c.evidence
  };
}

async function openApplyForm(spec, opts = {}) {
  const note = opts.note || (() => {});
  let sitterId = await storedSitterId(spec.profileId);
  if (!sitterId && opts.tabId) {
    try { const r = await sendToTab(opts.tabId, 'assistant_resolve_sitter_id', { profileId: spec.profileId }); if (r?.ok) sitterId = r.sitterId; } catch (_) {}
  }
  if (!sitterId) {
    const pasted = prompt('このシッターの申請用IDを自動取得できませんでした。\nプロフィールの「依頼する」を一度開き、そのURL（…sitter_id=XXXX…）を貼り付けてください。');
    const m = /sitter_id=(\d+)/.exec(pasted || '') || /(\d{3,})/.exec(pasted || '');
    if (!m) { note('sitter_id を取得できませんでした。', true); return false; }
    sitterId = m[1];
    await chrome.storage.local.set({ [`sitterid:${spec.profileId}`]: { sitterId, source: 'manual', at: Date.now() } });
  }
  const d = isoToUtc(spec.date);
  const deepLink = 'https://smartsitter.jp/parent/sitting/issues/new'
    + `?date=${encodeURIComponent(fmtSlash(d))}`
    + `&start=${hhmmCompact(spec.startTime)}&end=${hhmmCompact(spec.endTime)}`
    + '&issue_type=sitting&include_interview=false'
    + `&sitter_id=${sitterId}`;
  await chrome.storage.local.set({
    pendingApply: {
      sitterId, date: spec.date,
      start: hhmmCompact(spec.startTime), end: hhmmCompact(spec.endTime),
      description: buildDescription(spec), sitterName: spec.sitterName, createdAt: Date.now()
    }
  });
  await chrome.tabs.create({ url: deepLink, active: true });
  note('実フォームを開きました。内容を確認して「依頼する」を押してください（送信は手動）。');
  return true;
}

async function fillForm(cand, binding, item, btn) {
  btn.disabled = true;
  try {
    const spec = specFromCandidate(cand, binding);
    const ok = await openApplyForm(spec, { tabId: binding.tabId, note: (m, e) => setCardStatus(item, m, e) });
    if (ok) { await upsertQueueItem(spec, 'ready'); await renderQueue(); }
  } finally {
    btn.disabled = false;
  }
}

// ===== 申請キュー（永続）/ 状態追跡 =====
const qkey = (profileId, date, start) => `${profileId}|${date}|${start}`;
async function loadQueue() { return (await chrome.storage.local.get('applyQueue')).applyQueue || []; }

async function activeSmartsitterTabId() {
  const tab = await activeTab();
  return (tab?.id && /^https:\/\/smartsitter\.jp\/parent\//.test(tab.url || '')) ? tab.id : undefined;
}

async function upsertQueueItem(spec, status) {
  const q = await loadQueue();
  const key = qkey(spec.profileId, spec.date, hhmmCompact(spec.startTime));
  const now = Date.now();
  const base = {
    key, profileId: spec.profileId, sitterName: spec.sitterName,
    date: spec.date, start: hhmmCompact(spec.startTime), end: hhmmCompact(spec.endTime),
    startTime: spec.startTime, endTime: spec.endTime,
    decision: spec.decision || '', evidence: spec.evidence || '', updatedAt: now
  };
  const rank = { deferred: 0, ready: 1, applied: 2, needs_confirm: 3, booked: 4, canceled: 4 };
  const existing = q.find((x) => x.key === key);
  if (existing) {
    Object.assign(existing, base);
    if ((rank[status] ?? 0) >= (rank[existing.status] ?? 0)) existing.status = status;
  } else {
    q.push({ ...base, status, addedAt: now });
  }
  await chrome.storage.local.set({ applyQueue: q });
}
async function deleteQueueItem(key) {
  const q = (await loadQueue()).filter((x) => x.key !== key);
  await chrome.storage.local.set({ applyQueue: q });
}

const QUEUE_GROUPS = [
  ['needs_confirm', '要確定（見積もり到着・24h以内）'],
  ['ready', '申請可能'],
  ['deferred', '予約中（申請可能日待ち）'],
  ['applied', '申請済み・見積り待ち'],
  ['booked', '確定'],
  ['canceled', 'キャンセル']
];

async function renderQueue() {
  const box = $('applyQueueOut');
  if (!box) return;
  const q = await loadQueue();
  if (!q.length) { box.innerHTML = '<div class="muted">予約・追跡はまだありません。</div>'; return; }
  const today = todayTokyo();
  box.innerHTML = '';
  QUEUE_GROUPS.forEach(([status, title]) => {
    const items = q.filter((x) => x.status === status);
    if (!items.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'apply-group';
    const h = document.createElement('h4');
    h.textContent = `${title}（${items.length}）`;
    wrap.appendChild(h);
    items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    items.forEach((it) => wrap.appendChild(renderQueueItem(it, today)));
    box.appendChild(wrap);
  });
}

function renderQueueItem(it) {
  const d = isoToUtc(it.date);
  const node = document.createElement('div');
  node.className = 'apply-item' + (it.status === 'deferred' ? ' deferred' : it.status === 'canceled' ? ' excluded' : '');
  const when = d ? `${fmtJp(d)} ${it.startTime || ''}〜${it.endTime || ''}` : `${it.date}`;
  const meta = [esc(it.sitterName || '')];
  if (it.status === 'deferred' && d) meta.push(`${fmtSlash(addMonthsUtc(d, -2))} から申請可能`);
  if (it.statusText) meta.push(`状態: ${esc(it.statusText)}`);
  if (it.issueId) meta.push(`issue ${esc(it.issueId)}`);
  node.innerHTML = `<div class="when">${esc(when)}</div><div class="meta">${meta.join(' ・ ')}</div>`;
  const btns = document.createElement('div');
  btns.className = 'row-btns';
  if (it.status === 'ready') {
    const fill = document.createElement('button');
    fill.className = 'inline-btn';
    fill.type = 'button';
    fill.textContent = 'フォームに入力';
    fill.addEventListener('click', async () => {
      const tabId = await activeSmartsitterTabId();
      const spec = { profileId: it.profileId, sitterName: it.sitterName, date: it.date, startTime: it.startTime, endTime: it.endTime };
      const ok = await openApplyForm(spec, { tabId, note: (m, e) => setCardStatus(node, m, e) });
      if (ok) { await upsertQueueItem(spec, 'ready'); await renderQueue(); }
    });
    btns.appendChild(fill);
  }
  if (it.issueId) {
    const open = document.createElement('button');
    open.className = 'inline-btn';
    open.type = 'button';
    open.textContent = '依頼を開く';
    open.addEventListener('click', () => chrome.tabs.create({ url: `https://smartsitter.jp/parent/sitting/issues/${it.issueId}` }));
    btns.appendChild(open);
  }
  const del = document.createElement('button');
  del.className = 'inline-btn';
  del.type = 'button';
  del.textContent = '削除';
  del.addEventListener('click', async () => { await deleteQueueItem(it.key); await renderQueue(); });
  btns.appendChild(del);
  node.appendChild(btns);
  return node;
}

async function refreshQueueStatuses() {
  $('queueStatus').textContent = '更新中...';
  $('refreshQueue').disabled = true;
  try {
    let items = null;
    let warnings = [];
    const tabId = await activeSmartsitterTabId();
    if (tabId) {
      try {
        const r = await sendToTab(tabId, 'assistant_poll_issues');
        items = r.items || [];
        warnings = r.warnings || [];
      } catch (_) {}
    }
    const res = await chrome.runtime.sendMessage({ type: 'apply_poll', payload: { items } });
    await renderQueue();
    if (!res?.ok) throw new Error(res?.error || '更新に失敗');
    if (warnings.length) {
      $('applyWarn').hidden = false;
      $('applyWarn').textContent = warnings.join('\n');
      $('queueStatus').textContent = '一部取得に警告があります';
    } else {
      $('queueStatus').textContent = `更新しました ${new Date().toLocaleTimeString('ja-JP')}`;
    }
  } catch (e) {
    $('queueStatus').textContent = e.message || '更新に失敗';
  } finally {
    $('refreshQueue').disabled = false;
  }
}


function wire() {
  wireTabs();
  wireChips();
  wireTabRefresh();
  $('refreshState').addEventListener('click', refreshState);
  $('generate').addEventListener('click', () => generate(selectedShortcut || ''));
  $('generateAuto').addEventListener('click', () => generate('auto'));
  $('updateMemory').addEventListener('click', updateMemory);
  $('saveSitter').addEventListener('click', saveSitter);
  $('saveSettings').addEventListener('click', saveSettings);
  $('gcalConnect').addEventListener('click', connectGcal);
  $('extractApplications').addEventListener('click', runExtractApplications);
  $('refreshQueue').addEventListener('click', refreshQueueStatuses);
  const applyTab = document.querySelector('[data-pane="apply"]');
  if (applyTab) applyTab.addEventListener('click', renderQueue);
}

wire();
loadSettings();
refreshState();
renderQueue();
