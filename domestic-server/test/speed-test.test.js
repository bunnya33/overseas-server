import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runRemoteSpeedTest, toMbps } from '../src/speed-test.js';

test('Mbps calculation uses decimal megabits', () => {
  assert.equal(toMbps(1_000_000, 1000), 8);
  assert.equal(toMbps(1_000_000, 500), 16);
});

test('remote speed test measures both directions and sends a token', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer secret') {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/speed/download') {
      const bytes = Number(url.searchParams.get('bytes'));
      response.writeHead(200, { 'Content-Length': bytes });
      response.end(Buffer.alloc(bytes));
      return;
    }
    let bytes = 0;
    request.on('data', (chunk) => { bytes += chunk.length; });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ bytes }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const result = await runRemoteSpeedTest(
    { speedTestUrl: `http://127.0.0.1:${port}`, speedTestToken: 'secret' },
    { downloadBytes: 128 * 1024, uploadBytes: 64 * 1024, timeoutMs: 3000 },
  );

  assert.equal(result.downloadBytes, 128 * 1024);
  assert.equal(result.uploadBytes, 64 * 1024);
  assert.ok(result.downloadMbps > 0);
  assert.ok(result.uploadMbps > 0);
});
