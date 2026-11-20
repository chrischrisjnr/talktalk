'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Server } = require('socket.io');

const { db, UPLOAD_DIR } = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 25;
const MAX_MESSAGE_LENGTH = 4000;
const PAGE_SIZE = 50;

// Images we are happy to show inline. Everything else is served as a download,
// which stops uploaded HTML/SVG files from running scripts on our site.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => Date.now();

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function randomFileName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  return crypto.randomBytes(16).toString('hex') + ext;
}

function removeUpload(storedName) {
  if (!storedName) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(storedName)), () => {});
}

/** Very small fixed-window rate limiter, keyed by anything (user id, IP...). */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (key) => {
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    return count <= max;
  };
}

const messageLimiter = rateLimiter({ windowMs: 10_000, max: 20 });
const authLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 30 });

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE'),
  insertUser: db.prepare(
    'INSERT INTO users (username, password_hash, display_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'
  ),
  updateProfile: db.prepare(
    'UPDATE users SET display_name = ?, bio = ?, status = ?, color = ? WHERE id = ?'
  ),
  updateAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),

  roomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  roomByName: db.prepare('SELECT * FROM rooms WHERE name = ?'),
  channels: db.prepare("SELECT * FROM rooms WHERE kind = 'channel' ORDER BY name"),
  dmsForUser: db.prepare(`
    SELECT r.* FROM rooms r
    JOIN room_members m ON m.room_id = r.id
    WHERE r.kind = 'dm' AND m.user_id = ?
    ORDER BY r.id`),
  roomMembers: db.prepare('SELECT user_id FROM room_members WHERE room_id = ?'),
  isMember: db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?'),
  insertRoom: db.prepare('INSERT INTO rooms (kind, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?)'),
  insertMember: db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)'),
  updateTopic: db.prepare('UPDATE rooms SET topic = ? WHERE id = ?'),
  lastMessageIds: db.prepare('SELECT room_id, MAX(id) AS last_id FROM messages GROUP BY room_id'),

  insertFile: db.prepare(
    'INSERT INTO files (stored_name, original_name, mime, size, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),

  insertMessage: db.prepare('INSERT INTO messages (room_id, user_id, body, file_id, created_at) VALUES (?, ?, ?, ?, ?)'),
  messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  recentMessages: db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?'),
  olderMessages: db.prepare('SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),

  reactionsFor: db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at'),
  hasReaction: db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  addReaction: db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'),
  removeReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),

  allEmojis: db.prepare('SELECT * FROM emojis ORDER BY name'),
  emojiByName: db.prepare('SELECT * FROM emojis WHERE name = ?'),
  insertEmoji: db.prepare('INSERT INTO emojis (name, stored_name, uploader_id, created_at) VALUES (?, ?, ?, ?)'),
  deleteEmoji: db.prepare('DELETE FROM emojis WHERE name = ?'),
};

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    status: u.status,
    color: u.color,
    avatarUrl: u.avatar ? `/avatars/${u.avatar}` : null,
    createdAt: u.created_at,
    lastSeen: u.last_seen,
    online: onlineCount.has(u.id),
  };
}

function publicRoom(room, viewerId) {
  const out = {
    id: room.id,
    kind: room.kind,
    name: room.name,
    topic: room.topic,
    createdAt: room.created_at,
  };
  if (room.kind === 'dm') {
    out.memberIds = q.roomMembers.all(room.id).map((r) => r.user_id);
    out.otherUserId = out.memberIds.find((id) => id !== viewerId) ?? viewerId;
  }
  return out;
}

function reactionSummary(messageId) {
  const grouped = new Map();
  for (const { emoji, user_id } of q.reactionsFor.all(messageId)) {
    if (!grouped.has(emoji)) grouped.set(emoji, []);
    grouped.get(emoji).push(user_id);
  }
  return [...grouped].map(([emoji, userIds]) => ({ emoji, userIds }));
}

function publicMessage(m) {
  const file = m.file_id ? q.fileById.get(m.file_id) : null;
  return {
    id: m.id,
    roomId: m.room_id,
    userId: m.user_id,
    body: m.body,
    createdAt: m.created_at,
    file: file
      ? {
          id: file.id,
          name: file.original_name,
          mime: file.mime,
          size: file.size,
          url: `/files/${file.id}/${encodeURIComponent(file.original_name)}`,
          isImage: INLINE_IMAGE_TYPES.has(file.mime),
        }
      : null,
    reactions: reactionSummary(m.id),
  };
}

function publicEmoji(e) {
  return { name: e.name, url: `/emoji/${e.stored_name}`, uploaderId: e.uploader_id };
}

/** Throws unless the user is allowed to see/post in the room. */
function requireRoomAccess(roomId, userId) {
  const room = q.roomById.get(Number(roomId));
  if (!room) throw new HttpError(404, 'That room does not exist.');
  if (room.kind === 'dm' && !q.isMember.get(room.id, userId)) {
    throw new HttpError(403, 'That is not your conversation.');
  }
  return room;
}

// ---------------------------------------------------------------------------
// App + realtime setup
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

/** userId -> number of open sockets (a user can have several tabs open). */
const onlineCount = new Map();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

function currentUser(req) {
  const userId = auth.userIdForToken(req.cookies[auth.COOKIE_NAME]);
  return userId ? q.userById.get(userId) : null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return next(new HttpError(401, 'Please log in first.'));
  req.user = user;
  next();
}

// Block cross-site form posts: any state-changing API request must come from our own page.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  let originHost = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = 'invalid';
  }
  if (originHost && originHost !== req.get('host')) {
    return next(new HttpError(403, 'Cross-site request blocked.'));
  }
  next();
});

const wrap = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

function makeUploader({ maxBytes, imagesOnly }) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (req, file, cb) => cb(null, randomFileName(file.originalname)),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 10 },
    fileFilter: (req, file, cb) => {
      if (imagesOnly && !INLINE_IMAGE_TYPES.has(file.mimetype)) {
        return cb(new HttpError(400, 'Please pick a PNG, JPG, GIF or WEBP image.'));
      }
      cb(null, true);
    },
  });
}

const fileUpload = makeUploader({ maxBytes: MAX_FILE_MB * 1024 * 1024, imagesOnly: false });
const avatarUpload = makeUploader({ maxBytes: 2 * 1024 * 1024, imagesOnly: true });
const emojiUpload = makeUploader({ maxBytes: 512 * 1024, imagesOnly: true });

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/signup', wrap((req, res) => {
  if (!authLimiter(`signup:${req.ip}`)) throw new HttpError(429, 'Whoa there! Too many tries. Take a breather.');
  const username = cleanText(req.body.username, 24).toLowerCase();
  const password = String(req.body.password ?? '');
  const displayName = cleanText(req.body.displayName, 40) || username;

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new HttpError(400, 'Usernames are 3-24 characters: letters, numbers and underscores.');
  }
  if (password.length < 6 || password.length > 200) {
    throw new HttpError(400, 'Passwords need at least 6 characters.');
  }
  if (q.userByName.get(username)) throw new HttpError(409, 'That username is taken. Try another!');

  const { lastInsertRowid } = q.insertUser.run(username, auth.hashPassword(password), displayName, now(), now());
  const user = q.userById.get(Number(lastInsertRowid));
  auth.setSessionCookie(res, auth.createSession(user.id));
  io.emit('user:update', publicUser(user));
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/login', wrap((req, res) => {
  if (!authLimiter(`login:${req.ip}`)) throw new HttpError(429, 'Whoa there! Too many tries. Take a breather.');
  const user = q.userByName.get(cleanText(req.body.username, 24).toLowerCase());
  if (!user || !auth.verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
    throw new HttpError(401, 'Wrong username or password.');
  }
  auth.setSessionCookie(res, auth.createSession(user.id));
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  auth.destroySession(req.cookies[auth.COOKIE_NAME]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Users & profiles
// ---------------------------------------------------------------------------

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', requireAuth, wrap((req, res) => {
  const u = req.user;
  const displayName = req.body.displayName !== undefined ? cleanText(req.body.displayName, 40) : u.display_name;
  const bio = req.body.bio !== undefined ? cleanText(req.body.bio, 1000) : u.bio;
  const status = req.body.status !== undefined ? cleanText(req.body.status, 120) : u.status;
  let color = u.color;
  if (req.body.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(req.body.color)) throw new HttpError(400, 'Colors look like #ff00ff.');
    color = req.body.color;
  }
  if (!displayName) throw new HttpError(400, 'Your display name cannot be empty.');

  q.updateProfile.run(displayName, bio, status, color, u.id);
  const updated = publicUser(q.userById.get(u.id));
  io.emit('user:update', updated);
  res.json({ user: updated });
}));

app.post('/api/me/avatar', requireAuth, avatarUpload.single('avatar'), wrap((req, res) => {
  if (!req.file) throw new HttpError(400, 'No picture received.');
  const old = req.user.avatar;
  q.updateAvatar.run(req.file.filename, req.user.id);
  removeUpload(old);
  const updated = publicUser(q.userById.get(req.user.id));
  io.emit('user:update', updated);
  res.json({ user: updated });
}));

app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: q.allUsers.all().map(publicUser) });
});

// ---------------------------------------------------------------------------
// Rooms (channels + direct messages)
// ---------------------------------------------------------------------------

app.get('/api/rooms', requireAuth, (req, res) => {
  const lastIds = Object.fromEntries(q.lastMessageIds.all().map((r) => [r.room_id, r.last_id]));
  const rooms = [...q.channels.all(), ...q.dmsForUser.all(req.user.id)].map((r) => ({
    ...publicRoom(r, req.user.id),
    lastMessageId: lastIds[r.id] || 0,
  }));
  res.json({ rooms });
});

app.post('/api/channels', requireAuth, wrap((req, res) => {
  const name = cleanText(req.body.name, 40).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  const topic = cleanText(req.body.topic, 250);
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name)) {
    throw new HttpError(400, 'Channel names are 2-40 characters: letters, numbers, - and _.');
  }
  if (q.roomByName.get(name)) throw new HttpError(409, `#${name} already exists!`);
  const { lastInsertRowid } = q.insertRoom.run('channel', name, topic, req.user.id, now());
  const room = publicRoom(q.roomById.get(Number(lastInsertRowid)), req.user.id);
  io.emit('room:new', { ...room, lastMessageId: 0 });
  res.status(201).json({ room });
}));

app.patch('/api/channels/:id', requireAuth, wrap((req, res) => {
  const room = requireRoomAccess(req.params.id, req.user.id);
  if (room.kind !== 'channel') throw new HttpError(400, 'Only channels have topics.');
  q.updateTopic.run(cleanText(req.body.topic, 250), room.id);
  const updated = publicRoom(q.roomById.get(room.id), req.user.id);
  io.emit('room:update', updated);
  res.json({ room: updated });
}));

app.post('/api/dms', requireAuth, wrap((req, res) => {
  const other = q.userById.get(Number(req.body.userId));
  if (!other) throw new HttpError(404, 'No such member.');
  const [a, b] = [req.user.id, other.id].sort((x, y) => x - y);
  const name = `dm:${a}:${b}`;

  let room = q.roomByName.get(name);
  if (!room) {
    const { lastInsertRowid } = q.insertRoom.run('dm', name, '', req.user.id, now());
    room = q.roomById.get(Number(lastInsertRowid));
    q.insertMember.run(room.id, a);
    q.insertMember.run(room.id, b);
    for (const uid of new Set([a, b])) {
      io.to(`user:${uid}`).emit('room:new', { ...publicRoom(room, uid), lastMessageId: 0 });
    }
  }
  res.json({ room: publicRoom(room, req.user.id) });
}));

/** Send an event to whoever can see a room. */
function emitToRoom(room, event, payload) {
  if (room.kind === 'channel') {
    io.to('authed').emit(event, payload);
  } else {
    let target = io;
    for (const { user_id } of q.roomMembers.all(room.id)) target = target.to(`user:${user_id}`);
    target.emit(event, payload);
  }
}

// ---------------------------------------------------------------------------
// Messages, files & reactions
// ---------------------------------------------------------------------------

app.get('/api/rooms/:id/messages', requireAuth, wrap((req, res) => {
  const room = requireRoomAccess(req.params.id, req.user.id);
  const before = Number(req.query.before) || 0;
  const rows = before
    ? q.olderMessages.all(room.id, before, PAGE_SIZE)
    : q.recentMessages.all(room.id, PAGE_SIZE);
  res.json({ messages: rows.reverse().map(publicMessage), hasMore: rows.length === PAGE_SIZE });
}));

app.post('/api/rooms/:id/messages', requireAuth, (req, res, next) => {
  // Check access *before* accepting a potentially large upload.
  try {
    requireRoomAccess(req.params.id, req.user.id);
    if (!messageLimiter(req.user.id)) throw new HttpError(429, 'Slow down, speed racer! Too many messages.');
  } catch (err) {
    return next(err);
  }
  fileUpload.single('file')(req, res, (err) => {
    if (err) return next(err);
    try {
      const room = requireRoomAccess(req.params.id, req.user.id);
      const body = cleanText(req.body.body, MAX_MESSAGE_LENGTH);
      if (!body && !req.file) throw new HttpError(400, 'Type something first!');

      let fileId = null;
      if (req.file) {
        const original = cleanText(req.file.originalname, 200).replace(/[\\/]/g, '_') || 'file';
        const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.file.mimetype) ? req.file.mimetype : 'application/octet-stream';
        fileId = Number(q.insertFile.run(req.file.filename, original, mime, req.file.size, req.user.id, now()).lastInsertRowid);
      }

      const { lastInsertRowid } = q.insertMessage.run(room.id, req.user.id, body, fileId, now());
      const message = publicMessage(q.messageById.get(Number(lastInsertRowid)));
      emitToRoom(room, 'message:new', message);
      res.status(201).json({ message });
    } catch (e) {
      if (req.file) removeUpload(req.file.filename);
      next(e);
    }
  });
});

app.delete('/api/messages/:id', requireAuth, wrap((req, res) => {
  const msg = q.messageById.get(Number(req.params.id));
  if (!msg) throw new HttpError(404, 'Message not found.');
  if (msg.user_id !== req.user.id) throw new HttpError(403, 'You can only delete your own messages.');
  const room = q.roomById.get(msg.room_id);
  q.deleteMessage.run(msg.id);
  if (msg.file_id) {
    const file = q.fileById.get(msg.file_id);
    if (file) {
      q.deleteFile.run(file.id);
      removeUpload(file.stored_name);
    }
  }
  emitToRoom(room, 'message:delete', { id: msg.id, roomId: msg.room_id });
  res.json({ ok: true });
}));

const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[‍️⃣#*0-9]|\p{Emoji_Modifier})+$/u;

app.post('/api/messages/:id/reactions', requireAuth, wrap((req, res) => {
  const msg = q.messageById.get(Number(req.params.id));
  if (!msg) throw new HttpError(404, 'Message not found.');
  const room = requireRoomAccess(msg.room_id, req.user.id);

  const emoji = cleanText(req.body.emoji, 40);
  const custom = /^:([a-z0-9_-]{2,32}):$/.exec(emoji);
  if (custom ? !q.emojiByName.get(custom[1]) : !UNICODE_EMOJI.test(emoji)) {
    throw new HttpError(400, 'That is not an emoji we know.');
  }

  if (q.hasReaction.get(msg.id, req.user.id, emoji)) {
    q.removeReaction.run(msg.id, req.user.id, emoji);
  } else {
    q.addReaction.run(msg.id, req.user.id, emoji, now());
  }
  const payload = { messageId: msg.id, roomId: msg.room_id, reactions: reactionSummary(msg.id) };
  emitToRoom(room, 'reaction:update', payload);
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// Custom emoji
// ---------------------------------------------------------------------------

app.get('/api/emojis', requireAuth, (req, res) => res.json({ emojis: q.allEmojis.all().map(publicEmoji) }));

app.post('/api/emojis', requireAuth, emojiUpload.single('image'), wrap((req, res) => {
  try {
    if (!req.file) throw new HttpError(400, 'No picture received.');
    const name = cleanText(req.body.name, 32).toLowerCase().replace(/^:|:$/g, '');
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) {
      throw new HttpError(400, 'Emoji names are 2-32 characters: letters, numbers, - and _.');
    }
    if (q.emojiByName.get(name)) throw new HttpError(409, `:${name}: already exists!`);
    q.insertEmoji.run(name, req.file.filename, req.user.id, now());
    const emoji = publicEmoji(q.emojiByName.get(name));
    io.to('authed').emit('emoji:new', emoji);
    res.status(201).json({ emoji });
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    throw err;
  }
}));

app.delete('/api/emojis/:name', requireAuth, wrap((req, res) => {
  const emoji = q.emojiByName.get(String(req.params.name));
  if (!emoji) throw new HttpError(404, 'Emoji not found.');
  if (emoji.uploader_id !== req.user.id) throw new HttpError(403, 'Only the creator can delete this emoji.');
  q.deleteEmoji.run(emoji.name);
  removeUpload(emoji.stored_name);
  io.to('authed').emit('emoji:delete', { name: emoji.name });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Serving uploaded files (members only)
// ---------------------------------------------------------------------------

function sendStoredImage(storedName, res, next) {
  const safe = path.basename(String(storedName));
  res.sendFile(path.join(UPLOAD_DIR, safe), { maxAge: '7d', immutable: true }, (err) => {
    if (err && !res.headersSent) next(new HttpError(404, 'Not found.'));
  });
}

app.get('/avatars/:name', requireAuth, (req, res, next) => sendStoredImage(req.params.name, res, next));
app.get('/emoji/:name', requireAuth, (req, res, next) => sendStoredImage(req.params.name, res, next));

app.get('/files/:id/:name?', requireAuth, wrap((req, res, next) => {
  const file = q.fileById.get(Number(req.params.id));
  if (!file) throw new HttpError(404, 'File not found.');
  const msg = db.prepare('SELECT room_id FROM messages WHERE file_id = ?').get(file.id);
  if (msg) requireRoomAccess(msg.room_id, req.user.id);

  const inline = INLINE_IMAGE_TYPES.has(file.mime) && req.query.download === undefined;
  res.attachment(file.original_name);
  res.set('Content-Type', inline ? file.mime : 'application/octet-stream');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (inline) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
  res.sendFile(path.join(UPLOAD_DIR, path.basename(file.stored_name)), { maxAge: '7d' }, (err) => {
    if (err && !res.headersSent) next(new HttpError(404, 'File not found.'));
  });
}));

// ---------------------------------------------------------------------------
// Static front-end + errors
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
// IBM Plex, self-hosted (Carbon's typeface)
for (const [route, pkg] of [['/fonts/plex-sans', '@fontsource/ibm-plex-sans'], ['/fonts/plex-mono', '@fontsource/ibm-plex-mono']]) {
  app.use(route, express.static(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files'), {
    maxAge: '30d',
    immutable: true,
  }));
}

app.use('/api', (req, res, next) => next(new HttpError(404, 'Unknown API route.')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big!' : 'Upload problem: ' + err.message;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Bad request.';
  } else if (status >= 500) {
    console.error(err);
    message = 'Something went wrong on our end.';
  }
  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------------------
// Realtime: presence + typing
// ---------------------------------------------------------------------------

io.use((socket, next) => {
  const userId = auth.userIdForToken(auth.tokenFromCookieHeader(socket.request.headers.cookie));
  if (!userId || !q.userById.get(userId)) return next(new Error('unauthorized'));
  socket.data.userId = userId;
  next();
});

const typingLimiter = rateLimiter({ windowMs: 1000, max: 5 });

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  socket.join('authed');
  socket.join(`user:${userId}`);

  const count = (onlineCount.get(userId) || 0) + 1;
  onlineCount.set(userId, count);
  q.touchUser.run(now(), userId);
  if (count === 1) io.emit('presence', { userId, online: true });

  socket.on('typing', (roomId) => {
    if (!typingLimiter(socket.id)) return;
    const room = q.roomById.get(Number(roomId));
    if (!room || (room.kind === 'dm' && !q.isMember.get(room.id, userId))) return;
    if (room.kind === 'channel') socket.to('authed').emit('typing', { roomId: room.id, userId });
    else {
      for (const { user_id } of q.roomMembers.all(room.id)) {
        if (user_id !== userId) io.to(`user:${user_id}`).emit('typing', { roomId: room.id, userId });
      }
    }
  });

  socket.on('disconnect', () => {
    const left = (onlineCount.get(userId) || 1) - 1;
    q.touchUser.run(now(), userId);
    if (left <= 0) {
      onlineCount.delete(userId);
      io.emit('presence', { userId, online: false });
    } else {
      onlineCount.set(userId, left);
    }
  });
});

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use, so talktalk can't start.`);
      console.error('  talktalk is probably already running in another Terminal window.');
      console.error('  Go to that window and press Control+C, or stop it from here with:\n');
      console.error(`    lsof -ti :${PORT} | xargs kill\n`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`\n  talktalk is up! Open http://localhost:${PORT} in your browser.\n`);
  });
}

module.exports = { app, server, io };
