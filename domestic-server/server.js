import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionManager, hashPassword, verifyPassword } from './src/auth.js';
import { loadConfig, PROJECT_ROOT } from './src/config.js';
import { NetworkMonitor } from './src/monitor.js';
import { probeTarget } from './src/probe.js';
import { SettingsStore } from './src/settings-store.js';
import { runRemoteSpeedTest } from './src/speed-test.js';
import { normalizeTarget } from './src/targets.js';

const config = loadConfig();
const publicDir = path.join(PROJECT_ROOT, 'public');
const settingsPath = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.resolve(PROJECT_ROOT, config.storage.settingsFile);
const store = new SettingsStore(settingsPath);
const sessions = new SessionManager(config.admin.sessionTtlHours);
const loginAttempts = new Map();
const speedResults = new Map();
let persistedSettings = store.get();
let activeSpeedTransfers = 0;
let activeRemoteSpeedTest = false;

function environmentTarget() {
  if (!process.env.OVERSEAS_HOST) return null;
  return normalizeTarget({
    label: process.env.OVERSEAS_LABEL || '环境变量节点',
    host: process.env.OVERSEAS_HOST,
    port: process.env.OVERSEAS_PORT || 443,
    mode: process.env.OVERSEAS_MODE || 'tcp',
    speedTestUrl: process.env.OVERSEAS_SPEED_URL || '',
    speedTestToken: process.env.OVERSEAS_AGENT_TOKEN || '',
    enabled: true,
  }, 'environment-target');
}

function runtimeState() {
  const injected = environmentTarget();
  if (injected) {
    return {
      targets: [injected],
      activeTargetId: injected.id,
    };
  }
  const active = persistedSettings.targets.find((target) => target.id === persistedSettings.activeTargetId);
  return {
    targets: active ? [active] : [],
    activeTargetId: active?.id || null,
  };
}

const initialState = runtimeState();
config.targets = initialState.targets;
const monitor = new NetworkMonitor(config);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function serveStatic(requestPath, requestMethod, response) {
  let relativePath;
  if (requestPath === '/') relativePath = 'index.html';
  else if (requestPath === '/admin' || requestPath === '/admin/') relativePath = 'admin/index.html';
  else relativePath = requestPath.replace(/^\/+/, '');

  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, 'index.html')) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    response.end(requestMethod === 'HEAD' ? undefined : content);
  });
}

function isAgentAuthorized(request) {
  const expected = config.speedTest.agentToken;
  if (!expected) return true;
  const actual = request.headers.authorization || '';
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const actualBuffer = Buffer.from(actual);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function reserveSpeedTransfer(response) {
  if (activeSpeedTransfers >= config.speedTest.maxConcurrentTransfers) {
    sendJson(response, 429, { error: '测速任务过多，请稍后重试' });
    return false;
  }
  activeSpeedTransfers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeSpeedTransfers -= 1;
  };
  response.once('close', release);
  response.once('finish', release);
  return true;
}

function requestedBytes(url) {
  const bytes = Number.parseInt(url.searchParams.get('bytes'), 10) || config.speedTest.downloadBytes;
  return Math.max(65536, Math.min(bytes, config.speedTest.maxTransferBytes));
}

function streamDownload(response, bytes) {
  const chunk = crypto.randomBytes(Math.min(262144, bytes));
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes,
    'Cache-Control': 'no-store, no-transform',
    'Content-Encoding': 'identity',
    'X-Content-Type-Options': 'nosniff',
  });
  let remaining = bytes;
  const write = () => {
    while (remaining > 0) {
      const size = Math.min(remaining, chunk.length);
      remaining -= size;
      if (!response.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
        response.once('drain', write);
        return;
      }
    }
    response.end();
  };
  write();
}

function receiveUpload(request, response) {
  const advertised = Number.parseInt(request.headers['content-length'], 10);
  if (Number.isFinite(advertised) && advertised > config.speedTest.maxTransferBytes) {
    sendJson(response, 413, { error: '上传测速数据超过限制' });
    request.resume();
    return;
  }
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > config.speedTest.maxTransferBytes) request.destroy();
  });
  request.on('end', () => sendJson(response, 200, { bytes }));
  request.on('error', () => {
    if (!response.headersSent) sendJson(response, 400, { error: '上传中断' });
  });
}

function readJsonBody(request, limit = 16384) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > limit) {
        settled = true;
        reject(new Error('请求内容过大'));
      }
    });
    request.on('end', () => {
      if (settled) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON 格式无效'));
      }
    });
    request.on('error', reject);
  });
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function requireAdmin(request, response) {
  const session = sessions.get(request);
  if (!session) sendJson(response, 401, { error: '请先登录管理后台' });
  return session;
}

function loginBlocked(address) {
  const entry = loginAttempts.get(address);
  if (!entry || entry.resetAt <= Date.now()) {
    loginAttempts.delete(address);
    return false;
  }
  return entry.attempts >= config.admin.loginMaxAttempts;
}

function recordLoginFailure(address) {
  const windowMs = config.admin.loginWindowMinutes * 60 * 1000;
  const current = loginAttempts.get(address);
  if (!current || current.resetAt <= Date.now()) {
    loginAttempts.set(address, { attempts: 1, resetAt: Date.now() + windowMs });
  } else {
    current.attempts += 1;
  }
}

function applyPersistedSettings(next) {
  persistedSettings = next;
  const state = runtimeState();
  monitor.replaceTargets(state.targets);
  for (const id of speedResults.keys()) {
    if (!state.targets.some((target) => target.id === id)) speedResults.delete(id);
  }
}

function updateSettings(mutator) {
  const next = store.update(mutator);
  applyPersistedSettings(next);
  return next;
}

function adminState() {
  const liveById = Object.fromEntries(monitor.snapshot().targets.map((target) => [target.id, target.summary]));
  return {
    activeTargetId: persistedSettings.activeTargetId,
    targets: persistedSettings.targets.map((target) => ({ ...target, summary: liveById[target.id] || null })),
    admin: { username: persistedSettings.admin.username },
    environmentOverride: Boolean(process.env.OVERSEAS_HOST),
  };
}

async function testTarget(target) {
  const connection = await probeTarget(target, config.probe.timeoutMs);
  let agent = { configured: false, ok: null, latencyMs: null, error: null };
  if (target.speedTestUrl) {
    const started = performance.now();
    try {
      const url = new URL('api/speed/download', `${target.speedTestUrl}/`);
      url.searchParams.set('bytes', '65536');
      const response = await fetch(url, {
        headers: target.speedTestToken ? { Authorization: `Bearer ${target.speedTestToken}` } : {},
        cache: 'no-store',
        signal: AbortSignal.timeout(config.probe.timeoutMs + 3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.arrayBuffer();
      agent = { configured: true, ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, error: null };
    } catch (error) {
      agent = { configured: true, ok: false, latencyMs: null, error: error.message };
    }
  }
  return { connection, agent };
}

async function handleAdminApi(request, response, url) {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: '请求来源无效' });
    return true;
  }

  if (url.pathname === '/api/admin/session' && request.method === 'GET') {
    const session = sessions.get(request);
    sendJson(response, 200, session
      ? { authenticated: true, username: session.username }
      : { authenticated: false });
    return true;
  }

  if (url.pathname === '/api/admin/login' && request.method === 'POST') {
    const address = request.socket.remoteAddress || 'unknown';
    if (loginBlocked(address)) {
      sendJson(response, 429, { error: '登录失败次数过多，请稍后重试' });
      request.resume();
      return true;
    }
    try {
      const { username, password } = await readJsonBody(request, 4096);
      const valid = username === persistedSettings.admin.username
        && typeof password === 'string'
        && verifyPassword(password, persistedSettings.admin);
      if (!valid) {
        recordLoginFailure(address);
        sendJson(response, 401, { error: '用户名或密码错误' });
        return true;
      }
      loginAttempts.delete(address);
      const sessionId = sessions.create(username);
      sendJson(response, 200, { ok: true, username }, { 'Set-Cookie': sessions.cookie(sessionId, request) });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
    sessions.destroy(request);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessions.clearCookie() });
    return true;
  }

  if (!requireAdmin(request, response)) return true;

  if (url.pathname === '/api/admin/state' && request.method === 'GET') {
    sendJson(response, 200, adminState());
    return true;
  }

  if (url.pathname === '/api/admin/password' && request.method === 'POST') {
    try {
      const { currentPassword, newPassword } = await readJsonBody(request, 8192);
      if (!verifyPassword(String(currentPassword || ''), persistedSettings.admin)) {
        sendJson(response, 403, { error: '当前密码错误' });
        return true;
      }
      if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 256) {
        sendJson(response, 400, { error: '新密码长度必须为 10-256 个字符' });
        return true;
      }
      const passwordData = hashPassword(newPassword);
      updateSettings((settings) => Object.assign(settings.admin, passwordData));
      sessions.clear();
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessions.clearCookie() });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (url.pathname === '/api/admin/targets' && request.method === 'POST') {
    try {
      const input = await readJsonBody(request);
      const target = normalizeTarget(input, crypto.randomUUID());
      const next = updateSettings((settings) => {
        settings.targets.push(target);
        if (!settings.activeTargetId) settings.activeTargetId = target.id;
      });
      sendJson(response, 201, { target, activeTargetId: next.activeTargetId });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  const targetMatch = url.pathname.match(/^\/api\/admin\/targets\/([^/]+)$/);
  if (targetMatch && request.method === 'PUT') {
    try {
      const id = decodeURIComponent(targetMatch[1]);
      const index = persistedSettings.targets.findIndex((target) => target.id === id);
      if (index === -1) {
        sendJson(response, 404, { error: '节点不存在' });
        return true;
      }
      const target = normalizeTarget(await readJsonBody(request), id);
      updateSettings((settings) => { settings.targets[index] = target; });
      sendJson(response, 200, { target });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (targetMatch && request.method === 'DELETE') {
    const id = decodeURIComponent(targetMatch[1]);
    if (!persistedSettings.targets.some((target) => target.id === id)) {
      sendJson(response, 404, { error: '节点不存在' });
      return true;
    }
    const next = updateSettings((settings) => {
      settings.targets = settings.targets.filter((target) => target.id !== id);
      if (settings.activeTargetId === id) settings.activeTargetId = settings.targets[0]?.id || null;
    });
    sendJson(response, 200, { ok: true, activeTargetId: next.activeTargetId });
    return true;
  }

  const actionMatch = url.pathname.match(/^\/api\/admin\/targets\/([^/]+)\/(activate|test)$/);
  if (actionMatch && request.method === 'POST') {
    const id = decodeURIComponent(actionMatch[1]);
    const target = persistedSettings.targets.find((item) => item.id === id);
    if (!target) {
      sendJson(response, 404, { error: '节点不存在' });
      return true;
    }
    if (actionMatch[2] === 'activate') {
      updateSettings((settings) => {
        settings.activeTargetId = id;
        const selected = settings.targets.find((item) => item.id === id);
        selected.enabled = true;
      });
      sendJson(response, 200, { ok: true, activeTargetId: id });
      return true;
    }
    const result = await testTarget(target);
    sendJson(response, 200, result);
    return true;
  }

  sendJson(response, 404, { error: 'Admin API not found' });
  return true;
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    sendJson(response, 400, { error: 'Invalid URL' });
    return;
  }

  if (url.pathname.startsWith('/api/admin/')) {
    await handleAdminApi(request, response, url);
    return;
  }

  if (url.pathname === '/api/client-ping') {
    response.writeHead(204, {
      'Cache-Control': 'no-store',
      'Server-Timing': 'app;dur=0',
      'X-Probe-Time': new Date().toISOString(),
    });
    response.end();
    return;
  }

  if (url.pathname === '/api/status') {
    const state = runtimeState();
    sendJson(response, 200, {
      dashboard: config.dashboard,
      activeTargetId: state.activeTargetId,
      thresholds: {
        degradedLatencyMs: config.probe.degradedLatencyMs,
        degradedJitterMs: config.probe.degradedJitterMs,
        downAfterFailures: config.probe.downAfterFailures,
      },
      ...monitor.snapshot(),
      speedResults: Object.fromEntries(speedResults),
    });
    return;
  }

  if (url.pathname === '/api/speed/download' && request.method === 'GET') {
    if (!sessions.get(request)) {
      sendJson(response, 401, { error: '请先登录管理后台后测速' });
      return;
    }
    if (!isAgentAuthorized(request)) {
      sendJson(response, 401, { error: '测速令牌无效' });
      return;
    }
    if (!reserveSpeedTransfer(response)) return;
    streamDownload(response, requestedBytes(url));
    return;
  }

  if (url.pathname === '/api/speed/upload' && request.method === 'POST') {
    if (!sessions.get(request) || !sameOrigin(request)) {
      sendJson(response, 401, { error: '请先登录管理后台后测速' });
      request.resume();
      return;
    }
    if (!isAgentAuthorized(request)) {
      sendJson(response, 401, { error: '测速令牌无效' });
      request.resume();
      return;
    }
    if (!reserveSpeedTransfer(response)) {
      request.resume();
      return;
    }
    receiveUpload(request, response);
    return;
  }

  if (url.pathname === '/api/remote-speed-test' && request.method === 'POST') {
    if (!sessions.get(request)) {
      sendJson(response, 401, { error: '请先登录管理后台后测速' });
      request.resume();
      return;
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: '请求来源无效' });
      request.resume();
      return;
    }
    if (activeRemoteSpeedTest) {
      sendJson(response, 409, { error: '已有节点间测速正在运行' });
      request.resume();
      return;
    }
    activeRemoteSpeedTest = true;
    readJsonBody(request)
      .then(async ({ targetId }) => {
        const activeState = runtimeState();
        const target = activeState.targets.find((item) => item.id === activeState.activeTargetId && item.id === targetId && item.enabled !== false);
        if (!target) throw new Error('测速目标不存在或未启用');
        const result = await runRemoteSpeedTest(target, config.speedTest);
        speedResults.set(target.id, result);
        sendJson(response, 200, result);
      })
      .catch((error) => sendJson(response, 400, { error: error.message }))
      .finally(() => { activeRemoteSpeedTest = false; });
    return;
  }

  if (url.pathname === '/api/health') {
    const snapshot = monitor.snapshot();
    const state = runtimeState();
    const active = snapshot.targets.find((target) => target.id === state.activeTargetId);
    const down = active?.summary.state === 'down';
    sendJson(response, down ? 503 : 200, {
      ok: !down,
      state: active ? (down ? 'down' : 'up') : 'unconfigured',
      activeTargetId: state.activeTargetId,
      time: snapshot.generatedAt,
    });
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid path' });
    return;
  }
  serveStatic(pathname, request.method, response);
});

server.listen(config.server.port, config.server.host, async () => {
  console.log(`链路观察台已启动: http://${config.server.host}:${config.server.port}`);
  console.log(`管理后台: http://${config.server.host}:${config.server.port}/admin`);
  if (!runtimeState().targets.length) console.log('尚未配置测速节点，请登录管理后台添加。');
  await monitor.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    monitor.stop();
    server.close(() => process.exit(0));
  });
}
