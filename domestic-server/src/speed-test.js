import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

function round(value) {
  return Math.round(value * 10) / 10;
}

function toMbps(bytes, durationMs) {
  return round((bytes * 8) / (durationMs / 1000) / 1_000_000);
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function speedEndpoint(baseUrl, path, bytes) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (bytes) url.searchParams.set('bytes', String(bytes));
  url.searchParams.set('_', String(Date.now()));
  return url;
}

export async function runRemoteSpeedTest(target, options) {
  if (!target.speedTestUrl) {
    const error = new Error('测速节点未配置测速端点');
    error.code = 'SPEED_TEST_NOT_CONFIGURED';
    throw error;
  }

  const headers = authHeaders(target.speedTestToken);
  const downloadStarted = performance.now();
  const downloadResponse = await fetch(
    speedEndpoint(target.speedTestUrl, 'api/speed/download', options.downloadBytes),
    { headers, cache: 'no-store', signal: AbortSignal.timeout(options.timeoutMs) },
  );
  if (!downloadResponse.ok) throw new Error(`测速节点下载端点返回 HTTP ${downloadResponse.status}`);
  const downloaded = (await downloadResponse.arrayBuffer()).byteLength;
  const downloadDurationMs = performance.now() - downloadStarted;

  const uploadBody = crypto.randomBytes(options.uploadBytes);
  const uploadStarted = performance.now();
  const uploadResponse = await fetch(speedEndpoint(target.speedTestUrl, 'api/speed/upload'), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: uploadBody,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!uploadResponse.ok) throw new Error(`测速节点上传端点返回 HTTP ${uploadResponse.status}`);
  const uploadResult = await uploadResponse.json();
  const uploadDurationMs = performance.now() - uploadStarted;

  return {
    timestamp: new Date().toISOString(),
    downloadMbps: toMbps(downloaded, downloadDurationMs),
    uploadMbps: toMbps(uploadResult.bytes, uploadDurationMs),
    downloadBytes: downloaded,
    uploadBytes: uploadResult.bytes,
    downloadDurationMs: round(downloadDurationMs),
    uploadDurationMs: round(uploadDurationMs),
  };
}

export { toMbps };
