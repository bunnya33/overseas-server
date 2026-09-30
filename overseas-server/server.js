import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
const serverHost = process.env.HOST || config.server.host;
const serverPort = positiveInteger(process.env.PORT, config.server.port);
const token = process.env.AGENT_TOKEN ?? config.security.token;
const maxTransferBytes = positiveInteger(
  process.env.SPEED_MAX_BYTES,
  config.speedTest.maxTransferBytes,
  65536,
);
const maxConcurrentTransfers = positiveInteger(
  process.env.SPEED_MAX_CONCURRENT,
  config.speedTest.maxConcurrentTransfers,
);
let activeTransfers = 0;

if (!token || token === 'change-this-token-before-deploy') {
  throw new Error('请先通过 install.sh 安装，或在 config.json 中设置独立的 security.token');
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(request) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization || '');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function reserveTransfer(response) {
  if (activeTransfers >= maxConcurrentTransfers) {
    sendJson(response, 429, { error: '测速任务过多，请稍后重试' });
    return false;
  }
  activeTransfers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeTransfers -= 1;
  };
  response.once('close', release);
  response.once('finish', release);
  return true;
}

function requestedBytes(url) {
  const parsed = Number.parseInt(url.searchParams.get('bytes'), 10);
  const bytes = Number.isFinite(parsed) ? parsed : 8 * 1024 * 1024;
  return Math.max(65536, Math.min(bytes, maxTransferBytes));
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
  if (Number.isFinite(advertised) && advertised > maxTransferBytes) {
    sendJson(response, 413, { error: '上传测速数据超过限制' });
    request.resume();
    return;
  }

  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxTransferBytes) request.destroy();
  });
  request.on('end', () => sendJson(response, 200, { bytes }));
  request.on('error', () => {
    if (!response.headersSent) sendJson(response, 400, { error: '上传中断' });
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      service: 'overseas-speed-agent',
      activeTransfers,
      time: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === '/api/speed/download' && request.method === 'GET') {
    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: '测速令牌无效' });
      return;
    }
    if (!reserveTransfer(response)) return;
    streamDownload(response, requestedBytes(url));
    return;
  }

  if (url.pathname === '/api/speed/upload' && request.method === 'POST') {
    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: '测速令牌无效' });
      request.resume();
      return;
    }
    if (!reserveTransfer(response)) {
      request.resume();
      return;
    }
    receiveUpload(request, response);
    return;
  }

  if (url.pathname === '/' && request.method === 'GET') {
    sendJson(response, 200, {
      service: 'overseas-speed-agent',
      health: '/api/health',
    });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

server.listen(serverPort, serverHost, () => {
  console.log(`国外测速探针已启动: http://${serverHost}:${serverPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
