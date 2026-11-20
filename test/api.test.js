'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

process.env.TALKTALK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'talktalk-test-'));
const { server, io } = require('../server/index.js');

let base;
before(() => new Promise((resolve) => server.listen(0, () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
after(() => {
  io.close();
  server.close();
  fs.rmSync(process.env.TALKTALK_DATA_DIR, { recursive: true, force: true });
});

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const opts = { method, headers: { ...headers } };
    if (cookie) opts.headers.cookie = cookie;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opts);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
}

const alice = client();
const bob = client();
const eve = client();
let aliceId, bobId;

test('sign up, log in and reject bad credentials', async () => {
  let r = await alice('POST', '/api/signup', { username: 'Alice', password: 'secret123', displayName: 'Alice A' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.username, 'alice');
  aliceId = r.data.user.id;

  r = await bob('POST', '/api/signup', { username: 'bob', password: 'hunter22' });
  bobId = r.data.user.id;
  await eve('POST', '/api/signup', { username: 'eve', password: 'evil1234' });

  r = await client()('POST', '/api/signup', { username: 'ALICE', password: 'whatever1' });
  assert.equal(r.status, 409, 'usernames are case-insensitive');

  r = await client()('POST', '/api/login', { username: 'alice', password: 'wrong' });
  assert.equal(r.status, 401);

  r = await client()('GET', '/api/me');
  assert.equal(r.status, 401);
});

test('profile updates', async () => {
  const r = await alice('PATCH', '/api/me', { status: 'brb', bio: 'hello <b>world</b>' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.status, 'brb');
  assert.equal(r.data.user.bio, 'hello <b>world</b>', 'stored as plain text; the client never renders it as HTML');

  const fd = new FormData();
  fd.append('avatar', new Blob([PNG], { type: 'image/png' }), 'me.png');
  const up = await alice('POST', '/api/me/avatar', fd);
  assert.equal(up.status, 200);
  assert.match(up.data.user.avatarUrl, /^\/avatars\/[a-f0-9]{32}\.png$/);

  const img = await alice('GET', up.data.user.avatarUrl);
  assert.equal(img.status, 200);
});

test('channels: seeded, create, duplicate rejected', async () => {
  const { data } = await alice('GET', '/api/rooms');
  assert.ok(data.rooms.some((r) => r.name === 'general'));

  let r = await alice('POST', '/api/channels', { name: 'Cool Stuff', topic: 'things' });
  assert.equal(r.status, 201);
  assert.equal(r.data.room.name, 'cool-stuff');
  r = await bob('POST', '/api/channels', { name: 'cool-stuff' });
  assert.equal(r.status, 409);
});

test('messages, file sharing and reactions in a channel', async () => {
  const { data } = await alice('GET', '/api/rooms');
  const general = data.rooms.find((r) => r.name === 'general');

  const fd = new FormData();
  fd.append('body', 'check this out :party:');
  fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
  let r = await alice('POST', `/api/rooms/${general.id}/messages`, fd);
  assert.equal(r.status, 201);
  const msg = r.data.message;
  assert.equal(msg.file.name, 'evil.html');
  assert.equal(msg.file.isImage, false);

  // HTML uploads must download, never render on our origin.
  const file = await bob('GET', msg.file.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /^attachment/);

  const img = new FormData();
  img.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
  r = await bob('POST', `/api/rooms/${general.id}/messages`, img);
  const imgFile = await alice('GET', r.data.message.file.url);
  assert.equal(imgFile.headers.get('content-type'), 'image/png');
  assert.match(imgFile.headers.get('content-disposition'), /^inline/);

  r = await bob('POST', `/api/messages/${msg.id}/reactions`, { emoji: '🔥' });
  assert.deepEqual(r.data.reactions, [{ emoji: '🔥', userIds: [bobId] }]);
  r = await bob('POST', `/api/messages/${msg.id}/reactions`, { emoji: '🔥' });
  assert.deepEqual(r.data.reactions, [], 'second click removes the reaction');

  r = await bob('POST', `/api/messages/${msg.id}/reactions`, { emoji: '<img src=x>' });
  assert.equal(r.status, 400);

  const empty = await alice('POST', `/api/rooms/${general.id}/messages`, { body: '   ' });
  assert.equal(empty.status, 400);

  r = await bob('DELETE', `/api/messages/${msg.id}`);
  assert.equal(r.status, 403, 'cannot delete other people\'s messages');
  r = await alice('DELETE', `/api/messages/${msg.id}`);
  assert.equal(r.status, 200);
  r = await bob('GET', msg.file.url);
  assert.equal(r.status, 404, 'deleting a message deletes its file');
});

test('direct messages stay private', async () => {
  let r = await alice('POST', '/api/dms', { userId: bobId });
  const dm = r.data.room;
  assert.equal(dm.kind, 'dm');
  assert.equal(dm.otherUserId, bobId);

  r = await bob('POST', '/api/dms', { userId: aliceId });
  assert.equal(r.data.room.id, dm.id, 'same conversation from either side');

  const fd = new FormData();
  fd.append('body', 'psst');
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'secret.png');
  r = await alice('POST', `/api/rooms/${dm.id}/messages`, fd);
  assert.equal(r.status, 201);
  const fileUrl = r.data.message.file.url;

  assert.equal((await bob('GET', `/api/rooms/${dm.id}/messages`)).data.messages.length, 1);
  assert.equal((await eve('GET', `/api/rooms/${dm.id}/messages`)).status, 403);
  assert.equal((await eve('POST', `/api/rooms/${dm.id}/messages`, { body: 'hi' })).status, 403);
  assert.equal((await eve('GET', fileUrl)).status, 403);
  assert.ok(!(await eve('GET', '/api/rooms')).data.rooms.some((r) => r.id === dm.id));
});

test('custom emoji: create, use as reaction, delete', async () => {
  const fd = new FormData();
  fd.append('name', 'Party');
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'party.png');
  let r = await alice('POST', '/api/emojis', fd);
  assert.equal(r.status, 201);
  assert.equal(r.data.emoji.name, 'party');

  const svg = new FormData();
  svg.append('name', 'sneaky');
  svg.append('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await alice('POST', '/api/emojis', svg)).status, 400, 'SVG is refused');

  const { data } = await alice('GET', '/api/rooms');
  const general = data.rooms.find((x) => x.name === 'general');
  const m = await alice('POST', `/api/rooms/${general.id}/messages`, { body: 'yay' });
  r = await bob('POST', `/api/messages/${m.data.message.id}/reactions`, { emoji: ':party:' });
  assert.equal(r.status, 200);
  r = await bob('POST', `/api/messages/${m.data.message.id}/reactions`, { emoji: ':nope:' });
  assert.equal(r.status, 400);

  assert.equal((await bob('DELETE', '/api/emojis/party')).status, 403);
  assert.equal((await alice('DELETE', '/api/emojis/party')).status, 200);
});

test('cross-site requests are blocked', async () => {
  const r = await alice('POST', '/api/channels', { name: 'phish' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('every built-in picker emoji is accepted as a reaction', async () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/emoji-data.js'), 'utf8'), sandbox);
  const all = sandbox.window.EMOJI_GROUPS.flatMap(([, list]) => list.map(([e]) => e));

  const { data } = await alice('GET', '/api/rooms');
  const general = data.rooms.find((x) => x.name === 'general');
  const m = await alice('POST', `/api/rooms/${general.id}/messages`, { body: 'react to me' });
  const rejected = [];
  for (const emoji of all) {
    const r = await alice('POST', `/api/messages/${m.data.message.id}/reactions`, { emoji });
    if (r.status !== 200) rejected.push(emoji);
  }
  assert.deepEqual(rejected, []);
});
