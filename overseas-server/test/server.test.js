import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('deployment config has a valid port, token and transfer limit', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

  assert.ok(Number.isInteger(config.server.port));
  assert.ok(config.server.port > 0 && config.server.port < 65536);
  assert.ok(config.security.token.length >= 16);
  assert.ok(config.speedTest.maxTransferBytes >= 65536);
  assert.ok(config.speedTest.maxConcurrentTransfers >= 1);
});
