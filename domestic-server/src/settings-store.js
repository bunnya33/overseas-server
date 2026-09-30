import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from './auth.js';

function clone(value) {
  return structuredClone(value);
}

function validateSettings(settings) {
  if (!settings || settings.version !== 1) throw new Error('settings.json 版本不受支持');
  if (!Array.isArray(settings.targets)) throw new Error('settings.targets 必须是数组');
  if (!settings.admin?.username || !settings.admin?.passwordSalt || !settings.admin?.passwordHash) {
    throw new Error('settings.admin 配置不完整');
  }
}

export class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    if (!fs.existsSync(filePath)) {
      const password = crypto.randomBytes(18).toString('base64url');
      this.write({
        version: 1,
        activeTargetId: null,
        targets: [],
        admin: { username: 'admin', ...hashPassword(password) },
      });
      console.log(`首次启动管理员账号: admin，临时密码: ${password}`);
      console.log('请登录管理后台后立即修改密码。');
    }
    this.settings = this.read();
  }

  read() {
    const settings = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    validateSettings(settings);
    return settings;
  }

  get() {
    return clone(this.settings);
  }

  update(mutator) {
    const next = clone(this.settings);
    mutator(next);
    validateSettings(next);
    this.write(next);
    this.settings = next;
    return this.get();
  }

  write(settings) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const temporaryBackupPath = `${this.backupPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, temporaryBackupPath);
      fs.chmodSync(temporaryBackupPath, 0o600);
      fs.renameSync(temporaryBackupPath, this.backupPath);
    }
    fs.renameSync(temporaryPath, this.filePath);
  }
}
