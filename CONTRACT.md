# BantuChat — API & Protocol Contract

A WhatsApp-style chat app built in **Bantu v1.4.0**. Uses all three socket layers:
- **`sua.server`** (HTTP/TCP) — REST API + serving the frontend
- **`sua.ws`** (WebSocket RFC 6455) — real-time messaging, presence, call signaling, live code sync
- **`sua.udp`** (native UDP) — voice-frame relay + STUN discovery (NAT public-IP reporting)

## Base URL & static files
- Frontend served from `./public` via `sua.server.static("./public")`
- `GET /` → `public/index.html` (login/register)
- `GET /app` → `public/app.html` (main app shell, all views)
- All API routes under `/api/*`

## Auth
- Bearer token in `Authorization: Bantu <token>` header (or `Authorization: Bearer <token>`)
- Token = 32-char hex, stored in `users.token`
- WS auth: first message must be `{"type":"auth","token":"..."}`

## REST API (JSON in/out)

### Public
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, version, features, uptime, sockets}` |
| POST | `/api/auth/register` | `{username, password, name}` | `{token, user:{id,username,name,avatar,about,phone}}` |
| POST | `/api/auth/login` | `{username, password}` | `{token, user}` |

### Auth required (Bearer token)
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/auth/me` | — | `{user}` |
| GET | `/api/users` | `?q=` (search by name/username) | `[{id,username,name,avatar,about}]` |
| GET | `/api/users/:id` | — | `{id,username,name,avatar,about,phone,lastSeen,online}` |
| PUT | `/api/profile` | `{name?, about?, avatar?, phone?}` | `{user}` |
| PUT | `/api/account/password` | `{old, new}` | `{ok}` |
| DELETE | `/api/account` | — | `{ok}` (deletes account + its messages) |
| GET | `/api/chats` | — | `[{id, type:"dm"\|"group", name?, peer:{id,name,avatar,online,lastSeen}, lastMessage, unread, lastSeenAt}]` |
| GET | `/api/messages/:chatId` | `?before=<msgId>&limit=50` | `[{id, chatId, senderId, body, kind:"text"\|"voice"\|"code"\|"image", duration?, fileName?, codeLang?, createdAt, status:"sent"\|"delivered"\|"read"}]` |
| POST | `/api/messages` | `{chatId, body, kind, duration?, fileName?, codeLang?}` | `{message}` (also broadcast via WS) |
| POST | `/api/groups` | `{name, memberIds:[...]}` | `{group:{id,name,members:[...],createdBy,createdAt}}` |
| GET | `/api/groups` | — | `[{id,name,members:[{id,name,avatar}],lastMessage}]` |
| GET | `/api/groups/:id/messages` | `?before=&limit=` | `[messages]` |
| POST | `/api/groups/:id/members` | `{userId}` | `{ok}` |
| GET | `/api/status` | — | `[{id,userId,body,kind,createdAt,author:{id,name,avatar},viewed,views}]` |
| POST | `/api/status` | `{body, kind:"text"\|"image"}` | `{status}` |
| POST | `/api/status/:id/view` | — | `{ok}` |
| GET | `/api/calls` | — | `[{id,fromUserId,toUserId,kind:"voice"\|"video",startedAt,endedAt,duration,status}]` |
| POST | `/api/call/start` | `{peerId, kind:"voice"}` | `{callId, fromUserId, toUserId, kind}` (signaling over WS) |
| GET | `/api/editor/sessions` | — | `[{id,name,language,content,participants:[{id,name}]}]` |
| POST | `/api/editor/sessions` | `{name, language}` | `{session:{id,name,language,content:""}}` |
| GET | `/api/editor/sessions/:id` | — | `{session, content, participants}` |
| PUT | `/api/editor/sessions/:id` | `{content}` | `{ok}` (persisted; live edits go via WS) |
| GET | `/api/stun-info` | — | `{publicIp, stunServer, port}` (server reports its public IP via sua.udp STUN binding) |

## WebSocket (`sua.ws`) message types (JSON frames)

### Client → Server
| type | fields | behavior |
|---|---|---|
| `auth` | `token` | authenticate the WS connection; bind to user |
| `chat_message` | `chatId, body, kind, tempId, duration?, fileName?, codeLang?` | persist + broadcast to chat participants |
| `typing` | `chatId, isTyping` | relay typing indicator to the chat peer |
| `read` | `chatId` | mark messages read, notify peer |
| `voice_frame` | `callId, bytes:[0-255,...]` (binary-capable) | relay voice bytes to the other call participant |
| `call_offer` | `callId, peerId, sdp` | relay WebRTC offer |
| `call_answer` | `callId, peerId, sdp` | relay WebRTC answer |
| `call_ice` | `callId, peerId, candidate` | relay ICE candidate |
| `call_end` | `callId` | end call, notify peer |
| `call_reject` | `callId` | reject incoming call |
| `code_edit` | `sessionId, revision, ops:[{type:"insert"\|"delete", pos, text?}]` | apply + broadcast to session participants |
| `code_cursor` | `sessionId, pos, selectionEnd` | broadcast cursor position |
| `status_view` | `statusId` | mark status viewed |
| `ping` | — | server replies `{type:"pong"}` |

### Server → Client
| type | fields |
|---|---|
| `auth_ok` | `user:{id,username,name,avatar}` |
| `auth_error` | `message` |
| `message` | `message:{id,chatId,senderId,body,kind,...}` |
| `typing` | `chatId, userId, isTyping` |
| `read` | `chatId, userId` |
| `presence` | `userId, online, lastSeen` |
| `voice_frame` | `callId, fromUserId, bytes:[...]` |
| `call_incoming` | `callId, fromUserId, kind:"voice"` |
| `call_offer` | `callId, fromUserId, sdp` |
| `call_answer` | `callId, fromUserId, sdp` |
| `call_ice` | `callId, fromUserId, candidate` |
| `call_end` | `callId, fromUserId, reason:"ended"\|"rejected"\|"missed"` |
| `code_edit` | `sessionId, userId, revision, ops` |
| `code_cursor` | `sessionId, userId, pos, selectionEnd` |
| `status_new` | `status:{...}` |
| `pong` | — |
| `error` | `message` |

## UDP voice relay (`sua.udp`)
Server binds a UDP socket on `0.0.0.0:<UDP_PORT>` (default 4120). Datagrams are text-framed JSON for interop (browsers can't speak raw UDP; this path is for Bantu CLI clients + a server-side STUN query):

- **STUN discovery (server → STUN server, on startup):** `sua.udp.send("stun.l.google.com:19302", <20-byte STUN binding request>)` → parse the XOR-MAPPED-ADDRESS for the server's public IP. Exposed at `GET /api/stun-info` so clients can hint WebRTC ICE.
- **Voice relay (Bantu CLI client → server → other Bantu CLI client):** datagram = JSON `{"t":"voice","callId":"...","from":"<userId>","b":"<base64 opus/pcm>"}`. Server looks up the call's other participant and `send_to`s the datagram to their UDP address (registered via a prior `{"t":"register","userId":"..."}` datagram). Browser clients use the WS binary `voice_frame` path instead (WebRTC handles browser-to-browser UDP).

## Data model (SQLite via `sua.sqlite`)
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT, avatar TEXT, about TEXT, phone TEXT,
  token TEXT, last_seen INTEGER, created_at INTEGER
);
CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- 'dm' | 'group'
  name TEXT,                     -- group name (NULL for dm)
  created_by INTEGER, created_at INTEGER
);
CREATE TABLE chat_members (
  chat_id INTEGER, user_id INTEGER,
  PRIMARY KEY(chat_id, user_id)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER, sender_id INTEGER,
  body TEXT, kind TEXT,          -- 'text' | 'voice' | 'code' | 'image'
  duration INTEGER, file_name TEXT, code_lang TEXT,
  status TEXT,                   -- 'sent' | 'delivered' | 'read'
  created_at INTEGER
);
CREATE TABLE statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, body TEXT, kind TEXT,
  created_at INTEGER, expires_at INTEGER
);
CREATE TABLE status_views (
  status_id INTEGER, user_id INTEGER,
  PRIMARY KEY(status_id, user_id)
);
CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER, to_user_id INTEGER,
  kind TEXT, started_at INTEGER, ended_at INTEGER,
  duration INTEGER, status TEXT
);
CREATE TABLE editor_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, language TEXT, content TEXT,
  created_by INTEGER, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE editor_participants (
  session_id INTEGER, user_id INTEGER, joined_at INTEGER,
  PRIMARY KEY(session_id, user_id)
);
```

## Frontend pages (served from `./public`)
- `index.html` — login + register tabs, WhatsApp-style green hero
- `app.html` — main shell: sidebar (chats/groups/status/calls/editor tabs) + main pane
- `css/style.css` — WhatsApp theme: #075E54 (dark teal), #128C7E (teal), #25D366 (green accent), #DCF8C6 (outgoing bubble), #fff (incoming bubble), #e5ddd5 (chat bg), speech-bubble tails, checkmark read receipts (✓✓ blue)
- `js/app.js` — auth + routing + WS client + REST helper + presence
- `js/chat.js` — chat view: speech bubbles, voice messages (record/play), typing indicator, read receipts, emoji
- `js/call.js` — voice call: WebRTC getUserAudio, offer/answer/ICE over WS, call timer, mute/hangup
- `js/editor.js` — live code editor: CodeMirror (CDN), sync edits over WS, show other users' cursors
- `js/status.js` — status feed: post text/image, view contacts' statuses (ephemeral 24h), ring of avatars
- `js/profile.js` — profile edit, settings (theme/notifications toggles), account (change password, logout, delete)

## Bantu v1.4.0 API reference (for backend author)
- `sua.server.get/post/put/delete(path, def($req,$res){...})` — register route
- `sua.server.static("./public")` — serve static files
- `sua.server.listen(port)` — start HTTP+WS server
- `sua.server.options("/*", handler)` — CORS preflight
- `$req.body` — parsed JSON (or form), `$req.params.id`, `$req.query`, `$req.headers`
- `$res.json({...})`, `$res.status(201)`, `$res.send("text")`, `$res.status(401).json({error:"..."})`
- `sua.ws.on("connect", def($c){...})`, `sua.ws.on("message", def($m){...})`, `sua.ws.on("disconnect", def($c){...})`
- `sua.ws.send(clientId, textData)`, `sua.ws.broadcast(textData)`, `sua.ws.send_binary(clientId, byteList)`, `sua.ws.broadcast_binary(byteList)`, `sua.ws.clients()` → list of ids
- `sua.udp.socket({"family":"ipv4"})`, `sua.udp.bind(sock, "0.0.0.0:4120")`, `sua.udp.recvfrom(sock, {"timeoutMs":...})`, `sua.udp.send_to(sock, addr, byteList)`, `sua.udp.send(addr, byteList, opts)` (one-shot)
- `sua.sqlite.connect("path")`, `sua.sqlite.exec(sql, [params])`, `sua.sqlite.query(sql, [params])`
- `sua.fs.mkdirp(dir)`, `sua.fs.writefile(path, data)`, `sua.fs.readfile(path)` — for uploads
- `format(fmt, args...)` — string formatting
- `len(x)`, `str(x)`, `num(x)`, `split(s, sep)`, `substr(s, start, len)`, `clock()`, `random(n)`, `chr(n)`, `keys(d)`, `values(d)`, `append(l, x)`, `sort(l)`, `reverse(l)`
- `print(x)` — log to stdout
- `include "./file.b" as ns;` — modular include (direct: `include "./file.b";`)
- `def name(params) { ... return x; }` — function; `def($a,$b){...}` — anonymous
- `class Name extends Parent { ... }` — OOP
- `try { ... } catch ($e) { ... }` — `$e` is `{message,type,line}` or thrown value
- `if (c) { } else if (c) { } else { }`, `while (c) { }`, `for $x in $list { }`, `each ($k,$v in $dict) { }`, `switch ($v) { case X { } default { } }`
- `throw {code:42, msg:"..."}`; `const $X = ...`
- Dict: `{"k": v}`, list: `[1,2,3]`; `$d.k` or `$d["k"]`; `$l[0]` or `$l.size()`
- `$env = env("PORT")` — get env var; `$env = "8080"` fallback via `num($env)`
