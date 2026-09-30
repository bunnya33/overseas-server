import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configure = path.join(projectRoot, 'linux', 'configure.mjs');

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [configure, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('installer migrates old targets and preserves saved state on rerun', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npo-install-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, 'config.json');
  const settingsPath = path.join(tempDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    server: { host: '0.0.0.0', port: 8787 },
    probe: {},
    speedTest: {},
    targets: [{ id: 'old-vpn', label: '旧节点', host: '127.0.0.1', port: 443, mode: 'tcp', enabled: true }],
  }));

  run(['install', 'domestic', configPath, settingsPath], { NETPATH_PORT: '9001', NETPATH_PASSWORD: 'test-password-123' });
  const migrated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(configured.server.port, 9001);
  assert.equal(configured.targets, undefined);
  assert.equal(migrated.activeTargetId, 'old-vpn');
  assert.equal(migrated.targets[0].label, '旧节点');

  run(['install', 'domestic', configPath, settingsPath], { NETPATH_PORT: '9002', NETPATH_PASSWORD: 'different-password-456' });
  const preserved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(preserved, migrated);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).server.port, 9002);
});

test('installer generates and preserves an overseas token', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npo-overseas-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, 'config.json');
  fs.copyFileSync(path.join(projectRoot, 'overseas-server', 'config.json'), configPath);

  run(['install', 'overseas', configPath], { NETPATH_PORT: '9003' });
  const first = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(first.security.token.length >= 16);
  assert.notEqual(first.security.token, 'change-this-token-before-deploy');
  run(['install', 'overseas', configPath], { NETPATH_PORT: '9004' });
  const second = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(second.security.token, first.security.token);
  assert.equal(second.server.port, 9004);
});
