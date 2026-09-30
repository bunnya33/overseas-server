import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(ROOT, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadConfig() {
  const configPath = path.join(PROJECT_ROOT, 'config.json');
  const base = readJson(configPath);

  const config = {
    ...base,
    server: {
      ...base.server,
      host: process.env.HOST || base.server.host,
      port: positiveInteger(process.env.PORT, base.server.port),
    },
    probe: {
      ...base.probe,
      intervalMs: positiveInteger(process.env.PROBE_INTERVAL_MS, base.probe.intervalMs, 500),
      timeoutMs: positiveInteger(process.env.PROBE_TIMEOUT_MS, base.probe.timeoutMs, 100),
      historySize: positiveInteger(process.env.PROBE_HISTORY_SIZE, base.probe.historySize, 10),
    },
    speedTest: {
      ...base.speedTest,
      downloadBytes: positiveInteger(process.env.SPEED_DOWNLOAD_BYTES, base.speedTest.downloadBytes, 65536),
      uploadBytes: positiveInteger(process.env.SPEED_UPLOAD_BYTES, base.speedTest.uploadBytes, 65536),
      maxTransferBytes: positiveInteger(process.env.SPEED_MAX_BYTES, base.speedTest.maxTransferBytes, 65536),
      timeoutMs: positiveInteger(process.env.SPEED_TIMEOUT_MS, base.speedTest.timeoutMs, 1000),
      agentToken: process.env.AGENT_TOKEN ?? base.speedTest.agentToken,
    },
  };

  return config;
}

export { PROJECT_ROOT };
