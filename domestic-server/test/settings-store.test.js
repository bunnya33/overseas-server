import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../src/settings-store.js';

test('settings can replace an existing backup', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npo-settings-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const settingsPath = path.join(tempDir, 'settings.json');
  const initial = {
    version: 1,
    activeTargetId: null,
    targets: [],
    admin: { username: 'admin', passwordSalt: 'salt', passwordHash: 'hash' },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(initial), { mode: 0o600 });
  fs.writeFileSync(`${settingsPath}.bak`, 'old backup', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(`${settingsPath}.bak`, 0o400);

  const store = new SettingsStore(settingsPath);
  store.update((settings) => { settings.targets.push({ id: 'node-1' }); });

  assert.equal(store.get().targets[0].id, 'node-1');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${settingsPath}.bak`, 'utf8')), initial);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).targets[0].id, 'node-1');
});
