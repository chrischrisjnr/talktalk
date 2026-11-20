# talktalk

Free, open source chat for your crew. Channels, direct messages, profiles, custom emoji you can draw or upload, and file sharing — in a bold, ink-on-paper interface.

No ads. No tracking. No accounts with anyone but you. Run it on your own computer or server and invite your friends.

## Features

- **Channels** anyone can create, with topics
- **Direct messages** between members (private to the two of you), plus a personal notes space
- **Profiles** with photo, status line and an "about" section
- **Emoji reactions** on any message
- **Custom emoji** — draw a 16×16 pixel emoji in the built-in studio, or upload any PNG / GIF / JPG / WEBP (animated GIFs work). Use them in messages as `:name:`
- **File sharing** — attach, paste or drag & drop any file (up to 25 MB by default). Images show inline
- **Real-time** — messages, reactions, typing indicators and online status update live
- Light & dark mode, works on phones

## Run it (5 minutes)

You need **Node.js 22.13 or newer** — download it from [nodejs.org](https://nodejs.org).

```bash
npm install
```

```bash
npm start
```

Then open **http://localhost:3000**, create an account and start chatting. Everything (accounts, messages, uploads) is saved in the `data/` folder — back that folder up to keep your history.

To let friends join, run it on a server (any small VPS works) and put it behind HTTPS.

## Settings

Set these as environment variables before `npm start`, if you want:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `MAX_FILE_MB` | `25` | Largest file people can share |
| `TALKTALK_DATA_DIR` | `./data` | Where the database and uploads are stored |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `TRUST_PROXY` | `false` | Set to `true` when running behind a reverse proxy (nginx, Caddy…) |

## Formatting

`*bold*` · `_italic_` · `` `code` `` · ` ```code block``` ` · `:emoji_name:` · `@username` · links are clickable.
Enter sends, Shift+Enter makes a new line.

## How it's built

Deliberately small and dependency-light so anyone can read and change it:

- `server/` — Node.js + Express + Socket.IO, with the built-in SQLite database (no database server to install)
- `public/` — plain HTML, CSS and JavaScript, no build step
- `test/` — run `npm test`

Security basics are covered: hashed passwords (scrypt), http-only session cookies, cross-site request blocking, a strict Content Security Policy, private DMs and DM files, and uploaded files that can't run code on the site.

## Typeface

**Aileron** by Dot Colon (CC0, via Fontsource) — used for everything, from the heavy capital headlines to the body text.

## License

MIT — free to use, change and share.
