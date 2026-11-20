/* talktalk front-end. Plain JavaScript, no build step. */
(() => {
  'use strict';

  // ------------------------------------------------------------------------
  // Tiny helpers
  // ------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** Build a DOM element. Text is always set via textContent, so user input can never inject HTML. */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || 'Something went wrong.');
    return data;
  }

  /** Upload with a progress callback (fetch can't report upload progress). */
  function uploadWithProgress(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        const data = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data.error || 'Upload failed.'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Network error. Check your connection.'));
      xhr.send(formData);
    });
  }

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  };
  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayKey = (ts) => new Date(ts).toDateString();
  function formatDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  const storage = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
    },
  };

  // ------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------

  const state = {
    me: null,
    users: new Map(),
    rooms: new Map(),
    emojis: new Map(),
    currentRoomId: null,
    messages: new Map(), // roomId -> { list: [], hasMore: bool, loaded: bool }
    unread: new Map(),   // roomId -> count (0 = "has unread but unknown count")
    lastRead: {},        // roomId -> last message id seen
    typing: new Map(),   // roomId -> Map(userId -> timeout)
    pendingFile: null,
    soundOn: storage.get('tt:sound', true),
    pinned: true, // is the message list stuck to the newest message?
    socket: null,
  };

  // ------------------------------------------------------------------------
  // Avatars & names
  // ------------------------------------------------------------------------

  function initialsAvatar(name) {
    const letters = (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#111"/>` +
      `<text x="32" y="41" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#ecebe6" text-anchor="middle">${
        letters.replace(/[^A-Z0-9]/g, '') || '?'}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  const avatarFor = (user) => (user?.avatarUrl ? user.avatarUrl : initialsAvatar(user?.displayName));
  const userName = (id) => state.users.get(id)?.displayName ?? 'Someone';

  function roomLabel(room) {
    if (room.kind === 'channel') return room.name;
    const other = state.users.get(room.otherUserId);
    const name = other?.displayName ?? 'Unknown';
    return room.otherUserId === state.me.id ? `${name} (you)` : name;
  }

  // ------------------------------------------------------------------------
  // Rich text: *bold* _italic_ `code` ```blocks``` links :custom: @mentions
  // ------------------------------------------------------------------------

  const INLINE_TOKEN = new RegExp(
    [
      '(https?:\\/\\/[^\\s<>"]+[^\\s<>".,:;\'!?)\\]])', // 1 url
      '(:[a-z0-9_-]{2,32}:)', //                          2 custom emoji
      '(?<![\\w*])\\*([^*\\n]+)\\*(?![\\w*])', //         3 bold
      '(?<![\\w_])_([^_\\n]+)_(?![\\w_])', //             4 italic
      '(?<![\\w@])@([a-z0-9_]{3,24})\\b', //              5 mention
      '((?:\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier}|\\u200D\\p{Extended_Pictographic})*)+)', // 6 unicode emoji
    ].join('|'),
    'giu'
  );

  function customEmojiImg(name) {
    const emoji = state.emojis.get(name);
    return emoji ? h('img', { class: 'cemoji', src: emoji.url, alt: `:${name}:`, title: `:${name}:` }) : null;
  }

  function renderInline(text, parent) {
    let last = 0;
    for (const m of text.matchAll(INLINE_TOKEN)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) parent.append(h('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer' }, m[1]));
      else if (m[2]) parent.append(customEmojiImg(m[2].slice(1, -1)) || m[2]);
      else if (m[3]) renderInline(m[3], parent.appendChild(h('strong')));
      else if (m[4]) renderInline(m[4], parent.appendChild(h('em')));
      else if (m[5]) {
        const user = [...state.users.values()].find((u) => u.username === m[5].toLowerCase());
        parent.append(user ? h('span', { class: 'mention', title: user.displayName }, m[0]) : m[0]);
      } else if (m[6]) parent.append(h('span', { class: 'uemoji' }, m[6]));
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function renderRich(text, parent) {
    // Code blocks first, then inline code, then everything else.
    text.split(/```\n?([\s\S]*?)```/g).forEach((part, i) => {
      if (i % 2 === 1) return parent.append(h('pre', {}, h('code', {}, part)));
      part.split(/`([^`\n]+)`/g).forEach((seg, j) => {
        if (j % 2 === 1) parent.append(h('code', {}, seg));
        else renderInline(seg, parent);
      });
    });
    return parent;
  }

  /** Messages that are only emoji (up to 6) render big, like in most chat apps. */
  function isJumbo(text) {
    const CUSTOM = /:([a-z0-9_-]{2,32}):/g;
    let count = 0;
    const rest = text
      .replace(CUSTOM, (m, name) => (state.emojis.has(name) ? (count++, '') : m))
      .replace(/\p{Extended_Pictographic}/gu, () => (count++, ''))
      .replace(/[\uFE0F\u200D\s]|\p{Emoji_Modifier}/gu, '');
    return rest === '' && count > 0 && count <= 6;
  }

  // ------------------------------------------------------------------------
  // Sound
  // ------------------------------------------------------------------------

  let audioCtx;
  function blip() {
    if (!state.soundOn) return;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      [[880, 0], [1320, 0.07]].forEach(([freq, delay]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + delay);
        gain.gain.exponentialRampToValueAtTime(0.08, t + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.12);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t + delay);
        osc.stop(t + delay + 0.13);
      });
    } catch { /* audio not available */ }
  }

  function updateSoundButton() {
    const btn = $('#sound-btn');
    btn.classList.toggle('off', !state.soundOn);
    btn.title = state.soundOn ? 'Sound on' : 'Sound off';
  }

  // ------------------------------------------------------------------------
  // Sidebar
  // ------------------------------------------------------------------------

  function renderSidebar() {
    const rooms = [...state.rooms.values()];
    const channels = rooms.filter((r) => r.kind === 'channel').sort((a, b) => a.name.localeCompare(b.name));
    const dms = rooms.filter((r) => r.kind === 'dm').sort((a, b) => roomLabel(a).localeCompare(roomLabel(b)));

    const roomItem = (room) => {
      const unread = state.unread.get(room.id);
      const sigil = room.kind === 'channel'
        ? h('span', { class: 'sigil' }, '#')
        : h('span', { class: `presence${state.users.get(room.otherUserId)?.online ? ' on' : ''}` });
      return h('li', {},
        h('button', {
          type: 'button',
          class: [room.id === state.currentRoomId && 'active', unread !== undefined && 'unread'].filter(Boolean).join(' '),
          onclick: () => openRoom(room.id),
        },
        sigil,
        h('span', { class: 'label' }, roomLabel(room)),
        unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null)
      );
    };

    $('#channel-list').replaceChildren(...channels.map(roomItem));
    $('#dm-list').replaceChildren(...dms.map(roomItem));

    const users = [...state.users.values()].sort((a, b) =>
      (b.online - a.online) || a.displayName.localeCompare(b.displayName));
    $('#buddy-list').replaceChildren(...users.map((u) =>
      h('li', {},
        h('button', { type: 'button', onclick: () => showUser(u.id), title: u.status || '' },
          h('span', { class: `presence${u.online ? ' on' : ''}` }),
          h('span', { class: 'label' }, u.id === state.me.id ? `${u.displayName} (you)` : u.displayName)))
    ));
    $('#online-count').textContent = `${users.filter((u) => u.online).length}/${users.length}`;

    // "Me" card
    const me = state.users.get(state.me.id) || state.me;
    $('#me-avatar').src = avatarFor(me);
    $('#me-name').textContent = me.displayName;
    $('#me-status').textContent = me.status || `@${me.username}`;

    // Tab title shows total unread
    const total = [...state.unread.values()].reduce((sum, n) => sum + (n || 0), 0);
    document.title = total ? `(${total}) talktalk` : 'talktalk';
  }

  // ------------------------------------------------------------------------
  // Rooms & messages
  // ------------------------------------------------------------------------

  function markRead(roomId) {
    const room = state.rooms.get(roomId);
    if (!room) return;
    state.unread.delete(roomId);
    state.lastRead[roomId] = room.lastMessageId || 0;
    storage.set(`tt:lastRead:${state.me.id}`, state.lastRead);
  }

  async function openRoom(roomId) {
    const room = state.rooms.get(roomId);
    if (!room) return;
    state.currentRoomId = roomId;
    if (location.hash !== `#/room/${roomId}`) history.replaceState(null, '', `#/room/${roomId}`);
    $('#app').classList.remove('sidebar-open');
    $('#scrim').hidden = true;

    renderHeader();
    markRead(roomId);
    renderSidebar();
    renderTyping();

    const input = $('#message-input');
    input.placeholder = room.kind === 'channel' ? `Message #${room.name}` : `Message ${roomLabel(room)}`;

    if (!state.messages.get(roomId)?.loaded) {
      $('#messages').replaceChildren(h('div', { class: 'empty-room' }, 'Loading…'));
      await loadMessages(roomId);
    }
    if (state.currentRoomId === roomId) {
      renderMessages({ scroll: 'bottom' });
      if (matchMedia('(pointer: fine)').matches) input.focus();
    }
  }

  function renderHeader() {
    const room = state.rooms.get(state.currentRoomId);
    if (!room) return;
    $('#room-kind').textContent = room.kind === 'channel' ? 'Channel' : 'Direct message';
    if (room.kind === 'channel') {
      $('#room-name').textContent = `#${room.name}`;
      $('#room-topic').textContent = room.topic || 'No topic yet';
      $('#edit-topic-btn').hidden = false;
    } else {
      const other = state.users.get(room.otherUserId);
      $('#room-name').textContent = roomLabel(room);
      $('#room-topic').textContent = other?.status || (other?.online ? 'Active now' : `@${other?.username ?? ''}`);
      $('#edit-topic-btn').hidden = true;
    }
  }

  async function loadMessages(roomId, { older = false } = {}) {
    const entry = state.messages.get(roomId) || { list: [], hasMore: true, loaded: false };
    const before = older && entry.list.length ? `?before=${entry.list[0].id}` : '';
    try {
      const { messages, hasMore } = await api('GET', `/api/rooms/${roomId}/messages${before}`);
      if (older) {
        entry.list = [...messages, ...entry.list];
      } else {
        // Merge with anything that arrived over the socket while loading.
        const byId = new Map([...messages, ...entry.list].map((m) => [m.id, m]));
        entry.list = [...byId.values()].sort((a, b) => a.id - b.id);
      }
      entry.hasMore = hasMore;
      entry.loaded = true;
      state.messages.set(roomId, entry);
    } catch (err) {
      toast(err.message);
    }
  }

  function renderMessages({ scroll } = {}) {
    const container = $('#messages');
    const room = state.rooms.get(state.currentRoomId);
    const entry = state.messages.get(state.currentRoomId);
    if (!room || !entry) return;

    const prevHeight = container.scrollHeight;
    const prevTop = container.scrollTop;
    const nearBottom = state.pinned;

    const nodes = [];
    if (entry.hasMore && entry.list.length) {
      nodes.push(h('button', { class: 'btn small load-more', type: 'button', onclick: loadOlder }, 'Load older messages'));
    } else {
      nodes.push(roomIntro(room));
    }

    let prev = null;
    for (const msg of entry.list) {
      if (!prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt)) {
        nodes.push(h('div', { class: 'day-divider' }, h('span', {}, formatDay(msg.createdAt))));
        prev = null;
      }
      const grouped = prev && prev.userId === msg.userId && msg.createdAt - prev.createdAt < 5 * 60 * 1000;
      nodes.push(renderMessage(msg, grouped));
      prev = msg;
    }
    container.replaceChildren(...nodes);

    if (scroll === 'bottom' || (scroll === 'auto' && nearBottom)) {
      state.pinned = true;
      container.scrollTop = container.scrollHeight;
    } else if (scroll === 'keep') {
      container.scrollTop = container.scrollHeight - prevHeight + prevTop;
    } else {
      container.scrollTop = prevTop;
    }
  }

  function roomIntro(room) {
    if (room.kind === 'channel') {
      return h('div', { class: 'empty-room' },
        h('h3', {}, 'It starts', h('br'), 'here.'),
        h('p', {}, `This is the very beginning of #${room.name}. ${room.topic || ''}`));
    }
    const other = state.users.get(room.otherUserId);
    return h('div', { class: 'empty-room' },
      h('h3', {}, ...(room.otherUserId === state.me.id ? ['Your', h('br'), 'notes.'] : ['Just', h('br'), 'you two.'])),
      h('p', {}, room.otherUserId === state.me.id
        ? 'This is your space. Draft messages, keep notes, or park files here.'
        : `This is the start of your conversation with ${other?.displayName ?? 'this member'}.`));
  }

  async function loadOlder() {
    await loadMessages(state.currentRoomId, { older: true });
    renderMessages({ scroll: 'keep' });
  }

  function renderMessage(msg, grouped) {
    const user = state.users.get(msg.userId);
    const isMine = msg.userId === state.me.id;

    const left = grouped
      ? h('div', { class: 'gutter-time', title: new Date(msg.createdAt).toLocaleString() }, formatTime(msg.createdAt))
      : h('img', { class: 'avatar', src: avatarFor(user), alt: '', onclick: () => showUser(msg.userId) });

    const content = h('div', { class: 'msg-content' });
    if (!grouped) {
      content.append(h('div', { class: 'msg-head' },
        h('button', { class: 'msg-author', type: 'button', onclick: () => showUser(msg.userId) }, user?.displayName ?? 'Unknown'),
        h('time', { class: 'msg-time', title: new Date(msg.createdAt).toLocaleString() }, formatTime(msg.createdAt))));
    }
    if (msg.body) {
      content.append(renderRich(msg.body, h('div', { class: `msg-body${isJumbo(msg.body) ? ' jumbo' : ''}` })));
    }
    if (msg.file) content.append(renderAttachment(msg.file));
    content.append(renderReactions(msg));

    const actions = h('div', { class: 'msg-actions' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Add reaction', 'aria-label': 'Add reaction',
        onclick: (e) => openPicker(e.currentTarget, { mode: 'react', messageId: msg.id }) }, '☺'),
      isMine ? h('button', { class: 'icon-btn', type: 'button', title: 'Delete', 'aria-label': 'Delete message',
        onclick: () => deleteMessage(msg.id) }, '×') : null);

    return h('div', { class: `msg${grouped ? ' grouped' : ''}`, dataset: { id: msg.id } }, left, content, actions);
  }

  function renderAttachment(file) {
    if (file.isImage) {
      return h('div', { class: 'attachment' },
        h('img', { src: file.url, alt: file.name, loading: 'lazy', onclick: () => lightbox(file.url, file.name) }));
    }
    const ext = (file.name.split('.').pop() || 'file').slice(0, 5).toUpperCase();
    return h('div', { class: 'attachment' },
      h('a', { class: 'file-card', href: `${file.url}?download`, download: file.name },
        h('span', { class: 'ext' }, ext),
        h('span', { class: 'meta' },
          h('span', { class: 'name' }, file.name),
          h('span', { class: 'size' }, `${formatSize(file.size)} · download`))));
  }

  function renderReactions(msg) {
    const wrap = h('div', { class: 'reactions' });
    for (const { emoji, userIds } of msg.reactions) {
      const custom = /^:([a-z0-9_-]+):$/.exec(emoji);
      const face = custom ? (customEmojiImg(custom[1]) || emoji) : h('span', { class: 'uemoji' }, emoji);
      const names = userIds.map(userName);
      wrap.append(h('button', {
        type: 'button',
        class: `reaction${userIds.includes(state.me.id) ? ' mine' : ''}`,
        title: `${names.join(', ')} reacted with ${emoji}`,
        onclick: (e) => { e.currentTarget.classList.add('pop'); toggleReaction(msg.id, emoji); },
      }, face, h('span', {}, userIds.length)));
    }
    if (msg.reactions.length) {
      wrap.append(h('button', {
        type: 'button', class: 'reaction add', title: 'Add reaction', 'aria-label': 'Add reaction',
        onclick: (e) => openPicker(e.currentTarget, { mode: 'react', messageId: msg.id }),
      }, '☺＋'));
    } else {
      wrap.hidden = true;
    }
    return wrap;
  }

  function findMessage(id) {
    for (const [roomId, entry] of state.messages) {
      const msg = entry.list.find((m) => m.id === id);
      if (msg) return { roomId, entry, msg };
    }
    return null;
  }

  async function toggleReaction(messageId, emoji) {
    try {
      const data = await api('POST', `/api/messages/${messageId}/reactions`, { emoji });
      applyReactionUpdate(data);
    } catch (err) {
      toast(err.message);
    }
  }

  function applyReactionUpdate({ messageId, reactions }) {
    const found = findMessage(messageId);
    if (!found) return;
    found.msg.reactions = reactions;
    if (found.roomId === state.currentRoomId) {
      const old = $(`.msg[data-id="${messageId}"] .reactions`);
      if (old) old.replaceWith(renderReactions(found.msg));
    }
  }

  async function deleteMessage(id) {
    if (!confirm('Delete this message? This cannot be undone.')) return;
    try {
      await api('DELETE', `/api/messages/${id}`);
      removeMessage(id);
    } catch (err) {
      toast(err.message);
    }
  }

  function removeMessage(id) {
    const found = findMessage(id);
    if (!found) return;
    found.entry.list = found.entry.list.filter((m) => m.id !== id);
    if (found.roomId === state.currentRoomId) renderMessages();
  }

  function addMessage(msg) {
    const room = state.rooms.get(msg.roomId);
    if (!room) return;
    room.lastMessageId = Math.max(room.lastMessageId || 0, msg.id);

    const entry = state.messages.get(msg.roomId);
    if (entry && !entry.list.some((m) => m.id === msg.id)) {
      entry.list.push(msg);
      entry.list.sort((a, b) => a.id - b.id);
    }

    const mine = msg.userId === state.me.id;
    const viewing = msg.roomId === state.currentRoomId && !document.hidden;

    if (msg.roomId === state.currentRoomId) {
      renderMessages({ scroll: mine ? 'bottom' : 'auto' });
      clearTyping(msg.roomId, msg.userId);
    }
    if (viewing || mine) {
      if (msg.roomId === state.currentRoomId) markRead(msg.roomId);
    } else {
      state.unread.set(msg.roomId, (state.unread.get(msg.roomId) || 0) + 1);
      const mentioned = new RegExp(`@${state.me.username}\\b`, 'i').test(msg.body);
      if (room.kind === 'dm' || mentioned || document.hidden) blip();
    }
    renderSidebar();
  }

  // ------------------------------------------------------------------------
  // Composer
  // ------------------------------------------------------------------------

  function setPendingFile(file) {
    state.pendingFile = file;
    $('#attachment-chip').hidden = !file;
    $('#attachment-name').textContent = file ? `${file.name} · ${formatSize(file.size)}` : '';
    if (file) $('#message-input').focus();
  }

  function autoGrow() {
    const input = $('#message-input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  let sending = false;
  async function sendMessage(e) {
    e?.preventDefault();
    if (sending) return;
    const input = $('#message-input');
    const body = input.value.trim();
    const file = state.pendingFile;
    if (!body && !file) return;

    const roomId = state.currentRoomId;
    const form = new FormData();
    form.append('body', body);
    if (file) form.append('file', file);

    sending = true;
    const progress = $('#upload-progress');
    progress.hidden = !file;
    try {
      const { message } = await uploadWithProgress(`/api/rooms/${roomId}/messages`, form, (p) => {
        progress.firstElementChild.style.width = `${Math.round(p * 100)}%`;
      });
      input.value = '';
      autoGrow();
      setPendingFile(null);
      addMessage(message);
    } catch (err) {
      toast(err.message);
    } finally {
      sending = false;
      progress.hidden = true;
      progress.firstElementChild.style.width = '0';
    }
  }

  function insertAtCursor(text) {
    const input = $('#message-input');
    const { selectionStart: s, selectionEnd: e, value } = input;
    const before = value.slice(0, s);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    input.value = `${before}${pad}${text} ${value.slice(e)}`;
    const pos = s + pad.length + text.length + 1;
    input.setSelectionRange(pos, pos);
    input.focus();
    autoGrow();
  }

  let lastTypingSent = 0;
  function sendTyping() {
    if (Date.now() - lastTypingSent < 2500) return;
    lastTypingSent = Date.now();
    state.socket?.emit('typing', state.currentRoomId);
  }

  function clearTyping(roomId, userId) {
    const map = state.typing.get(roomId);
    if (!map?.has(userId)) return;
    clearTimeout(map.get(userId));
    map.delete(userId);
    renderTyping();
  }

  function renderTyping() {
    const names = [...(state.typing.get(state.currentRoomId)?.keys() || [])].map(userName);
    $('#typing').textContent =
      names.length === 0 ? '' :
      names.length === 1 ? `${names[0]} is typing…` :
      names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }

  // ------------------------------------------------------------------------
  // Emoji picker
  // ------------------------------------------------------------------------

  let pickerTarget = null;

  function openPicker(anchor, target) {
    pickerTarget = target;
    const picker = $('#emoji-picker');
    picker.hidden = false;
    $('#emoji-search').value = '';
    renderPickerGrid('');

    const rect = anchor.getBoundingClientRect();
    const w = picker.offsetWidth;
    const ph = picker.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 8);
    let top = rect.top - ph - 8;
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - ph - 8);
    picker.style.left = `${Math.max(8, left)}px`;
    picker.style.top = `${Math.max(8, top)}px`;
    if (matchMedia('(pointer: fine)').matches) $('#emoji-search').focus();
  }

  function closePicker() {
    $('#emoji-picker').hidden = true;
    pickerTarget = null;
  }

  function choose(emoji) {
    const target = pickerTarget;
    closePicker();
    if (!target) return;
    if (target.mode === 'react') toggleReaction(target.messageId, emoji);
    else insertAtCursor(emoji);
  }

  function renderPickerGrid(query) {
    const q = query.trim().toLowerCase();
    const grid = $('#emoji-grid');
    const nodes = [];

    const custom = [...state.emojis.values()].filter((e) => !q || e.name.includes(q));
    if (custom.length) {
      nodes.push(h('div', { class: 'group-title' }, 'Custom'));
      for (const e of custom) {
        nodes.push(h('button', { type: 'button', title: `:${e.name}:`, onclick: () => choose(`:${e.name}:`) },
          h('img', { src: e.url, alt: `:${e.name}:` })));
      }
    }
    for (const [group, list] of window.EMOJI_GROUPS) {
      const items = list.filter(([, words]) => !q || words.includes(q));
      if (!items.length) continue;
      nodes.push(h('div', { class: 'group-title' }, group));
      for (const [char, words] of items) {
        nodes.push(h('button', { type: 'button', title: words.split(' ')[0], onclick: () => choose(char) }, char));
      }
    }
    if (!nodes.length) nodes.push(h('div', { class: 'group-title' }, 'Nothing found'));
    grid.replaceChildren(...nodes);
  }

  // ------------------------------------------------------------------------
  // Dialogs: profile, members, channels, topic
  // ------------------------------------------------------------------------

  function openDialog(id) {
    const dlg = $(id);
    $$('[data-error]', dlg).forEach((el) => (el.textContent = ''));
    if (!dlg.open) dlg.showModal();
    return dlg;
  }

  function formError(form, err) {
    const el = $('[data-error]', form);
    if (el) el.textContent = err.message;
    else toast(err.message);
  }

  function openProfileEditor() {
    const me = state.users.get(state.me.id);
    const form = $('#profile-form');
    form.displayName.value = me.displayName;
    form.status.value = me.status;
    form.bio.value = me.bio;
    $('#profile-avatar-preview').src = avatarFor(me);
    openDialog('#profile-dialog');
  }

  function showUser(userId) {
    const u = state.users.get(userId);
    if (!u) return;
    $('#view-avatar').src = avatarFor(u);
    $('#view-name').textContent = u.displayName;
    $('#view-username').textContent = `@${u.username} · ${u.online ? 'online' : 'away'}`;
    $('#view-status').textContent = u.status;
    $('#view-bio').textContent = u.bio;
    $('#view-meta').textContent = `Member since ${new Date(u.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })}`;
    $('#view-dm-btn').textContent = u.id === state.me.id ? 'Open your notes' : `Message ${u.displayName}`;
    $('#view-dm-btn').onclick = async () => {
      $('#user-dialog').close();
      await openDm(u.id);
    };
    openDialog('#user-dialog');
  }

  async function openDm(userId) {
    try {
      const { room } = await api('POST', '/api/dms', { userId });
      if (!state.rooms.has(room.id)) state.rooms.set(room.id, { ...room, lastMessageId: 0 });
      openRoom(room.id);
    } catch (err) {
      toast(err.message);
    }
  }

  // ------------------------------------------------------------------------
  // Emoji studio: draw 16x16 pixel emoji, upload images, browse gallery
  // ------------------------------------------------------------------------

  const PALETTE = [
    '#000000', '#ffffff', '#7f7f7f', '#c3c3c3', '#ff004d', '#ff77a8', '#ffa300', '#ffec27',
    '#00e436', '#008751', '#29adff', '#1d2b53', '#83769c', '#7e2553', '#ab5236', '#ffccaa',
  ];
  const paint = { color: '#000000', tool: 'pen', drawing: false };

  function setupPaint() {
    const canvas = $('#paint-canvas');
    const ctx = canvas.getContext('2d');

    $('#palette').replaceChildren(...PALETTE.map((c) => h('button', {
      type: 'button', style: `background:${c}`, 'aria-label': `Color ${c}`, dataset: { color: c },
      onclick: () => { paint.color = c; if (paint.tool === 'eraser') setTool('pen'); syncPaintUi(); },
    })));

    function setTool(tool) {
      if (tool === 'clear') {
        ctx.clearRect(0, 0, 16, 16);
        updatePreview();
        return;
      }
      paint.tool = tool;
      syncPaintUi();
    }
    $$('[data-tool]').forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

    function syncPaintUi() {
      $$('#palette button').forEach((b) => b.classList.toggle('active', b.dataset.color === paint.color));
      $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === paint.tool));
    }

    function cellAt(e) {
      const r = canvas.getBoundingClientRect();
      return [
        Math.min(15, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 16))),
        Math.min(15, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * 16))),
      ];
    }

    function pixelHex(x, y) {
      const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
      return a === 0 ? null : `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }

    function floodFill(x, y) {
      const target = pixelHex(x, y);
      const fill = paint.color;
      if (target === fill) return;
      const stack = [[x, y]];
      const seen = new Set();
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const key = cy * 16 + cx;
        if (cx < 0 || cy < 0 || cx > 15 || cy > 15 || seen.has(key) || pixelHex(cx, cy) !== target) continue;
        seen.add(key);
        ctx.fillStyle = fill;
        ctx.fillRect(cx, cy, 1, 1);
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
    }

    function apply(e) {
      const [x, y] = cellAt(e);
      if (paint.tool === 'fill') floodFill(x, y);
      else if (paint.tool === 'eraser') ctx.clearRect(x, y, 1, 1);
      else {
        ctx.fillStyle = paint.color;
        ctx.fillRect(x, y, 1, 1);
      }
      updatePreview();
    }

    canvas.addEventListener('pointerdown', (e) => {
      paint.drawing = paint.tool !== 'fill';
      canvas.setPointerCapture(e.pointerId);
      apply(e);
    });
    canvas.addEventListener('pointermove', (e) => paint.drawing && apply(e));
    const stop = () => (paint.drawing = false);
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    function updatePreview() {
      for (const id of ['#paint-preview', '#paint-preview-big']) {
        const p = $(id);
        const pctx = p.getContext('2d');
        pctx.imageSmoothingEnabled = false;
        pctx.clearRect(0, 0, p.width, p.height);
        pctx.drawImage(canvas, 0, 0, p.width, p.height);
      }
    }

    syncPaintUi();
    paint.isBlank = () => !ctx.getImageData(0, 0, 16, 16).data.some((v, i) => i % 4 === 3 && v > 0);
    paint.clear = () => setTool('clear');
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  async function saveEmoji(form, imageBlob, filename) {
    const fd = new FormData();
    fd.append('name', form.name.value.trim().toLowerCase());
    fd.append('image', imageBlob, filename);
    const { emoji } = await api('POST', '/api/emojis', fd);
    state.emojis.set(emoji.name, emoji);
    toast(`:${emoji.name}: is ready to use`);
    form.reset();
    return emoji;
  }

  function switchEmojiTab(tab) {
    $$('[data-emoji-tab]').forEach((b) => b.classList.toggle('active', b.dataset.emojiTab === tab));
    $$('[data-emoji-panel]').forEach((p) => (p.hidden = p.dataset.emojiPanel !== tab));
    if (tab === 'gallery') renderEmojiGallery();
  }

  function renderEmojiGallery() {
    const list = [...state.emojis.values()].sort((a, b) => a.name.localeCompare(b.name));
    const gallery = $('#emoji-gallery');
    if (!list.length) {
      gallery.replaceChildren(h('div', { class: 'emoji-empty' }, 'No custom emoji yet. Draw the first one!'));
      return;
    }
    gallery.replaceChildren(...list.map((e) => h('div', { class: 'emoji-tile' },
      h('img', { src: e.url, alt: '' }),
      h('span', {}, `:${e.name}:`),
      h('span', { class: 'muted small' }, `by ${userName(e.uploaderId)}`),
      e.uploaderId === state.me.id
        ? h('button', { type: 'button', class: 'btn small', onclick: () => deleteEmoji(e.name) }, 'Delete')
        : null)));
  }

  async function deleteEmoji(name) {
    if (!confirm(`Delete :${name}: for everyone?`)) return;
    try {
      await api('DELETE', `/api/emojis/${encodeURIComponent(name)}`);
      state.emojis.delete(name);
      renderEmojiGallery();
    } catch (err) {
      toast(err.message);
    }
  }

  // ------------------------------------------------------------------------
  // Lightbox
  // ------------------------------------------------------------------------

  function lightbox(src, alt) {
    const dlg = h('dialog', { class: 'lightbox' }, h('img', { src, alt }));
    dlg.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // ------------------------------------------------------------------------
  // Realtime
  // ------------------------------------------------------------------------

  function connectSocket() {
    const socket = io({ withCredentials: true });
    state.socket = socket;
    let wasConnected = false;

    socket.on('connect', async () => {
      if (wasConnected) {
        // Catch up on anything missed while offline.
        await refreshAll();
        if (state.currentRoomId) {
          state.messages.delete(state.currentRoomId);
          await loadMessages(state.currentRoomId);
          renderMessages({ scroll: 'auto' });
        }
        toast('Reconnected');
      }
      wasConnected = true;
    });
    socket.on('disconnect', () => toast('Connection lost — reconnecting…'));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') location.reload();
    });

    socket.on('message:new', addMessage);
    socket.on('message:delete', ({ id }) => removeMessage(id));
    socket.on('reaction:update', applyReactionUpdate);

    socket.on('room:new', (room) => {
      if (!state.rooms.has(room.id)) state.rooms.set(room.id, room);
      renderSidebar();
    });
    socket.on('room:update', (room) => {
      const existing = state.rooms.get(room.id);
      if (existing) Object.assign(existing, room);
      if (room.id === state.currentRoomId) renderHeader();
      renderSidebar();
    });

    socket.on('user:update', (user) => {
      const existing = state.users.get(user.id);
      state.users.set(user.id, { ...existing, ...user, online: existing?.online ?? user.online });
      renderSidebar();
      renderHeader();
      if (state.currentRoomId) renderMessages();
    });
    socket.on('presence', ({ userId, online }) => {
      const user = state.users.get(userId);
      if (user) user.online = online;
      renderSidebar();
      renderHeader();
    });

    socket.on('emoji:new', (emoji) => {
      state.emojis.set(emoji.name, emoji);
      if (!$('#emoji-dialog [data-emoji-panel="gallery"]').hidden) renderEmojiGallery();
    });
    socket.on('emoji:delete', ({ name }) => {
      state.emojis.delete(name);
      if (state.currentRoomId) renderMessages();
    });

    socket.on('typing', ({ roomId, userId }) => {
      if (!state.typing.has(roomId)) state.typing.set(roomId, new Map());
      const map = state.typing.get(roomId);
      clearTimeout(map.get(userId));
      map.set(userId, setTimeout(() => clearTyping(roomId, userId), 4000));
      if (roomId === state.currentRoomId) renderTyping();
    });
  }

  async function refreshAll() {
    const [{ users }, { rooms }, { emojis }] = await Promise.all([
      api('GET', '/api/users'), api('GET', '/api/rooms'), api('GET', '/api/emojis'),
    ]);
    state.users = new Map(users.map((u) => [u.id, u]));
    state.rooms = new Map(rooms.map((r) => [r.id, r]));
    state.emojis = new Map(emojis.map((e) => [e.name, e]));
    for (const room of rooms) {
      if (room.id !== state.currentRoomId && room.lastMessageId > (state.lastRead[room.id] ?? 0)) {
        if (!state.unread.has(room.id)) state.unread.set(room.id, 0);
      }
    }
    renderSidebar();
  }

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------

  async function startApp(me) {
    state.me = me;
    state.lastRead = storage.get(`tt:lastRead:${me.id}`, {});
    $('#welcome').hidden = true;
    $('#app').hidden = false;
    updateSoundButton();

    // First visit on this device: treat existing history as read.
    const firstVisit = !Object.keys(state.lastRead).length;
    await refreshAll();
    if (firstVisit) {
      for (const room of state.rooms.values()) state.lastRead[room.id] = room.lastMessageId;
      state.unread.clear();
      storage.set(`tt:lastRead:${me.id}`, state.lastRead);
    }

    connectSocket();
    setupPaint();

    const fromHash = Number((/^#\/room\/(\d+)$/.exec(location.hash) || [])[1]);
    const general = [...state.rooms.values()].find((r) => r.name === 'general');
    openRoom(state.rooms.has(fromHash) ? fromHash : (general || state.rooms.values().next().value).id);
  }

  function showWelcome() {
    $('#app').hidden = true;
    $('#welcome').hidden = false;
    $('#login-form').username.focus();
  }

  function bindAuth() {
    $$('[data-auth-tab]').forEach((tab) => tab.addEventListener('click', () => {
      const which = tab.dataset.authTab;
      $$('[data-auth-tab]').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab);
      });
      $('#login-form').hidden = which !== 'login';
      $('#signup-form').hidden = which !== 'signup';
      $('#auth-error').textContent = '';
      $(`#${which}-form`).username.focus();
    }));

    for (const [formId, url] of [['#login-form', '/api/login'], ['#signup-form', '/api/signup']]) {
      $(formId).addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const button = $('button[type=submit]', form);
        button.disabled = true;
        $('#auth-error').textContent = '';
        try {
          const { user } = await api('POST', url, Object.fromEntries(new FormData(form)));
          await startApp(user);
        } catch (err) {
          $('#auth-error').textContent = err.message;
        } finally {
          button.disabled = false;
        }
      });
    }
  }

  function bindApp() {
    // Toolbar / menu actions
    document.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      switch (target.dataset.action) {
        case 'edit-profile': openProfileEditor(); break;
        case 'new-channel': $('#channel-form').reset(); openDialog('#channel-dialog'); break;
        case 'emoji-studio': closePicker(); openDialog('#emoji-dialog'); switchEmojiTab('draw'); break;
        case 'toggle-sound':
          state.soundOn = !state.soundOn;
          storage.set('tt:sound', state.soundOn);
          updateSoundButton();
          if (state.soundOn) blip();
          break;
        case 'logout':
          await api('POST', '/api/logout').catch(() => {});
          location.hash = '';
          location.reload();
          break;
      }
    });

    // Close buttons in dialogs
    $$('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));
    // Click on the backdrop closes a dialog
    $$('dialog.dialog').forEach((dlg) => dlg.addEventListener('mousedown', (e) => {
      if (e.target === dlg) {
        const r = dlg.getBoundingClientRect();
        const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) dlg.close();
      }
    }));

    // Mobile sidebar
    $('#sidebar-toggle').addEventListener('click', () => {
      $('#app').classList.add('sidebar-open');
      $('#scrim').hidden = false;
    });
    $('#scrim').addEventListener('click', () => {
      $('#app').classList.remove('sidebar-open');
      $('#scrim').hidden = true;
    });

    // Composer
    const input = $('#message-input');
    $('#composer').addEventListener('submit', sendMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', () => { autoGrow(); if (input.value) sendTyping(); });
    input.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (file) {
        e.preventDefault();
        setPendingFile(file);
      }
    });
    $('#file-input').addEventListener('change', (e) => {
      setPendingFile(e.target.files[0] || null);
      e.target.value = '';
    });
    $('#attachment-remove').addEventListener('click', () => setPendingFile(null));
    $('#composer-emoji').addEventListener('click', (e) => openPicker(e.currentTarget, { mode: 'insert' }));

    // Drag & drop anywhere
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || $('#app').hidden) return;
      dragDepth++;
      $('#drop-overlay').hidden = false;
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#drop-overlay').hidden = true;
    });
    window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $('#drop-overlay').hidden = true;
      if (!$('#app').hidden && e.dataTransfer.files[0]) setPendingFile(e.dataTransfer.files[0]);
    });

    // Emoji picker
    $('#emoji-search').addEventListener('input', (e) => renderPickerGrid(e.target.value));
    $('#emoji-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#emoji-grid button')?.click();
      }
    });
    document.addEventListener('mousedown', (e) => {
      const picker = $('#emoji-picker');
      if (!picker.hidden && !picker.contains(e.target) && !e.target.closest('#composer-emoji, .msg-actions, .reaction.add')) {
        closePicker();
      }
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && closePicker());

    // Infinite scroll upward
    // Stay pinned to the newest message while images and fonts finish loading.
    const messagesEl = $('#messages');
    const keepPinned = () => { if (state.pinned) messagesEl.scrollTop = messagesEl.scrollHeight; };
    messagesEl.addEventListener('load', keepPinned, true);
    document.fonts?.ready.then(keepPinned);
    window.addEventListener('resize', keepPinned);

    messagesEl.addEventListener('scroll', (e) => {
      state.pinned = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 80;
      const entry = state.messages.get(state.currentRoomId);
      if (e.target.scrollTop < 40 && entry?.hasMore && !entry.loadingOlder) {
        entry.loadingOlder = true;
        loadOlder().finally(() => (entry.loadingOlder = false));
      }
    });

    // Mark read when coming back to the tab
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.currentRoomId) {
        markRead(state.currentRoomId);
        renderSidebar();
      }
    });
    window.addEventListener('hashchange', () => {
      const id = Number((/^#\/room\/(\d+)$/.exec(location.hash) || [])[1]);
      if (id && id !== state.currentRoomId && state.rooms.has(id)) openRoom(id);
    });

    // Profile
    $('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      try {
        const { user } = await api('PATCH', '/api/me', {
          displayName: form.displayName.value, status: form.status.value, bio: form.bio.value,
        });
        state.users.set(user.id, { ...state.users.get(user.id), ...user });
        renderSidebar();
        $('#profile-dialog').close();
        toast('Profile saved');
      } catch (err) {
        formError(form, err);
      }
    });
    $('#avatar-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const fd = new FormData();
      fd.append('avatar', file);
      try {
        const { user } = await api('POST', '/api/me/avatar', fd);
        state.users.set(user.id, { ...state.users.get(user.id), ...user });
        $('#profile-avatar-preview').src = avatarFor(user);
        renderSidebar();
        if (state.currentRoomId) renderMessages();
      } catch (err) {
        formError($('#profile-form'), err);
      }
    });

    // Channels
    $('#channel-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      try {
        const { room } = await api('POST', '/api/channels', { name: form.name.value, topic: form.topic.value });
        if (!state.rooms.has(room.id)) state.rooms.set(room.id, { ...room, lastMessageId: 0 });
        $('#channel-dialog').close();
        openRoom(room.id);
      } catch (err) {
        formError(form, err);
      }
    });
    $('#edit-topic-btn').addEventListener('click', () => {
      $('#topic-form').topic.value = state.rooms.get(state.currentRoomId)?.topic || '';
      openDialog('#topic-dialog');
    });
    $('#topic-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      try {
        const { room } = await api('PATCH', `/api/channels/${state.currentRoomId}`, { topic: form.topic.value });
        Object.assign(state.rooms.get(room.id), room);
        renderHeader();
        $('#topic-dialog').close();
      } catch (err) {
        formError(form, err);
      }
    });

    // Emoji studio
    $$('[data-emoji-tab]').forEach((b) => b.addEventListener('click', () => switchEmojiTab(b.dataset.emojiTab)));
    $('#draw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (paint.isBlank()) return formError(form, new Error('Draw something first.'));
      try {
        await saveEmoji(form, await canvasToBlob($('#paint-canvas')), 'emoji.png');
        paint.clear();
      } catch (err) {
        formError(form, err);
      }
    });
    $('#upload-emoji-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const file = form.image.files[0];
      if (!file) return formError(form, new Error('Pick an image first.'));
      try {
        await saveEmoji(form, file, file.name);
      } catch (err) {
        formError(form, err);
      }
    });
  }

  async function boot() {
    bindAuth();
    bindApp();
    try {
      const { user } = await api('GET', '/api/me');
      await startApp(user);
    } catch (err) {
      if (err.status === 401) showWelcome();
      else {
        showWelcome();
        $('#auth-error').textContent = 'Could not reach the server. Is it running?';
      }
    }
  }

  boot();
})();
