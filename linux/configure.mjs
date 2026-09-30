import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [command, role, configPath, settingsPath] = process.argv.slice(2);

function hashPassword(password) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  return {
    passwordSalt,
    passwordHash: crypto.scryptSync(password, passwordSalt, 64).toString('hex'),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function requirePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1-65535 之间');
  return port;
}

if (!['domestic', 'overseas'].includes(role) || !configPath) {
  throw new Error('用法: configure.mjs install|port|password|token domestic|overseas CONFIG_PATH [SETTINGS_PATH]');
}

const config = readJson(configPath);

if (command === 'install') {
  config.server.port = requirePort(process.env.NETPATH_PORT || config.server.port);
  const legacyTargets = role === 'domestic' && Array.isArray(config.targets)
    ? config.targets.filter((target) => target && target.id && target.host && target.port)
    : [];
  if (role === 'domestic') {
    config.storage ||= { settingsFile: 'data/settings.json' };
    config.admin ||= { sessionTtlHours: 24, loginMaxAttempts: 8, loginWindowMinutes: 15 };
    delete config.targets;
  }
  writeJson(configPath, config);
  if (role === 'domestic') {
    if (!settingsPath) throw new Error('国内节点缺少设置文件路径');
    if (!fs.existsSync(settingsPath)) {
      const password = process.env.NETPATH_PASSWORD || crypto.randomBytes(18).toString('base64url');
      if (password.length < 10) throw new Error('管理密码至少需要 10 个字符');
      writeJson(settingsPath, {
        version: 1,
        activeTargetId: legacyTargets.find((target) => target.enabled !== false)?.id || null,
        targets: legacyTargets,
        admin: { username: 'admin', ...hashPassword(password) },
      });
      console.log(`管理员账号: admin`);
      console.log(`管理员密码: ${password}`);
      if (legacyTargets.length) console.log(`已迁移 ${legacyTargets.length} 台旧版节点。`);
    } else {
      console.log('已保留现有后台账号与节点配置。');
    }
  } else {
    if (!config.security?.token || config.security.token === 'change-this-token-before-deploy') {
      config.security.token = process.env.NETPATH_TOKEN || crypto.randomBytes(24).toString('base64url');
      writeJson(configPath, config);
      console.log(`测速探针令牌: ${config.security.token}`);
    } else {
      console.log('已保留现有测速探针令牌。');
    }
  }
  console.log(`监听端口: ${config.server.port}`);
} else if (command === 'port') {
  config.server.port = requirePort(process.env.NETPATH_PORT);
  writeJson(configPath, config);
  console.log(`端口已修改为 ${config.server.port}，重启服务后生效。`);
} else if (command === 'password' && role === 'domestic') {
  if (!settingsPath) throw new Error('缺少设置文件路径');
  const password = process.env.NETPATH_PASSWORD || crypto.randomBytes(18).toString('base64url');
  if (password.length < 10) throw new Error('管理密码至少需要 10 个字符');
  const settings = readJson(settingsPath);
  Object.assign(settings.admin, hashPassword(password));
  writeJson(settingsPath, settings);
  console.log(`管理员新密码: ${password}`);
  console.log('重启服务后生效。');
} else if (command === 'token' && role === 'overseas') {
  config.security.token = process.env.NETPATH_TOKEN || crypto.randomBytes(24).toString('base64url');
  if (config.security.token.length < 16) throw new Error('测速探针令牌至少需要 16 个字符');
  writeJson(configPath, config);
  console.log(`测速探针新令牌: ${config.security.token}`);
  console.log('重启服务后生效，同时需要更新国内后台对应节点的令牌。');
} else {
  throw new Error('不支持的配置操作');
}
