/* =====================================================================
 * BantuChat — status.js
 * Status feed (WhatsApp-style ephemeral status updates).
 *  • Ring-of-avatars: my status + contacts' statuses.
 *    Unviewed = colored ring, viewed = gray ring.
 *  • Click a status → full-screen viewer (tap to advance,
 *    auto-advance after 5s).
 *  • Post status: text input or image upload → POST /api/status
 *  • 24h expiry (client hides expired ones based on createdAt)
 *
 * REST:
 *   GET  /api/status         → [{id,userId,body,kind,createdAt,author:{...},viewed,views}]
 *   POST /api/status         → {body, kind:"text"|"image"}
 *   POST /api/status/:id/view→ {ok}
 *
 * WS:
 *   client→server: status_view {statusId}
 *   server→client: status_new {status:{...}}
 *
 * Exposes: window.Status  (global)
 * ===================================================================== */
(function () {
  'use strict';

  const Status = window.Status = {
    state: {
      statuses: [],         // all loaded
      activeAuthorIdx: -1,  // index into grouped array
      activeStatusIdx: 0,
      advTimer: null,
      feedEl: null,
    },
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  // ==========================================================
  // View lifecycle
  // ==========================================================
  App.registerView('status', {
    enter(list, pane) {
      list.innerHTML = `
        <div style="padding:10px 12px; border-bottom:1px solid var(--border); background:var(--panel);">
          <button class="btn block" id="status-post-btn">＋ Post a status</button>
        </div>
        <div id="status-mylist"></div>
      `;
      pane.innerHTML = `
        <div style="flex:1; overflow-y:auto; background:var(--bg);">
          <div class="status-rings" id="status-rings" aria-label="Recent status updates"></div>
          <div style="padding:12px 14px; color:var(--text-secondary); font-size:13px; text-transform:uppercase; letter-spacing:.5px;">Recent updates</div>
          <div id="status-feed"></div>
        </div>
      `;
      document.getElementById('status-post-btn').addEventListener('click', openComposer);
      loadStatuses();
    },
    leave() {
      closeViewer();
    },
  });

  // ==========================================================
  // Load + group
  // ==========================================================
  async function loadStatuses() {
    const rings = document.getElementById('status-rings');
    const feed = document.getElementById('status-feed');
    if (rings) rings.innerHTML = App.skeletonList(3).replace(/sk-row/g, 'sk-row').replace(/circle/g, 'circle') + '';
    try {
      const r = await App.api('GET', '/api/status');
      const all = Array.isArray(r) ? r : [];
      // Filter expired
      const now = Date.now();
      Status.state.statuses = all.filter(s => {
        const t = (s.createdAt || 0) * (s.createdAt < 1e12 ? 1000 : 1);
        return (now - t) < DAY_MS;
      });
      renderRings();
      renderFeed();
    } catch (e) {
      App.toast('Failed to load statuses: ' + e.message, 'error');
      if (feed) feed.innerHTML = `<div class="empty-state"><p>${App.escapeHTML(e.message)}</p></div>`;
    }
  }

  function groupedByAuthor() {
    // Group statuses by userId, sorted by most recent first
    const map = new Map();
    Status.state.statuses.forEach(s => {
      const uid = s.userId || (s.author && s.author.id);
      if (!map.has(uid)) map.set(uid, { userId: uid, author: s.author || { id: uid }, items: [] });
      map.get(uid).items.push(s);
    });
    const arr = Array.from(map.values());
    arr.forEach(g => g.items.sort((a,b) => (a.createdAt||0) - (b.createdAt||0)));
    arr.sort((a,b) => {
      const at = a.items[a.items.length-1].createdAt||0;
      const bt = b.items[b.items.length-1].createdAt||0;
      return bt - at;
    });
    return arr;
  }

  // ==========================================================
  // Render rings (horizontal strip)
  // ==========================================================
  function renderRings() {
    const el = document.getElementById('status-rings');
    if (!el) return;
    const groups = groupedByAuthor();
    if (!groups.length) {
      el.innerHTML = `<div style="padding:12px; color:var(--text-secondary); font-size:13px;">No recent updates. Tap "Post a status" to share one!</div>`;
      return;
    }
    // My status ring first if present
    const myUid = App.user && App.user.id;
    const myGroup = groups.find(g => g.userId === myUid);
    const otherGroups = groups.filter(g => g.userId !== myUid);
    const ringsHTML = [];
    // "My status" ring
    if (myGroup) {
      ringsHTML.push(ringHTML(myGroup, 'My status', true));
    } else {
      ringsHTML.push(`
        <div class="status-ring" data-action="my-new" role="button" tabindex="0" aria-label="Add my status">
          <div class="ring" style="background:transparent; border:2px dashed var(--border);">
            <div class="inner" style="background:transparent;">
              <div class="avatar-initials" style="width:48px;height:48px;border-radius:50%;background:var(--teal);display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;">+</div>
            </div>
          </div>
          <span class="label">My status</span>
        </div>
      `);
    }
    otherGroups.forEach(g => {
      const allViewed = g.items.every(i => i.viewed);
      ringsHTML.push(ringHTML(g, g.author.name || 'User', !allViewed));
    });
    el.innerHTML = ringsHTML.join('');
    // Bind
    el.querySelectorAll('.status-ring').forEach((node, i) => {
      node.onclick = () => {
        if (node.dataset.action === 'my-new') { openComposer(); return; }
        // Determine which group this is — my-new is index 0 only when my status missing
        let idx;
        if (myGroup) {
          idx = i === 0 ? -1 : i - 1;  // -1 means "my"
        } else {
          idx = i - 1;  // skip the "add" ring
        }
        if (idx === -1) openViewerForGroup(myGroup);
        else openViewerForGroup(otherGroups[idx]);
      };
    });
  }

  function ringHTML(group, label, unviewed) {
    const last = group.items[group.items.length - 1];
    const author = group.author || {};
    return `
      <div class="status-ring ${unviewed ? '' : 'viewed'}" role="button" tabindex="0" aria-label="View ${App.escapeHTML(label)} status">
        <div class="ring">
          <div class="inner">${App.avatarHTML(author, 'md')}</div>
        </div>
        <span class="label">${App.escapeHTML(label)}</span>
      </div>`;
  }

  // ==========================================================
  // Render feed (vertical list)
  // ==========================================================
  function renderFeed() {
    const el = document.getElementById('status-feed');
    if (!el) return;
    const groups = groupedByAuthor().filter(g => g.userId !== (App.user && App.user.id));
    if (!groups.length) {
      el.innerHTML = `<div class="empty-state" style="padding:24px"><p style="color:var(--text-muted)">No contact updates yet.</p></div>`;
      return;
    }
    el.innerHTML = groups.map(g => {
      const last = g.items[g.items.length - 1];
      const unviewed = g.items.some(i => !i.viewed);
      const ringColor = unviewed ? 'var(--teal-light)' : '#c1c7cc';
      return `
        <div class="list-item" data-uid="${g.userId}" role="button" tabindex="0" aria-label="View ${App.escapeHTML(g.author.name || 'user')} status">
          <div class="avatar" style="border-radius:50%; overflow:hidden; box-shadow: 0 0 0 3px ${ringColor};">
            ${App.avatarHTML(g.author, 'lg')}
          </div>
          <div class="info">
            <div class="top"><span class="name">${App.escapeHTML(g.author.name || 'User')}</span><span class="time">${App.escapeHTML(App.fmtRelative(last.createdAt))}</span></div>
            <div class="preview">${unviewed ? 'Tap to view' : 'Viewed'}</div>
          </div>
        </div>`;
    }).join('');
    el.querySelectorAll('.list-item').forEach(node => {
      node.onclick = () => {
        const uid = parseInt(node.dataset.uid, 10);
        const g = groupedByAuthor().find(x => x.userId === uid);
        if (g) openViewerForGroup(g);
      };
    });
  }

  // ==========================================================
  // Viewer (full-screen)
  // ==========================================================
  function openViewerForGroup(group) {
    if (!group || !group.items.length) return;
    Status.state.activeGroup = group;
    Status.state.activeStatusIdx = 0;
    renderViewer(group, 0);
    scheduleAdvance();
  }

  function renderViewer(group, idx) {
    const v = document.getElementById('status-viewer');
    if (!v) return;
    const s = group.items[idx];
    if (!s) { closeViewer(); return; }
    const author = group.author || {};
    document.getElementById('sv-avatar').innerHTML = App.avatarHTML(author, 'sm');
    document.getElementById('sv-name').textContent = author.name || 'User';
    document.getElementById('sv-time').textContent = App.fmtRelative(s.createdAt);
    // Reset progress bar
    const bar = document.getElementById('status-bar');
    bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    // Body
    const body = document.getElementById('sv-body');
    if (s.kind === 'image') {
      body.innerHTML = `<img src="${App.escapeHTML(s.body || '')}" alt="status image" />`;
    } else {
      // Text — pick a background color based on author
      const color = App.colorFor(author.name || author.id || 'x');
      body.innerHTML = `<div style="background:${color}; padding:32px; border-radius:14px; max-width:80vw; max-height:80vh; font-size:22px; line-height:1.4;">${App.escapeHTML(s.body || '')}</div>`;
    }
    v.classList.add('show');
    v.setAttribute('aria-hidden', 'false');
    // Mark viewed
    if (!s.viewed) {
      s.viewed = true;
      App.wsSend({ type: 'status_view', statusId: s.id });
      // Best-effort REST call
      App.api('POST', '/api/status/' + s.id + '/view').catch(() => {});
    }
  }

  function scheduleAdvance() {
    if (Status.state.advTimer) clearTimeout(Status.state.advTimer);
    Status.state.advTimer = setTimeout(() => advanceViewer(1), 5000);
  }

  function advanceViewer(dir) {
    const g = Status.state.activeGroup; if (!g) return;
    Status.state.activeStatusIdx += dir;
    if (Status.state.activeStatusIdx >= g.items.length) {
      closeViewer();
      // Move to next author group?
      const groups = groupedByAuthor();
      const i = groups.findIndex(x => x.userId === g.userId);
      if (i >= 0 && i + 1 < groups.length) {
        openViewerForGroup(groups[i+1]);
      }
      return;
    }
    if (Status.state.activeStatusIdx < 0) Status.state.activeStatusIdx = 0;
    renderViewer(g, Status.state.activeStatusIdx);
    scheduleAdvance();
  }

  function closeViewer() {
    const v = document.getElementById('status-viewer');
    if (v) { v.classList.remove('show'); v.setAttribute('aria-hidden', 'true'); }
    if (Status.state.advTimer) { clearTimeout(Status.state.advTimer); Status.state.advTimer = null; }
    Status.state.activeGroup = null;
    Status.state.activeStatusIdx = 0;
    renderRings();
    renderFeed();
  }
  Status.closeViewer = closeViewer;

  // Bind viewer controls (once)
  document.addEventListener('DOMContentLoaded', () => {
    const v = document.getElementById('status-viewer');
    if (v) {
      document.getElementById('sv-close').onclick = closeViewer;
      document.getElementById('sv-prev').onclick = () => advanceViewer(-1);
      document.getElementById('sv-next').onclick = () => advanceViewer(1);
      v.addEventListener('click', (e) => {
        if (e.target.id === 'sv-body' || e.target.closest('.sv-nav') || e.target.closest('.sv-close')) return;
        // Tap advances forward
        advanceViewer(1);
      });
    }
  });

  // ==========================================================
  // Composer (post status)
  // ==========================================================
  function openComposer() {
    const ta = document.createElement('textarea');
    ta.placeholder = "What's on your mind?";
    ta.style.cssText = 'width:100%; min-height:100px; padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--panel-2); color:var(--text); resize:vertical';
    const wrap = document.createElement('div');
    wrap.appendChild(ta);
    const fileRow = document.createElement('div');
    fileRow.style.cssText = 'margin-top:10px; font-size:13px; color:var(--text-secondary)';
    const fileLabel = document.createElement('label');
    fileLabel.innerHTML = 'or attach an image: ';
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = 'image/*';
    fileLabel.appendChild(fileInput);
    fileRow.appendChild(fileLabel);
    wrap.appendChild(fileRow);
    App.showModal({
      title: 'Post a status',
      body: wrap,
      buttons: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Post', onClick: async () => {
          if (fileInput.files && fileInput.files[0]) {
            const f = fileInput.files[0];
            if (f.size > 2*1024*1024) { App.toast('Image too large (max 2MB)', 'error'); return false; }
            const reader = new FileReader();
            reader.onload = async () => {
              try {
                await App.api('POST', '/api/status', { body: reader.result, kind: 'image' });
                App.hideModal();
                App.toast('Status posted', 'success');
                loadStatuses();
              } catch (e) { App.toast(e.message, 'error'); }
            };
            reader.readAsDataURL(f);
            return false;  // keep modal open while reading
          }
          const text = ta.value.trim();
          if (!text) return false;
          try {
            await App.api('POST', '/api/status', { body: text, kind: 'text' });
            App.toast('Status posted', 'success');
            loadStatuses();
          } catch (e) { App.toast(e.message, 'error'); return false; }
        } },
      ],
    });
    setTimeout(() => ta.focus(), 50);
  }
  Status.openComposer = openComposer;

  // ==========================================================
  // WS handlers
  // ==========================================================
  App.registerWSHandler('status_new', (msg) => {
    if (!msg.status) return;
    // Only show if still in status view
    const s = msg.status;
    // Skip expired
    const t = (s.createdAt || 0) * (s.createdAt < 1e12 ? 1000 : 1);
    if (Date.now() - t > DAY_MS) return;
    // De-dupe
    if (!Status.state.statuses.find(x => x.id === s.id)) {
      Status.state.statuses.push(s);
      // Only re-render if status view is active
      if (App.activeView === 'status') {
        renderRings();
        renderFeed();
      } else {
        App.toast('New status from ' + (s.author && s.author.name || 'someone'), 'info');
      }
    }
  });
})();
