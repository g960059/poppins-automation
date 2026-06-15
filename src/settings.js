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
}

wire();
loadSettings();
refreshState();
