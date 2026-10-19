/* =====================================================================
 * BantuChat — editor.js
 * Live collaborative code editor (CodeMirror 5 from CDN).
 *
 * Layout: session list (left) | editor (center) | participants (right).
 *  • Create session:   POST /api/editor/sessions {name, language}
 *  • Open session:     GET /api/editor/sessions/:id → load into CodeMirror
 *  • Local changes:    send {type:"code_edit", sessionId, revision,
 *                       ops:[{type:"insert"|"delete", pos, text?}]} (50ms
 *                       debounce + coalescing)
 *  • Remote edits:     apply to CodeMirror without re-triggering our own
 *  • Cursor sync:      code_cursor on cursorActivity; render remote
 *                       cursors as colored markers
 *  • Language select changes CodeMirror mode
 *
 * Exposes: window.Editor  (global)
 * ===================================================================== */
(function () {
  'use strict';

  if (!window.CodeMirror) {
    console.warn('CodeMirror not loaded — editor view will be limited');
  }

  const Editor = window.Editor = {
    state: {
      sessions: [],
      activeId: null,
      activeSession: null,
      cm: null,
      revision: 0,
      applyingRemote: false,
      pendingSend: null,         // { ops: [], timer }
      participants: {},          // userId -> {name, color, pos, marker}
      cursorMarkers: {},        // userId -> CodeMirror TextMarker
      colorByUser: {},
    },
  };

  // DOM cache (set on enter)
  let listEl, paneEl, sideLeftBody, sideRightBody, cmHost, toolbar;

  const LANGS = [
    ['javascript', 'JavaScript'],
    ['python', 'Python'],
    ['xml', 'HTML/XML'],
    ['clike', 'C/C++/Java/C#'],
    ['shell', 'Shell'],
    ['sql', 'SQL'],
    ['go', 'Go'],
    ['text', 'Plain text'],
  ];

  // ==========================================================
  // View lifecycle
  // ==========================================================
  App.registerView('editor', {
    enter(list, pane) {
      listEl = list; paneEl = pane;
      // Sidebar: session list with create button
      listEl.innerHTML = `
        <div style="padding:10px 12px; border-bottom:1px solid var(--border); background:var(--panel);">
          <button class="btn block" id="editor-create-btn">＋ New session</button>
        </div>
        <div id="editor-session-list"></div>
      `;
      // Main pane: 3-column grid
      paneEl.innerHTML = `
        <div class="editor-grid">
          <div class="editor-side" id="editor-left">
            <h4>Participants <span style="font-size:11px;color:var(--text-muted)" id="editor-participants-count"></span></h4>
            <div class="es-body" id="editor-participants"></div>
          </div>
          <div class="editor-center">
            <div class="editor-toolbar">
              <select id="editor-lang" aria-label="Language"></select>
              <input id="editor-name" placeholder="Session name" aria-label="Session name" />
              <span class="spacer"></span>
              <span class="save-state" id="editor-save-state"></span>
              <button class="btn ghost" id="editor-save" style="min-height:34px;padding:6px 12px">Save</button>
            </div>
            <div class="editor-host" id="editor-host"></div>
          </div>
        </div>
      `;
      // Build lang select
      const sel = document.getElementById('editor-lang');
      LANGS.forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o);
      });
      // Re-arrange: participants on the right per spec — but our grid puts left/middle.
      // Per contract: session list (left), editor (center), participants (right).
      // Move participants to the right by switching the grid.
      // Easier: rebuild the grid in the contract order.
      paneEl.innerHTML = `
        <div class="editor-grid" style="grid-template-columns:240px 1fr 220px;">
          <div class="editor-side">
            <h4>Sessions</h4>
            <div class="es-body" id="editor-session-list"></div>
          </div>
          <div class="editor-center">
            <div class="editor-toolbar">
              <select id="editor-lang" aria-label="Language"></select>
              <input id="editor-name" placeholder="Session name" aria-label="Session name" />
              <span class="spacer"></span>
              <span class="save-state" id="editor-save-state">Saved</span>
              <button class="btn ghost" id="editor-save" style="min-height:34px;padding:6px 12px">Save</button>
            </div>
            <div class="editor-host" id="editor-host">
              <div class="empty-state" id="editor-empty">
                <div class="icon">📝</div>
                <h3>No session open</h3>
                <p>Create or open a session to start coding together.</p>
                <button class="btn" id="editor-create-btn2" style="margin-top:14px">＋ New session</button>
              </div>
            </div>
          </div>
          <div class="editor-side right">
            <h4>Participants <span style="font-size:11px;color:var(--text-muted)" id="editor-participants-count"></span></h4>
            <div class="es-body" id="editor-participants"></div>
          </div>
        </div>
      `;
      const sel2 = document.getElementById('editor-lang');
      LANGS.forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l; sel2.appendChild(o);
      });

      document.getElementById('editor-create-btn')?.addEventListener('click', openCreateDialog);
      document.getElementById('editor-create-btn2')?.addEventListener('click', openCreateDialog);
      document.getElementById('editor-save')?.addEventListener('click', saveSession);
      document.getElementById('editor-lang')?.addEventListener('change', () => {
        if (Editor.state.cm && Editor.state.activeSession) {
          const mode = document.getElementById('editor-lang').value;
          Editor.state.cm.setOption('mode', mode);
          Editor.state.activeSession.language = mode;
          // Update server (PUT content + language via /api/editor/sessions/:id with content)
          saveSession();
        }
      });
      document.getElementById('editor-name')?.addEventListener('change', () => {
        if (Editor.state.activeSession) {
          Editor.state.activeSession.name = document.getElementById('editor-name').value;
          saveSession();
          renderSessionList();
        }
      });

      loadSessions();
    },
    leave() {
      // Flush pending sends
      flushPendingEdits();
      // Clear markers
      Object.values(Editor.state.cursorMarkers).forEach(m => { try { m.clear(); } catch {} });
      Editor.state.cursorMarkers = {};
      // Do not destroy CodeMirror — keep it for next time? Actually clear it.
      if (Editor.state.cm) {
        try { Editor.state.cm.toTextArea(); } catch {}
        Editor.state.cm = null;
      }
      Editor.state.activeId = null;
      Editor.state.activeSession = null;
    },
  });

  // ==========================================================
  // Sessions
  // ==========================================================
  async function loadSessions() {
    const list = document.getElementById('editor-session-list');
    if (!list) return;
    list.innerHTML = App.skeletonList(3);
    try {
      const r = await App.api('GET', '/api/editor/sessions');
      Editor.state.sessions = Array.isArray(r) ? r : [];
      renderSessionList();
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><p>${App.escapeHTML(e.message)}</p></div>`;
    }
  }

  function renderSessionList() {
    const list = document.getElementById('editor-session-list');
    if (!list) return;
    if (!Editor.state.sessions.length) {
      list.innerHTML = `<div class="empty-state" style="padding:24px"><div class="icon">📭</div><h3>No sessions</h3><p>Tap "New session" to create one.</p></div>`;
      return;
    }
    list.innerHTML = Editor.state.sessions.map(s => `
      <div class="item ${s.id === Editor.state.activeId ? 'active' : ''}" data-id="${s.id}" role="button" tabindex="0">
        <div class="i-name">${App.escapeHTML(s.name || ('Session #' + s.id))}</div>
        <div class="i-sub">${App.escapeHTML(s.language || 'text')} · ${s.participants ? s.participants.length : 0} users</div>
      </div>
    `).join('');
    list.querySelectorAll('.item').forEach(el => {
      el.onclick = () => openSession(parseInt(el.dataset.id, 10));
    });
  }

  async function openSession(id) {
    flushPendingEdits();
    // Clear existing CM
    if (Editor.state.cm) {
      try { Editor.state.cm.toTextArea(); } catch {}
      Editor.state.cm = null;
    }
    Object.values(Editor.state.cursorMarkers).forEach(m => { try { m.clear(); } catch {} });
    Editor.state.cursorMarkers = {};
    Editor.state.activeId = id;
    try {
      const r = await App.api('GET', '/api/editor/sessions/' + id);
      if (!r || !r.session) throw new Error('Invalid session response');
      Editor.state.activeSession = Object.assign({}, r.session, { content: r.content != null ? r.content : (r.session.content || '') });
      Editor.state.revision = 0;
      Editor.state.participants = {};
      (r.participants || []).forEach(p => {
        Editor.state.participants[p.id] = { name: p.name, color: colorFor(p.id) };
      });
      // Build CodeMirror
      const host = document.getElementById('editor-host');
      host.innerHTML = '';
      const ta = document.createElement('textarea');
      host.appendChild(ta);
      Editor.state.cm = CodeMirror.fromTextArea(ta, {
        lineNumbers: true,
        mode: Editor.state.activeSession.language || 'text',
        // Use CodeMirror's default theme; our CSS overrides handle dark mode.
        theme: 'default',
        lineWrapping: false,
        indentUnit: 2,
        tabSize: 2,
        extraKeys: {
          'Cmd-S': () => saveSession(),
          'Ctrl-S': () => saveSession(),
        },
      });
      // Suppress CM's own 'default' theme if no theme css — keep simple, just rely on our CSS overrides
      Editor.state.cm.setValue(Editor.state.activeSession.content || '');
      // Set toolbar values
      document.getElementById('editor-lang').value = Editor.state.activeSession.language || 'text';
      document.getElementById('editor-name').value = Editor.state.activeSession.name || '';
      document.getElementById('editor-save-state').textContent = 'Saved';
      // Bind change handler
      Editor.state.cm.on('change', onLocalChange);
      Editor.state.cm.on('cursorActivity', onCursorActivity);
      renderParticipants();
      renderSessionList();
    } catch (e) {
      App.toast('Failed to open session: ' + e.message, 'error');
    }
  }
  Editor.openSession = openSession;

  async function openCreateDialog() {
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Session name';
    nameInput.style.cssText = 'width:100%; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2); color:var(--text)';
    const langSel = document.createElement('select');
    langSel.style.cssText = 'width:100%; margin-top:8px; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2); color:var(--text)';
    LANGS.forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; langSel.appendChild(o);
    });
    langSel.value = 'javascript';
    const wrap = document.createElement('div');
    wrap.appendChild(nameInput); wrap.appendChild(langSel);
    App.showModal({
      title: 'New code session',
      body: wrap,
      buttons: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Create', onClick: async () => {
          const name = nameInput.value.trim() || 'Untitled session';
          const language = langSel.value;
          try {
            const r = await App.api('POST', '/api/editor/sessions', { name, language });
            if (r && r.session) {
              await loadSessions();
              openSession(r.session.id);
            }
          } catch (e) { App.toast(e.message, 'error'); return false; }
        } },
      ],
    });
    setTimeout(() => nameInput.focus(), 50);
  }

  async function saveSession() {
    if (!Editor.state.cm || !Editor.state.activeSession) return;
    const content = Editor.state.cm.getValue();
    const stateEl = document.getElementById('editor-save-state');
    if (stateEl) stateEl.textContent = 'Saving…';
    try {
      await App.api('PUT', '/api/editor/sessions/' + Editor.state.activeId, { content });
      if (stateEl) stateEl.textContent = 'Saved';
    } catch (e) {
      if (stateEl) stateEl.textContent = 'Error';
      App.toast('Save failed: ' + e.message, 'error');
    }
  }

  // ==========================================================
  // Local change → emit ops
  // ==========================================================
  function onLocalChange(cm, change) {
    if (Editor.state.applyingRemote) return;
    // Defensive: CodeMirror fires `change` events for our own remote
    // edits with origin `+remote` (or whatever origin string we pass to
    // replaceRange). If the applyingRemote flag was already reset by
    // the time the change event fires (which can happen because the
    // flag is set OUTSIDE cm.operation while change events fire
    // INSIDE), we'd otherwise re-broadcast our own remote edits as if
    // they were local — creating an infinite echo loop. Checking the
    // origin is the bulletproof fix.
    if (change && change.origin && change.origin === '+remote') return;
    // Build ops from change object
    // change.from, change.to, change.text (array of lines), change.removed (array)
    // We model as: delete from change.from..change.to, then insert change.text at change.from
    const ops = [];
    // Delete
    if (change.removed && change.removed.length) {
      const pos = cm.indexFromPos(change.from);
      const removedText = change.removed.join('\n');
      ops.push({ type: 'delete', pos, text: removedText });
    }
    // Insert
    if (change.text && change.text.length && !(change.text.length === 1 && change.text[0] === '')) {
      const pos = cm.indexFromPos(change.from);
      const insertText = change.text.join('\n');
      ops.push({ type: 'insert', pos, text: insertText });
    }
    if (!ops.length) return;
    queueOps(ops);
    setSaveState('Unsaved');
  }

  function setSaveState(text) {
    const el = document.getElementById('editor-save-state');
    if (el) el.textContent = text;
  }

  let sendTimer = null;
  const pendingOps = [];
  function queueOps(ops) {
    for (const o of ops) pendingOps.push(o);
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(flushPendingEdits, 50);
  }
  function flushPendingEdits() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (!pendingOps.length || !Editor.state.activeId || !App.wsAuthed) {
      // If WS not authed, fall back to PUT save
      if (pendingOps.length && Editor.state.activeId) {
        pendingOps.length = 0;
        saveSession();
      }
      return;
    }
    Editor.state.revision = (Editor.state.revision || 0) + 1;
    const opsToSend = pendingOps.slice();
    pendingOps.length = 0;
    App.wsSend({
      type: 'code_edit',
      sessionId: Editor.state.activeId,
      revision: Editor.state.revision,
      ops: opsToSend,
    });
  }

  // ==========================================================
  // Cursor sync
  // ==========================================================
  let cursorTimer = null;
  function onCursorActivity(cm) {
    if (Editor.state.applyingRemote) return;
    if (cursorTimer) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      if (!Editor.state.activeId) return;
      const pos = cm.indexFromPos(cm.getCursor('from'));
      const end = cm.indexFromPos(cm.getCursor('to'));
      App.wsSend({
        type: 'code_cursor',
        sessionId: Editor.state.activeId,
        pos, selectionEnd: end,
      });
    }, 80);
  }

  // ==========================================================
  // Remote handlers
  // ==========================================================
  App.registerWSHandler('code_edit', (msg) => {
    if (!Editor.state.cm || msg.sessionId !== Editor.state.activeId) return;
    if (msg.userId === App.user.id) return;  // our own echo
    const cm = Editor.state.cm;
    Editor.state.applyingRemote = true;
    cm.operation(() => {
      (msg.ops || []).forEach(op => {
        try {
          if (op.type === 'insert') {
            const from = cm.posFromIndex(op.pos);
            cm.replaceRange(op.text || '', from, from, '+remote');
          } else if (op.type === 'delete') {
            const from = cm.posFromIndex(op.pos);
            const len = (op.text && op.text.length) || 0;
            const to = cm.posFromIndex(op.pos + len);
            cm.replaceRange('', from, to, '+remote');
          }
        } catch (e) { console.warn('apply op', e); }
      });
    });
    Editor.state.applyingRemote = false;
    Editor.state.revision = msg.revision;
    setSaveState('Unsaved');
  });

  App.registerWSHandler('code_cursor', (msg) => {
    if (!Editor.state.cm || msg.sessionId !== Editor.state.activeId) return;
    if (msg.userId === App.user.id) return;
    const cm = Editor.state.cm;
    const userId = msg.userId;
    // Clear previous marker
    if (Editor.state.cursorMarkers[userId]) {
      try { Editor.state.cursorMarkers[userId].clear(); } catch {}
    }
    const color = colorFor(userId);
    const from = cm.posFromIndex(msg.pos);
    const to = cm.posFromIndex(msg.selectionEnd || msg.pos);
    const name = (Editor.state.participants[userId] && Editor.state.participants[userId].name) || ('User ' + userId);
    // Use a non-empty marker element. Show the first 3 chars of the
    // participant's name as the marker label (was previously broken —
    // charAt(1) gave the second char, then slice(0,4) on a 1-char string
    // returned only that one char).
    const initials = (name || '?').slice(0, 3).toUpperCase();
    const el = document.createElement('span');
    el.className = 'cm-cursor-marker';
    el.style.color = color;
    el.style.background = color + '33';   // 20% alpha
    el.style.padding = '0 2px';
    el.style.borderRadius = '2px';
    el.style.fontWeight = '700';
    el.style.fontSize = '11px';
    el.setAttribute('data-name', initials);
    el.textContent = initials;
    try {
      Editor.state.cursorMarkers[userId] = cm.markText(from, to, {
        replacedWith: el,
        handleMouseEvents: false,
      });
    } catch (e) { /* ignore */ }
    // Update participant marker in the list
    const item = document.querySelector(`.participant-item[data-uid="${userId}"]`);
    if (item) item.classList.add('active-now');
  });

  // ==========================================================
  // Participants UI
  // ==========================================================
  function renderParticipants() {
    const el = document.getElementById('editor-participants');
    if (!el) return;
    const list = Object.entries(Editor.state.participants);
    if (!list.length) {
      el.innerHTML = `<div class="empty-state" style="padding:24px"><p>No other participants.</p></div>`;
      return;
    }
    el.innerHTML = list.map(([uid, p]) => `
      <div class="item participant-item" data-uid="${uid}">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="width:10px; height:10px; border-radius:50%; background:${p.color}; display:inline-block;"></span>
          <div>
            <div class="i-name">${App.escapeHTML(p.name || 'User')}</div>
            <div class="i-sub">${uid == App.user.id ? 'you' : ''}</div>
          </div>
        </div>
      </div>`).join('');
    const cnt = document.getElementById('editor-participants-count');
    if (cnt) cnt.textContent = `(${list.length})`;
  }
  // Also expose a hook for editor participants to be updated on code_cursor / future join events.
  Editor.updateParticipant = function (userId, name) {
    if (!Editor.state.participants[userId]) {
      Editor.state.participants[userId] = { name: name || ('User ' + userId), color: colorFor(userId) };
      renderParticipants();
    }
  };

  // ==========================================================
  // Helpers
  // ==========================================================
  function colorFor(userId) {
    const palette = ['#FF7043','#26A69A','#7E57C2','#EC407A','#34B7F1','#F6A623','#5C6BC0','#25D366'];
    const n = typeof userId === 'number' ? userId : String(userId).length;
    return palette[n % palette.length];
  }
})();
