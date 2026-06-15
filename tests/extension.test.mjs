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
assert.equal(manifest.version, '0.4.0');
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
assert.deepEqual(manifest.content_scripts?.[0]?.matches, ['https://smartsitter.jp/parent/message_rooms*']);

for (const host of ['https://smartsitter.jp/*', 'https://openrouter.ai/*', 'https://www.googleapis.com/*']) {
  assert.ok(manifest.host_permissions.includes(host), `missing host permission: ${host}`);
}

for (const permission of ['storage', 'unlimitedStorage', 'identity', 'sidePanel']) {
  assert.ok(manifest.permissions.includes(permission), `missing permission: ${permission}`);
}

for (const path of ['src/background.js', 'src/content.js', 'src/settings.js']) {
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

const background = read('src/background.js');
assert.match(background, /setAccessLevel/);
assert.match(background, /TRUSTED_CONTEXTS/);
assert.match(background, /stripContentSecrets/);
assert.match(background, /canContentWrite/);
assert.match(background, /open_panel/);

const settings = read('src/settings.js');
assert.match(settings, /makeBinding/);
assert.match(settings, /expectedContext/);
assert.match(settings, /renderSignals/);
assert.match(settings, /保存する候補を選択/);

console.log('extension manifest and scripts are valid');
