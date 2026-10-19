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

  // ==========================================================
  // Default ICE server list
  //
  // The server can override this via GET /api/ice-servers, but these
  // defaults always work as a fallback.
  //
  // What's in here and why:
  //
  //   • stun.l.google.com:19302  — Google's public STUN. Standard,
  //     widely reachable. Used by ~all WebRTC demos.
  //
  //   • stun.cloudflare.com:3478 — Cloudflare's public STUN. Different
  //     port (3478 vs 19302) and different operator — important for
  //     networks that block one but not the other (some corporate
  //     firewalls, some hotel Wi-Fi).
  //
  //   • OpenRelay TURN servers (metered.ca) — FREE public TURN relay
  //     with shared credentials. This is the crucial piece for
  //     cross-network calls: when both peers are behind symmetric NAT
  //     (mobile carriers, carrier-grade NAT, some corporate Wi-Fi),
  //     STUN cannot punch through. The only option is to relay all
  //     audio through a TURN server.
  //
  //     OpenRelay runs two regions (US and Asia-Pacific) — WebRTC
  //     will pick the one with the lowest latency automatically.
  //
  //     Credentials are public and shared — Metered.ca explicitly
  //     publishes them for testing/dev use. For production you'd run
  //     your own TURN (coturn) with rotating credentials via
  //     /api/ice-servers.
  //
  //   • Without a TURN server, calls across different networks fail
  //     silently — exactly the symptom the user reported: "works on
  //     same network, fails on different networks".
  // ==========================================================
  const DEFAULT_ICE_SERVERS = [
    // Google STUN — primary
    { urls: 'stun:stun.l.google.com:19302' },
    // Cloudflare STUN — fallback on networks that block Google
    { urls: 'stun:stun.cloudflare.com:3478' },
    // OpenRelay TURN — global relay, used automatically by WebRTC
    // when STUN fails (symmetric NAT, CGNAT, etc.)
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    // OpenRelay also runs a US-East relay for lower-latency NA/SA users
    {
      urls: 'turn:openrelay.metered.ca:443?transport=udp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

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
      pendingOffer: null,      // buffered SDP offer that arrived before user clicked Accept
      pendingIce: [],          // buffered ICE candidates that arrived before PC was created
      accepted: false,         // has the callee clicked Accept (or caller has SendOffer)?
    },
  };

  // ==========================================================
  // Audio element — created ONCE and attached to <body> so the
  // browser's autoplay policy doesn't block remote audio playback.
  // Some browsers (Chrome, Edge) refuse to play <audio> elements
  // that are not in the DOM tree, even after a user gesture.
  // ==========================================================
  function ensureAudioElement() {
    if (Call.state.audioEl && document.body.contains(Call.state.audioEl)) {
      return Call.state.audioEl;
    }
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', 'true');
    el.style.position = 'fixed';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    Call.state.audioEl = el;
    return el;
  }

  // Try to play the remote audio. If autoplay is blocked (no recent
  // user gesture), retry on the next user interaction.
  function playRemoteAudio() {
    const el = Call.state.audioEl;
    if (!el || !el.srcObject) return;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => {
        // Autoplay blocked — retry on next user gesture.
        const retry = () => {
          el.play().catch(() => {});
          document.removeEventListener('click', retry);
          document.removeEventListener('touchstart', retry);
          document.removeEventListener('keydown', retry);
        };
        document.addEventListener('click', retry, { once: true });
        document.addEventListener('touchstart', retry, { once: true });
        document.addEventListener('keydown', retry, { once: true });
      });
    }
  }

  // Flush any ICE candidates that arrived before the PC was ready
  // (PC was null, OR remoteDescription was null because the offer hadn't
  // arrived yet). Both preconditions must be met before addIceCandidate
  // can be called without throwing InvalidStateError.
  async function flushPendingIce() {
    if (!canApplyIce()) return;
    const pending = Call.state.pendingIce || [];
    Call.state.pendingIce = [];
    for (const c of pending) {
      if (!c) continue;
      try {
        await Call.state.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        // ICE errors are non-fatal — log to console for debugging
        console.warn('[call] flush addIceCandidate failed:', e.message);
      }
    }
  }

  // ==========================================================
  // Initiate outgoing call
  // ==========================================================
  Call.startCall = async function (peerId, peerName) {
    if (Call.state.callId) { App.toast('Already in a call', 'info'); return; }
    Call.state.direction = 'out';
    Call.state.peerId = peerId;
    Call.state.peerName = peerName || 'Unknown';
    Call.state.accepted = true;       // caller implicitly "accepted" the call
    showCallModal({ incoming: false });

    // Pre-create the audio element so it's in the DOM and ready when
    // the remote track arrives (avoids autoplay-policy issues).
    ensureAudioElement();

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
    // Note: do NOT flush pending ICE here — as the caller, we haven't
    // received the answer yet, so remoteDescription is null.
    // flushPendingIce() is called in the call_answer handler after
    // setRemoteDescription(answer) completes.

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
  //
  // ICE server list — used by WebRTC to traverse NATs.
  //
  // Three kinds of candidates WebRTC tries to gather:
  //   1. Host candidates — local IP, only works on the same LAN.
  //      This is why calls work when both users are on the same
  //      network and fail on different networks.
  //   2. Server-reflexive (srflx) — public IP discovered via STUN.
  //      Works across different networks when the NAT is "cone-shaped"
  //      (most home routers, most cellular hotspots in fallback mode).
  //   3. Relay (relay) — packets go through a TURN server. The only
  //      thing that works behind symmetric NAT (carrier-grade NAT,
  //      some corporate Wi-Fi, some hotel/Airbnb networks). Without
  //      a TURN server, calls behind symmetric NAT simply cannot
  //      connect.
  //
  // The previous code pointed a "STUN query" at the BantuChat server's
  // public IP — but the BantuChat server is NOT a STUN server, so that
  // did nothing. We now use:
  //   • Google STUN  (19302) — the de-facto default, widely reachable
  //   • Cloudflare STUN (3478) — alternative for networks that block
  //     Google's STUN port
  //   • OpenRelay TURN — free public TURN relay run by Metered.ca
  //     with shared credentials, used automatically by WebRTC when
  //     direct connection fails. Without this, calls across symmetric
  //     NATs (mobile carriers, some home routers, corporate Wi-Fi)
  //     will fail with "ICE failed" — exactly the symptom reported.
  // ==========================================================
  async function createPeerConnection() {
    // Try to fetch the ICE config from the server (lets us rotate TURN
    // credentials without redeploying the client). Falls back to the
    // hardcoded list if the endpoint is unavailable.
    let iceServers = DEFAULT_ICE_SERVERS;
    try {
      const cfg = await App.api('GET', '/api/ice-servers');
      if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
        iceServers = cfg.iceServers;
      }
    } catch (e) { /* server older than this client — use defaults */ }

    const pc = new RTCPeerConnection({
      iceServers,
      // Pre-allocate 4 ICE candidate ports. Speeds up gathering and
      // makes connection setup more reliable on flaky networks.
      iceCandidatePoolSize: 4,
    });
    Call.state.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        App.wsSend({
          type: 'call_ice',
          callId: Call.state.callId,
          peerId: Call.state.peerId,
          candidate: ev.candidate,
        });
      } else {
        // null candidate = end of local ICE gathering.
        // Could send an explicit "end-of-candidates" signal, but most
        // modern browsers handle the trickle-ICE timeout correctly
        // without it. Just log for debugging.
        console.debug('[call] ICE gathering complete');
      }
    };
    pc.onicegatheringstatechange = () => {
      console.debug('[call] ICE gathering state:', pc.iceGatheringState);
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      console.debug('[call] ICE connection state:', st);
      if (st === 'failed') {
        // ICE failed — typically means we exhausted STUN and have no
        // TURN path. Show a clear message so the user understands
        // what's wrong (instead of just silence).
        App.toast('Connection failed — likely a NAT/firewall issue. Try a different network or use a TURN relay.', 'error');
        // Trigger an ICE restart — this is the standard recovery path
        // when ICE fails. The new offer will trigger fresh candidate
        // gathering and possibly pick a relay path that works.
        try {
          if (Call.state.direction === 'out' && Call.state.pc) {
            pc.restartIce();
            // Re-negotiate: create a new offer with iceRestart: true.
            pc.createOffer({ iceRestart: true }).then(offer => {
              pc.setLocalDescription(offer).then(() => {
                App.wsSend({
                  type: 'call_offer',
                  callId: Call.state.callId,
                  peerId: Call.state.peerId,
                  sdp: pc.localDescription,
                });
              });
            }).catch(() => {});
          }
        } catch (e) { /* non-fatal */ }
      }
    };
    pc.ontrack = (ev) => {
      // Use the persistent audio element (already in <body>) so autoplay
      // works. Some browsers refuse to play detached <audio> elements
      // and silently drop the audio — exactly the "one-way audio"
      // symptom the user reported.
      const audio = ensureAudioElement();
      // Build a fresh MediaStream if the event has none (some Chrome versions
      // fire ontrack with ev.streams[0] === undefined but ev.track set).
      let stream = ev.streams && ev.streams[0];
      if (!stream) {
        stream = new MediaStream();
        if (ev.track) stream.addTrack(ev.track);
      }
      Call.state.remoteStream = stream;
      audio.srcObject = stream;
      // Explicitly unmute (speaker button state).
      audio.muted = false;
      audio.volume = Call.state.speaker ? 1 : 0;
      // Try to play. If autoplay blocks it, the helper will retry on the
      // next user gesture (the Accept button counts as a gesture).
      playRemoteAudio();
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
      // Spontaneous offer — we missed the call_incoming (or the server
      // didn't send one). Set up state and show the incoming call modal
      // so the USER can choose to accept or reject — we must NOT
      // auto-answer, because doing so would (a) create a PC before the
      // user has granted mic permission, (b) trigger autoplay-policy
      // violations for the remote audio, and (c) result in the user
      // clicking Accept later, which would create a SECOND PC and
      // break the audio path negotiated by the first one.
      Call.state.callId = msg.callId;
      Call.state.peerId = msg.fromUserId;
      Call.state.direction = 'in';
      Call.state.accepted = false;
      try {
        const u = await App.api('GET', '/api/users/' + msg.fromUserId);
        Call.state.peerName = (u && (u.name || u.username)) || 'Caller';
      } catch { Call.state.peerName = 'Caller'; }
      // Buffer the offer; acceptIncoming will process it.
      Call.state.pendingOffer = msg;
      showCallModal({ incoming: true });
      return;
    }

    // If we got here, the callId matches. Are we the callee (direction=in)
    // who hasn't clicked Accept yet? Buffer the offer.
    if (Call.state.direction === 'in' && !Call.state.accepted) {
      Call.state.pendingOffer = msg;
      return;
    }

    // Otherwise we are either the caller (shouldn't receive offers) or
    // the callee who HAS clicked Accept and has a PC. Process the offer
    // immediately: set remote desc, create answer, send it.
    if (!Call.state.pc) {
      // Defensive: shouldn't happen, but if it does, create the PC now.
      if (!Call.state.localStream) {
        try { Call.state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { App.wsSend({ type: 'call_reject', callId: msg.callId }); return; }
      }
      await createPeerConnection();
      Call.state.localStream.getTracks().forEach(t => Call.state.pc.addTrack(t, Call.state.localStream));
      // Note: do NOT flush pending ICE here — remoteDescription is null
      // until setRemoteDescription() below. The flush happens after.
    }
    try {
      await Call.state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      // Flush any ICE candidates that arrived before the offer was set.
      // Without this, candidates buffered when remoteDescription was null
      // are silently dropped — exactly the symptom reported (one-way
      // audio because ICE only completes in one direction).
      await flushPendingIce();
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
      // Flush any ICE candidates that arrived before the answer was set.
      await flushPendingIce();
    } catch (e) {
      App.toast('Failed to set remote answer: ' + e.message, 'error');
    }
  });

  // ==========================================================
  // ICE candidate buffering
  //
  // WebRTC's RTCPeerConnection.addIceCandidate() has TWO preconditions:
  //   1. A PC must exist (we created one in createPeerConnection)
  //   2. remoteDescription must be set (the caller's offer must have been
  //      applied via setRemoteDescription)
  //
  // The previous code only checked condition #1. When the caller's
  // ICE gathering finished BEFORE the offer arrived (a common network
  // race — UDP candidate frames can overtake the WebSocket offer frame),
  // the callee would receive `call_ice` after creating the PC but before
  // setting the remote description, then call `addIceCandidate(c)` on
  // a PC with `remoteDescription === null` → InvalidStateError, which
  // surfaced in the console as:
  //
  //   "Failed to execute 'addIceCandidate' on 'RTCPeerConnection':
  //    The remote description was null"
  //
  // The fix: also buffer candidates when remoteDescription is null,
  // and flush them after setRemoteDescription() completes.
  // ==========================================================
  function bufferIceCandidate(candidate) {
    if (!candidate) return;
    Call.state.pendingIce = Call.state.pendingIce || [];
    Call.state.pendingIce.push(candidate);
  }

  function canApplyIce() {
    const pc = Call.state.pc;
    if (!pc) return false;
    // The spec says addIceCandidate can be called after setLocalDescription
    // on the answerer side too, BUT in practice some browsers refuse if
    // remoteDescription is null. We require remoteDescription to be set.
    if (!pc.remoteDescription || pc.remoteDescription.type === '') return false;
    return true;
  }

  App.registerWSHandler('call_ice', async (msg) => {
    if (!Call.state.callId || msg.callId !== Call.state.callId) return;
    if (!msg.candidate) return;
    // Buffer if PC is null OR remoteDescription is null
    if (!canApplyIce()) {
      bufferIceCandidate(msg.candidate);
      return;
    }
    try {
      await Call.state.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (e) {
      // ICE errors are non-fatal — log to console for debugging
      console.warn('[call] addIceCandidate failed:', e.message);
    }
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
    // Pre-create the audio element so it's in the DOM and ready when
    // the remote track arrives (also counts as "user gesture" context
    // for autoplay purposes since this runs from the Accept click).
    ensureAudioElement();
    try {
      Call.state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      App.toast('Microphone access denied', 'error');
      App.wsSend({ type: 'call_reject', callId: Call.state.callId });
      endCall('rejected');
      return;
    }
    Call.state.accepted = true;       // mark BEFORE creating PC so the offer handler knows
    await createPeerConnection();
    Call.state.localStream.getTracks().forEach(t => Call.state.pc.addTrack(t, Call.state.localStream));
    // Note: we do NOT call flushPendingIce() here because remoteDescription
    // is still null at this point (the offer hasn't been applied yet).
    // flushPendingIce() is called AFTER setRemoteDescription() below.

    // If we already received the offer (it was buffered in pendingOffer),
    // process it now: set remote desc, create answer, send it.
    if (Call.state.pendingOffer) {
      const msg = Call.state.pendingOffer;
      Call.state.pendingOffer = null;
      try {
        await Call.state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        // Flush any ICE candidates that arrived while remoteDescription
        // was null. This is THE critical fix for the InvalidStateError
        // ("The remote description was null") — candidates buffered
        // before the offer was set are now applied.
        await flushPendingIce();
        const ans = await Call.state.pc.createAnswer();
        await Call.state.pc.setLocalDescription(ans);
        App.wsSend({ type: 'call_answer', callId: msg.callId, peerId: msg.fromUserId, sdp: ans });
      } catch (e) {
        App.toast('Failed to answer: ' + e.message, 'error');
        endCall('ended');
        return;
      }
    }
    // If we haven't received the offer yet, the call_offer handler
    // will pick it up when it arrives (because Call.state.accepted is
    // true and Call.state.pc exists).
    setState('Ringing…');
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
      try {
        Call.state.audioEl.srcObject = null;
        Call.state.audioEl.pause();
      } catch {}
      // Leave the audio element in the DOM — it'll be reused for the
      // next call. Removing it can cause autoplay-policy issues on the
      // next call because we lose the "user-initiated" gesture context.
    }
    if (Call.state.timerInterval) clearInterval(Call.state.timerInterval);
    Call.state = {
      callId: null, peerId: null, peerName: null, direction: null,
      pc: null, localStream: null, remoteStream: null,
      audioEl: Call.state.audioEl,  // preserve the DOM-attached audio element
      timerStart: null, timerInterval: null, muted: false, speaker: true,
      pendingOffer: null, pendingIce: [], accepted: false,
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
        try {
          // Use muted instead of volume=0 — volume=0 can interact badly
          // with autoplay-policy on some browsers, and a "muted=true"
          // element can still be played (so we don't lose the play()
          // permission) — we just toggle the mute flag.
          Call.state.audioEl.muted = !Call.state.speaker;
          // Try to resume playback in case it was paused.
          if (Call.state.speaker) playRemoteAudio();
        } catch {}
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
