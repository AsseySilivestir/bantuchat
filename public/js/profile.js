/* =====================================================================
 * BantuChat — profile.js
 * Profile view + settings + account management.
 *  • Profile sub-view: avatar URL, name, about, phone — editable inline
 *    → PUT /api/profile
 *  • Settings sub-view: theme toggle (light/dark, persisted), notification
 *    toggles (UI-only)
 *  • Account sub-view: change password (PUT /api/account/password),
 *    logout (clear localStorage + redirect), delete account
 *    (DELETE /api/account with confirm)
 *
 * Exposes: window.Profile  (global)
 * ===================================================================== */
(function () {
  'use strict';

  const Profile = window.Profile = {
    state: {
      activeSub: 'profile',   // 'profile' | 'settings' | 'account'
      user: null,
    },
  };

  let listEl, paneEl;

  // ==========================================================
  // View lifecycle
  // ==========================================================
  App.registerView('profile', {
    enter(list, pane) {
      listEl = list; paneEl = pane;
      renderSidebar();
      renderActive();
    },
    leave() {},
  });

  function renderSidebar() {
    listEl.innerHTML = `
      <div style="padding:8px;">
        <button class="list-item ${Profile.state.activeSub==='profile'?'active':''}" data-sub="profile" role="button">
          <div class="info"><div class="name">Profile</div><div class="preview">Avatar, name, about, phone</div></div>
        </button>
        <button class="list-item ${Profile.state.activeSub==='settings'?'active':''}" data-sub="settings" role="button">
          <div class="info"><div class="name">Settings</div><div class="preview">Theme & notifications</div></div>
        </button>
        <button class="list-item ${Profile.state.activeSub==='account'?'active':''}" data-sub="account" role="button">
          <div class="info"><div class="name">Account</div><div class="preview">Password, logout, delete</div></div>
        </button>
      </div>
    `;
    listEl.querySelectorAll('.list-item').forEach(b => {
      b.onclick = () => {
        Profile.state.activeSub = b.dataset.sub;
        renderSidebar();
        renderActive();
      };
    });
  }

  function renderActive() {
    if (Profile.state.activeSub === 'profile') renderProfileSub();
    else if (Profile.state.activeSub === 'settings') renderSettingsSub();
    else if (Profile.state.activeSub === 'account') renderAccountSub();
  }

  // ==========================================================
  // Profile sub-view
  // ==========================================================
  function renderProfileSub() {
    const u = App.user || {};
    App.setMainHeader({
      title: 'Profile',
      sub: 'Edit your public info',
      avatarHTML: '',
      actions: '',
      backVisible: App.isMobile,
    });
    paneEl.innerHTML = `
      <div class="profile-pane" style="overflow-y:auto">
        <div class="profile-card">
          <div id="profile-avatar-display">${App.avatarHTML(u, 'xl')}</div>
          <h2 class="p-name">${App.escapeHTML(u.name || u.username || 'User')}</h2>
          <div class="p-sub">@${App.escapeHTML(u.username || '')}</div>
          <button class="btn ghost" id="edit-avatar" style="margin-top:14px">Change avatar URL</button>
        </div>
        <div class="profile-section">
          <h4>Name</h4>
          <div class="profile-row">
            <input class="profile-edit" id="edit-name" value="${App.escapeHTML(u.name || '')}" placeholder="Your display name" />
          </div>
        </div>
        <div class="profile-section">
          <h4>About</h4>
          <div class="profile-row">
            <input class="profile-edit" id="edit-about" value="${App.escapeHTML(u.about || '')}" placeholder="A short bio" />
          </div>
        </div>
        <div class="profile-section">
          <h4>Phone</h4>
          <div class="profile-row">
            <input class="profile-edit" id="edit-phone" value="${App.escapeHTML(u.phone || '')}" placeholder="+1 555 555 1234" />
          </div>
        </div>
        <div style="padding:0 16px 24px;">
          <button class="btn block" id="save-profile">Save changes</button>
        </div>
      </div>
    `;
    // Edit avatar URL
    document.getElementById('edit-avatar').onclick = () => {
      const input = document.createElement('input');
      input.type = 'url';
      input.value = u.avatar || '';
      input.placeholder = 'https://…/avatar.png';
      input.style.cssText = 'width:100%; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2); color:var(--text)';
      App.showModal({
        title: 'Avatar URL',
        body: input,
        buttons: [
          { label: 'Cancel', kind: 'ghost' },
          { label: 'Save', onClick: async () => {
            const v = input.value.trim();
            try {
              const r = await App.api('PUT', '/api/profile', { avatar: v });
              if (r && r.user) { App.user = r.user; localStorage.setItem('bantu_user', JSON.stringify(r.user)); App.renderMe(); renderProfileSub(); }
            } catch (e) { App.toast(e.message, 'error'); return false; }
          } },
        ],
      });
      setTimeout(() => input.focus(), 50);
    };
    document.getElementById('save-profile').onclick = async () => {
      const name = document.getElementById('edit-name').value.trim();
      const about = document.getElementById('edit-about').value.trim();
      const phone = document.getElementById('edit-phone').value.trim();
      try {
        const r = await App.api('PUT', '/api/profile', { name, about, phone });
        if (r && r.user) {
          App.user = r.user;
          localStorage.setItem('bantu_user', JSON.stringify(r.user));
          App.renderMe();
          App.toast('Profile saved', 'success');
          renderProfileSub();
        }
      } catch (e) { App.toast(e.message, 'error'); }
    };
  }

  // ==========================================================
  // Settings sub-view
  // ==========================================================
  function renderSettingsSub() {
    App.setMainHeader({
      title: 'Settings',
      sub: 'Theme & notifications',
      avatarHTML: '',
      actions: '',
      backVisible: App.isMobile,
    });
    const theme = App.getTheme();
    const notifEnabled = localStorage.getItem('bantu_notif') !== 'off';
    const soundEnabled = localStorage.getItem('bantu_sound') !== 'off';
    paneEl.innerHTML = `
      <div class="profile-pane">
        <div class="profile-section">
          <h4>Appearance</h4>
          <div class="profile-row">
            <div class="pr-label">
              Dark mode
              <span class="sub">Toggle between light and dark themes</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-theme" ${theme === 'dark' ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="profile-section">
          <h4>Notifications</h4>
          <div class="profile-row">
            <div class="pr-label">
              Desktop notifications
              <span class="sub">Show OS pop-ups for new messages</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-notif" ${notifEnabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
          <div class="profile-row">
            <div class="pr-label">
              Notification sound
              <span class="sub">Play a sound on new message</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-sound" ${soundEnabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>
    `;
    document.getElementById('setting-theme').onchange = (e) => {
      App.setTheme(e.target.checked ? 'dark' : 'light');
    };
    document.getElementById('setting-notif').onchange = (e) => {
      localStorage.setItem('bantu_notif', e.target.checked ? 'on' : 'off');
      if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission();
      }
    };
    document.getElementById('setting-sound').onchange = (e) => {
      localStorage.setItem('bantu_sound', e.target.checked ? 'on' : 'off');
    };
  }

  // ==========================================================
  // Account sub-view
  // ==========================================================
  function renderAccountSub() {
    App.setMainHeader({
      title: 'Account',
      sub: 'Security & data',
      avatarHTML: '',
      actions: '',
      backVisible: App.isMobile,
    });
    paneEl.innerHTML = `
      <div class="profile-pane">
        <div class="profile-section">
          <h4>Change password</h4>
          <div class="profile-row">
            <input class="profile-edit" id="old-pw" type="password" placeholder="Current password" autocomplete="current-password" />
          </div>
          <div class="profile-row">
            <input class="profile-edit" id="new-pw" type="password" placeholder="New password (min 6 chars)" autocomplete="new-password" />
          </div>
          <div class="profile-row">
            <input class="profile-edit" id="new-pw2" type="password" placeholder="Confirm new password" autocomplete="new-password" />
          </div>
          <div class="profile-row" style="border-top:0;">
            <button class="btn block" id="btn-change-pw">Update password</button>
          </div>
        </div>
        <div class="profile-section">
          <h4>Session</h4>
          <div class="profile-row">
            <div class="pr-label">Log out<span class="sub">End your session on this device</span></div>
            <button class="btn ghost" id="btn-logout">Logout</button>
          </div>
        </div>
        <div class="profile-section">
          <h4>Danger zone</h4>
          <div class="profile-row">
            <div class="pr-label">Delete account<span class="sub">Permanently remove your account and all messages</span></div>
            <button class="btn danger" id="btn-delete">Delete</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btn-change-pw').onclick = async () => {
      const old = document.getElementById('old-pw').value;
      const neu = document.getElementById('new-pw').value;
      const neu2 = document.getElementById('new-pw2').value;
      if (!old || !neu) { App.toast('Fill in all fields', 'error'); return; }
      if (neu.length < 6) { App.toast('New password too short (min 6)', 'error'); return; }
      if (neu !== neu2) { App.toast('Passwords do not match', 'error'); return; }
      try {
        await App.api('PUT', '/api/account/password', { old, new: neu });
        App.toast('Password updated', 'success');
        document.getElementById('old-pw').value = '';
        document.getElementById('new-pw').value = '';
        document.getElementById('new-pw2').value = '';
      } catch (e) { App.toast(e.message, 'error'); }
    };
    document.getElementById('btn-logout').onclick = () => App.logout();
    document.getElementById('btn-delete').onclick = async () => {
      const ok = await App.confirm('Delete account?',
        'This will permanently delete your account and all your messages. This action cannot be undone.');
      if (!ok) return;
      try {
        await App.api('DELETE', '/api/account');
        App.toast('Account deleted', 'info');
        App.logout();
      } catch (e) { App.toast(e.message, 'error'); }
    };
  }

  // ==========================================================
  // Presence hook (for active chat header updates only — no-op here)
  // ==========================================================
  Profile.onPresence = function (userId, info) { /* no-op */ };
})();
