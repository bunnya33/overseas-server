function text(value, name, maxLength = 255) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name}不能为空`);
  if (result.length > maxLength) throw new Error(`${name}过长`);
  return result;
}

function port(value, name) {
  const result = Number.parseInt(value, 10);
  if (!Number.isInteger(result) || result < 1 || result > 65535) {
    throw new Error(`${name}必须是 1-65535 之间的端口`);
  }
  return result;
}

function optionalUrl(value) {
  const result = String(value ?? '').trim();
  if (!result) return '';
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error('测速探针地址格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('测速探针地址仅支持 HTTP 或 HTTPS');
  return result.replace(/\/+$/, '');
}

export function normalizeTarget(input, id) {
  const mode = String(input.mode || 'tcp').toLowerCase();
  if (!['tcp', 'tls'].includes(mode)) throw new Error('探测协议仅支持 TCP 或 TLS');
  return {
    id,
    label: text(input.label, '节点名称', 80),
    host: text(input.host, '服务器地址', 255),
    port: port(input.port, '服务端口'),
    mode,
    rejectUnauthorized: input.rejectUnauthorized !== false,
    speedTestUrl: optionalUrl(input.speedTestUrl),
    speedTestToken: String(input.speedTestToken ?? '').trim(),
    enabled: input.enabled !== false,
  };
}

export function publicTarget(target) {
  const { speedTestToken, ...safe } = target;
  return safe;
}
