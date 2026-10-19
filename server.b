// ═══════════════════════════════════════════════════════════════════
//  BantuChat — server.b  (Bantu v1.4.0)
//  A WhatsApp-style chat using all three Bantu socket layers:
//    • sua.server  (HTTP/TCP)  — REST API + static files
//    • sua.ws      (WebSocket) — real-time messaging, presence, call signaling, code sync
//    • sua.udp     (UDP)       — STUN discovery + voice-frame relay for Bantu CLI clients
//  Plus: sua.sqlite (persistence), sua.fs (uploads).
// ═══════════════════════════════════════════════════════════════════

// ─── Config ──────────────────────────────────────────────────────
$PORT = num(env("PORT"));
if ($PORT == 0) { $PORT = 8080; }
$UDP_PORT = num(env("UDP_PORT"));
if ($UDP_PORT == 0) { $UDP_PORT = 4120; }
$DB_PATH = env("DB_PATH");
if ($DB_PATH == "") { $DB_PATH = "./bantuchat.db"; }
$STARTED_AT = clock();
print("[bantuchat] boot  port=" + str($PORT) + "  udp=" + str($UDP_PORT) + "  db=" + $DB_PATH);

// ─── Database ────────────────────────────────────────────────────
$db = sua.sqlite;
$db.open($DB_PATH);
$db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, name TEXT, avatar TEXT, about TEXT, phone TEXT, token TEXT, last_seen INTEGER, created_at INTEGER)");
$db.exec("CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT, created_by INTEGER, created_at INTEGER)");
$db.exec("CREATE TABLE IF NOT EXISTS chat_members (chat_id INTEGER, user_id INTEGER, PRIMARY KEY(chat_id, user_id))");
$db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, sender_id INTEGER, body TEXT, kind TEXT, duration INTEGER, file_name TEXT, code_lang TEXT, status TEXT, created_at INTEGER)");
$db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id DESC)");
$db.exec("CREATE TABLE IF NOT EXISTS statuses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, body TEXT, kind TEXT, created_at INTEGER, expires_at INTEGER)");
$db.exec("CREATE TABLE IF NOT EXISTS status_views (status_id INTEGER, user_id INTEGER, PRIMARY KEY(status_id, user_id))");
$db.exec("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user_id INTEGER, to_user_id INTEGER, kind TEXT, started_at INTEGER, ended_at INTEGER, duration INTEGER, status TEXT)");
$db.exec("CREATE TABLE IF NOT EXISTS editor_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, language TEXT, content TEXT, created_by INTEGER, created_at INTEGER, updated INTEGER)");
$db.exec("CREATE TABLE IF NOT EXISTS editor_participants (session_id INTEGER, user_id INTEGER, joined_at INTEGER, PRIMARY KEY(session_id, user_id))");
print("[bantuchat] schema ready");

// ─── Global registries (mutable, shared across handlers via closure) ───
$wsByUser = {};      // userId(string) -> wsClientId
$userByWs = {};      // wsClientId     -> userId(string)
$udpByUser = {};     // userId(string) -> udpAddr (registered CLI clients)
$editorSessions = {}; // sessionId(string) -> {content, revision, participants:[userIds]}
$stunInfo = {"ok": false, "publicIp": "", "port": 0, "stunServer": "stun.l.google.com:19302", "ts": 0};

// ─── Helpers ─────────────────────────────────────────────────────

// 32-char hex token
def newToken() {
    $hex = "0123456789abcdef";
    $t = "";
    for $i in range(0, 32) {
        $t = $t + substr($hex, floor(random(16)), 1);
    }
    return $t;
}

// DEMO password store — salted but NOT cryptographically hashed (Bantu has no
// native ord() builtin; a real hash needs the hash.b/crypto.b stdlib modules).
// Swap for crypto.hash_password($pw) from crypto.b in production.
def hashPass($pw) {
    $salt = "bantuchat-v1.4.0$";
    return $salt + $pw + "$" + str(len($pw));
}

// SQL string escape (doubles single quotes)
def escStr($s) {
    if ($s == null) { return ""; }
    $out = "";
    $i = 0;
    while ($i < len($s)) {
        $c = substr($s, $i, 1);
        if ($c == "'") { $out = $out + "''"; } else { $out = $out + $c; }
        $i = $i + 1;
    }
    return $out;
}

// extract the bearer token from an Authorization header value
def extractToken($auth) {
    if ($auth == null) { return ""; }
    $auth = trim($auth);
    if (len($auth) > 6 && substr($auth, 0, 6) == "Bantu ") { return trim(substr($auth, 6, len($auth) - 6)); }
    if (len($auth) > 7 && substr($auth, 0, 7) == "Bearer ") { return trim(substr($auth, 7, len($auth) - 7)); }
    return $auth;
}

// look up the user from the request's Authorization header; returns the user row or null
def authUser($req) {
    $auth = "";
    if ($req.headers["authorization"] != null) { $auth = $req.headers["authorization"]; }
    if ($req.headers["Authorization"] != null) { $auth = $req.headers["Authorization"]; }
    $tok = extractToken($auth);
    if ($tok == "") { return null; }
    $rows = $db.query("SELECT * FROM users WHERE token = ?", [$tok]);
    if (len($rows) == 0) { return null; }
    return $rows[0];
}

// public user projection (no password / token)
def publicUser($row, $includeOnline) {
    if ($row == null) { return null; }
    $id = str($row.id);
    $online = false;
    if ($includeOnline) { $online = ($wsByUser[$id] != null); }
    $r = {
        "id": $row.id,
        "username": $row.username,
        "name": $row.name,
        "avatar": $row.avatar,
        "about": $row.about,
        "phone": $row.phone,
        "online": $online,
        "lastSeen": $row.last_seen
    };
    return $r;
}

// send a JSON object to a user's open WS connection (no-op if offline)
def sendToUser($userId, $obj) {
    $cid = $wsByUser[str($userId)];
    if ($cid == null) { return false; }
    $payload = json.stringify($obj);
    sua.ws.send($cid, $payload);
    return true;
}

// get all member userIds of a chat (DM or group)
def chatMembers($chatId) {
    $rows = $db.query("SELECT user_id FROM chat_members WHERE chat_id = ?", [$chatId]);
    $out = [];
    each ($r in $rows) { append($out, $r.user_id); }
    return $out;
}

// broadcast a JSON object to every online member of a chat
def broadcastToChat($chatId, $obj, $exceptUserId) {
    $members = chatMembers($chatId);
    each ($m in $members) {
        if (str($m) != str($exceptUserId)) { sendToUser($m, $obj); }
    }
}

def jsonError($res, $status, $msg) {
    $res.status($status);
    $res.json({"error": $msg});
}

def okJson($res, $obj) {
    $res.json($obj);
}

// ─── UDP: STUN discovery (one-shot at boot) + voice relay ────────

// byte XOR (pure Bantu — no native bitops needed)
def bxorByte($a, $b) {
    $r = 0; $m = 1;
    for $i in range(0, 8) {
        $ab = floor($a / $m) % 2;
        $bb = floor($b / $m) % 2;
        if ($ab != $bb) { $r = $r + $m; }
        $m = $m * 2;
    }
    return $r;
}

// query a public STUN server for our public IP/port (uses sua.udp one-shot send)
def stunQuery() {
    $server = "stun.l.google.com:19302";
    // STUN Binding Request: 0x0001 0x0000 + magic cookie 0x2112A442 + 12 random tx id
    $req = [0, 1, 0, 0, 33, 18, 164, 66];
    for $i in range(0, 12) { append($req, floor(random(256))); }
    try {
        $r = sua.udp.send($server, $req, {"timeoutMs": 2500});
        if ($r.timeout) { $stunInfo.ok = false; $stunInfo.error = "stun timeout"; return; }
        $data = $r.data;
        if (len($data) < 20) { $stunInfo.ok = false; $stunInfo.error = "short stun response"; return; }
        // verify magic cookie at offset 4-7 (0x21 0x12 0xA4 0x42)
        if (!($data[4] == 33 && $data[5] == 18 && $data[6] == 164 && $data[7] == 66)) {
            $stunInfo.ok = false; $stunInfo.error = "bad stun magic"; return;
        }
        // walk attributes from offset 20
        $i = 20;
        $found = false;
        while ($i + 4 <= len($data) && !$found) {
            $atype = $data[$i] * 256 + $data[$i+1];
            $alen = $data[$i+2] * 256 + $data[$i+3];
            $valStart = $i + 4;
            if ($atype == 32 && $alen >= 8 && $valStart + 8 <= len($data)) {
                // XOR-MAPPED-ADDRESS: family byte, port (2 bytes XOR 0x2112), ip (4 bytes XOR magic cookie)
                $fam = $data[$valStart + 1];
                if ($fam == 1) {
                    $port = (bxorByte($data[$valStart + 2], 33) * 256) + bxorByte($data[$valStart + 3], 18);
                    $ip1 = bxorByte($data[$valStart + 4], 33);
                    $ip2 = bxorByte($data[$valStart + 5], 18);
                    $ip3 = bxorByte($data[$valStart + 6], 164);
                    $ip4 = bxorByte($data[$valStart + 7], 66);
                    $stunInfo.ok = true;
                    $stunInfo.publicIp = str($ip1) + "." + str($ip2) + "." + str($ip3) + "." + str($ip4);
                    $stunInfo.port = $port;
                    $stunInfo.ts = clock();
                    $found = true;
                }
            }
            // advance past the attribute (4-byte aligned)
            $advance = 4 + $alen;
            while (($advance % 4) != 0) { $advance = $advance + 1; }
            $i = $i + $advance;
        }
        if (!$found) { $stunInfo.ok = false; $stunInfo.error = "no xor-mapped-address"; }
    } catch ($e) {
        $stunInfo.ok = false;
        $stunInfo.error = "stun failed: " + str($e);
    }
}
print("[bantuchat] running STUN discovery...");
stunQuery();
if ($stunInfo.ok) {
    print("[bantuchat] STUN ok  publicIp=" + $stunInfo.publicIp + ":" + str($stunInfo.port));
} else {
    print("[bantuchat] STUN unavailable (" + str($stunInfo.error) + ") — voice calls fall back to browser ICE");
}

// ─── WebSocket handlers ──────────────────────────────────────────

sua.ws.on("connect", def($c) {
    print("[ws] connect " + str($c.id));
});

sua.ws.on("disconnect", def($c) {
    $uid = $userByWs[$c.id];
    if ($uid != null) {
        $userByWs[$c.id] = null;
        $wsByUser[$uid] = null;
        $udpByUser[$uid] = null;
        // update last_seen
        $db.exec("UPDATE users SET last_seen = ? WHERE id = ?", [clock(), num($uid)]);
        // broadcast presence offline
        $obj = {"type": "presence", "userId": $uid, "online": false, "lastSeen": clock()};
        sua.ws.broadcast(json.stringify($obj));
        print("[ws] user " + $uid + " offline");
    }
});

sua.ws.on("message", def($m) {
    $clientId = $m.client;
    $data = $m.data;
    $msg = null;
    try { $msg = json.parse($data); } catch ($e) { return; }
    if ($msg == null) { return; }
    $t = $msg.type;
    if ($t == null) { return; }

    // ping/pong (no auth required)
    if ($t == "ping") {
        sua.ws.send($clientId, "{\"type\":\"pong\"}");
        return;
    }

    // auth
    if ($t == "auth") {
        $tok = $msg.token;
        $rows = $db.query("SELECT * FROM users WHERE token = ?", [$tok]);
        if (len($rows) == 0) {
            sua.ws.send($clientId, json.stringify({"type": "auth_error", "message": "invalid token"}));
            return;
        }
        $u = $rows[0];
        $uid = str($u.id);
        $userByWs[$clientId] = $uid;
        $wsByUser[$uid] = $clientId;
        // mark online + last_seen
        $db.exec("UPDATE users SET last_seen = ? WHERE id = ?", [clock(), $u.id]);
        sua.ws.send($clientId, json.stringify({"type": "auth_ok", "user": publicUser($u, true)}));
        // broadcast presence online
        $obj = {"type": "presence", "userId": $uid, "online": true, "lastSeen": clock()};
        sua.ws.broadcast(json.stringify($obj));
        print("[ws] user " + $uid + " (" + str($u.username) + ") online");
        return;
    }

    // every other message type requires auth
    $uid = $userByWs[$clientId];
    if ($uid == null) {
        sua.ws.send($clientId, json.stringify({"type": "error", "message": "not authenticated — send {type:auth, token} first"}));
        return;
    }

    // chat_message
    if ($t == "chat_message") {
        $chatId = num($msg.chatId);
        $body = $msg.body;
        if ($body == null) { $body = ""; }
        $kind = $msg.kind;
        if ($kind == null) { $kind = "text"; }
        $duration = $msg.duration;
        $fileName = $msg.fileName;
        $codeLang = $msg.codeLang;
        $now = clock();
        $db.exec("INSERT INTO messages(chat_id, sender_id, body, kind, duration, file_name, code_lang, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                 [$chatId, num($uid), $body, $kind, $duration, $fileName, $codeLang, "sent", $now]);
        $newRows = $db.query("SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 1", [$chatId, num($uid)]);
        $newId = $newRows[0].id;
        // build the message object + broadcast to chat members
        $uRows = $db.query("SELECT * FROM users WHERE id = ?", [num($uid)]);
        $out = {
            "type": "message",
            "message": {
                "id": $newId, "chatId": $chatId, "senderId": num($uid),
                "body": $body, "kind": $kind, "duration": $duration,
                "fileName": $fileName, "codeLang": $codeLang,
                "status": "sent", "createdAt": $now,
                "sender": publicUser($uRows[0], true)
            }
        };
        broadcastToChat($chatId, $out, $uid);
        // also echo back to the sender (so the tempId can be reconciled)
        $out.echo = true;
        $out.tempId = $msg.tempId;
        sendToUser($uid, $out);
        return;
    }

    // typing
    if ($t == "typing") {
        $chatId = $msg.chatId;
        $isTyping = $msg.isTyping;
        if ($isTyping == null) { $isTyping = true; }
        $obj = {"type": "typing", "chatId": $chatId, "userId": $uid, "isTyping": $isTyping};
        broadcastToChat(num($chatId), $obj, $uid);
        return;
    }

    // read
    if ($t == "read") {
        $chatId = num($msg.chatId);
        $db.exec("UPDATE messages SET status = 'read' WHERE chat_id = ? AND sender_id != ?", [$chatId, num($uid)]);
        $obj = {"type": "read", "chatId": $chatId, "userId": $uid};
        broadcastToChat($chatId, $obj, $uid);
        return;
    }

    // voice_frame (WS binary fallback — browsers usually use WebRTC, but this relays bytes)
    if ($t == "voice_frame") {
        $callId = $msg.callId;
        $bytes = $msg.bytes;
        $targetId = $msg.targetUserId;
        $obj = {"type": "voice_frame", "callId": $callId, "fromUserId": $uid, "bytes": $bytes};
        if ($targetId != null) { sendToUser($targetId, $obj); }
        return;
    }

    // call signaling relay: call_offer / call_answer / call_ice / call_end / call_reject
    if ($t == "call_offer" || $t == "call_answer" || $t == "call_ice" || $t == "call_end" || $t == "call_reject") {
        $peerId = $msg.peerId;
        $obj = {"type": $t, "callId": $msg.callId, "fromUserId": $uid};
        if ($msg.sdp != null) { $obj.sdp = $msg.sdp; }
        if ($msg.candidate != null) { $obj.candidate = $msg.candidate; }
        if ($msg.reason != null) { $obj.reason = $msg.reason; }
        if ($peerId != null) { sendToUser($peerId, $obj); }
        // persist call record on call_end
        if ($t == "call_end") {
            $now = clock();
            $db.exec("UPDATE calls SET ended_at = ?, status = 'ended' WHERE id = ?", [$now, num($msg.callId)]);
        }
        return;
    }

    // code_edit (live code editor)
    if ($t == "code_edit") {
        $sid = str($msg.sessionId);
        $sess = $editorSessions[$sid];
        if ($sess == null) {
            // load from DB
            $srows = $db.query("SELECT * FROM editor_sessions WHERE id = ?", [num($sid)]);
            if (len($srows) > 0) {
                $sess = {"content": $srows[0].content, "revision": 0, "participants": []};
                $editorSessions[$sid] = $sess;
            } else { return; }
        }
        $ops = $msg.ops;
        if ($ops != null) {
            // apply ops to local content (best-effort, append-only for insert; delete by char count)
            each ($op in $ops) {
                if ($op.type == "insert") {
                    $pos = num($op.pos);
                    $txt = $op.text;
                    if ($txt == null) { $txt = ""; }
                    $pre = substr($sess.content, 0, $pos);
                    $post = substr($sess.content, $pos, len($sess.content) - $pos);
                    $sess.content = $pre + $txt + $post;
                }
                if ($op.type == "delete") {
                    $pos = num($op.pos);
                    // The client sends `op.text` = the removed text
                    // (string). We delete by the LENGTH of that text so
                    // the server's cached content stays in sync with
                    // what clients have. The previous code read
                    // `op.count` (which was never sent) and defaulted
                    // to 1, causing the server's content to diverge
                    // from clients' content after the first delete —
                    // which broke live sync for any user who joined
                    // later and got the stale server content.
                    $cnt = 0;
                    if ($op.text != null) {
                        $cnt = len(str($op.text));
                    } else if ($op.count != null) {
                        $cnt = num($op.count);
                    }
                    if ($cnt == 0) { $cnt = 1; }
                    $pre = substr($sess.content, 0, $pos);
                    $post = substr($sess.content, $pos + $cnt, len($sess.content) - ($pos + $cnt));
                    $sess.content = $pre + $post;
                }
            }
            $sess.revision = $sess.revision + 1;
            // persist periodically (every 10th edit) to avoid DB thrash
            if (($sess.revision % 10) == 0) {
                $db.exec("UPDATE editor_sessions SET content = ?, updated = ? WHERE id = ?", [$sess.content, clock(), num($sid)]);
            }
            // broadcast to other participants
            $out = {"type": "code_edit", "sessionId": $sid, "userId": $uid, "revision": $sess.revision, "ops": $ops};
            each ($p in $sess.participants) {
                if (str($p) != str($uid)) { sendToUser($p, $out); }
            }
        }
        return;
    }

    // code_cursor
    if ($t == "code_cursor") {
        $sid = str($msg.sessionId);
        $out = {"type": "code_cursor", "sessionId": $sid, "userId": $uid, "pos": $msg.pos, "selectionEnd": $msg.selectionEnd};
        $sess = $editorSessions[$sid];
        if ($sess != null) {
            each ($p in $sess.participants) {
                if (str($p) != str($uid)) { sendToUser($p, $out); }
            }
        }
        return;
    }

    // status_view
    if ($t == "status_view") {
        $sid = num($msg.statusId);
        $db.exec("INSERT OR IGNORE INTO status_views(status_id, user_id) VALUES(?, ?)", [$sid, num($uid)]);
        return;
    }

    // unknown
    print("[ws] unknown type: " + str($t));
});

// ─── HTTP routes ─────────────────────────────────────────────────

// CORS preflight + default CORS headers on every response
sua.server.options("/*", def($req, $res) {
    $res.status(204);
    $res.send("");
});

// health
sua.server.get("/api/health", def($req, $res) {
    $res.json({
        "ok": true,
        "version": "1.4.0",
        "app": "BantuChat",
        "uptime": clock() - $STARTED_AT,
        "features": ["chat", "voice_call", "voice_messages", "status", "groups", "live_editor", "profile", "settings", "account"],
        "sockets": ["http", "ws", "udp"],
        "stun": $stunInfo
    });
});

// ── auth ──
sua.server.post("/api/auth/register", def($req, $res) {
    $u = $req.body.username;
    $p = $req.body.password;
    $name = $req.body.name;
    if ($u == null || $p == null || $u == "" || $p == "") {
        jsonError($res, 400, "username and password required"); return;
    }
    if ($name == null || $name == "") { $name = $u; }
    $existing = $db.query("SELECT id FROM users WHERE username = ?", [$u]);
    if (len($existing) > 0) { jsonError($res, 409, "username taken"); return; }
    $tok = newToken();
    $db.exec("INSERT INTO users(username, password, name, avatar, about, phone, token, last_seen, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
             [$u, hashPass($p), $name, "", "Hey there! I'm on BantuChat.", "", $tok, clock(), clock()]);
    $uRows = $db.query("SELECT * FROM users WHERE username = ?", [$u]);
    $row = $uRows[0];
    $res.status(201);
    $res.json({"token": $tok, "user": publicUser($row, true)});
});

sua.server.post("/api/auth/login", def($req, $res) {
    $u = $req.body.username;
    $p = $req.body.password;
    if ($u == null || $p == null) { jsonError($res, 400, "username and password required"); return; }
    $rows = $db.query("SELECT * FROM users WHERE username = ? AND password = ?", [$u, hashPass($p)]);
    if (len($rows) == 0) { jsonError($res, 401, "invalid credentials"); return; }
    $row = $rows[0];
    $tok = newToken();
    $db.exec("UPDATE users SET token = ?, last_seen = ? WHERE id = ?", [$tok, clock(), $row.id]);
    $row.token = $tok;
    $res.json({"token": $tok, "user": publicUser($row, true)});
});

sua.server.get("/api/auth/me", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $res.json({"user": publicUser($u, true)});
});

// ── users ──
sua.server.get("/api/users", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $q = $req.query.q;
    if ($q == null) { $q = ""; }
    $qpat = "%" + $q + "%";
    $rows = $db.query("SELECT * FROM users WHERE (username LIKE ? OR name LIKE ?) AND id != ? ORDER BY name LIMIT 50", [$qpat, $qpat, $u.id]);
    $out = [];
    each ($r in $rows) { append($out, publicUser($r, true)); }
    $res.json($out);
});

sua.server.get("/api/users/:id", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $rows = $db.query("SELECT * FROM users WHERE id = ?", [num($req.params.id)]);
    if (len($rows) == 0) { jsonError($res, 404, "user not found"); return; }
    $res.json(publicUser($rows[0], true));
});

// ── profile ──
sua.server.put("/api/profile", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $name = $req.body.name; if ($name == null) { $name = $u.name; }
    $about = $req.body.about; if ($about == null) { $about = $u.about; }
    $avatar = $req.body.avatar; if ($avatar == null) { $avatar = $u.avatar; }
    $phone = $req.body.phone; if ($phone == null) { $phone = $u.phone; }
    $db.exec("UPDATE users SET name=?, about=?, avatar=?, phone=? WHERE id=?", [$name, $about, $avatar, $phone, $u.id]);
    $row = $db.query("SELECT * FROM users WHERE id = ?", [$u.id])[0];
    $res.json({"user": publicUser($row, true)});
});

// ── account ──
sua.server.put("/api/account/password", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $old = $req.body.old;
    $new = $req.body.new;
    if ($old == null || $new == null) { jsonError($res, 400, "old and new required"); return; }
    if (hashPass($old) != $u.password) { jsonError($res, 403, "old password wrong"); return; }
    $db.exec("UPDATE users SET password=? WHERE id=?", [hashPass($new), $u.id]);
    $res.json({"ok": true});
});

sua.server.delete("/api/account", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $db.exec("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE type='dm' AND id IN (SELECT chat_id FROM chat_members WHERE user_id=?))", [$u.id]);
    $db.exec("DELETE FROM chat_members WHERE user_id=?", [$u.id]);
    $db.exec("DELETE FROM status_views WHERE user_id=?", [$u.id]);
    $db.exec("DELETE FROM statuses WHERE user_id=?", [$u.id]);
    $db.exec("DELETE FROM calls WHERE from_user_id=? OR to_user_id=?", [$u.id, $u.id]);
    $db.exec("DELETE FROM users WHERE id=?", [$u.id]);
    $res.json({"ok": true});
});

// ── chats & messages ──
// ensure a DM chat exists between two users; returns the chatId
def ensureDM($uidA, $uidB) {
    // find an existing DM with both users
    $rows = $db.query("SELECT c.id FROM chats c WHERE c.type='dm' AND c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?) AND c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?)", [$uidA, $uidB]);
    if (len($rows) > 0) { return $rows[0].id; }
    $db.exec("INSERT INTO chats(type, name, created_by, created_at) VALUES('dm', null, ?, ?)", [$uidA, clock()]);
    $cidRows = $db.query("SELECT id FROM chats WHERE type='dm' AND created_by = ? ORDER BY id DESC LIMIT 1", [$uidA]);
    $cid = $cidRows[0].id;
    $db.exec("INSERT INTO chat_members(chat_id, user_id) VALUES(?, ?)", [$cid, $uidA]);
    $db.exec("INSERT INTO chat_members(chat_id, user_id) VALUES(?, ?)", [$cid, $uidB]);
    return $cid;
}

sua.server.get("/api/chats", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $chats = $db.query("SELECT c.* FROM chats c WHERE c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?) ORDER BY c.id DESC", [$u.id]);
    $out = [];
    each ($c in $chats) {
        $peerRow = null;
        if ($c.type == "dm") {
            // find the other member
            $members = $db.query("SELECT user_id FROM chat_members WHERE chat_id=? AND user_id != ?", [$c.id, $u.id]);
            if (len($members) == 0) { continue; }
            $peerRow = $db.query("SELECT * FROM users WHERE id=?", [$members[0].user_id])[0];
        }
        $lastRows = $db.query("SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1", [$c.id]);
        $last = null; $lastAt = 0;
        if (len($lastRows) > 0) { $last = $lastRows[0]; $lastAt = $last.created_at; }
        $unreadRows = $db.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND sender_id != ? AND status != 'read'", [$c.id, $u.id]);
        $unread = $unreadRows[0].n;
        $entry = {
            "id": $c.id, "type": $c.type, "name": $c.name,
            "peer": publicUser($peerRow, true),
            "lastMessage": $last,
            "unread": $unread,
            "lastSeenAt": $lastAt
        };
        append($out, $entry);
    }
    $res.json($out);
});

sua.server.get("/api/messages/:chatId", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $cid = num($req.params.chatId);
    $before = $req.query.before;
    $limit = 50;
    $rows = [];
    if ($before != null) {
        $rows = $db.query("SELECT * FROM messages WHERE chat_id=? AND id < ? ORDER BY id DESC LIMIT ?", [$cid, num($before), $limit]);
    } else {
        $rows = $db.query("SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?", [$cid, $limit]);
    }
    // reverse to chronological + attach sender
    $out = [];
    $rev = reverse($rows);
    each ($r in $rev) {
        $uRows = $db.query("SELECT * FROM users WHERE id=?", [$r.sender_id]);
        $d = {
            "id": $r.id, "chatId": $r.chat_id, "senderId": $r.sender_id,
            "body": $r.body, "kind": $r.kind, "duration": $r.duration,
            "fileName": $r.file_name, "codeLang": $r.code_lang,
            "status": $r.status, "createdAt": $r.created_at,
            "sender": publicUser($uRows[0], true)
        };
        append($out, $d);
    }
    $res.json($out);
});

sua.server.post("/api/messages", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $chatId = $req.body.chatId;
    $peerId = $req.body.peerId;     // optional — auto-create DM if chatId==0 and peerId set
    if (($chatId == null || num($chatId) == 0) && $peerId != null) {
        $chatId = ensureDM($u.id, num($peerId));
    }
    if ($chatId == null) { jsonError($res, 400, "chatId or peerId required"); return; }
    $chatId = num($chatId);
    $body = $req.body.body; if ($body == null) { $body = ""; }
    $kind = $req.body.kind; if ($kind == null) { $kind = "text"; }
    $duration = $req.body.duration;
    $fileName = $req.body.fileName;
    $codeLang = $req.body.codeLang;
    $now = clock();
    $db.exec("INSERT INTO messages(chat_id, sender_id, body, kind, duration, file_name, code_lang, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
             [$chatId, $u.id, $body, $kind, $duration, $fileName, $codeLang, "sent", $now]);
    $newRows = $db.query("SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 1", [$chatId, $u.id]);
    $newId = $newRows[0].id;
    // broadcast via WS to all chat members
    $out = {
        "type": "message",
        "message": {
            "id": $newId, "chatId": $chatId, "senderId": $u.id,
            "body": $body, "kind": $kind, "duration": $duration,
            "fileName": $fileName, "codeLang": $codeLang,
            "status": "sent", "createdAt": $now,
            "sender": publicUser($u, true)
        }
    };
    broadcastToChat($chatId, $out, $u.id);
    $res.status(201);
    $res.json({"message": $out.message});
});

// ── groups ──
sua.server.post("/api/groups", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $name = $req.body.name;
    $members = $req.body.memberIds;
    if ($name == null || $members == null) { jsonError($res, 400, "name and memberIds required"); return; }
    $db.exec("INSERT INTO chats(type, name, created_by, created_at) VALUES('group', ?, ?, ?)", [$name, $u.id, clock()]);
    $gidRows = $db.query("SELECT id FROM chats WHERE type='group' AND name = ? AND created_by = ? ORDER BY id DESC LIMIT 1", [$name, $u.id]);
    $gid = $gidRows[0].id;
    $db.exec("INSERT INTO chat_members(chat_id, user_id) VALUES(?, ?)", [$gid, $u.id]);
    each ($mid in $members) {
        if (num($mid) != $u.id) {
            $db.exec("INSERT OR IGNORE INTO chat_members(chat_id, user_id) VALUES(?, ?)", [$gid, num($mid)]);
        }
    }
    $res.status(201);
    $res.json({"group": {"id": $gid, "name": $name, "createdBy": $u.id, "createdAt": clock()}});
});

sua.server.get("/api/groups", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $groups = $db.query("SELECT c.* FROM chats c WHERE c.type='group' AND c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?) ORDER BY c.id DESC", [$u.id]);
    $out = [];
    each ($g in $groups) {
        $mrows = $db.query("SELECT user_id FROM chat_members WHERE chat_id=?", [$g.id]);
        $mems = [];
        each ($mr in $mrows) {
            $ur = $db.query("SELECT * FROM users WHERE id=?", [$mr.user_id])[0];
            append($mems, publicUser($ur, true));
        }
        $lastRows = $db.query("SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1", [$g.id]);
        $last = null;
        if (len($lastRows) > 0) { $last = $lastRows[0]; }
        append($out, {"id": $g.id, "name": $g.name, "members": $mems, "lastMessage": $last, "createdAt": $g.created_at});
    }
    $res.json($out);
});

sua.server.get("/api/groups/:id/messages", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $gid = num($req.params.id);
    $rows = $db.query("SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?", [$gid, 50]);
    $out = [];
    each ($r in reverse($rows)) {
        $uRows = $db.query("SELECT * FROM users WHERE id=?", [$r.sender_id]);
        append($out, {
            "id": $r.id, "chatId": $r.chat_id, "senderId": $r.sender_id,
            "body": $r.body, "kind": $r.kind, "duration": $r.duration,
            "fileName": $r.file_name, "codeLang": $r.code_lang,
            "status": $r.status, "createdAt": $r.created_at,
            "sender": publicUser($uRows[0], true)
        });
    }
    $res.json($out);
});

sua.server.post("/api/groups/:id/members", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $gid = num($req.params.id);
    $uid = num($req.body.userId);
    $db.exec("INSERT OR IGNORE INTO chat_members(chat_id, user_id) VALUES(?, ?)", [$gid, $uid]);
    $res.json({"ok": true});
});

// ── status ──
sua.server.get("/api/status", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $cutoff = clock() - 86400000; // 24h
    $rows = $db.query("SELECT * FROM statuses WHERE expires_at > ? ORDER BY id DESC LIMIT 100", [$cutoff]);
    $out = [];
    each ($s in $rows) {
        $uRows = $db.query("SELECT * FROM users WHERE id=?", [$s.user_id]);
        $viewed = $db.query("SELECT 1 FROM status_views WHERE status_id=? AND user_id=?", [$s.id, $u.id]);
        $viewRows = $db.query("SELECT user_id FROM status_views WHERE status_id=?", [$s.id]);
        $viewers = [];
        each ($v in $viewRows) { append($viewers, $v.user_id); }
        append($out, {
            "id": $s.id, "userId": $s.user_id, "body": $s.body, "kind": $s.kind,
            "createdAt": $s.created_at, "expiresAt": $s.expires_at,
            "author": publicUser($uRows[0], true),
            "viewed": len($viewed) > 0,
            "views": $viewers
        });
    }
    $res.json($out);
});

sua.server.post("/api/status", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $body = $req.body.body;
    $kind = $req.body.kind; if ($kind == null) { $kind = "text"; }
    if ($body == null) { jsonError($res, 400, "body required"); return; }
    $now = clock();
    $exp = $now + 86400000;
    $db.exec("INSERT INTO statuses(user_id, body, kind, created_at, expires_at) VALUES(?,?,?,?,?)", [$u.id, $body, $kind, $now, $exp]);
    $sidRows = $db.query("SELECT id FROM statuses WHERE user_id = ? ORDER BY id DESC LIMIT 1", [$u.id]);
    $sid = $sidRows[0].id;
    $status = {"id": $sid, "userId": $u.id, "body": $body, "kind": $kind, "createdAt": $now, "expiresAt": $exp, "author": publicUser($u, true), "viewed": false, "views": []};
    // broadcast to all online users
    $obj = {"type": "status_new", "status": $status};
    sua.ws.broadcast(json.stringify($obj));
    $res.status(201);
    $res.json({"status": $status});
});

sua.server.post("/api/status/:id/view", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $sid = num($req.params.id);
    $db.exec("INSERT OR IGNORE INTO status_views(status_id, user_id) VALUES(?, ?)", [$sid, $u.id]);
    $res.json({"ok": true});
});

// ── calls ──
sua.server.get("/api/calls", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $rows = $db.query("SELECT * FROM calls WHERE from_user_id=? OR to_user_id=? ORDER BY id DESC LIMIT 50", [$u.id, $u.id]);
    $out = [];
    each ($c in $rows) {
        append($out, {
            "id": $c.id, "fromUserId": $c.from_user_id, "toUserId": $c.to_user_id,
            "kind": $c.kind, "startedAt": $c.started_at, "endedAt": $c.ended_at,
            "duration": $c.duration, "status": $c.status
        });
    }
    $res.json($out);
});

sua.server.post("/api/call/start", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $peerId = num($req.body.peerId);
    $kind = $req.body.kind; if ($kind == null) { $kind = "voice"; }
    $now = clock();
    $db.exec("INSERT INTO calls(from_user_id, to_user_id, kind, started_at, status) VALUES(?,?,?,?,?)", [$u.id, $peerId, $kind, $now, "ringing"]);
    $cidRows = $db.query("SELECT id FROM calls WHERE from_user_id = ? AND to_user_id = ? ORDER BY id DESC LIMIT 1", [$u.id, $peerId]);
    $callId = $cidRows[0].id;
    // notify the peer via WS
    $obj = {"type": "call_incoming", "callId": $callId, "fromUserId": str($u.id), "kind": $kind};
    sendToUser(str($peerId), $obj);
    $res.status(201);
    $res.json({"callId": $callId, "fromUserId": str($u.id), "toUserId": str($peerId), "kind": $kind});
});

// ── editor sessions ──
sua.server.get("/api/editor/sessions", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $rows = $db.query("SELECT * FROM editor_sessions ORDER BY id DESC LIMIT 50");
    $out = [];
    each ($s in $rows) {
        $prows = $db.query("SELECT user_id FROM editor_participants WHERE session_id=?", [$s.id]);
        $mems = [];
        each ($p in $prows) {
            $ur = $db.query("SELECT * FROM users WHERE id=?", [$p.user_id])[0];
            append($mems, publicUser($ur, true));
        }
        append($out, {"id": $s.id, "name": $s.name, "language": $s.language, "content": $s.content, "participants": $mems});
    }
    $res.json($out);
});

sua.server.post("/api/editor/sessions", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $name = $req.body.name; if ($name == null) { $name = "untitled"; }
    $language = $req.body.language; if ($language == null) { $language = "text"; }
    $now = clock();
    $db.exec("INSERT INTO editor_sessions(name, language, content, created_by, created_at, updated) VALUES(?,?,?,?,?,?)", [$name, $language, "", $u.id, $now, $now]);
    $sidRows = $db.query("SELECT id FROM editor_sessions WHERE name = ? AND created_by = ? ORDER BY id DESC LIMIT 1", [$name, $u.id]);
    $sid = $sidRows[0].id;
    $db.exec("INSERT OR IGNORE INTO editor_participants(session_id, user_id, joined_at) VALUES(?,?,?)", [$sid, $u.id, $now]);
    $res.status(201);
    $res.json({"session": {"id": $sid, "name": $name, "language": $language, "content": ""}});
});

sua.server.get("/api/editor/sessions/:id", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $sid = num($req.params.id);
    $rows = $db.query("SELECT * FROM editor_sessions WHERE id=?", [$sid]);
    if (len($rows) == 0) { jsonError($res, 404, "session not found"); return; }
    $s = $rows[0];
    $db.exec("INSERT OR IGNORE INTO editor_participants(session_id, user_id, joined_at) VALUES(?,?,?)", [$sid, $u.id, clock()]);
    $prows = $db.query("SELECT user_id FROM editor_participants WHERE session_id=?", [$sid]);
    $mems = [];
    each ($p in $prows) {
        $ur = $db.query("SELECT * FROM users WHERE id=?", [$p.user_id])[0];
        append($mems, publicUser($ur, true));
    }
    // register in the in-memory session (for live sync)
    $key = str($sid);
    $sess = $editorSessions[$key];
    if ($sess == null) {
        $sess = {"content": $s.content, "revision": 0, "participants": []};
        $editorSessions[$key] = $sess;
    }
    // ensure the user is in the participant list
    $found = false;
    each ($p in $sess.participants) { if (str($p) == str($u.id)) { $found = true; } }
    if (!$found) { append($sess.participants, str($u.id)); }
    $res.json({"session": {"id": $s.id, "name": $s.name, "language": $s.language, "content": $sess.content}, "participants": $mems});
});

sua.server.put("/api/editor/sessions/:id", def($req, $res) {
    $u = authUser($req);
    if ($u == null) { jsonError($res, 401, "not authenticated"); return; }
    $sid = num($req.params.id);
    $content = $req.body.content;
    if ($content == null) { jsonError($res, 400, "content required"); return; }
    $db.exec("UPDATE editor_sessions SET content=?, updated=? WHERE id=?", [$content, clock(), $sid]);
    // update in-memory
    $key = str($sid);
    $sess = $editorSessions[$key];
    if ($sess != null) { $sess.content = $content; }
    $res.json({"ok": true});
});

// ── stun info ──
sua.server.get("/api/stun-info", def($req, $res) {
    $res.json($stunInfo);
});

// ─── Static files + entry routes ─────────────────────────────────
sua.server.static("./public");

// explicit entry routes (static serving maps / -> index.html, /app -> app.html)
sua.server.get("/", def($req, $res) {
    $res.type("text/html");
    $res.send(readfile("./public/index.html"));
});
sua.server.get("/app", def($req, $res) {
    $res.type("text/html");
    $res.send(readfile("./public/app.html"));
});

// ─── Start ───────────────────────────────────────────────────────
print("[bantuchat] listening on http://0.0.0.0:" + str($PORT));
print("[bantuchat] features: chat | voice_call | voice_messages | status | groups | live_editor | profile | settings | account");
sua.server.listen($PORT);
