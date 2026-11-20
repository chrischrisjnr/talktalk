'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

const COOKIE_NAME = 'tt_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const insertSession = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
const selectSession = db.prepare('SELECT user_id, created_at FROM sessions WHERE token = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpired = db.prepare('DELETE FROM sessions WHERE created_at < ?');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  insertSession.run(token, userId, Date.now());
  return token;
}

function userIdForToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = selectSession.get(token);
  if (!row) return null;
  if (Date.now() - row.created_at > SESSION_MAX_AGE_MS) {
    deleteSession.run(token);
    return null;
  }
  return row.user_id;
}

function destroySession(token) {
  if (token) deleteSession.run(token);
}

// Tidy up old sessions once an hour.
setInterval(() => deleteExpired.run(Date.now() - SESSION_MAX_AGE_MS), 60 * 60 * 1000).unref();

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Read a cookie value out of a raw Cookie header (used for websocket handshakes). */
function tokenFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  userIdForToken,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  tokenFromCookieHeader,
};
