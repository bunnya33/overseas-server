import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStatisticsReport, createHistory, displayWidth, historyKey, recordConnection, recordSpeed, summarizeHistory } from '../public/history.js';

const timestamp = (index) => new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
const sample = (index, latencyMs, ok = true) => ({ timestamp: timestamp(index), latencyMs, ok, error: ok ? '' : '连接超时' });

test('connection history retains only the newest 30 observations and averages that window', () => {
  const history = createHistory();
  for (let index = 0; index < 35; index += 1) recordConnection(history, sample(index, index), sample(index, index * 2));
  const summary = summarizeHistory(history);
  assert.equal(history.connections.length, 30);
  assert.equal(history.connections[0].timestamp, timestamp(5));
  assert.equal(summary.connectionCount, 30);
  assert.equal(summary.localConnection.average, 19.5);
  assert.equal(summary.remoteConnection.average, 39);
});

test('failures, missing probes and repeated server probes do not become zero-valued latency samples', () => {
  const history = createHistory();
  recordConnection(history, sample(1, 0), sample(1, 40));
  recordConnection(history, sample(2, 20), sample(1, 40));
  recordConnection(history, sample(3, null, false), sample(3, null, false));
  recordConnection(history, sample(4, 40));
  const summary = summarizeHistory(history);
  assert.equal(summary.localConnection.average, 20);
  assert.equal(summary.localConnection.failedCount, 1);
  assert.equal(summary.remoteConnection.average, 40);
  assert.equal(summary.remoteConnection.count, 2);
  assert.equal(summary.remoteConnection.failedCount, 1);
  assert.equal(summary.remoteConnection.missingCount, 2);
  const restored = createHistory(JSON.parse(JSON.stringify(history)));
  recordConnection(restored, sample(5, 30), sample(3, null, false));
  assert.equal(restored.connections.at(-1).remote, null);
});

test('speed history keeps 10 attempts and averages each route and direction independently', () => {
  const history = createHistory();
  for (let index = 0; index < 12; index += 1) {
    recordSpeed(history, {
      timestamp: timestamp(index),
      local: { downloadMbps: index * 10, uploadMbps: index === 11 ? null : 40, error: index === 11 ? '上传超时' : '' },
      remote: { downloadMbps: index === 10 ? null : 80, uploadMbps: 0, error: index === 10 ? '下载失败' : '' },
    });
  }
  const summary = summarizeHistory(history);
  assert.equal(summary.speedCount, 10);
  assert.equal(history.speeds[0].timestamp, timestamp(2));
  assert.equal(summary.localSpeed.download.average, 65);
  assert.equal(summary.localSpeed.upload.average, 40);
  assert.equal(summary.localSpeed.upload.validCount, 9);
  assert.equal(summary.remoteSpeed.download.average, 80);
  assert.equal(summary.remoteSpeed.download.validCount, 9);
  assert.equal(summary.remoteSpeed.upload.average, 0);
  assert.equal(summary.remoteSpeed.upload.validCount, 10);
});

test('node identities and changed endpoints have independent history keys', () => {
  const tokyo = { id: 'tokyo', host: 'tokyo.example', port: 8788, mode: 'tcp' };
  const singapore = { ...tokyo, id: 'singapore', host: 'singapore.example' };
  const keys = [historyKey('管理节点', tokyo), historyKey('管理节点', singapore), historyKey('管理节点', { ...tokyo, port: 9000 }), historyKey('另一个管理节点', tokyo)];
  assert.equal(new Set(keys).size, 4);
  assert.equal(historyKey('管理节点', { ...tokyo, label: '东京改名' }), keys[0]);
});

test('restored records are bounded and malformed measurements cannot affect averages', () => {
  const connections = Array.from({ length: 40 }, (_, index) => ({ timestamp: timestamp(index), local: sample(index, index), remote: null }));
  const speeds = Array.from({ length: 12 }, (_, index) => ({ timestamp: timestamp(index), local: { downloadMbps: index }, remote: {} }));
  const restored = createHistory({ connections: [null, { timestamp: 'invalid' }, ...connections], speeds: [null, ...speeds] });
  assert.equal(restored.connections.length, 30);
  assert.equal(restored.speeds.length, 10);
  assert.equal(summarizeHistory(restored).remoteConnection.average, null);
  assert.equal(summarizeHistory(restored).remoteSpeed.download.average, null);
  recordSpeed(restored, { timestamp: timestamp(50), local: { downloadMbps: '999', uploadMbps: -1 }, remote: {} });
  assert.equal(restored.speeds.at(-1).local.downloadMbps, null);
  assert.equal(restored.speeds.at(-1).local.uploadMbps, null);
});

test('copied reports use actual counts, dates and aligned numeric columns across different node names', () => {
  const history = createHistory();
  recordConnection(history, sample(1, 40), sample(1, 50));
  recordSpeed(history, { timestamp: timestamp(2), local: { downloadMbps: 168.9, uploadMbps: 103.1 }, remote: { downloadMbps: 16.8, uploadMbps: 10.3 } });
  const targets = ['新加坡', '成都', 'Tokyo', '日本东京电信线路长名称测试'.repeat(4)];
  const reports = targets.map((speed) => buildStatisticsReport(history, { manager: '管理节点', speed }, timestamp(3)));
  const unitColumn = (report, unit, value) => {
    const line = report.text.split('\n').find((row) => row.includes(`${value} ${unit}`));
    return displayWidth(line.slice(0, line.indexOf(unit)));
  };
  for (const report of reports) {
    assert.match(report.text, /统计时间：2026-10-01 \d{2}:\d{2}:\d{2}/);
    assert.match(report.text, /连接状态测试：1 次/);
    assert.match(report.text, /带宽测试：1 次/);
    assert.equal(unitColumn(report, 'ms', '50.0'), unitColumn(reports[0], 'ms', '50.0'));
    assert.equal(unitColumn(report, 'Mbps', '16.8'), unitColumn(reports[0], 'Mbps', '16.8'));
    assert.match(report.html, /table-layout:fixed/);
  }
  const unsafe = buildStatisticsReport(history, { manager: '<管理>', speed: '东京<script>alert(1)</script>' }, timestamp(3));
  assert.equal(unsafe.html.includes('<script>'), false);
  assert.ok(unsafe.html.includes('&lt;script&gt;'));
  const empty = buildStatisticsReport(createHistory(), { manager: '管理节点', speed: '成都' });
  assert.match(empty.text, /带宽测试：0 次/);
  assert.ok(!empty.text.includes('0.0 Mbps'));
});
