/* =====================================================================
 * BantuChat — app.js
 * Auth bootstrap • REST helper • WebSocket client • SPA router
 * • Presence tracking • Toasts • Modal • Emoji picker
 *
 * Loaded as a plain (non-module) script.
 * Exposes:  window.App  (global)
 * Other modules (Chat, Call, Editor, Status, Profile) attach handlers via:
 *   App.registerWSHandler(type, fn)
 *   App.registerView(name, { enter(listTarget, paneTarget), leave() })
 * ===================================================================== */
(function () {
  'use strict';

  const TOKEN_KEY = 'bantu_token';
  const USER_KEY  = 'bantu_user';
  const THEME_KEY = 'bantu_theme';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const App = window.App = {
    user: null,
    token: null,
    ws: null,
    wsReady: false,
    wsAuthed: false,
    presence: {},           // userId -> {online, lastSeen}
    activeView: null,
    activeChatId: null,
    isMobile: window.matchMedia('(max-width: 768px)').matches,
    mql: window.matchMedia('(max-width: 768px)'),
  };

  const wsHandlers = Object.create(null);  // type -> [fn]
  const views = Object.create(null);        // name -> view-def

  App.registerWSHandler = function (type, fn) {
    if (!wsHandlers[type]) wsHandlers[type] = [];
    wsHandlers[type].push(fn);
  };
  App.unregisterWSHandler = function (type, fn) {
    const arr = wsHandlers[type]; if (!arr) return;
    const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
  };

  App.registerView = function (name, def) { views[name] = def; };

  // ------------------------------------------------------------------
  // Auth bootstrap
  // ------------------------------------------------------------------
  function bootstrap() {
    App.token = localStorage.getItem(TOKEN_KEY);
    const userJson = localStorage.getItem(USER_KEY);
    try { App.user = userJson ? JSON.parse(userJson) : null; } catch { App.user = null; }
    if (!App.token || !App.user) {
      location.href = '/';
      return;
    }
    // Verify token still valid; refresh user object
    App.api('GET', '/api/auth/me').then(r => {
      if (!r || !r.user) throw 0;
      App.user = r.user;
      localStorage.setItem(USER_KEY, JSON.stringify(r.user));
      renderMe();
      connectWS();
      App.setView('chats');
    }).catch(() => {
      // 401 path auto-redirects inside api()
    });
  }

  // ------------------------------------------------------------------
  // REST helper
  // ------------------------------------------------------------------
  App.api = async function (method, path, body) {
    const token = localStorage.getItem(TOKEN_KEY) || App.token || '';
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bantu ' + token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('Network error: ' + (e && e.message));
    }
    if (res.status === 401) {
      // Token invalid/expired
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      location.href = '/';
      return;
    }
    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('json')) {
      try { data = await res.json(); }
      catch { data = null; }
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  // FormData POST (for file uploads like voice messages)
  App.apiForm = async function (path, formData) {
    const token = localStorage.getItem(TOKEN_KEY) || App.token || '';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Authorization': 'Bantu ' + token },  // browser sets Content-Type for FormData
      body: formData,
    });
    if (res.status === 401) { localStorage.clear(); location.href = '/'; return; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      const err = new Error(msg); err.data = data; throw err;
    }
    return data;
  };

  // ------------------------------------------------------------------
  // WebSocket client
  // ------------------------------------------------------------------
  function wsURL() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The Bantu sua.ws server auto-upgrades HTTP→WS on the same port
    return proto + '//' + location.host;
  }

  function connectWS() {
    setConn('connecting');
    try {
      App.ws = new WebSocket(wsURL());
    } catch (e) {
      setConn('offline');
      App.toast('WebSocket unavailable — retrying in 3s', 'error');
      setTimeout(connectWS, 3000);
      return;
    }

    App.ws.onopen = function () {
      App.wsReady = true;
      // First frame must be auth
      App.wsSend({ type: 'auth', token: App.token });
    };

    App.ws.onclose = function () {
      App.wsReady = false;
      App.wsAuthed = false;
      setConn('connecting');
      // Auto-reconnect
      setTimeout(connectWS, 1500);
    };

    App.ws.onerror = function () {
      setConn('offline');
    };

    App.ws.onmessage = function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch { return; }
      dispatchWS(msg);
    };
  }

  function dispatchWS(msg) {
    if (!msg || !msg.type) return;

    // Built-in handlers
    switch (msg.type) {
      case 'auth_ok':
        App.wsAuthed = true;
        App.user = Object.assign({}, App.user, msg.user || {});
        localStorage.setItem(USER_KEY, JSON.stringify(App.user));
        setConn('online');
        renderMe();
        // Notify any view that's waiting on auth
        if (App.onWSAuthed) try { App.onWSAuthed(); } catch (e) { console.error(e); }
        return;
      case 'auth_error':
        App.toast('Auth error: ' + (msg.message || ''), 'error');
        localStorage.clear();
        location.href = '/';
        return;
      case 'presence': {
        const id = msg.userId;
        App.presence[id] = { online: !!msg.online, lastSeen: msg.lastSeen };
        if (window.Chat && Chat.onPresence) Chat.onPresence(id, App.presence[id]);
        if (window.Profile && Profile.onPresence) Profile.onPresence(id, App.presence[id]);
        return;
      }
      case 'pong': return;
      case 'error':
        App.toast('Server: ' + (msg.message || 'error'), 'error');
        return;
    }

    // Dispatch to registered handlers
    const arr = wsHandlers[msg.type];
    if (arr) {
      for (let i = 0; i < arr.length; i++) {
        try { arr[i](msg); } catch (e) { console.error('handler', msg.type, e); }
      }
    } else {
      // Unknown message — log once
      console.debug('Unhandled WS message type:', msg.type, msg);
    }
  }

  App.wsSend = function (obj) {
    if (App.ws && App.ws.readyState === WebSocket.OPEN) {
      try { App.ws.send(JSON.stringify(obj)); } catch (e) { console.warn('wsSend', e); }
    }
  };

  App.onWSAuthed = null;  // hook for views

  function setConn(state) {
    const el = document.getElementById('conn-indicator');
    if (!el) return;
    el.className = 'conn-indicator ' + state;
    el.title = state === 'online' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Offline';
  }

  // Heartbeat ping every 25s
  setInterval(() => { if (App.wsAuthed) App.wsSend({ type: 'ping' }); }, 25000);

  // ------------------------------------------------------------------
  // Router (SPA: show/hide panes)
  // ------------------------------------------------------------------
  App.setView = function (name) {
    if (!views[name]) { console.warn('Unknown view', name); return; }
    // leave previous
    if (App.activeView && views[App.activeView] && views[App.activeView].leave) {
      try { views[App.activeView].leave(); } catch (e) { console.error(e); }
    }
    App.activeView = name;
    // Update tabs
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.view === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const listTarget = document.getElementById('sidebar-body');
    const paneTarget = document.getElementById('pane-content');
    // Clear pane content for new view
    paneTarget.innerHTML = '';
    // Reset main header to defaults
    setMainHeader({ title: '', sub: '', avatarHTML: '', actions: '' });
    // Enter view
    try { views[name].enter(listTarget, paneTarget); }
    catch (e) { console.error('view enter', name, e); }

    // Mobile: keep sidebar visible by default, hide when a chat is opened
    if (App.isMobile) {
      // Sidebar visible
      document.getElementById('sidebar').classList.remove('collapsed');
      document.getElementById('main-pane').classList.remove('show');
    }
  };

  App.showMainPaneMobile = function () {
    if (!App.isMobile) return;
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('main-pane').classList.add('show');
  };

  App.setMainHeader = setMainHeader;
  function setMainHeader({ title, sub, avatarHTML, actions, backVisible }) {
    document.getElementById('main-header-title').textContent = title || '';
    document.getElementById('main-header-sub').textContent = sub || '';
    document.getElementById('main-header-avatar').innerHTML = avatarHTML || '';
    document.getElementById('main-header-actions').innerHTML = actions || '';
    const back = document.getElementById('back-btn');
    if (back) back.style.display = backVisible ? 'inline-flex' : 'none';
  }

  // ------------------------------------------------------------------
  // Toasts
  // ------------------------------------------------------------------
  App.toast = function (text, kind) {
    const host = document.getElementById('toast-host');
    if (!host) { console.warn('toast', text); return; }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = String(text);
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, 3200);
  };

  // ------------------------------------------------------------------
  // Modal
  // ------------------------------------------------------------------
  App.showModal = function ({ title, body, buttons }) {
    document.getElementById('modal-title').textContent = title || '';
    const bodyEl = document.getElementById('modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof HTMLElement) { bodyEl.innerHTML = ''; bodyEl.appendChild(body); }
    else bodyEl.innerHTML = '';
    const foot = document.getElementById('modal-foot');
    foot.innerHTML = '';
    (buttons || [{ label: 'OK', kind: 'primary' }]).forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.kind === 'danger' ? ' danger' : b.kind === 'ghost' ? ' ghost' : '');
      btn.textContent = b.label;
      btn.onclick = () => {
        if (b.onClick) {
          const r = b.onClick();
          if (r === false) return;  // keep open
        }
        App.hideModal();
      };
      foot.appendChild(btn);
    });
    const bd = document.getElementById('modal-backdrop');
    bd.classList.add('show');
    bd.setAttribute('aria-hidden', 'false');
    // Click outside to close
    bd.onclick = (e) => { if (e.target === bd) App.hideModal(); };
    setTimeout(() => {
      const first = foot.querySelector('button');
      if (first) first.focus();
    }, 0);
  };
  App.hideModal = function () {
    const bd = document.getElementById('modal-backdrop');
    bd.classList.remove('show');
    bd.setAttribute('aria-hidden', 'true');
    bd.onclick = null;
  };

  App.confirm = function (title, body) {
    return new Promise(resolve => {
      App.showModal({
        title, body,
        buttons: [
          { label: 'Cancel', kind: 'ghost', onClick: () => resolve(false) },
          { label: 'Confirm', onClick: () => resolve(true) },
        ],
      });
    });
  };

  // ------------------------------------------------------------------
  // Avatars
  // ------------------------------------------------------------------
  App.initials = function (name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  // Color hash for initials backgrounds
  App.colorFor = function (s) {
    const palette = ['#075E54','#128C7E','#25D366','#34B7F1','#7E57C2','#EC407A','#FF7043','#F6A623','#26A69A','#5C6BC0'];
    let h = 0; const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };

  App.avatarHTML = function (user, sizeClass, extraAttr) {
    if (!user) user = {};
    const name = user.name || user.username || '?';
    const cls = 'avatar-initials ' + (sizeClass || 'md');
    const dim = ({ sm: 28, md: 40, lg: 48, xl: 120 })[sizeClass] || 40;
    if (user.avatar) {
      const extra = extraAttr || '';
      // Image avatar — set explicit size so it renders correctly outside of
      // list-item/header containers that have their own size rules.
      return `<img src="${escapeAttr(user.avatar)}" alt="${escapeAttr(name)}" width="${dim}" height="${dim}" class="${cls.replace('avatar-initials','').trim()}" style="width:${dim}px;height:${dim}px;border-radius:50%;object-fit:cover" ${extra} onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls}',style:'width:${dim}px;height:${dim}px;border-radius:50%;display:flex;align-items:center;justify-content:center;textTransform:uppercase;background:${App.colorFor(name)};color:#fff;',textContent:'${escapeAttr(App.initials(name))}'}))" />`;
    }
    const color = App.colorFor(name);
    return `<div class="${cls}" style="background:${color};width:${dim}px;height:${dim}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;text-transform:uppercase;color:#fff;">${escapeHTML(App.initials(name))}</div>`;
  };

  // ------------------------------------------------------------------
  // Time formatting
  // ------------------------------------------------------------------
  App.fmtTime = function (ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    const diff = (now - d) / 86400000;
    if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
  };

  App.fmtTimeShort = function (ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  App.fmtDuration = function (secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    const m = Math.floor(secs / 60); const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  App.fmtRelative = function (ts) {
    if (!ts) return '';
    const t = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts;
    const diff = (Date.now() - new Date(t)) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
    return new Date(t).toLocaleDateString();
  };

  // ------------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------------
  App.setTheme = function (theme) {
    document.body.classList.toggle('dark', theme === 'dark');
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  };
  App.getTheme = function () {
    return document.body.classList.contains('dark') ? 'dark' : 'light';
  };

  // ------------------------------------------------------------------
  // Emoji picker (simple, popup)
  // ------------------------------------------------------------------
  App.emojiPicker = (function () {
    let el = null, target = null, onPick = null;
    const EMOJIS = '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😝 😜 🤪 😎 🤓 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😬 😏 😬 🙄 😯 😦 😧 😮 😲 🤤 🥱 😴 😪 🤐 💨 🤧 🤒 🤕 🤑 🤠 👋 🤚 ✋ 🖖 🤙 👌 🤌 🤏 👈 👉 👆 🖕 👇 ☝ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🙏 🤝 💪 👅 👀 👂 👃 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣ 💕 💞 💓 💗 💖 💘 💝 🔥 ⭐ 🌟 ✨ ⚡ 💯 ✅ ❌ ⚠ ️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔶 🔷 🔸 🔹 🔺 🔻 💬 💭 🗨 👤 👥'.split(' ');

    function ensure() {
      if (el) return el;
      el = document.createElement('div');
      el.className = 'emoji-picker';
      el.setAttribute('role', 'listbox');
      el.innerHTML = EMOJIS.map(e => `<button class="e" type="button" data-e="${e}">${e}</button>`).join('');
      el.addEventListener('click', (ev) => {
        const t = ev.target.closest('.e'); if (!t) return;
        if (onPick) onPick(t.dataset.e);
      });
      document.body.appendChild(el);
      // Close on outside click
      document.addEventListener('click', (e) => {
        if (el.classList.contains('show') && !el.contains(e.target) && e.target !== target) {
          el.classList.remove('show');
        }
      });
      return el;
    }
    return {
      toggle(anchorEl, cb) {
        ensure();
        target = anchorEl;
        onPick = cb;
        const show = !el.classList.contains('show');
        el.classList.toggle('show', show);
        if (show && anchorEl) {
          const r = anchorEl.getBoundingClientRect();
          el.style.left = (r.left) + 'px';
          el.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        }
      },
      hide() { if (el) el.classList.remove('show'); },
    };
  })();

  // ------------------------------------------------------------------
  // Attach-menu helper (for chat attach button)
  // ------------------------------------------------------------------
  App.attachMenu = (function () {
    let el = null, target = null, items = [];
    function ensure() {
      if (el) return el;
      el = document.createElement('div');
      el.className = 'attach-menu';
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]'); if (!b) return;
        const it = items.find(i => i.act === b.dataset.act);
        if (it && it.onClick) it.onClick();
        el.classList.remove('show');
      });
      document.addEventListener('click', (e) => {
        if (el.classList.contains('show') && !el.contains(e.target) && e.target !== target) {
          el.classList.remove('show');
        }
      });
      return el;
    }
    return {
      toggle(anchorEl, list) {
        ensure(); target = anchorEl; items = list || [];
        const show = !el.classList.contains('show');
        el.classList.toggle('show', show);
        el.innerHTML = items.map(i =>
          `<button type="button" data-act="${escapeAttr(i.act)}"><span class="a-icon" style="background:${escapeAttr(i.color || '#128C7E')}">${i.icon || ''}</span><span>${escapeHTML(i.label || '')}</span></button>`
        ).join('');
        if (show && anchorEl) {
          const r = anchorEl.getBoundingClientRect();
          el.style.left = (r.left) + 'px';
          el.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        }
      },
      hide() { if (el) el.classList.remove('show'); },
    };
  })();

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHTML(s); }
  App.escapeHTML = escapeHTML;

  App.linkify = function (text) {
    // Escape first, then wrap URLs
    const esc = escapeHTML(text);
    return esc.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
  };

  // Skeleton loader helper
  App.skeletonList = function (n) {
    const out = [];
    for (let i = 0; i < (n || 5); i++) {
      out.push(`<div class="sk-row">
        <div class="skeleton circle"></div>
        <div class="sk-body">
          <div class="skeleton line med"></div>
          <div class="skeleton line short"></div>
        </div>
      </div>`);
    }
    return out.join('');
  };

  // ------------------------------------------------------------------
  // Render top-of-sidebar (user identity)
  // ------------------------------------------------------------------
  function renderMe() {
    if (!App.user) return;
    document.getElementById('me-avatar').innerHTML = App.avatarHTML(App.user, 'sm');
    document.getElementById('me-name').textContent = App.user.name || App.user.username || 'User';
  }
  App.renderMe = renderMe;

  // ------------------------------------------------------------------
  // Logout (shared)
  // ------------------------------------------------------------------
  App.logout = function () {
    if (App.ws) try { App.ws.close(); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    location.href = '/';
  };

  // ------------------------------------------------------------------
  // Boot on DOM ready
  // ------------------------------------------------------------------
  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(function () {
    // Mobile hamburger / back
    App.mql.addEventListener('change', (e) => { App.isMobile = e.matches; });
    document.getElementById('hamburger').onclick = () => {
      const sb = document.getElementById('sidebar');
      sb.classList.toggle('collapsed');
    };
    document.getElementById('back-btn').onclick = () => {
      const sb = document.getElementById('sidebar');
      const mp = document.getElementById('main-pane');
      sb.classList.remove('collapsed');
      mp.classList.remove('show');
    };
    document.getElementById('btn-logout').onclick = () => App.logout();
    document.getElementById('me-row').addEventListener('click', () => App.setView('profile'));
    document.getElementById('me-row').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); App.setView('profile'); }
    });
    document.getElementById('btn-status-new').onclick = () => {
      App.setView('status');
      if (window.Status && Status.openComposer) Status.openComposer();
    };

    // Tabs
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => App.setView(t.dataset.view));
    });

    // ESC closes modal / overlays
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        App.hideModal();
        App.emojiPicker.hide();
        App.attachMenu.hide();
        const sv = document.getElementById('status-viewer');
        if (sv && sv.classList.contains('show') && window.Status) Status.closeViewer();
      }
    });

    bootstrap();
  });
})();
