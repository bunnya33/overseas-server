import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as historyApi from '../public/history.js';

// Exercise the dashboard controller without a browser. These minimal elements
// expose rendered text and records; layout and browser permissions are not simulated.
class Element {
  constructor() { this.textContent = ''; this.children = []; this.dataset = {}; this.hidden = false; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  hasAttribute() { return false; }
  focus() {}
  select() {}
  remove() {}
  getBoundingClientRect() { return { width: 600, height: 300 }; }
  getContext() { return new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 40 }) : () => {} }); }
}

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace(/^import .+\r?\n/u, '')
  .replace(/\nrefresh\(\);\s*\npollTimer = setInterval\(refresh, 3000\);?\s*$/u, '');

function dashboard(storage = new Map(), options = {}) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const routeElements = ['client', 'remote'].map((route) => Object.assign(new Element(), { dataset: { route } }));
  const fixture = { target: 'tokyo', cycle: 0, remoteFailure: false, statusFailure: false, localFailure: false, authenticated: true };
  const document = {
    querySelector: get,
    querySelectorAll: () => routeElements,
    createElement: () => new Element(),
    body: new Element(),
    activeElement: new Element(),
    execCommand: () => false,
  };
  const copied = [];
  const clipboard = { write: async (items) => copied.push(items) };
  const context = vm.createContext({
    ...historyApi,
    document, performance, crypto: crypto.webcrypto, AbortSignal, Uint8Array, Blob, Date, Intl,
    setInterval: () => 0,
    window: { devicePixelRatio: 1, addEventListener() {} },
    navigator: { clipboard: options.clipboard === false ? undefined : clipboard },
    ClipboardItem: class { constructor(items) { this.items = items; } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
    },
    fetch: async (url) => {
      if (url.startsWith('/api/status')) {
        if (fixture.statusFailure) throw new Error('状态读取超时');
        fixture.cycle += 1;
        const timestamp = new Date(Date.UTC(2026, 9, 1, 0, 0, fixture.cycle * 3)).toISOString();
        const target = { id: fixture.target, label: fixture.target === 'tokyo' ? '东京' : '新加坡', host: `${fixture.target}.example`, port: 8788, mode: 'tcp', enabled: true, summary: { state: 'healthy', sampleCount: fixture.cycle, latestMs: 50 }, samples: [{ timestamp, ok: true, latencyMs: 50 }] };
        return Response.json({ dashboard: { title: '链路观察台', relayName: '管理节点' }, activeTargetId: target.id, probeIntervalMs: 3000, generatedAt: timestamp, targets: [target], events: [{ timestamp, targetLabel: target.label, message: '连接恢复', level: 'recovered' }] });
      }
      if (url.startsWith('/api/client-ping')) {
        if (fixture.localFailure) throw new Error('本地连接超时');
        return new Response(null, { status: 204 });
      }
      if (url === '/api/admin/session') return Response.json({ authenticated: fixture.authenticated });
      if (url.startsWith('/api/speed/download')) return new Response(new Uint8Array(8192));
      if (url === '/api/speed/upload') return Response.json({ bytes: 4096 });
      if (url === '/api/remote-speed-test') return fixture.remoteFailure
        ? Response.json({ error: '下载超时' }, { status: 400 })
        : Response.json({ timestamp: new Date().toISOString(), downloadMbps: 168.9, uploadMbps: 103.1 });
      throw new Error(`Unexpected test endpoint: ${url}`);
    },
  });
  vm.runInContext(source, context, { filename: 'dashboard-controller.js' });
  return { elements, routes: routeElements, copied, fixture, storage, call: (expression) => vm.runInContext(expression, context) };
}

test('dashboard polling caps displayed records, preserves them on reload and isolates switched nodes', async () => {
  const app = dashboard();
  for (let index = 0; index < 35; index += 1) await app.call('refresh()');
  assert.equal(app.elements.get('#connection-history-count').textContent, '30 / 30 次');
  assert.equal(app.elements.get('#connection-history-rows').children.length, 30);
  assert.match(app.elements.get('#event-rows').children[0].children[0].children[0].textContent, /2026-10-01/);
  const reloaded = dashboard(app.storage);
  await reloaded.call('refresh()');
  assert.equal(reloaded.elements.get('#connection-history-count').textContent, '30 / 30 次');
  reloaded.fixture.target = 'singapore';
  await reloaded.call('refresh()');
  assert.equal(reloaded.elements.get('#connection-history-count').textContent, '1 / 30 次');
  assert.equal(reloaded.routes[1].textContent, '管理节点 → 新加坡');
  reloaded.fixture.target = 'tokyo';
  await reloaded.call('refresh()');
  assert.equal(reloaded.elements.get('#connection-history-count').textContent, '30 / 30 次');
});

test('a failed status request records local failures without counting stale remote measurements', async () => {
  const app = dashboard();
  await app.call('refresh()');
  app.fixture.statusFailure = true;
  app.fixture.localFailure = true;
  await app.call('refresh()');
  assert.equal(app.elements.get('#sync-text').textContent, '连接已中断');
  const summary = app.call('summarizeHistory(currentHistory())');
  assert.equal(summary.connectionCount, 2);
  assert.equal(summary.localConnection.failedCount, 1);
  assert.equal(summary.remoteConnection.count, 1);
  assert.equal(summary.remoteConnection.missingCount, 1);
});

test('dashboard keeps 10 speed attempts and preserves valid local data when the remote route times out', async () => {
  const app = dashboard();
  await app.call('refresh()');
  for (let index = 0; index < 11; index += 1) await app.call('runSpeedTest()');
  app.fixture.remoteFailure = true;
  await app.call('runSpeedTest()');
  assert.equal(app.elements.get('#speed-history-count').textContent, '10 / 10 次');
  assert.equal(app.elements.get('#speed-history-rows').children.length, 10);
  assert.equal(app.elements.get('#remote-download').textContent, '--');
  assert.match(app.elements.get('#speed-last-run').textContent, /下载超时/);
  const summary = app.call('summarizeHistory(currentHistory())');
  assert.equal(summary.localSpeed.download.validCount, 10);
  assert.equal(summary.remoteSpeed.download.validCount, 9);
  assert.equal(summary.remoteSpeed.download.average, 168.9);
  const restored = dashboard(app.storage);
  await restored.call('refresh()');
  assert.equal(restored.elements.get('#speed-history-count').textContent, '10 / 10 次');
});

test('copy includes both plain and rich statistics, and HTTP clipboard failures reveal the manual copy view', async () => {
  const app = dashboard();
  await app.call('refresh()');
  await app.call('runSpeedTest()');
  await app.call('copyStatistics()');
  const item = app.copied[0][0].items;
  assert.match(await item['text/plain'].text(), /连接状态测试：1 次/);
  assert.match(await item['text/plain'].text(), /带宽测试：1 次/);
  assert.match(await item['text/html'].text(), /<table/);
  const unavailable = dashboard(undefined, { clipboard: false });
  await unavailable.call('refresh()');
  await unavailable.call('copyStatistics()');
  assert.equal(unavailable.elements.get('#statistics-export').open, true);
  assert.match(unavailable.elements.get('#copy-feedback').textContent, /手动复制/);
  const manualText = unavailable.elements.get('#statistics-text').textContent;
  await unavailable.call('refresh()');
  assert.equal(unavailable.elements.get('#statistics-text').textContent, manualText);
});

test('login failures do not create a speed attempt', async () => {
  const app = dashboard();
  await app.call('refresh()');
  app.fixture.authenticated = false;
  await app.call('runSpeedTest()');
  assert.equal(app.call('currentHistory().speeds.length'), 0);
  assert.equal(app.elements.get('#speed-button').disabled, false);
  assert.match(app.elements.get('#speed-last-run').textContent, /请先登录/);
  await app.call('refresh()');
  assert.match(app.elements.get('#speed-last-run').textContent, /请先登录/);
});
