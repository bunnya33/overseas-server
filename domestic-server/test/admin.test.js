import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launch(port, settingsPath) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SETTINGS_FILE: settingsPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`服务启动失败: ${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/admin/session`);
      if (response.ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`服务启动超时: ${log}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit');
}

test('admin saves multiple nodes and switches the active node across restart', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npo-admin-'));
  const settingsPath = path.join(tempDir, 'settings.json');
  const password = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    activeTargetId: null,
    targets: [],
    admin: { username: 'admin', ...hashPassword(password) },
  }));
  const port = await freePort();
  let child = await launch(port, settingsPath);
  t.after(async () => {
    await stop(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(`${base}${url}`, options);

  const unauthenticated = await request('/api/admin/state');
  assert.equal(unauthenticated.status, 401);
  const login = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const adminRequest = (url, options = {}) => request(url, {
    ...options,
    headers: { Cookie: cookie, Origin: base, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });

  const add = async (label, secret) => {
    const response = await adminRequest('/api/admin/targets', {
      method: 'POST',
      body: JSON.stringify({ label, host: '127.0.0.1', port: 443, mode: 'tcp', speedTestUrl: '', speedTestToken: secret, enabled: true }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).target.id;
  };
  const firstId = await add('东京一号', 'private-one');
  const secondId = await add('新加坡二号', 'private-two');

  const activation = await adminRequest(`/api/admin/targets/${secondId}/activate`, { method: 'POST' });
  assert.equal(activation.status, 200);
  const publicStatus = await (await request('/api/status')).json();
  assert.equal(publicStatus.activeTargetId, secondId);
  assert.deepEqual(publicStatus.targets.map((target) => target.id), [secondId]);
  assert.ok(!JSON.stringify(publicStatus).includes('private-two'));
  const speedWithoutLogin = await request('/api/remote-speed-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: secondId }),
  });
  assert.equal(speedWithoutLogin.status, 401);

  await stop(child);
  child = await launch(port, settingsPath);
  const secondLogin = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'admin', password }),
  });
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const saved = await (await request('/api/admin/state', { headers: { Cookie: secondCookie } })).json();
  assert.equal(saved.activeTargetId, secondId);
  assert.deepEqual(saved.targets.map((target) => target.id), [firstId, secondId]);
  assert.equal(saved.targets[0].speedTestToken, 'private-one');
  assert.equal(saved.targets[1].speedTestToken, 'private-two');
});
