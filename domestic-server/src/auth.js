import crypto from 'node:crypto';

const COOKIE_NAME = 'npo_session';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    passwordSalt: salt,
    passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'),
  };
}

export function verifyPassword(password, admin) {
  const actual = crypto.scryptSync(password, admin.passwordSalt, 64);
  const expected = Buffer.from(admin.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

export class SessionManager {
  constructor(ttlHours) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.sessions = new Map();
  }

  create(username) {
    const id = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(id, { username, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(request) {
    const id = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + this.ttlMs;
    return { id, ...session };
  }

  destroy(request) {
    const session = this.get(request);
    if (session) this.sessions.delete(session.id);
  }

  clear() {
    this.sessions.clear();
  }

  cookie(id, request) {
    const forwardedProto = request.headers['x-forwarded-proto'];
    const secure = request.socket.encrypted || forwardedProto === 'https';
    return `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.ttlMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
