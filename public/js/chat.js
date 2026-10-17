/* =====================================================================
 * BantuChat — chat.js
 * Chat list (sidebar) + chat view (right pane).
 *  • search + list of chats with last message + unread badge + avatar
 *  • speech bubbles: outgoing green #DCF8C6 ✓✓ (blue when read),
 *    incoming white with avatar, voice/code/image bubbles
 *  • message input bar (textarea + emoji + attach + send + mic)
 *  • typing indicator, infinite scroll (history), read-receipt sync
 *
 * Exposes: window.Chat  (global)
 * ===================================================================== */
(function () {
  'use strict';

  const Chat = window.Chat = {
    state: {
      chats: [],
      activeChatId: null,
      activeChat: null,         // {id, type, name, peer, ...}
      activeMessages: [],       // ascending by id
      oldestLoadedId: null,
      loadingHistory: false,
      hasMoreHistory: true,
      peersTyping: {},          // chatId -> Set of userIds
      drafts: {},               // chatId -> text
      lastReadAt: {},           // chatId -> ts
      voiceRecording: null,     // { recorder, chunks, startTime, stream }
    },
  };

  // ----- DOM cache (set on enter) -----
  let listEl, paneEl, searchInput;
  let msgContainer, inputBar, inputTextarea;

  // ==========================================================
  // View lifecycle
  // ==========================================================
  App.registerView('chats', {
    enter(list, pane) {
      listEl = list; paneEl = pane;
      list.innerHTML = `
        <div class="search-bar">
          <input id="chat-search" type="search" placeholder=" 🔍  Search chats" aria-label="Search chats" />
        </div>
        <div id="chat-list-body"></div>
      `;
      pane.innerHTML = `
        <div class="empty-state">
          <div class="icon">💬</div>
          <h3>Welcome to BantuChat</h3>
          <p>Select a chat to start messaging, or find a user to begin a new conversation.</p>
          <button class="btn" id="new-chat-btn" style="margin-top:18px">＋ New chat</button>
          <div class="sub">All messages are relayed in real-time via the Bantu WebSocket server.</div>
        </div>
      `;
      searchInput = document.getElementById('chat-search');
      searchInput.addEventListener('input', () => renderList(filterChats(searchInput.value)));
      document.getElementById('new-chat-btn').addEventListener('click', openNewChatDialog);

      loadChats();
    },
    leave() {
      // Persist draft
      if (inputTextarea && Chat.state.activeChatId) {
        Chat.state.drafts[Chat.state.activeChatId] = inputTextarea.value;
      }
    },
  });

  // ==========================================================
  // Chat list
  // ==========================================================
  async function loadChats() {
    const body = document.getElementById('chat-list-body');
    body.innerHTML = App.skeletonList(5);
    try {
      const chats = await App.api('GET', '/api/chats');
      Chat.state.chats = Array.isArray(chats) ? chats : [];
      renderList();
      // If pending open request, fulfill it
      if (Chat.state.pendingOpenChatPeerId) {
        const peerId = Chat.state.pendingOpenChatPeerId;
        Chat.state.pendingOpenChatPeerId = null;
        openChatWithPeer(peerId).catch(err => App.toast(err.message, 'error'));
      }
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><p>Failed to load chats: ${App.escapeHTML(e.message)}</p></div>`;
    }
  }

  function filterChats(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return Chat.state.chats;
    return Chat.state.chats.filter(c => {
      const name = c.name || (c.peer && c.peer.name) || '';
      const last = c.lastMessage && (c.lastMessage.body || '');
      return name.toLowerCase().includes(q) || String(last).toLowerCase().includes(q);
    });
  }

  function renderList(list) {
    const body = document.getElementById('chat-list-body');
    if (!body) return;
    list = list || Chat.state.chats;
    if (!list.length) {
      body.innerHTML = `
        <div class="empty-state" style="padding:24px">
          <div class="icon">📭</div>
          <h3>No chats yet</h3>
          <p>Tap "New chat" to find a user and start a conversation.</p>
        </div>`;
      return;
    }
    body.innerHTML = list.map(c => listItemHTML(c)).join('');
    // Bind clicks
    body.querySelectorAll('.list-item').forEach(el => {
      el.addEventListener('click', () => selectChat(parseInt(el.dataset.id, 10)));
    });
  }

  function listItemHTML(c) {
    const active = c.id === Chat.state.activeChatId ? ' active' : '';
    const name = c.name || (c.peer && c.peer.name) || 'Unknown';
    const peer = c.peer || {};
    const last = c.lastMessage;
    let preview = '— no messages yet —';
    let previewIcon = '';
    if (last) {
      previewIcon = last.kind === 'voice' ? '🎤 '
                 : last.kind === 'code'   ? '🧑‍💻 '
                 : last.kind === 'image'  ? '🖼 '
                 : '';
      preview = previewIcon + (last.body || '');
      // Truncate long previews
      if (preview.length > 38) preview = preview.slice(0, 38) + '…';
    }
    const time = last ? App.fmtTime(last.createdAt) : (c.lastSeenAt ? App.fmtTime(c.lastSeenAt) : '');
    const unread = c.unread ? `<span class="unread">${c.unread}</span>` : '';
    const onlineDot = peer.online ? `<span class="online-dot"></span>` : '';
    return `
      <div class="list-item${active}" data-id="${c.id}" role="button" tabindex="0" aria-label="Chat with ${App.escapeHTML(name)}">
        <div class="avatar">${App.avatarHTML(peer, 'lg')}${onlineDot}</div>
        <div class="info">
          <div class="top">
            <span class="name">${App.escapeHTML(name)}</span>
            <span class="time">${App.escapeHTML(time)}</span>
          </div>
          <div class="preview">
            <span>${App.escapeHTML(preview)}</span>
            ${unread}
          </div>
        </div>
      </div>`;
  }

  // ==========================================================
  // Select & open a chat
  // ==========================================================
  async function selectChat(chatId) {
    if (Chat.state.activeChatId === chatId) {
      App.showMainPaneMobile();
      return;
    }
    const chat = Chat.state.chats.find(c => c.id === chatId) || { id: chatId };
    Chat.state.activeChatId = chatId;
    Chat.state.activeChat = chat;
    Chat.state.activeMessages = [];
    Chat.state.oldestLoadedId = null;
    Chat.state.hasMoreHistory = true;
    Chat.state.peersTyping[chatId] = Chat.state.peersTyping[chatId] || new Set();
    renderList();
    await renderChatView(chat);
    App.showMainPaneMobile();
    // Load history
    await loadHistory(chatId);
    // Send read receipt
    sendRead(chatId);
  }
  Chat.selectChat = selectChat;

  async function renderChatView(chat) {
    const peer = chat.peer || {};
    const name = chat.name || peer.name || peer.username || 'Chat';
    const onlineText = chat.type === 'group' ? (chat.members && chat.members.length + ' members') :
                       peer.online ? 'online' :
                       peer.lastSeen ? 'last seen ' + App.fmtRelative(peer.lastSeen) : '';
    const headerAvatar = chat.type === 'group' ?
      `<div class="avatar-initials" style="background:#128C7E;width:36px;height:36px;border-radius:50%">#${App.escapeHTML(String(chat.id))}</div>` :
      App.avatarHTML(peer, 'md');
    const callBtn = chat.type === 'dm' ? `<button class="hbtn" id="call-btn" title="Voice call" aria-label="Voice call">📞</button>` : '';
    App.setMainHeader({
      title: name,
      sub: onlineText,
      avatarHTML: headerAvatar,
      actions: callBtn,
      backVisible: true,
    });
    // Bind call
    const cb = document.getElementById('call-btn');
    if (cb) cb.addEventListener('click', () => {
      if (window.Call && peer.id) Call.startCall(peer.id, peer.name || name);
    });
    // Render messages area + input bar
    paneEl.innerHTML = `
      <div class="chat-bg" id="chat-bg" role="log" aria-live="polite" aria-label="Messages"></div>
      <div class="typing-line" id="typing-line" style="display:none"></div>
      <div class="input-bar" id="input-bar">
        <button class="ibtn" id="attach-btn" aria-label="Attach">📎</button>
        <button class="ibtn" id="emoji-btn" aria-label="Emoji">😊</button>
        <textarea id="msg-input" rows="1" placeholder="Type a message" aria-label="Message input"></textarea>
        <button class="ibtn send" id="send-btn" aria-label="Send" title="Send">➤</button>
        <button class="ibtn" id="mic-btn" aria-label="Record voice message" title="Hold to record">🎙</button>
      </div>
    `;
    msgContainer = document.getElementById('chat-bg');
    inputBar = document.getElementById('input-bar');
    inputTextarea = document.getElementById('msg-input');
    // Restore draft
    if (Chat.state.drafts[chat.id]) inputTextarea.value = Chat.state.drafts[chat.id];

    // Auto-grow textarea
    inputTextarea.addEventListener('input', () => {
      inputTextarea.style.height = 'auto';
      inputTextarea.style.height = Math.min(120, inputTextarea.scrollHeight) + 'px';
      // Typing indicator (debounced)
      sendTypingThrottled(true);
      // Stop typing after pause
      clearTimeout(Chat._typingStop);
      Chat._typingStop = setTimeout(() => sendTyping(false), 1500);
    });
    inputTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText(); }
    });

    // Send button
    document.getElementById('send-btn').addEventListener('click', submitText);

    // Emoji picker
    document.getElementById('emoji-btn').addEventListener('click', (e) => {
      App.emojiPicker.toggle(e.currentTarget, (em) => {
        const s = inputTextarea.selectionStart || inputTextarea.value.length;
        inputTextarea.value = inputTextarea.value.slice(0, s) + em + inputTextarea.value.slice(s);
        inputTextarea.focus();
        inputTextarea.selectionStart = inputTextarea.selectionEnd = s + em.length;
      });
    });

    // Attach menu
    document.getElementById('attach-btn').addEventListener('click', (e) => {
      App.attachMenu.toggle(e.currentTarget, [
        { act: 'image', label: 'Photo', icon: '🖼', color: '#7E57C2', onClick: () => pickAndSendImage() },
        { act: 'code',  label: 'Code snippet', icon: '🧑‍💻', color: '#26A69A', onClick: () => openCodeComposer() },
        { act: 'doc',   label: 'Document', icon: '📄', color: '#5C6BC0', onClick: () => App.toast('Document upload not yet supported', 'info') },
      ]);
    });

    // Mic button — hold to record
    const micBtn = document.getElementById('mic-btn');
    let micHeld = false, micTimer = null;
    micBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      micHeld = true;
      micTimer = setTimeout(() => {
        if (micHeld) startVoiceRecording();
      }, 250);
    });
    micBtn.addEventListener('pointerup', (e) => {
      micHeld = false;
      clearTimeout(micTimer);
      if (Chat.state.voiceRecording) stopAndSendVoiceRecording();
    });
    micBtn.addEventListener('pointerleave', () => {
      if (micHeld) {
        micHeld = false; clearTimeout(micTimer);
        if (Chat.state.voiceRecording) cancelVoiceRecording();
      }
    });

    // Infinite scroll for history
    msgContainer.addEventListener('scroll', () => {
      if (msgContainer.scrollTop < 60 && Chat.state.hasMoreHistory && !Chat.state.loadingHistory) {
        loadHistory(chat.id, Chat.state.oldestLoadedId);
      }
      // Read receipts: when user views bottom, mark read
      if (msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 80) {
        sendRead(chat.id);
      }
    });

    inputTextarea.focus();
  }

  // ==========================================================
  // Render messages
  // ==========================================================
  function renderMessages() {
    if (!msgContainer) return;
    const msgs = Chat.state.activeMessages;
    if (!msgs.length) {
      msgContainer.innerHTML = `<div class="empty-state" style="flex:1;align-self:center;background:transparent;box-shadow:none">
        <div class="icon">💬</div><h3>No messages yet</h3><p>Say hello!</p></div>`;
      return;
    }
    const myId = App.user && App.user.id;
    let html = '';
    let lastDate = '';
    msgs.forEach(m => {
      const d = new Date(m.createdAt && m.createdAt < 1e12 ? m.createdAt * 1000 : m.createdAt);
      const dateStr = d.toDateString();
      if (dateStr !== lastDate) {
        lastDate = dateStr;
        html += `<div class="date-divider">${App.escapeHTML(formatDateLabel(d))}</div>`;
      }
      html += messageHTML(m, myId);
    });
    // Typing bubble
    const typingSet = Chat.state.peersTyping[Chat.state.activeChatId];
    if (typingSet && typingSet.size) {
      html += `<div class="msg-row in"><div class="typing-bubble"><i></i><i></i><i></i></div></div>`;
    }
    const wasAtBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 80;
    msgContainer.innerHTML = html;
    // Bind code copy buttons
    msgContainer.querySelectorAll('button.copy-btn').forEach(b => {
      b.addEventListener('click', () => {
        const code = b.closest('.msg.code').querySelector('code');
        if (code) {
          navigator.clipboard.writeText(code.textContent).then(() => {
            b.textContent = '✓ Copied';
            setTimeout(() => b.textContent = '📋 Copy', 1500);
          });
        }
      });
    });
    // Bind voice play buttons
    msgContainer.querySelectorAll('button.play-btn').forEach(b => {
      b.addEventListener('click', () => playVoice(b));
    });
    if (wasAtBottom) msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function messageHTML(m, myId) {
    const out = m.senderId === myId;
    const dirClass = out ? 'out' : 'in';
    const time = App.fmtTimeShort(m.createdAt);
    const receipt = out ? receiptHTML(m.status) : '';
    const peer = (Chat.state.activeChat && Chat.state.activeChat.peer) || {};
    const showAvatar = !out && Chat.state.activeChat && Chat.state.activeChat.type !== 'group';
    const av = showAvatar ? `<div style="margin-right:6px;align-self:flex-end">${App.avatarHTML({ name: peer.name, avatar: peer.avatar }, 'sm')}</div>` : '';
    let inner = '';
    switch (m.kind) {
      case 'voice': inner = voiceBubbleHTML(m); break;
      case 'code':  inner = codeBubbleHTML(m); break;
      case 'image': inner = imageBubbleHTML(m); break;
      default:      inner = `<div class="msg ${dirClass}"><div>${App.linkify(m.body || '')}</div><div class="meta">${App.escapeHTML(time)}${receipt}</div></div>`;
    }
    return `<div class="msg-row ${dirClass}">${av}${inner}</div>`;
  }

  function receiptHTML(status) {
    if (!status) return '';
    // 'sent' (✓) | 'delivered' (✓✓ gray) | 'read' (✓✓ blue)
    if (status === 'sent') return `<span class="receipt single">✓</span>`;
    if (status === 'delivered') return `<span class="receipt">✓✓</span>`;
    if (status === 'read') return `<span class="receipt read">✓✓</span>`;
    return '';
  }

  function voiceBubbleHTML(m) {
    const dur = App.fmtDuration(m.duration || 0);
    const body = m.body || '';
    // Generate 18 pseudo-waveform bars from duration/seed
    const bars = [];
    for (let i = 0; i < 18; i++) bars.push(`<i style="height:${5 + Math.abs(Math.sin(i * 1.7 + (m.id||0))) * 16}px"></i>`);
    return `<div class="msg voice">
      <div class="voice-bubble">
        <button class="play play-btn" aria-label="Play voice message">▶</button>
        <div class="wave">${bars.join('')}</div>
        <div class="dur">${App.escapeHTML(dur)}</div>
      </div>
      <audio class="voice-audio" src="${App.escapeHTML(body)}" preload="metadata"></audio>
      <div class="meta" style="margin-top:4px">${App.fmtTimeShort(m.createdAt)}<span class="receipt"></span></div>
    </div>`;
  }

  function codeBubbleHTML(m) {
    const lang = m.codeLang || 'text';
    const code = m.body || '';
    return `<div class="msg code">
      <div class="code-head">
        <span class="lang">${App.escapeHTML(lang)}</span>
        <button class="copy copy-btn" type="button">📋 Copy</button>
      </div>
      <pre><code>${App.escapeHTML(code)}</code></pre>
    </div>`;
  }

  function imageBubbleHTML(m) {
    const src = m.body || '';
    const time = App.fmtTimeShort(m.createdAt);
    return `<div class="msg image">
      <img src="${App.escapeHTML(src)}" alt="image" onerror="this.style.display='none'" />
      <div class="meta">${App.escapeHTML(time)}</div>
    </div>`;
  }

  function playVoice(btn) {
    const audio = btn.closest('.msg.voice').querySelector('audio.voice-audio');
    if (!audio) return;
    const wave = btn.parentElement.querySelector('.wave');
    if (audio.paused) {
      audio.play();
      btn.textContent = '⏸';
      wave.classList.add('playing');
      audio.onended = () => { btn.textContent = '▶'; wave.classList.remove('playing'); };
    } else {
      audio.pause();
      btn.textContent = '▶';
      wave.classList.remove('playing');
    }
  }

  function formatDateLabel(d) {
    const today = new Date();
    const yest = new Date(); yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ==========================================================
  // History (infinite scroll)
  // ==========================================================
  async function loadHistory(chatId, before) {
    if (Chat.state.loadingHistory) return;
    if (chatId !== Chat.state.activeChatId) return;
    Chat.state.loadingHistory = true;
    if (!before && Chat.state.activeMessages.length) {
      // already loaded
      Chat.state.loadingHistory = false;
      return;
    }
    let url = `/api/messages/${chatId}?limit=50`;
    if (before) url += `&before=${encodeURIComponent(before)}`;
    try {
      const msgs = await App.api('GET', url);
      if (!Array.isArray(msgs) || !msgs.length) {
        Chat.state.hasMoreHistory = false;
      } else {
        // Sort ascending
        msgs.sort((a, b) => (a.id || 0) - (b.id || 0));
        const prevHeight = msgContainer ? msgContainer.scrollHeight : 0;
        const prevTop = msgContainer ? msgContainer.scrollTop : 0;
        // Prepend older messages
        Chat.state.activeMessages = msgs.concat(Chat.state.activeMessages);
        Chat.state.oldestLoadedId = msgs[0].id;
        if (msgs.length < 50) Chat.state.hasMoreHistory = false;
        renderMessages();
        // Preserve scroll position: keep user at same viewport
        if (msgContainer) {
          const newHeight = msgContainer.scrollHeight;
          msgContainer.scrollTop = prevTop + (newHeight - prevHeight);
        }
      }
    } catch (e) {
      App.toast('Failed to load messages: ' + e.message, 'error');
    } finally {
      Chat.state.loadingHistory = false;
    }
  }

  // ==========================================================
  // Send text message
  // ==========================================================
  async function submitText() {
    if (!Chat.state.activeChatId) return;
    const text = (inputTextarea.value || '').trim();
    if (!text) return;
    inputTextarea.value = '';
    inputTextarea.style.height = 'auto';
    const tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const msg = {
      id: tempId,
      chatId: Chat.state.activeChatId,
      senderId: App.user.id,
      body: text,
      kind: 'text',
      createdAt: Date.now() / 1000,
      status: 'sent',
    };
    Chat.state.activeMessages.push(msg);
    renderMessages();
    msgContainer.scrollTop = msgContainer.scrollHeight;
    // Send via WS (preferred) — backend persists + broadcasts
    if (App.wsAuthed) {
      App.wsSend({ type: 'chat_message', chatId: Chat.state.activeChatId, body: text, kind: 'text', tempId });
    } else {
      // Fall back to REST
      try {
        const r = await App.api('POST', '/api/messages', { chatId: Chat.state.activeChatId, body: text, kind: 'text' });
        if (r && r.message) {
          const i = Chat.state.activeMessages.findIndex(x => x.id === tempId);
          if (i >= 0) { Chat.state.activeMessages[i] = r.message; renderMessages(); }
        }
      } catch (e) {
        App.toast('Send failed: ' + e.message, 'error');
      }
    }
    // Clear typing
    sendTyping(false);
  }

  // ==========================================================
  // Code composer
  // ==========================================================
  function openCodeComposer() {
    if (!Chat.state.activeChatId) return;
    const ta = document.createElement('textarea');
    ta.style.cssText = 'width:100%; min-height:160px; font-family:Menlo,Monaco,monospace; font-size:13px; padding:10px; border-radius:6px; border:1px solid var(--border); background:var(--panel-2); color:var(--text); resize:vertical';
    ta.placeholder = 'Paste or type code…';
    const langSel = document.createElement('select');
    ['text','javascript','python','java','c','cpp','csharp','go','sql','xml','shell','json'].forEach(l => {
      const o = document.createElement('option'); o.value = l; o.textContent = l; langSel.appendChild(o);
    });
    langSel.value = 'javascript';
    const wrap = document.createElement('div');
    wrap.appendChild(ta); wrap.appendChild(langSel);
    App.showModal({
      title: 'Send code snippet',
      body: wrap,
      buttons: [
        { label: 'Cancel', kind: 'ghost', onClick: () => false },
        { label: 'Send', onClick: async () => {
          const code = ta.value; if (!code.trim()) return false;
          try {
            const r = await App.api('POST', '/api/messages', {
              chatId: Chat.state.activeChatId, body: code, kind: 'code', codeLang: langSel.value,
            });
            if (r && r.message) {
              Chat.state.activeMessages.push(r.message);
              renderMessages();
              msgContainer.scrollTop = msgContainer.scrollHeight;
            }
          } catch (e) { App.toast(e.message, 'error'); }
        } },
      ],
    });
  }

  // ==========================================================
  // Image send
  // ==========================================================
  function pickAndSendImage() {
    if (!Chat.state.activeChatId) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files && input.files[0]; if (!f) return;
      if (f.size > 2 * 1024 * 1024) { App.toast('Image too large (max 2MB)', 'error'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        const dataURL = reader.result;
        try {
          const r = await App.api('POST', '/api/messages', {
            chatId: Chat.state.activeChatId, body: dataURL, kind: 'image', fileName: f.name,
          });
          if (r && r.message) {
            Chat.state.activeMessages.push(r.message);
            renderMessages();
            msgContainer.scrollTop = msgContainer.scrollHeight;
          }
        } catch (e) { App.toast(e.message, 'error'); }
      };
      reader.readAsDataURL(f);
    };
    input.click();
  }

  // ==========================================================
  // Voice recording (hold mic button)
  // ==========================================================
  async function startVoiceRecording() {
    if (!Chat.state.activeChatId) return;
    if (Chat.state.voiceRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const startTime = Date.now();
      mr.start();
      Chat.state.voiceRecording = { recorder: mr, chunks, startTime, stream };
      // UI: switch input-bar to "recording" state
      inputBar.classList.add('recording');
      inputBar.innerHTML = `
        <div class="rec-timer"><span class="rec-dot"></span><span id="rec-time">0:00</span><span style="font-size:13px">Recording…</span></div>
        <button class="ibtn" id="rec-cancel" aria-label="Cancel recording">✕</button>
        <button class="ibtn send" id="rec-send" aria-label="Send recording" title="Send">➤</button>
      `;
      document.getElementById('rec-cancel').onclick = cancelVoiceRecording;
      document.getElementById('rec-send').onclick = () => stopAndSendVoiceRecording();
      const timerEl = document.getElementById('rec-time');
      Chat.state._recInterval = setInterval(() => {
        const s = Math.floor((Date.now() - startTime) / 1000);
        timerEl.textContent = App.fmtDuration(s);
      }, 250);
    } catch (e) {
      App.toast('Microphone access denied: ' + e.message, 'error');
    }
  }

  function cancelVoiceRecording() {
    const r = Chat.state.voiceRecording; if (!r) return;
    try { r.recorder.stop(); } catch {}
    r.stream.getTracks().forEach(t => t.stop());
    Chat.state.voiceRecording = null;
    clearInterval(Chat.state._recInterval);
    restoreInputBar();
    App.toast('Recording canceled', 'info');
  }

  async function stopAndSendVoiceRecording() {
    const r = Chat.state.voiceRecording; if (!r) return;
    clearInterval(Chat.state._recInterval);
    const duration = Math.max(1, Math.round((Date.now() - r.startTime) / 1000));
    // Show "sending…" state
    inputBar.innerHTML = `<div class="rec-timer" style="color:var(--text-muted)"><span class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--teal)"></span> Sending voice…</div>`;
    await new Promise(resolve => {
      r.recorder.onstop = () => resolve();
      try { if (r.recorder.state !== 'inactive') r.recorder.stop(); else resolve(); } catch { resolve(); }
    });
    r.stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(r.chunks, { type: r.chunks[0] && r.chunks[0].type ? r.chunks[0].type : 'audio/webm' });
    const reader = new FileReader();
    reader.onload = async () => {
      const dataURL = reader.result;
      try {
        const resp = await App.api('POST', '/api/messages', {
          chatId: Chat.state.activeChatId,
          body: dataURL,
          kind: 'voice',
          duration,
          fileName: `voice_${Date.now()}.webm`,
        });
        if (resp && resp.message) {
          Chat.state.activeMessages.push(resp.message);
          renderMessages();
          msgContainer.scrollTop = msgContainer.scrollHeight;
        }
      } catch (e) {
        App.toast('Voice upload failed: ' + e.message, 'error');
      } finally {
        Chat.state.voiceRecording = null;
        restoreInputBar();
      }
    };
    reader.readAsDataURL(blob);
  }

  function restoreInputBar() {
    if (!inputBar || !Chat.state.activeChat) return;
    renderChatView(Chat.state.activeChat);
    renderMessages();
  }

  // ==========================================================
  // Typing + read receipts
  // ==========================================================
  let typingThrottle = 0;
  function sendTypingThrottled(isTyping) {
    const now = Date.now();
    if (now - typingThrottle < 1000) return;
    typingThrottle = now;
    sendTyping(isTyping);
  }
  function sendTyping(isTyping) {
    if (!Chat.state.activeChatId) return;
    App.wsSend({ type: 'typing', chatId: Chat.state.activeChatId, isTyping: !!isTyping });
  }
  function sendRead(chatId) {
    if (!chatId) return;
    if (Chat.state.lastReadAt[chatId] && Date.now() - Chat.state.lastReadAt[chatId] < 1500) return;
    Chat.state.lastReadAt[chatId] = Date.now();
    App.wsSend({ type: 'read', chatId });
    // Optimistically mark messages read locally
    let changed = false;
    Chat.state.activeMessages.forEach(m => {
      if (m.senderId !== App.user.id && m.status !== 'read') { m.status = 'read'; changed = true; }
    });
    if (changed) renderMessages();
    // Clear unread badge
    const c = Chat.state.chats.find(x => x.id === chatId);
    if (c) { c.unread = 0; renderList(); }
  }

  // ==========================================================
  // New chat (find user)
  // ==========================================================
  async function openNewChatDialog() {
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search by name or username…';
    input.style.cssText = 'width:100%; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2); color:var(--text)';
    const results = document.createElement('div');
    results.style.cssText = 'max-height:280px; overflow-y:auto; margin-top:8px';
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) { results.innerHTML = ''; return; }
        results.innerHTML = App.skeletonList(3);
        try {
          const users = await App.api('GET', '/api/users?q=' + encodeURIComponent(q));
          if (!Array.isArray(users) || !users.length) {
            results.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px">No users found.</p>';
            return;
          }
          results.innerHTML = users.map(u => `
            <div class="list-item" data-id="${u.id}" role="button" tabindex="0">
              <div class="avatar">${App.avatarHTML(u, 'md')}</div>
              <div class="info"><div class="name">${App.escapeHTML(u.name)}</div><div class="preview">@${App.escapeHTML(u.username)}</div></div>
            </div>`).join('');
          results.querySelectorAll('.list-item').forEach(el => {
            el.onclick = async () => {
              const uid = parseInt(el.dataset.id, 10);
              App.hideModal();
              await openChatWithPeer(uid);
            };
          });
        } catch (e) { results.innerHTML = `<p style="color:#b91c1c">${App.escapeHTML(e.message)}</p>`; }
      }, 250);
    });
    const wrap = document.createElement('div');
    wrap.appendChild(input); wrap.appendChild(results);
    App.showModal({ title: 'New chat', body: wrap, buttons: [{ label: 'Close', kind: 'ghost' }] });
    setTimeout(() => input.focus(), 50);
  }

  async function openChatWithPeer(peerId) {
    // Try to find existing DM chat
    const existing = Chat.state.chats.find(c => c.type === 'dm' && c.peer && c.peer.id === peerId);
    if (existing) { selectChat(existing.id); return; }
    // Need to load chats first
    if (!Chat.state.chats.length) {
      Chat.state.pendingOpenChatPeerId = peerId;
      loadChats();
      return;
    }
    // No existing chat — fetch user details, then send first message via REST
    // We rely on backend: GET /api/users/:id to show user details, but no chat exists yet.
    // Pragmatic approach: prompt the user to send a first message, which the server will create a DM chat for.
    try {
      const u = await App.api('GET', '/api/users/' + peerId);
      const ta = document.createElement('textarea');
      ta.placeholder = `First message to ${u.name || u.username}…`;
      ta.style.cssText = 'width:100%; min-height:80px; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2); color:var(--text)';
      App.showModal({
        title: 'Start chat with ' + (u.name || u.username),
        body: ta,
        buttons: [
          { label: 'Cancel', kind: 'ghost' },
          { label: 'Send', onClick: async () => {
            const text = ta.value.trim(); if (!text) return false;
            try {
              // Send a chat_message with a special "peerId" so the backend creates a DM chat.
              // We try REST first; if backend expects a chatId, we'll discover via chats list re-load.
              // Send via WS — but we don't have a chatId. Use REST /api/messages with peerId hint.
              // The CONTRACT specifies {chatId} — for a new chat, we POST then reload /api/chats.
              // We attempt with a synthesized body and reload chats; if backend rejects, the user
              // can try after the peer becomes available.
              const r = await App.api('POST', '/api/messages', { chatId: 0, body: text, kind: 'text', peerId: peerId });
              App.hideModal();
              await loadChats();
              const newChat = Chat.state.chats.find(c => c.type === 'dm' && c.peer && c.peer.id === peerId);
              if (newChat) selectChat(newChat.id);
              else App.toast('Message queued — chat will appear shortly', 'info');
            } catch (e) { App.toast(e.message, 'error'); return false; }
          } },
        ],
      });
    } catch (e) { App.toast(e.message, 'error'); }
  }
  Chat.openChatWithPeer = openChatWithPeer;

  // ==========================================================
  // WS handlers — register with App
  // ==========================================================
  App.registerWSHandler('message', (msg) => {
    const m = msg.message; if (!m) return;
    // Active chat?
    if (m.chatId === Chat.state.activeChatId) {
      // De-dupe by id
      const exists = Chat.state.activeMessages.find(x => x.id === m.id || x.id === msg.tempId);
      if (!exists) {
        Chat.state.activeMessages.push(m);
        // Sort by id
        Chat.state.activeMessages.sort((a,b) => (a.id||0) - (b.id||0));
        renderMessages();
        if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
        // If incoming (not from me), send read receipt
        if (m.senderId !== App.user.id) sendRead(m.chatId);
      } else {
        // Update existing (e.g., tempId → real id, status)
        const i = Chat.state.activeMessages.findIndex(x => x === exists);
        if (i >= 0) { Chat.state.activeMessages[i] = Object.assign({}, exists, m); renderMessages(); }
      }
    }
    // Update chat list preview
    const c = Chat.state.chats.find(x => x.id === m.chatId);
    if (c) {
      c.lastMessage = m;
      if (m.senderId !== App.user.id) c.unread = (c.unread || 0) + (m.chatId === Chat.state.activeChatId ? 0 : 1);
      // Move to top
      Chat.state.chats = [c].concat(Chat.state.chats.filter(x => x.id !== c.id));
      renderList();
    } else {
      // New chat not in list yet — reload
      loadChats();
    }
  });

  App.registerWSHandler('typing', (msg) => {
    const { chatId, userId, isTyping } = msg;
    if (!chatId || userId === App.user.id) return;
    if (!Chat.state.peersTyping[chatId]) Chat.state.peersTyping[chatId] = new Set();
    if (isTyping) Chat.state.peersTyping[chatId].add(userId);
    else Chat.state.peersTyping[chatId].delete(userId);
    if (chatId === Chat.state.activeChatId) renderMessages();
  });

  App.registerWSHandler('read', (msg) => {
    const { chatId } = msg;
    if (chatId !== Chat.state.activeChatId) return;
    // Mark my messages as read
    let changed = false;
    Chat.state.activeMessages.forEach(m => {
      if (m.senderId === App.user.id && m.status !== 'read') { m.status = 'read'; changed = true; }
    });
    if (changed) renderMessages();
  });

  App.registerWSHandler('status_new', (msg) => {
    // Status feed handled by Status module — but we don't do anything here.
  });

  // ==========================================================
  // Presence handler
  // ==========================================================
  Chat.onPresence = function (userId, info) {
    // Update chat list peer's online flag
    let changed = false;
    Chat.state.chats.forEach(c => {
      if (c.peer && c.peer.id === userId) {
        c.peer.online = info.online;
        c.peer.lastSeen = info.lastSeen;
        changed = true;
      }
    });
    if (changed) renderList();
    // Update active chat header
    if (Chat.state.activeChat && Chat.state.activeChat.peer && Chat.state.activeChat.peer.id === userId) {
      const sub = document.getElementById('main-header-sub');
      if (sub) {
        sub.textContent = info.online ? 'online' : (info.lastSeen ? 'last seen ' + App.fmtRelative(info.lastSeen) : '');
      }
    }
  };
})();
