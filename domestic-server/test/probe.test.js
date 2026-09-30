import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { probeTarget, summarizeSamples } from '../src/probe.js';

test('TCP probe reports a reachable endpoint', async (t) => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const result = await probeTarget({ host: '127.0.0.1', port, mode: 'tcp' }, 1000);

  assert.equal(result.ok, true);
  assert.equal(result.address, '127.0.0.1');
  assert.equal(result.error, null);
  assert.ok(result.latencyMs >= 0);
});

test('TCP probe reports a refused endpoint', async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  await new Promise((resolve) => holder.close(resolve));

  const result = await probeTarget({ host: '127.0.0.1', port, mode: 'tcp' }, 1000);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ECONNREFUSED');
  assert.equal(result.error, '端口拒绝连接');
});

test('summary separates healthy, degraded and down states', () => {
  const thresholds = { degradedLatencyMs: 200, degradedJitterMs: 80, downAfterFailures: 3 };
  const good = [20, 22, 21].map((latencyMs) => ({ ok: true, latencyMs }));
  const noisy = [20, 250, 30].map((latencyMs) => ({ ok: true, latencyMs }));
  const failed = [...good, ...Array.from({ length: 3 }, () => ({ ok: false, error: '连接超时' }))];

  assert.equal(summarizeSamples(good, thresholds).state, 'healthy');
  assert.equal(summarizeSamples(noisy, thresholds).state, 'degraded');
  assert.equal(summarizeSamples(failed, thresholds).state, 'down');
  assert.equal(summarizeSamples(failed, thresholds).consecutiveFailures, 3);
});
