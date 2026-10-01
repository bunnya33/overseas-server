export const CONNECTION_HISTORY_LIMIT = 30;
export const SPEED_HISTORY_LIMIT = 10;

const finiteMeasurement = (value) => Number.isFinite(value) && value >= 0;
const validTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function normalizeSample(sample) {
  if (!sample || !validTimestamp(sample.timestamp)) return null;
  const ok = sample.ok === true && finiteMeasurement(sample.latencyMs);
  return {
    timestamp: sample.timestamp,
    ok,
    latencyMs: ok ? sample.latencyMs : null,
    error: ok ? '' : String(sample.error || '连接失败'),
  };
}

function normalizeSpeed(result) {
  return {
    downloadMbps: finiteMeasurement(result?.downloadMbps) ? result.downloadMbps : null,
    uploadMbps: finiteMeasurement(result?.uploadMbps) ? result.uploadMbps : null,
    error: String(result?.error || ''),
  };
}

export function createHistory(saved = {}) {
  return {
    connections: (Array.isArray(saved?.connections) ? saved.connections : [])
      .filter((record) => validTimestamp(record?.timestamp) && normalizeSample(record.local))
      .slice(-CONNECTION_HISTORY_LIMIT)
      .map((record) => ({ timestamp: record.timestamp, local: normalizeSample(record.local), remote: normalizeSample(record.remote) })),
    speeds: (Array.isArray(saved?.speeds) ? saved.speeds : [])
      .filter((record) => validTimestamp(record?.timestamp))
      .slice(-SPEED_HISTORY_LIMIT)
      .map((record) => ({ timestamp: record.timestamp, local: normalizeSpeed(record.local), remote: normalizeSpeed(record.remote) })),
    lastRemoteTimestamp: validTimestamp(saved?.lastRemoteTimestamp) ? saved.lastRemoteTimestamp : null,
  };
}

export function historyKey(manager, target) {
  return JSON.stringify([manager, target?.id || null, target?.host || '', target?.port || null, target?.mode || '']);
}

export function recordConnection(history, localSample, remoteSample = null) {
  const local = normalizeSample(localSample);
  if (!local) return;
  let remote = normalizeSample(remoteSample);
  // A manual refresh can return the same server probe; count it only once.
  if (remote?.timestamp === history.lastRemoteTimestamp) remote = null;
  if (remote) history.lastRemoteTimestamp = remote.timestamp;
  history.connections.push({ timestamp: local.timestamp, local, remote });
  history.connections = history.connections.slice(-CONNECTION_HISTORY_LIMIT);
}

export function recordSpeed(history, result) {
  if (!validTimestamp(result?.timestamp)) return;
  history.speeds.push({ timestamp: result.timestamp, local: normalizeSpeed(result.local), remote: normalizeSpeed(result.remote) });
  history.speeds = history.speeds.slice(-SPEED_HISTORY_LIMIT);
}

function summarizeValues(values) {
  const valid = values.filter(finiteMeasurement);
  return { average: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null, validCount: valid.length };
}

export function summarizeHistory(history) {
  const connection = (route) => {
    const samples = history.connections.map((record) => record[route]).filter(Boolean);
    const result = summarizeValues(samples.map((sample) => sample.ok ? sample.latencyMs : null));
    return { ...result, count: samples.length, failedCount: samples.length - result.validCount, missingCount: history.connections.length - samples.length };
  };
  const speed = (route) => ({
    download: summarizeValues(history.speeds.map((record) => record[route].downloadMbps)),
    upload: summarizeValues(history.speeds.map((record) => record[route].uploadMbps)),
  });
  return {
    connectionCount: history.connections.length,
    speedCount: history.speeds.length,
    localConnection: connection('local'),
    remoteConnection: connection('remote'),
    localSpeed: speed('local'),
    remoteSpeed: speed('remote'),
  };
}

export function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return '--';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const cleanText = (value) => String(value).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

function graphemeWidth(value) {
  if (/\p{Extended_Pictographic}/u.test(value)) return 2;
  const point = value.codePointAt(0);
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf) || (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) || (point >= 0xfe10 && point <= 0xfe6f) ||
    (point >= 0xff01 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x20000 && point <= 0x3ffff)
  ) ? 2 : 1;
}

export function displayWidth(value) {
  return [...segmenter.segment(String(value))].reduce((sum, item) => sum + graphemeWidth(item.segment), 0);
}

function wrapColumn(value, width) {
  const lines = [];
  let line = '';
  let size = 0;
  for (const { segment } of segmenter.segment(cleanText(value))) {
    const nextWidth = graphemeWidth(segment);
    if (size + nextWidth > width) { lines.push(line); line = ''; size = 0; }
    line += segment;
    size += nextWidth;
  }
  lines.push(line);
  return lines;
}

function textRow(values, widths, rightAlign = []) {
  const columns = values.map((value, index) => wrapColumn(value, widths[index]));
  return Array.from({ length: Math.max(...columns.map((column) => column.length)) }, (_, rowIndex) =>
    columns.map((column, index) => {
      const value = column[rowIndex] || '';
      const spaces = ' '.repeat(Math.max(0, widths[index] - displayWidth(value)));
      return rightAlign.includes(index) ? `${spaces}${value}` : `${value}${spaces}`;
    }).join('  ').trimEnd(),
  ).join('\n');
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const metric = (value, unit) => Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : '--';

function htmlTable(headers, rows) {
  const widths = ['20%', '4%', '24%', ...headers.slice(3).map(() => `${52 / (headers.length - 3)}%`)];
  const cell = (tag, value, index) => `<${tag} style="width:${widths[index]};padding:6px 8px;border:1px solid #dce2de;text-align:${index > 2 ? 'right' : 'left'};overflow-wrap:anywhere">${escapeHtml(value)}</${tag}>`;
  return `<table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:11pt"><thead><tr>${headers.map((value, index) => cell('th', value, index)).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => cell('td', value, index)).join('')}</tr>`).join('')}</tbody></table>`;
}

export function buildStatisticsReport(history, names, timestamp = new Date().toISOString()) {
  const summary = summarizeHistory(history);
  const manager = cleanText(names.manager);
  const target = cleanText(names.speed);
  const connectionHeaders = ['起点', '->', '终点', '平均延迟', '有效/采样'];
  const connectionRows = [
    ['本地', '->', manager, metric(summary.localConnection.average, 'ms'), `${summary.localConnection.validCount}/${summary.localConnection.count}`],
    [manager, '->', target, metric(summary.remoteConnection.average, 'ms'), `${summary.remoteConnection.validCount}/${summary.remoteConnection.count}`],
  ];
  const speedHeaders = ['起点', '->', '终点', '平均下载', '平均上传', '有效下载/上传'];
  const speedRows = [
    ['本地', '->', manager, metric(summary.localSpeed.download.average, 'Mbps'), metric(summary.localSpeed.upload.average, 'Mbps'), `${summary.localSpeed.download.validCount}/${summary.speedCount} · ${summary.localSpeed.upload.validCount}/${summary.speedCount}`],
    [manager, '->', target, metric(summary.remoteSpeed.download.average, 'Mbps'), metric(summary.remoteSpeed.upload.average, 'Mbps'), `${summary.remoteSpeed.download.validCount}/${summary.speedCount} · ${summary.remoteSpeed.upload.validCount}/${summary.speedCount}`],
  ];
  const dateLine = `统计时间：${formatDateTime(timestamp)}`;
  const connectionTitle = `连接状态测试：${summary.connectionCount} 次`;
  const speedTitle = `带宽测试：${summary.speedCount} 次`;
  const note = `平均值仅统计有效结果；-- 表示暂无有效数据。节点间缺失采样：${summary.remoteConnection.missingCount} 次。`;
  const connectionWidths = [24, 2, 24, 14, 12];
  const speedWidths = [24, 2, 24, 16, 16, 18];
  return {
    text: [dateLine, '', connectionTitle, textRow(connectionHeaders, connectionWidths), ...connectionRows.map((row) => textRow(row, connectionWidths, [3, 4])), '', speedTitle, textRow(speedHeaders, speedWidths), ...speedRows.map((row) => textRow(row, speedWidths, [3, 4, 5])), '', note].join('\n'),
    // Rich-text paste keeps table columns aligned even in proportional-font documents.
    html: `<html><body><div style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:11pt"><p>${escapeHtml(dateLine)}</p><p>${escapeHtml(connectionTitle)}</p>${htmlTable(connectionHeaders, connectionRows)}<p>${escapeHtml(speedTitle)}</p>${htmlTable(speedHeaders, speedRows)}<p>${escapeHtml(note)}</p></div></body></html>`,
  };
}
