import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const assertFile = (path) => assert.ok(existsSync(join(root, path)), `${path} should exist`);

const manifest = JSON.parse(read('manifest.json'));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, '0.6.0');
assert.equal(manifest.background?.type, 'module');
assertFile(manifest.background.service_worker);
assertFile(manifest.options_ui.page);
assertFile(manifest.side_panel.default_path);
assertFile('assets/icon.svg');

for (const size of ['16', '32', '48', '128']) {
  assertFile(manifest.icons?.[size]);
  assertFile(manifest.action?.default_icon?.[size]);
}

for (const script of manifest.content_scripts ?? []) {
  for (const js of script.js ?? []) assertFile(js);
}
assert.deepEqual(manifest.content_scripts?.[0]?.matches, [
  'https://smartsitter.jp/parent/message_rooms*',
  'https://smartsitter.jp/parent/sitting/issues/new*',
  'https://smartsitter.jp/parent/sitting/issues/*'
]);

for (const host of ['https://smartsitter.jp/*', 'https://openrouter.ai/*', 'https://www.googleapis.com/*']) {
  assert.ok(manifest.host_permissions.includes(host), `missing host permission: ${host}`);
}

for (const permission of ['storage', 'unlimitedStorage', 'identity', 'sidePanel', 'alarms', 'notifications', 'offscreen']) {
  assert.ok(manifest.permissions.includes(permission), `missing permission: ${permission}`);
}

assertFile('src/offscreen.html');
assertFile('src/offscreen.js');

for (const path of ['src/background.js', 'src/content.js', 'src/settings.js', 'src/offscreen.js']) {
  execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'pipe' });
}

const html = read('src/settings.html');
assert.match(html, /<script src="settings\.js"><\/script>/);
assert.match(html, /data-pane="compose"/);
assert.match(html, /data-pane="sitter"/);
assert.match(html, /data-pane="settings"/);
assert.match(html, /stateWarnings/);
assert.match(html, /文脈ステータス/);
assert.match(html, /sigLastMessage/);
assert.match(html, /sigSittings/);
assert.match(html, /sigGcal/);

const content = read('src/content.js');
assert.doesNotMatch(content, /chrome\.storage\.local/, 'content script must not read chrome.storage directly');
assert.doesNotMatch(content, /poppins-assistant-host|buildDrawer|launcher/, 'in-page drawer should stay disabled; side panel is the main UI');
assert.match(content, /memoryUpdateCandidates/);
assert.match(content, /profile_button/);
assert.match(content, /js-message-text-area/);
assert.match(content, /parent\/sitting\/histories/);
assert.match(content, /assistant_generate/);
assert.match(content, /文脈取得ステータス/);
assert.match(content, /expectedContext/);
assert.match(content, /assertExpectedContext/);
assert.match(content, /置換/);
assert.match(content, /末尾に追記/);
assert.match(content, /open_panel/);
assert.match(content, /REPLY_RESPONSE_SCHEMA/);
assert.match(content, /MEMORY_RESPONSE_SCHEMA/);
assert.match(content, /todayJstDate/);
assert.match(content, /futureWindowDaysFromText/);
assert.match(content, /unknown message/);
assert.match(content, /assistant_extract_applications/);
assert.match(content, /assistant_resolve_sitter_id/);
assert.match(content, /assistant_poll_issues/);
assert.match(content, /APPLICATION_RESPONSE_SCHEMA/);
assert.match(content, /initApplyForm/);
assert.match(content, /IS_APPLY_DETAIL/);
assert.match(content, /initApplyDetail/);
assert.match(content, /apply_detail_seen/);
assert.match(content, /readApplyFormValues/);
assert.match(content, /#issue_date/);
assert.match(content, /#js-start-at/);
assert.match(content, /#js-end-at/);
assert.match(content, /#sitter_public_id/);
assert.match(content, /pendingApply/);
assert.match(content, /Date\.now\(\) - pending\.createdAt < 30 \* 60 \* 1000/);
assert.match(content, /フォーム上の値を確認できませんでした/);
assert.match(content, /ページを超えたため/);
assert.match(content, /parseApplyDetail/);
assert.doesNotMatch(content, /js-submit-button[^]{0,200}\.click\(\)/, 'must never auto-click the application submit button');
assert.doesNotMatch(content, /setUTCMonth/, 'month arithmetic should clamp month-end dates');

const background = read('src/background.js');
assert.match(background, /setAccessLevel/);
assert.match(background, /TRUSTED_CONTEXTS/);
assert.match(background, /stripContentSecrets/);
assert.match(background, /canContentRead/);
assert.match(background, /canContentWrite/);
assert.match(background, /fetchWithTimeout/);
assert.match(background, /response_format/);
assert.match(background, /open_panel/);
assert.match(background, /pendingApply/);
assert.match(background, /sitterid:/);
assert.match(background, /chrome\.alarms/);
assert.match(background, /runApplyPoll/);
assert.match(background, /reconcileQueue/);
assert.match(background, /MAX_ISSUE_PAGES/);
assert.match(background, /nextHref/);
assert.match(background, /apply_detail_seen/);
assert.match(background, /chrome\.notifications/);
assert.match(background, /ensureOffscreen/);
assert.match(background, /apply_poll/);
assert.match(background, /STATUS_RANK/);
assert.match(background, /shouldAdvanceStatus/);
assert.ok(background.indexOf('承認待ち') < background.indexOf('booked|charged'), 'needs-confirm classification must run before booked');
assert.match(background, /シッター対応待ち/);
assert.match(background, /issueIdentityMatches/);
assert.match(background, /itemTimeMatches/);
assert.doesNotMatch(background, /setUTCMonth/, 'month arithmetic should clamp month-end dates');

const offscreen = read('src/offscreen.js');
assert.match(offscreen, /DOMParser/);
assert.match(offscreen, /parse_issues/);
assert.match(offscreen, /requested-item/);
assert.match(offscreen, /nextHref/);
assert.match(offscreen, /sitterPublicId/);

const settings = read('src/settings.js');
assert.match(settings, /makeBinding/);
assert.match(settings, /expectedContext/);
assert.match(settings, /renderSignals/);
assert.match(settings, /gcalStatusFromSettings/);
assert.match(settings, /tabs\.onActivated/);
assert.match(settings, /保存する候補を選択/);
assert.match(settings, /runExtractApplications/);
assert.match(settings, /classifyCandidate/);
assert.match(settings, /pendingApply/);
assert.match(settings, /applicationSitterId/);
assert.match(settings, /sitting\/issues\/new/);
assert.match(settings, /renderQueue/);
assert.match(settings, /upsertQueueItem/);
assert.match(settings, /refreshQueueStatuses/);
assert.match(settings, /applyQueue/);
assert.match(settings, /cand\.decision !== 'agreed'/);
assert.doesNotMatch(settings, /upsertQueueItem\(spec, 'applied'\)/, 'opening the application form must not mark queue items as applied');
assert.doesNotMatch(settings, /setUTCMonth/, 'month arithmetic should clamp month-end dates');

assert.match(html, /data-pane="apply"/);
assert.match(html, /extractApplications/);
assert.match(html, /refreshQueue/);
assert.match(html, /applyQueueOut/);

console.log('extension manifest and scripts are valid');
