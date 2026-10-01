import { buildStatisticsReport, createHistory, formatDateTime, historyKey, recordConnection, recordSpeed, summarizeHistory } from './history.js?v=1';

const CLIENT_HISTORY_LIMIT = 600;
const HISTORY_STORAGE_KEY = 'netpath.observation-history.v1';
const clientSamples = [];
let latestStatus = null;
let pollTimer = null;
let polling = false;
let speedTesting = false;
let speedTestKey = null;
let speedNotice = null;
let historyStorageAvailable = true;
const histories = loadHistories();

const $ = (selector) => document.querySelector(selector);

function round(value) {
  return Math.round(value * 10) / 10;
}

function formatNumber(value, fallback = '--') {
  return Number.isFinite(value) ? String(round(value)) : fallback;
}

function formatTime(timestamp, withSeconds = true) {
  if (!timestamp) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hour12: false,
  }).format(new Date(timestamp));
}

function loadHistories() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '{}');
    return new Map(Object.entries(saved.routes || {}).map(([key, value]) => [key, createHistory(value)]));
  } catch {
    historyStorageAvailable = false;
    return new Map();
  }
}

function saveHistories() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, routes: Object.fromEntries(histories) }));
    historyStorageAvailable = true;
  } catch {
    historyStorageAvailable = false;
  }
}

function currentHistory(target = primaryTarget(), manager = nodeNames(target).manager) {
  const key = historyKey(manager, target);
  if (!histories.has(key)) histories.set(key, createHistory());
  return histories.get(key);
}

function summarizeClient() {
  const samples = clientSamples.slice(-100);
  if (!samples.length) return { state: 'waiting', sampleCount: 0 };
  const successes = samples.filter((sample) => sample.ok);
  const latencies = successes.map((sample) => sample.latencyMs);
  const diffs = latencies.slice(1).map((value, index) => Math.abs(value - latencies[index]));
  const averageMs = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
  const jitterMs = diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : 0;
  const failureRate = ((samples.length - successes.length) / samples.length) * 100;
  let failures = 0;
  for (let i = samples.length - 1; i >= 0 && !samples[i].ok; i -= 1) failures += 1;
  let state = 'healthy';
  if (failures >= 3) state = 'down';
  else if (!samples.at(-1).ok || averageMs >= 180 || jitterMs >= 70 || failureRate >= 5) state = 'degraded';
  return {
    state,
    sampleCount: samples.length,
    latestMs: samples.at(-1).ok ? samples.at(-1).latencyMs : null,
    averageMs,
    jitterMs,
    failureRate,
    consecutiveFailures: failures,
  };
}

async function clientProbe() {
  const started = performance.now();
  let sample;
  try {
    const response = await fetch(`/api/client-ping?_=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    sample = { timestamp: new Date().toISOString(), ok: true, latencyMs: round(performance.now() - started) };
  } catch (error) {
    sample = { timestamp: new Date().toISOString(), ok: false, latencyMs: null, error: error.message };
  }
  clientSamples.push(sample);
  if (clientSamples.length > CLIENT_HISTORY_LIMIT) clientSamples.shift();
  return sample;
}

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const [status, client] = await Promise.allSettled([
      fetch(`/api/status?_=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
      clientProbe(),
    ]);
    const synced = status.status === 'fulfilled';
    if (synced) latestStatus = status.value;
    setConnectionState(synced);
    if (latestStatus && client.status === 'fulfilled') {
      const target = primaryTarget();
      const remoteSample = synced && target?.enabled ? target.samples?.at(-1) : null;
      recordConnection(currentHistory(target), client.value, remoteSample);
      saveHistories();
    }
    render();
  } finally {
    polling = false;
  }
}

function setConnectionState(online) {
  $('#sync-dot').className = online ? 'online' : 'offline';
  $('#sync-text').textContent = online ? '数据已同步' : '连接已中断';
}

function setStateClass(element, state, baseClass = '') {
  element.className = `${baseClass} ${state}`.trim();
}

function primaryTarget() {
  return latestStatus?.targets.find((target) => target.id === latestStatus.activeTargetId) || null;
}

function nodeNames(target = primaryTarget()) {
  return {
    manager: latestStatus?.dashboard?.relayName || '管理节点',
    speed: target?.label || latestStatus?.dashboard?.overseasName || '测速节点',
  };
}

function render() {
  if (!latestStatus) return;
  const client = summarizeClient();
  const target = primaryTarget();
  const remote = target?.summary || { state: 'disabled', sampleCount: 0 };

  document.title = latestStatus.dashboard.title;
  $('#dashboard-title').textContent = latestStatus.dashboard.title;
  const names = nodeNames(target);
  $('#relay-name').textContent = names.manager;
  $('#relay-name').title = names.manager;
  $('#overseas-name').textContent = names.speed;
  $('#overseas-name').title = names.speed;
  document.querySelectorAll('[data-route]').forEach((element) => {
    const arrow = element.hasAttribute('data-bidirectional') ? '↔' : '→';
    element.textContent = element.dataset.route === 'client'
      ? `本地 ${arrow} ${names.manager}`
      : `${names.manager} ${arrow} ${names.speed}`;
    element.title = element.textContent;
  });
  $('#overseas-endpoint').textContent = target?.enabled ? `${target.host}:${target.port}` : '未配置';

  $('#client-latency').textContent = formatNumber(client.latestMs);
  $('#client-jitter').textContent = formatNumber(client.jitterMs);
  $('#client-loss').textContent = formatNumber(client.failureRate);
  $('#overseas-latency').textContent = formatNumber(remote.latestMs);
  $('#overseas-jitter').textContent = formatNumber(remote.jitterMs);
  $('#overseas-loss').textContent = formatNumber(remote.failureRate);
  setStateClass($('#client-dot'), client.state, 'mini-dot');
  setStateClass($('#overseas-dot'), remote.state, 'mini-dot');

  const totalSamples = client.sampleCount + (remote.sampleCount || 0);
  $('#sample-count').textContent = totalSamples;
  const elapsedSamples = Math.max(client.sampleCount, remote.sampleCount || 0);
  $('#sample-window').textContent = totalSamples ? `每 ${latestStatus.probeIntervalMs / 1000} 秒刷新 · 最近 ${Math.max(1, Math.min(30, Math.ceil(elapsedSamples * latestStatus.probeIntervalMs / 60000)))} 分钟` : '等待第一批数据';

  const clientRouteValue = client.latestMs == null ? stateLabel(client.state) : `${formatNumber(client.latestMs)} ms`;
  const remoteRouteValue = remote.latestMs == null ? stateLabel(remote.state) : `${formatNumber(remote.latestMs)} ms`;
  $('#client-route-value').textContent = clientRouteValue;
  $('#overseas-route-value').textContent = remoteRouteValue;
  setStateClass($('#client-route-link'), client.state, 'route-link');
  setStateClass($('#overseas-route-link'), remote.state, 'route-link');

  renderDiagnosis(client, remote, target);
  renderSignals(target);
  renderEvents(latestStatus.events || []);
  renderStoredSpeed(target);
  renderHistory(target);
  drawChart(clientSamples, target?.samples || []);
}

function stateLabel(state) {
  return { healthy: '正常', degraded: '波动', down: '中断', disabled: '未配置', waiting: '等待采样' }[state] || '未知';
}

function renderDiagnosis(client, remote, target) {
  const names = nodeNames(target);
  let state = 'waiting';
  let title = '正在采集数据';
  let copy = '至少完成一次两段链路探测后显示判断。';

  if (!target?.enabled) {
    state = 'disabled';
    title = '测速节点尚未配置';
    copy = `尚未配置${names.manager}到测速节点的探测目标。`;
  } else if (client.state === 'down' && remote.state === 'healthy') {
    state = 'down'; title = '本地接入链路异常'; copy = `${names.manager}到${names.speed}正常，故障更可能位于本地网络、运营商入口或本地到${names.manager}之间。`;
  } else if (client.state === 'healthy' && ['down', 'degraded'].includes(remote.state)) {
    state = remote.state; title = remote.state === 'down' ? '节点间链路中断' : '节点间链路出现波动'; copy = `本地到${names.manager}正常，请检查${names.manager}到${names.speed}探测端口的网络路径与目标服务。`;
  } else if (['down', 'degraded'].includes(client.state) && ['down', 'degraded'].includes(remote.state)) {
    state = 'down'; title = '两段链路同时异常'; copy = `优先检查${names.manager}负载和网络出口；也可能存在本地接入与节点间网络的叠加故障。`;
  } else if (client.state === 'healthy' && remote.state === 'healthy') {
    state = 'healthy'; title = '链路运行正常'; copy = '两段链路均可达，当前延迟、抖动和失败率处于阈值内。';
  } else if (client.state === 'degraded' && remote.state === 'healthy') {
    state = 'degraded'; title = '本地接入存在波动'; copy = `节点间链路稳定，当前抖动主要来自本地到${names.manager}的路径。`;
  }

  const overall = $('#overall-status');
  setStateClass(overall, state, 'status-pill');
  overall.textContent = stateLabel(state);
  $('#overall-label').textContent = title;
  $('#overall-detail').textContent = copy;
  $('#diagnosis-title').textContent = title;
  $('#diagnosis-copy').textContent = copy;
  $('#diagnosis-time').textContent = `更新于 ${formatTime(latestStatus.generatedAt)}`;
  const mark = $('#diagnosis-mark');
  setStateClass(mark, state, 'diagnosis-mark');
  mark.textContent = state === 'healthy' ? '✓' : state === 'waiting' || state === 'disabled' ? '?' : '!';
}

function renderSignals(target) {
  const latest = target?.samples?.at(-1);
  $('#dns-value').textContent = latest?.ok ? `${formatNumber(latest.dnsMs)} ms` : '--';
  $('#connect-value').textContent = latest?.ok ? `${formatNumber(latest.connectMs)} ms` : '--';
  $('#p95-value').textContent = target?.summary?.p95Ms != null ? `${formatNumber(target.summary.p95Ms)} ms` : '--';
  $('#failure-streak').textContent = `${target?.summary?.consecutiveFailures || 0} 次`;
}

function renderEvents(events) {
  $('#event-count').textContent = `${events.length} 条`;
  const rows = $('#event-rows');
  if (!events.length) {
    rows.innerHTML = '<tr><td colspan="4" class="empty-row">暂无状态变化</td></tr>';
    return;
  }
  rows.replaceChildren(...events.map((event) => {
    const row = document.createElement('tr');
    const timeCell = document.createElement('td');
    timeCell.className = 'event-time';
    const time = document.createElement('time');
    time.dateTime = event.timestamp;
    time.textContent = formatDateTime(event.timestamp);
    timeCell.append(time);
    row.append(timeCell);
    const cells = [event.targetLabel, event.message];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const stateCell = document.createElement('td');
    const state = document.createElement('span');
    state.className = `event-state ${event.level}`;
    state.innerHTML = `<i></i>${event.level === 'recovered' ? '已恢复' : '异常'}`;
    stateCell.append(state);
    row.append(stateCell);
    return row;
  }));
}

function renderStoredSpeed(target) {
  const key = historyKey(nodeNames(target).manager, target);
  if (speedTesting && key === speedTestKey) return;
  const recent = currentHistory(target).speeds.at(-1);
  const stored = target && latestStatus.speedResults?.[target.id];
  $('#local-download').textContent = formatNumber(recent?.local.downloadMbps);
  $('#local-upload').textContent = formatNumber(recent?.local.uploadMbps);
  $('#remote-download').textContent = formatNumber(recent ? recent.remote.downloadMbps : stored?.downloadMbps);
  $('#remote-upload').textContent = formatNumber(recent ? recent.remote.uploadMbps : stored?.uploadMbps);
  const errors = [recent?.local.error, recent?.remote.error].filter(Boolean);
  $('#speed-last-run').textContent = speedNotice?.key === key ? speedNotice.message : recent
    ? `${formatDateTime(recent.timestamp)}${errors.length ? ` · ${errors.join('；')}` : ' · 测速完成'}`
    : stored ? `节点上次测速 ${formatDateTime(stored.timestamp)}` : '尚未测速';
}

function addCell(row, text, className = '', title = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  cell.className = className;
  if (title) cell.title = title;
  row.append(cell);
}

function latencyText(sample) {
  return sample ? sample.ok ? `${formatNumber(sample.latencyMs)} ms` : '失败' : '--';
}

function renderHistory(target) {
  const history = currentHistory(target);
  const summary = summarizeHistory(history);
  const names = nodeNames(target);
  $('#connection-history-count').textContent = `${summary.connectionCount} / 30 次`;
  $('#speed-history-count').textContent = `${summary.speedCount} / 10 次`;
  $('#history-context').textContent = `${names.manager} → ${names.speed} · ${historyStorageAvailable ? '记录保存在当前浏览器，刷新后保留' : '浏览器存储不可用，仅保留本次打开期间的记录'}`;
  for (const [route, value] of [['local', summary.localConnection], ['remote', summary.remoteConnection]]) {
    $(`#${route}-average-latency`).textContent = formatNumber(value.average);
    $(`#${route}-connection-count`).textContent = `有效 ${value.validCount} / 采样 ${value.count} 次 · 失败 ${value.failedCount} 次${value.missingCount ? ` · 缺失 ${value.missingCount} 次` : ''}`;
  }
  for (const [route, value] of [['local', summary.localSpeed], ['remote', summary.remoteSpeed]]) {
    $(`#${route}-average-download`).textContent = formatNumber(value.download.average);
    $(`#${route}-average-upload`).textContent = formatNumber(value.upload.average);
    $(`#${route}-speed-count`).textContent = `有效下载 ${value.download.validCount} / ${summary.speedCount} 次 · 有效上传 ${value.upload.validCount} / ${summary.speedCount} 次`;
  }
  const connections = $('#connection-history-rows');
  if (!history.connections.length) connections.innerHTML = '<tr><td colspan="4" class="empty-row">等待连接测试记录</td></tr>';
  else connections.replaceChildren(...history.connections.slice().reverse().map((record) => {
    const row = document.createElement('tr');
    addCell(row, formatDateTime(record.timestamp), 'event-time');
    addCell(row, latencyText(record.local), `measurement ${record.local.ok ? '' : 'measurement-error'}`, record.local.error);
    addCell(row, latencyText(record.remote), `measurement ${record.remote && !record.remote.ok ? 'measurement-error' : ''}`, record.remote ? `${formatDateTime(record.remote.timestamp)}${record.remote.error ? ` · ${record.remote.error}` : ''}` : '本轮未取得新的节点采样');
    const failed = !record.local.ok || record.remote?.ok === false;
    addCell(row, failed ? '异常' : record.remote ? '正常' : '待采样', failed ? 'measurement-error' : 'record-status');
    return row;
  }));
  const speeds = $('#speed-history-rows');
  if (!history.speeds.length) speeds.innerHTML = '<tr><td colspan="6" class="empty-row">点击「开始测速」后显示记录</td></tr>';
  else speeds.replaceChildren(...history.speeds.slice().reverse().map((record) => {
    const row = document.createElement('tr');
    addCell(row, formatDateTime(record.timestamp), 'event-time');
    for (const route of ['local', 'remote']) {
      for (const direction of ['downloadMbps', 'uploadMbps']) {
        const value = record[route][direction];
        addCell(row, formatNumber(value), `measurement ${value == null ? 'measurement-error' : ''}`, record[route].error);
      }
    }
    const errors = [record.local.error, record.remote.error].filter(Boolean);
    const complete = [record.local.downloadMbps, record.local.uploadMbps, record.remote.downloadMbps, record.remote.uploadMbps].every(Number.isFinite);
    addCell(row, complete ? '完成' : '未完成', complete ? 'record-status' : 'measurement-error', errors.join('；'));
    return row;
  }));
  $('#copy-statistics').disabled = !summary.connectionCount && !summary.speedCount;
  // Keep an expanded export stable while the user selects text for manual copy.
  if (!$('#statistics-export').open) $('#statistics-text').textContent = buildStatisticsReport(history, names).text;
}

async function copyStatistics() {
  const report = buildStatisticsReport(currentHistory(), nodeNames());
  $('#statistics-text').textContent = report.text;
  let copied = false;
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([report.text], { type: 'text/plain' }),
        'text/html': new Blob([report.html], { type: 'text/html' }),
      })]);
    } else {
      await navigator.clipboard.writeText(report.text);
    }
    copied = true;
  } catch {
    // HTTP dashboards may not have the Clipboard API; retain a user-click fallback.
    const textarea = document.createElement('textarea');
    textarea.className = 'clipboard-helper';
    textarea.value = report.text;
    textarea.readOnly = true;
    const previousFocus = document.activeElement;
    document.body.append(textarea);
    textarea.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
  }
  $('#copy-feedback').textContent = copied ? '已复制连接与带宽统计结果' : '自动复制不可用，请在下方选中结果手动复制';
  if (!copied) $('#statistics-export').open = true;
}

function makeRandomBytes(size) {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
  }
  return bytes;
}

function mbps(bytes, durationMs) {
  return round((bytes * 8) / (durationMs / 1000) / 1_000_000);
}

async function runLocalSpeedTest(result) {
  const downloadBytes = 8 * 1024 * 1024;
  let started = performance.now();
  const download = await fetch(`/api/speed/download?bytes=${downloadBytes}&_=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!download.ok) throw new Error('本地下载测速失败');
  const downloaded = (await download.arrayBuffer()).byteLength;
  result.downloadMbps = mbps(downloaded, performance.now() - started);

  const uploadBody = makeRandomBytes(4 * 1024 * 1024);
  started = performance.now();
  const upload = await fetch('/api/speed/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: uploadBody, signal: AbortSignal.timeout(30000) });
  if (!upload.ok) throw new Error('本地上传测速失败');
  const uploaded = await upload.json();
  result.uploadMbps = mbps(uploaded.bytes, performance.now() - started);
}

async function runSpeedTest() {
  if (speedTesting) return;
  speedTesting = true;
  speedNotice = null;
  const button = $('#speed-button');
  const progress = $('#speed-progress');
  button.disabled = true;
  progress.hidden = false;
  let history = null;
  let record = null;
  try {
    const target = primaryTarget();
    if (!target?.enabled) throw new Error('测速节点未配置');
    const names = nodeNames(target);
    speedTestKey = historyKey(names.manager, target);
    const sessionResponse = await fetch('/api/admin/session', { cache: 'no-store' });
    const session = await sessionResponse.json();
    if (!session.authenticated) throw new Error('请先登录管理后台，再返回测速');
    history = currentHistory(target, names.manager);
    record = { timestamp: new Date().toISOString(), local: {}, remote: {} };
    for (const id of ['local-download', 'local-upload', 'remote-download', 'remote-upload']) $(`#${id}`).textContent = '--';
    $('#speed-progress-text').textContent = `正在测试本地与${names.manager}的带宽`;
    try { await runLocalSpeedTest(record.local); }
    catch (error) { record.local.error = `本地测速：${error.message}`; }
    if (historyKey(nodeNames().manager, primaryTarget()) === speedTestKey) {
      $('#local-download').textContent = formatNumber(record.local.downloadMbps);
      $('#local-upload').textContent = formatNumber(record.local.uploadMbps);
    }
    $('#speed-progress-text').textContent = `正在测试${names.manager}与${names.speed}的带宽`;
    try {
      const response = await fetch('/api/remote-speed-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }),
      });
      const remote = await response.json();
      if (!response.ok) throw new Error(remote.error || '节点间测速失败');
      record.remote = remote;
    } catch (error) { record.remote.error = `节点间测速：${error.message}`; }
    record.timestamp = new Date().toISOString();
    recordSpeed(history, record);
    saveHistories();
  } catch (error) {
    speedNotice = { key: speedTestKey || historyKey(nodeNames().manager, primaryTarget()), message: error.message };
    $('#speed-last-run').textContent = error.message;
  } finally {
    speedTesting = false;
    speedTestKey = null;
    button.disabled = false;
    progress.hidden = true;
    if (record) { renderStoredSpeed(primaryTarget()); renderHistory(primaryTarget()); }
  }
}

function drawChart(local, remote) {
  const canvas = $('#latency-chart');
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  const pad = { top: 12, right: 12, bottom: 28, left: 46 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const localSlice = local.slice(-100);
  const remoteSlice = remote.slice(-100);
  const all = [...localSlice, ...remoteSlice].filter((sample) => sample.ok && Number.isFinite(sample.latencyMs));
  $('#chart-empty').hidden = all.length > 0;
  if (!all.length) return;

  const maxValue = Math.max(50, Math.ceil(Math.max(...all.map((sample) => sample.latencyMs)) / 50) * 50);
  ctx.font = '10px Consolas, monospace';
  ctx.fillStyle = '#7b8580';
  ctx.strokeStyle = '#e5e9e6';
  ctx.lineWidth = 1;
  for (let step = 0; step <= 4; step += 1) {
    const y = pad.top + (plotH * step) / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(`${round(maxValue * (1 - step / 4))} ms`, 2, y + 3);
  }

  const minTime = Math.min(...all.map((sample) => new Date(sample.timestamp).getTime()));
  const maxTime = Math.max(Date.now(), ...all.map((sample) => new Date(sample.timestamp).getTime()));
  const span = Math.max(1, maxTime - minTime);
  ctx.fillText(formatTime(minTime, false), pad.left, height - 7);
  const rightLabel = formatTime(maxTime, false);
  ctx.fillText(rightLabel, width - pad.right - ctx.measureText(rightLabel).width, height - 7);

  const plot = (samples, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    let active = false;
    ctx.beginPath();
    for (const sample of samples) {
      if (!sample.ok || !Number.isFinite(sample.latencyMs)) { active = false; continue; }
      const x = pad.left + ((new Date(sample.timestamp).getTime() - minTime) / span) * plotW;
      const y = pad.top + (1 - Math.min(sample.latencyMs, maxValue) / maxValue) * plotH;
      if (active) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      active = true;
    }
    ctx.stroke();
  };
  plot(localSlice, '#2f6fbd');
  plot(remoteSlice, '#7254a4');
}

$('#refresh-button').addEventListener('click', refresh);
$('#speed-button').addEventListener('click', runSpeedTest);
$('#copy-statistics').addEventListener('click', copyStatistics);
window.addEventListener('resize', () => latestStatus && drawChart(clientSamples, primaryTarget()?.samples || []));
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);
refresh();
pollTimer = setInterval(refresh, 3000);
