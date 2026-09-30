import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../domestic-server/src/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpath-preview-'));
const password = 'demo-preview-1234';
const token = crypto.randomBytes(24).toString('base64url');
const children = [];
let stopping = false;

async function availablePort(preferred) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(preferred, '127.0.0.1', resolve));
  } catch {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  }
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(label, directory, env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, directory),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.once('exit', (code) => {
    if (!stopping) {
      console.error(`${label} 已退出，退出码 ${code ?? 'unknown'}`);
      stop(1);
    }
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  fs.rmSync(temporaryDir, { recursive: true, force: true });
  process.exitCode = code;
}

async function main() {
  const domesticPort = await availablePort(8794);
  const firstPort = await availablePort(8795);
  const secondPort = await availablePort(8796);
  const settingsPath = path.join(temporaryDir, 'settings.json');
  const target = (id, label, port) => ({
    id,
    label,
    host: '127.0.0.1',
    port,
    mode: 'tcp',
    speedTestUrl: `http://127.0.0.1:${port}`,
    speedTestToken: token,
    enabled: true,
  });
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    version: 1,
    activeTargetId: 'demo-a',
    targets: [target('demo-a', '本机演示 A', firstPort), target('demo-b', '本机演示 B', secondPort)],
    admin: { username: 'admin', ...hashPassword(password) },
  }, null, 2)}\n`, { mode: 0o600 });

  start('探针 A', 'overseas-server', { HOST: '127.0.0.1', PORT: String(firstPort), AGENT_TOKEN: token });
  start('探针 B', 'overseas-server', { HOST: '127.0.0.1', PORT: String(secondPort), AGENT_TOKEN: token });
  const domesticEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(domesticPort), SETTINGS_FILE: settingsPath };
  for (const key of ['OVERSEAS_HOST', 'OVERSEAS_PORT', 'OVERSEAS_SPEED_URL', 'OVERSEAS_AGENT_TOKEN']) delete domesticEnv[key];
  start('管理节点', 'domestic-server', domesticEnv);

  console.log(`\n演示后台: http://127.0.0.1:${domesticPort}/admin`);
  console.log(`演示监控: http://127.0.0.1:${domesticPort}/`);
  console.log(`账号: admin  密码: ${password}`);
  console.log('演示数据只保存在临时目录；按 Ctrl+C 结束。\n');
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
main().catch((error) => {
  console.error(error);
  stop(1);
});
