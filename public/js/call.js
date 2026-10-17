/* =====================================================================
 * BantuChat — call.js
 * Voice call UI + WebRTC signaling.
 *  • Full-screen modal: peer avatar, "calling…" / "00:12" timer,
 *    mute + speaker + hangup (and accept for incoming)
 *  • getUserMedia({audio:true}) for mic capture
 *  • RTCPeerConnection (no STUN needed for local demo; reads
 *    /api/stun-info as ICE hint when available)
 *  • Signaling via WS: call_offer / call_answer / call_ice / call_end
 *    / call_reject (server relays)
 *  • Remote audio via <audio> + ontrack
 *  • Initiate via POST /api/call/start {peerId, kind:"voice"}
 *
 * Exposes: window.Call  (global)
 * ===================================================================== */
(function () {
  'use strict';

  const Call = window.Call = {
    state: {
      callId: null,
      peerId: null,
      peerName: null,
      direction: null,         // 'out' | 'in'
      pc: null,                // RTCPeerConnection
      localStream: null,
      remoteStream: null,
      audioEl: null,
      timerStart: null,
      timerInterval: null,
      muted: false,
      speaker: true,
      pendingOffer: null,
    },
  };

  // ==========================================================
  // Initiate outgoing call
  // ==========================================================
  Call.startCall = async function (peerId, peerName) {
    if (Call.state.callId) { App.toast('Already in a call', 'info'); return; }
    Call.state.direction = 'out';
    Call.state.peerId = peerId;
    Call.state.peerName = peerName || 'Unknown';
    showCallModal({ incoming: false });

    // Ask server to create call row + signal the peer
    let callId = null;
    try {
      const r = await App.api('POST', '/api/call/start', { peerId, kind: 'voice' });
      if (r && r.callId) callId = r.callId;
    } catch (e) {
      App.toast('Could not start call: ' + e.message, 'error');
      closeCallModal();
      return;
    }
    if (!callId) {
      App.toast('No callId from server', 'error');
      closeCallModal();
      return;
    }
    Call.state.callId = callId;

    // Capture local audio
    try {
      Call.state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      App.toast('Microphone access denied: ' + e.message, 'error');
      endCall('missed');
      return;
    }

    // Create peer connection
    await createPeerConnection();
    // Add local tracks
    Call.state.localStream.getTracks().forEach(t => {
      try { Call.state.pc.addTrack(t, Call.state.localStream); } catch {}
    });

    // Create offer
    try {
      const offer = await Call.state.pc.createOffer({ offerToReceiveAudio: true });
      await Call.state.pc.setLocalDescription(offer);
      App.wsSend({ type: 'call_offer', callId, peerId, sdp: Call.state.pc.localDescription });
    } catch (e) {
      App.toast('Failed to create offer: ' + e.message, 'error');
      endCall('missed');
    }
  };

  // ==========================================================
  // Create RTCPeerConnection
  // ==========================================================
  async function createPeerConnection() {
    // Try to read /api/stun-info for server's public IP hint (per contract).
    // For local demo this is optional; we provide Google STUN as fallback.
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const info = await App.api('GET', '/api/stun-info');
      if (info && info.publicIp) {
        // Hint: add a host candidate hint
        iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:' + info.publicIp + (info.port ? ':' + info.port : ':3478') }];
      }
    } catch (e) { /* ignore — optional */ }

    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 0 });
    Call.state.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        App.wsSend({
          type: 'call_ice',
          callId: Call.state.callId,
          peerId: Call.state.peerId,
          candidate: ev.candidate,
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        App.toast('ICE failed — try restarting the call', 'error');
      }
    };
    pc.ontrack = (ev) => {
      Call.state.remoteStream = ev.streams[0];
      const audio = Call.state.audioEl || document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = ev.streams[0];
      Call.state.audioEl = audio;
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && Call.state.timerStart === null) {
        startTimer();
        setState('In call');
      }
    };
    return pc;
  }

  // ==========================================================
  // WS handlers (server → client)
  // ==========================================================
  App.registerWSHandler('call_incoming', (msg) => {
    if (Call.state.callId) {
      // Already in a call — reject automatically
      App.wsSend({ type: 'call_reject', callId: msg.callId });
      return;
    }
    Call.state.callId = msg.callId;
    Call.state.peerId = msg.fromUserId;
    Call.state.direction = 'in';
    // Look up peer name
    App.api('GET', '/api/users/' + msg.fromUserId).then(u => {
      Call.state.peerName = (u && (u.name || u.username)) || 'Caller';
      showCallModal({ incoming: true });
    }).catch(() => {
      Call.state.peerName = 'Caller';
      showCallModal({ incoming: true });
    });
  });

  App.registerWSHandler('call_offer', async (msg) => {
    if (!Call.state.callId || msg.callId !== Call.state.callId) {
      // Spontaneous offer — accept it (we may have missed call_incoming)
      Call.state.callId = msg.callId;
      Call.state.peerId = msg.fromUserId;
      Call.state.direction = 'in';
      try {
        const u = await App.api('GET', '/api/users/' + msg.fromUserId);
        Call.state.peerName = (u && (u.name || u.username)) || 'Caller';
      } catch { Call.state.peerName = 'Caller'; }
      // Need local audio before we can answer
      if (!Call.state.localStream) {
        try { Call.state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { App.wsSend({ type: 'call_reject', callId: msg.callId }); return; }
      }
      showCallModal({ incoming: false });
      await createPeerConnection();
      Call.state.localStream.getTracks().forEach(t => Call.state.pc.addTrack(t, Call.state.localStream));
      await Call.state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const ans = await Call.state.pc.createAnswer();
      await Call.state.pc.setLocalDescription(ans);
      App.wsSend({ type: 'call_answer', callId: msg.callId, peerId: msg.fromUserId, sdp: ans });
      return;
    }

    // We are the caller? No, caller doesn't receive offers. We must be the callee.
    if (!Call.state.pc) {
      if (!Call.state.localStream) {
        try { Call.state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { App.wsSend({ type: 'call_reject', callId: msg.callId }); return; }
      }
      await createPeerConnection();
      Call.state.localStream.getTracks().forEach(t => Call.state.pc.addTrack(t, Call.state.localStream));
    }
    try {
      await Call.state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const ans = await Call.state.pc.createAnswer();
      await Call.state.pc.setLocalDescription(ans);
      App.wsSend({ type: 'call_answer', callId: msg.callId, peerId: msg.fromUserId, sdp: ans });
    } catch (e) {
      App.toast('Failed to answer: ' + e.message, 'error');
    }
  });

  App.registerWSHandler('call_answer', async (msg) => {
    if (!Call.state.callId || msg.callId !== Call.state.callId) return;
    if (!Call.state.pc) return;
    try {
      await Call.state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch (e) {
      App.toast('Failed to set remote answer: ' + e.message, 'error');
    }
  });

  App.registerWSHandler('call_ice', async (msg) => {
    if (!Call.state.callId || msg.callId !== Call.state.callId) return;
    if (!Call.state.pc) {
      // Buffer until pc is up
      Call.state.pendingIce = Call.state.pendingIce || [];
      Call.state.pendingIce.push(msg.candidate);
      return;
    }
    try {
      const c = msg.candidate ? new RTCIceCandidate(msg.candidate) : null;
      if (c) await Call.state.pc.addIceCandidate(c);
    } catch (e) { /* ICE errors are non-fatal */ }
  });

  App.registerWSHandler('call_end', (msg) => {
    if (!Call.state.callId || msg.callId !== Call.state.callId) return;
    const reason = msg.reason || 'ended';
    closeCallModal();
    if (reason === 'rejected') App.toast('Call rejected', 'info');
    else if (reason === 'missed') App.toast('Call missed', 'info');
    else if (reason === 'ended') { /* silent */ }
    cleanupCall();
  });

  // ==========================================================
  // Accept incoming
  // ==========================================================
  Call.acceptIncoming = async function () {
    if (!Call.state.callId) return;
    try {
      Call.state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      App.toast('Microphone access denied', 'error');
      App.wsSend({ type: 'call_reject', callId: Call.state.callId });
      endCall('rejected');
      return;
    }
    await createPeerConnection();
    Call.state.localStream.getTracks().forEach(t => Call.state.pc.addTrack(t, Call.state.localStream));
    // If we already received an offer, it's set; else wait for offer
    setState('In call');
    // The caller will receive our accept implicitly when we send the answer
    // (server may want an explicit accept — we just rely on the offer flow.)
  };

  // ==========================================================
  // Reject / hangup
  // ==========================================================
  Call.rejectIncoming = function () {
    if (!Call.state.callId) return;
    App.wsSend({ type: 'call_reject', callId: Call.state.callId });
    closeCallModal();
    cleanupCall();
  };
  Call.hangup = function () { endCall('ended'); };

  function endCall(reason) {
    if (!Call.state.callId) return;
    App.wsSend({ type: 'call_end', callId: Call.state.callId });
    closeCallModal();
    cleanupCall();
    if (Call.state.direction === 'out' && reason === 'missed' && Call.state.peerName) {
      App.toast(`Call to ${Call.state.peerName} not answered`, 'info');
    }
  }

  function cleanupCall() {
    if (Call.state.localStream) {
      Call.state.localStream.getTracks().forEach(t => t.stop());
    }
    if (Call.state.pc) {
      try { Call.state.pc.close(); } catch {}
    }
    if (Call.state.audioEl) {
      try { Call.state.audioEl.srcObject = null; } catch {}
    }
    if (Call.state.timerInterval) clearInterval(Call.state.timerInterval);
    Call.state = {
      callId: null, peerId: null, peerName: null, direction: null,
      pc: null, localStream: null, remoteStream: null, audioEl: null,
      timerStart: null, timerInterval: null, muted: false, speaker: true,
      pendingOffer: null,
    };
  }

  // ==========================================================
  // UI helpers
  // ==========================================================
  function showCallModal({ incoming }) {
    const modal = document.getElementById('call-modal');
    const nameEl = document.getElementById('call-name');
    const stateEl = document.getElementById('call-state');
    const avatarEl = document.getElementById('call-avatar');
    const actions = document.getElementById('call-actions');
    nameEl.textContent = Call.state.peerName || 'Unknown';
    avatarEl.innerHTML = App.avatarHTML({ name: Call.state.peerName }, 'xl');
    modal.classList.toggle('incoming', incoming);
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');

    if (incoming) {
      stateEl.textContent = 'Incoming call…';
      actions.innerHTML = `
        <button class="call-btn accept" id="call-accept" aria-label="Accept">📞</button>
        <button class="call-btn hangup" id="call-reject" aria-label="Reject">✕</button>
      `;
      document.getElementById('call-accept').onclick = Call.acceptIncoming;
      document.getElementById('call-reject').onclick = Call.rejectIncoming;
    } else {
      stateEl.textContent = 'calling…';
      actions.innerHTML = `
        <button class="call-btn mute" id="call-mute" aria-label="Mute">🎤</button>
        <button class="call-btn speaker" id="call-speaker" aria-label="Speaker">🔊</button>
        <button class="call-btn hangup" id="call-hangup" aria-label="Hang up">📞</button>
      `;
      bindCallControls();
    }
  }
  function closeCallModal() {
    const modal = document.getElementById('call-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.classList.remove('incoming');
    modal.setAttribute('aria-hidden', 'true');
  }
  function bindCallControls() {
    const muteBtn = document.getElementById('call-mute');
    const spkBtn = document.getElementById('call-speaker');
    const hpBtn = document.getElementById('call-hangup');
    if (muteBtn) muteBtn.onclick = () => {
      Call.state.muted = !Call.state.muted;
      if (Call.state.localStream) {
        Call.state.localStream.getAudioTracks().forEach(t => t.enabled = !Call.state.muted);
      }
      muteBtn.classList.toggle('on', Call.state.muted);
      muteBtn.textContent = Call.state.muted ? '🔇' : '🎤';
      muteBtn.setAttribute('aria-pressed', Call.state.muted);
    };
    if (spkBtn) spkBtn.onclick = () => {
      Call.state.speaker = !Call.state.speaker;
      if (Call.state.audioEl) {
        try { Call.state.audioEl.volume = Call.state.speaker ? 1 : 0; } catch {}
      }
      spkBtn.classList.toggle('on', Call.state.speaker);
      spkBtn.textContent = Call.state.speaker ? '🔊' : '🔈';
      spkBtn.setAttribute('aria-pressed', Call.state.speaker);
    };
    if (hpBtn) hpBtn.onclick = Call.hangup;
  }

  function startTimer() {
    Call.state.timerStart = Date.now();
    const stateEl = document.getElementById('call-state');
    if (Call.state.timerInterval) clearInterval(Call.state.timerInterval);
    Call.state.timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - Call.state.timerStart) / 1000);
      if (stateEl) stateEl.textContent = App.fmtDuration(s);
    }, 500);
  }
  function setState(text) {
    const el = document.getElementById('call-state');
    if (el) el.textContent = text;
  }

  // ==========================================================
  // "Calls" view — call history list + "start call" via user search.
  // Registered as a view with App so the sidebar tab works.
  // ==========================================================
  let callsListEl, callsPaneEl;

  App.registerView('calls', {
    enter(list, pane) {
      callsListEl = list; callsPaneEl = pane;
      list.innerHTML = `
        <div class="search-bar">
          <input id="call-search" type="search" placeholder=" 🔍  Find a user to call" aria-label="Find a user to call" />
        </div>
        <div id="call-search-results"></div>
      `;
      pane.innerHTML = `
        <div class="empty-state">
          <div class="icon">📞</div>
          <h3>Recent calls</h3>
          <p>Your voice call history will appear here. Use the search on the left to find a user and start a new call.</p>
        </div>
      `;
      const searchInput = document.getElementById('call-search');
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (!q) { document.getElementById('call-search-results').innerHTML = ''; return; }
        clearTimeout(Call._searchTimer);
        Call._searchTimer = setTimeout(async () => {
          const res = document.getElementById('call-search-results');
          res.innerHTML = App.skeletonList(2);
          try {
            const users = await App.api('GET', '/api/users?q=' + encodeURIComponent(q));
            if (!Array.isArray(users) || !users.length) {
              res.innerHTML = '<p style="color:var(--text-muted); padding:12px 14px; font-size:13px">No users found.</p>';
              return;
            }
            res.innerHTML = users.map(u => `
              <div class="list-item" data-id="${u.id}" role="button" tabindex="0">
                <div class="avatar">${App.avatarHTML(u, 'lg')}</div>
                <div class="info">
                  <div class="top"><span class="name">${App.escapeHTML(u.name)}</span></div>
                  <div class="preview">@${App.escapeHTML(u.username)}</div>
                </div>
                <button class="btn ghost" data-act="call" style="min-height:36px;padding:6px 12px" aria-label="Call ${App.escapeHTML(u.name)}">📞</button>
              </div>`).join('');
            res.querySelectorAll('.list-item').forEach(el => {
              const callBtn = el.querySelector('button[data-act="call"]');
              callBtn.onclick = async (e) => {
                e.stopPropagation();
                const uid = parseInt(el.dataset.id, 10);
                const name = el.querySelector('.name').textContent;
                await Call.startCall(uid, name);
              };
            });
          } catch (e) { res.innerHTML = `<p style="color:#b91c1c;padding:12px 14px">${App.escapeHTML(e.message)}</p>`; }
        }, 250);
      });
      // Load call history
      loadCallHistory();
    },
    leave() {},
  });

  async function loadCallHistory() {
    try {
      const r = await App.api('GET', '/api/calls');
      const list = Array.isArray(r) ? r : [];
      if (!list.length) {
        callsPaneEl.innerHTML = `
          <div class="empty-state">
            <div class="icon">📞</div>
            <h3>No calls yet</h3>
            <p>Find a user on the left and tap the 📞 button to start a voice call.</p>
          </div>`;
        return;
      }
      callsPaneEl.innerHTML = `
        <div class="profile-pane">
          <div class="profile-section">
            <h4>Call history</h4>
            ${list.map(c => callRowHTML(c)).join('')}
          </div>
        </div>`;
    } catch (e) {
      callsPaneEl.innerHTML = `<div class="empty-state"><p>Failed to load calls: ${App.escapeHTML(e.message)}</p></div>`;
    }
  }

  function callRowHTML(c) {
    const outgoing = c.fromUserId === App.user.id;
    const icon = outgoing ? '↗' : '↙';
    const color = c.status === 'missed' ? '#dc3545' : 'var(--teal)';
    const otherUserId = outgoing ? c.toUserId : c.fromUserId;
    const direction = outgoing ? 'Outgoing' : 'Incoming';
    const time = App.fmtTime(c.startedAt);
    const dur = c.duration ? App.fmtDuration(c.duration) : (c.status === 'missed' ? '—' : '0:00');
    return `
      <div class="profile-row" data-uid="${otherUserId}" style="cursor:pointer">
        <div style="font-size:18px; color:${color}; width:24px; text-align:center">${icon}</div>
        <div class="pr-label">
          <span>${App.escapeHTML(direction)} — user #${otherUserId}</span>
          <span class="sub">${App.escapeHTML(time)} · ${App.escapeHTML(c.status || 'ended')}${c.duration ? ' · ' + App.fmtDuration(c.duration) : ''}</span>
        </div>
        <div class="pr-val">${App.escapeHTML(dur)}</div>
      </div>`;
  }

  // ==========================================================
  // Re-bind controls when modal opens (already done in showCallModal)
  // Also bind static modal buttons as a fallback (so it works even if showCallModal didn't run)
  // ==========================================================
  document.addEventListener('DOMContentLoaded', () => {
    const hp = document.getElementById('call-hangup');
    if (hp && !hp.onclick) hp.onclick = Call.hangup;
    const mu = document.getElementById('call-mute');
    if (mu && !mu.onclick) {
      mu.onclick = () => {
        Call.state.muted = !Call.state.muted;
        if (Call.state.localStream) {
          Call.state.localStream.getAudioTracks().forEach(t => t.enabled = !Call.state.muted);
        }
        mu.classList.toggle('on', Call.state.muted);
        mu.textContent = Call.state.muted ? '🔇' : '🎤';
      };
    }
  });
})();
