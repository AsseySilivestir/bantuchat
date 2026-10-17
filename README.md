# BantuChat

A **WhatsApp-style chat application** built entirely in **[Bantu](https://github.com/AsseySilivestir/Bantu) v1.4.0** —
using all three of its real-time socket layers: `sua.server` (HTTP/TCP),
`sua.ws` (WebSocket RFC 6455), and `sua.udp` (native UDP).

![Bantu v1.4.0](https://img.shields.io/badge/Bantu-v1.4.0-25D366?logo=data:image/svg+xml;base64,&style=flat)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

| # | Feature | How it's built |
|---|---|---|
| 1 | **1:1 + group chat** with speech-bubble UI, typing indicators, read receipts (✓✓ blue) | REST for history, `sua.ws` for live delivery |
| 2 | **Voice calls** (real-time) | WebRTC peer-to-peer; Bantu server is the signaling relay over `sua.ws` (offer/answer/ICE) |
| 3 | **Voice messages** (async voice notes) | Record in browser → upload → recipient plays; stored in SQLite |
| 4 | **UDP voice-frame relay** + **STUN discovery** | `sua.udp` server relays voice datagrams between Bantu CLI clients and queries `stun.l.google.com` to report its public IP for NAT hints |
| 5 | **Status sharing** (WhatsApp Status — ephemeral 24h posts) | Text/image posts, ring-of-avatars feed, view counts |
| 6 | **User profiles** | Name, avatar, about, phone — editable |
| 7 | **Settings** | Theme (light/dark), notification toggles |
| 8 | **Account** | Change password, logout, delete account |
| 9 | **Groups** | Create, add members, group chat with all the chat features |
| 10 | **Live code editor** with real-time sync | CodeMirror (CDN) + `sua.ws` edit/cursor broadcast — collaborative editing for multiple users |

## Architecture

```
                 ┌─────────────────────────────────────┐
                 │            BantuChat server.b       │
                 │  (single Bantu v1.4.0 process)      │
  Browser ──────►│  ┌─────────────────────────────┐    │
  (app.html)     │  │  sua.server  (HTTP/TCP)      │──── REST API + static files
   WS client  ◄──┤  │  sua.ws      (WebSocket)    │──── messages, presence, call signaling, code sync
   UDP (via      │  │  sua.udp     (UDP voice)    │──── voice-frame relay + STUN discovery
   WebRTC)       │  │  sua.sqlite  (persistence)  │    │
                 │  └─────────────────────────────┘    │
                 └─────────────────────────────────────┘
                              │
                              ▼
                        SQLite at /data/bantuchat.db (Render disk)
```

## Local dev

```bash
# 1. Install Bantu v1.4.0 (one-time)
git clone --depth 1 https://github.com/AsseySilivestir/Bantu.git
cd Bantu/bantu-src/compiler && bash build.sh
sudo cp build/bantu /usr/local/bin/bantu

# 2. Run BantuChat
cd bantuchat
PORT=8080 UDP_PORT=4120 DB_PATH=./bantuchat.db bantu run server.b

# 3. Open http://localhost:8080  → register → chat, call, code, status…
```

## Docker

```bash
docker build -t bantuchat .
docker run -p 8080:8080 -p 4120:4120/udp -e PORT=8080 -e UDP_PORT=4120 \
           -v bantuchat-data:/data bantuchat
```

## Deploy on Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → pick this repo → **Apply**.
3. Render reads `render.yaml`, provisions the Docker web service + 1 GB disk, and deploys.
4. Visit the Render URL → register → you're chatting.

The persistent disk at `/data` keeps your SQLite DB across deploys and free-tier reboots.

## Project layout

```
bantuchat/
├── server.b              # Backend: HTTP API + WS handlers + UDP voice relay + SQLite schema
├── public/
│   ├── index.html        # Login + register
│   ├── app.html          # Main shell (chats / groups / status / calls / editor tabs)
│   ├── css/style.css     # WhatsApp theme (teal/green, speech bubbles, read receipts)
│   └── js/
│       ├── app.js        # Auth + routing + WS client + presence
│       ├── chat.js       # Chat view (bubbles, voice notes, typing, read receipts)
│       ├── call.js       # Voice call (WebRTC over WS signaling)
│       ├── editor.js     # Live code editor (CodeMirror + WS sync)
│       ├── status.js     # Status feed (post + view, 24h ephemeral)
│       └── profile.js    # Profile + settings + account
├── Dockerfile            # Multi-stage Ubuntu 22.04 build (Bantu from source + run)
├── render.yaml           # Render.com blueprint (web service + 1 GB disk)
├── bantu.json            # Bantu project manifest
├── CONTRACT.md           # API + WS + UDP protocol spec
└── README.md             # this file
```

## Tech

- **Backend:** Bantu v1.4.0 (`sua.server` + `sua.ws` + `sua.udp` + `sua.sqlite` + `sua.fs`)
- **Frontend:** vanilla HTML/CSS/JS + CodeMirror (CDN, for the live editor)
- **Real-time voice:** WebRTC (browser P2P) + Bantu WS signaling + Bantu UDP relay for CLI clients
- **Persistence:** SQLite on a Render disk
- **License:** MIT
