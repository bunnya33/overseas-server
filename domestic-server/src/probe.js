import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const lookup = dns.promises.lookup;

function round(value) {
  return Math.round(value * 10) / 10;
}

function friendlyError(error) {
  const messages = {
    ECONNREFUSED: '端口拒绝连接',
    ECONNRESET: '连接被对端重置',
    ENETUNREACH: '网络不可达',
    EHOSTUNREACH: '主机不可达',
    ENOTFOUND: 'DNS 解析失败',
    EAI_AGAIN: 'DNS 暂时不可用',
    ETIMEDOUT: '连接超时',
    CERT_HAS_EXPIRED: 'TLS 证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任',
  };
  return messages[error.code] || error.message || '探测失败';
}

export async function probeTarget(target, timeoutMs) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let address = target.host;
  let dnsMs = 0;

  try {
    if (net.isIP(target.host) === 0) {
      const dnsStarted = performance.now();
      const result = await lookup(target.host);
      dnsMs = performance.now() - dnsStarted;
      address = result.address;
    }

    const connectStarted = performance.now();
    const secure = target.mode === 'tls';
    const socket = secure
      ? tls.connect({
          host: address,
          port: target.port,
          servername: net.isIP(target.host) ? undefined : target.host,
          rejectUnauthorized: target.rejectUnauthorized !== false,
        })
      : net.connect({ host: address, port: target.port });

    const eventName = secure ? 'secureConnect' : 'connect';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('连接超时');
        error.code = 'ETIMEDOUT';
        socket.destroy(error);
      }, timeoutMs);
      timer.unref?.();

      socket.once(eventName, () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const connectMs = performance.now() - connectStarted;
    socket.destroy();
    return {
      timestamp: startedAt,
      ok: true,
      latencyMs: round(performance.now() - started),
      connectMs: round(connectMs),
      dnsMs: round(dnsMs),
      address,
      errorCode: null,
      error: null,
    };
  } catch (error) {
    return {
      timestamp: startedAt,
      ok: false,
      latencyMs: null,
      connectMs: null,
      dnsMs: round(dnsMs),
      address,
      errorCode: error.code || 'UNKNOWN',
      error: friendlyError(error),
    };
  }
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(percentage * sorted.length) - 1);
  return round(sorted[index]);
}

export function summarizeSamples(samples, thresholds) {
  if (!samples.length) {
    return {
      state: 'waiting',
      latestMs: null,
      averageMs: null,
      p95Ms: null,
      jitterMs: null,
      failureRate: null,
      consecutiveFailures: 0,
      sampleCount: 0,
      lastError: null,
    };
  }

  const successes = samples.filter((sample) => sample.ok);
  const latencies = successes.map((sample) => sample.latencyMs);
  const differences = latencies.slice(1).map((value, index) => Math.abs(value - latencies[index]));
  const average = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
  const jitter = differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : 0;
  let consecutiveFailures = 0;
  for (let index = samples.length - 1; index >= 0 && !samples[index].ok; index -= 1) consecutiveFailures += 1;

  const latest = samples.at(-1);
  const failureRate = ((samples.length - successes.length) / samples.length) * 100;
  let state = 'healthy';
  if (consecutiveFailures >= thresholds.downAfterFailures) state = 'down';
  else if (
    !latest.ok ||
    (average !== null && average >= thresholds.degradedLatencyMs) ||
    jitter >= thresholds.degradedJitterMs ||
    failureRate >= 5
  ) state = 'degraded';

  return {
    state,
    latestMs: latest.ok ? latest.latencyMs : null,
    averageMs: average === null ? null : round(average),
    p95Ms: percentile(latencies, 0.95),
    jitterMs: round(jitter),
    failureRate: round(failureRate),
    consecutiveFailures,
    sampleCount: samples.length,
    lastError: latest.ok ? null : latest.error,
  };
}
