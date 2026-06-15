// offscreen.js — service worker には DOMParser が無いため、
// 依頼一覧HTMLのパースだけをここ（DOMのあるoffscreen文書）で行う。
// background から {target:'offscreen', type:'parse_issues', html} を受け、items[] を返す。
'use strict';

const txt = (el) => (el ? el.textContent.replace(/\u00a0/g, ' ').trim() : '');

function looksLikeLoginPage(doc) {
  const body = txt(doc.body).slice(0, 1200);
  return !!doc.querySelector('form[action*="/users/sign_in"], input[type="password"]')
    || /ログイン|sign_in/.test(body);
}

function parseRequestedItems(doc) {
  return Array.from(doc.querySelectorAll('.requested-item')).map((it) => {
    const a = it.querySelector('a[href*="/parent/issues/"], a[href*="/parent/sitting/issues/"], a[href*="/parent/histories/"]');
    const href = a ? a.getAttribute('href') || '' : '';
    const issueId = ((href.match(/\/parent\/(?:sitting\/)?issues\/(\d+)/)
      || href.match(/\/parent\/histories\/(\d+)/) || [])[1]) || '';
    const names = Array.from(it.querySelectorAll('.requested-item-name')).map(txt);
    const em = it.querySelector('.requested-item-status em');
    return {
      issueId,
      sitterName: txt(it.querySelector('.requested-sitter-name')),
      date: names[0] || '',
      timeRange: (names[1] || '').replace(/【.*?】/, '').trim(),
      type: txt(it.querySelector('.requested-item-sitting-type')),
      status: txt(em),
      statusClass: em ? em.className || '' : ''
    };
  }).filter((x) => x.issueId || x.sitterName);
}

chrome.runtime.onMessage.addListener((req, _sender, send) => {
  if (req?.target !== 'offscreen') return;
  if (req.type === 'parse_issues') {
    try {
      const doc = new DOMParser().parseFromString(req.html || '', 'text/html');
      if (looksLikeLoginPage(doc)) { send({ ok: false, login: true, items: [] }); return; }
      send({ ok: true, items: parseRequestedItems(doc) });
    } catch (e) {
      send({ ok: false, error: String(e && e.message || e), items: [] });
    }
    return true;
  }
  return undefined;
});
