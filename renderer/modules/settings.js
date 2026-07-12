// ── Settings page ─────────────────────────────────────────────────────────────

// ── Accent color helpers ───────────────────────────────────────────────────────
function darkenHex(hex, amount = 0.18) {
  const r = parseInt(hex.slice(1,3), 16) / 255;
  const g = parseInt(hex.slice(3,5), 16) / 255;
  const b = parseInt(hex.slice(5,7), 16) / 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0, l = (max+min)/2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  l = Math.max(0, l - amount);
  const hue2rgb = (p, q, t) => {
    if (t<0) t+=1; if (t>1) t-=1;
    if (t<1/6) return p+(q-p)*6*t;
    if (t<1/2) return q;
    if (t<2/3) return p+(q-p)*(2/3-t)*6;
    return p;
  };
  const q = l < 0.5 ? l*(1+s) : l+s-l*s;
  const p = 2*l - q;
  const toHex = v => Math.round(hue2rgb(p,q,v)*255).toString(16).padStart(2,'0');
  return `#${toHex(h+1/3)}${toHex(h)}${toHex(h-1/3)}`;
}

function applyAccent(hex) {
  // Validate — fall back if bad value
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const root = document.documentElement;
  root.style.setProperty('--accent',     hex);
  root.style.setProperty('--accent-d',   darkenHex(hex));
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  // Keep the swatch and hex input in sync
  const swatch = $('accent-swatch');
  const picker = $('s-accent-color');
  const hexEl  = $('s-accent-hex');
  if (swatch) swatch.style.background = hex;
  if (picker) picker.value = hex;
  if (hexEl)  hexEl.value  = hex.toUpperCase();
}

// ── Auto-save (debounced for text fields) ─────────────────────────────────────
let settingsTimer   = null;
let remoteGamePaths = [];
let localBackupPaths = [];

// Dirty flags — credentials only get saved if the user actually typed in the
// field this session. This lets the fields start blank without overwriting
// stored credentials when other settings auto-save.
let _userDirty = false;
let _passDirty = false;

function scheduleSettingsSave() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(commitSettingsSave, 600);
}

async function commitSettingsSave() {
  const payload = {
    ftpHost:          $('s-host').value.trim(),
    ftpPorts:         $('s-ports').value.split(',').map(p => p.trim()).filter(Boolean),
    backupPaths:      localBackupPaths,
    backupPath:       localBackupPaths[0] || '',
    payloadLocalPath: $('s-payload-local').value.trim(),
    payloadRemotePath:$('s-payload-remote').value.trim(),
    cheatsRemotePath: $('s-cheats-remote').value.trim(),
    discordWebhookUrl: $('s-discord-webhook').value.trim(),
    mediaPsNotifyEnabled: $('s-media-discord-notify').checked,
    autoConnect:      $('s-auto-connect').checked,
    timeFormat:       $('s-time-format').value,
    hashConcurrency:  Number($('s-hash-concurrency')?.value) || 8,
  };
  // Only persist credentials when the user has actively typed in those fields
  if (_userDirty) payload.ftpUser = $('s-user').value.trim();
  if (_passDirty) payload.ftpPass = $('s-pass').value;
  await window.pork.setSettings(payload);
  // Mirror non-sensitive FTP fields to the dashboard quick-connect
  $('d-host').value  = $('s-host').value;
  $('d-ports').value = $('s-ports').value;
  setStatus('Settings saved', 'ok');
}

async function loadSettings(options = {}) {
  const background = !!options.background;
  const s = await window.pork.getSettings();
  $('s-host').value  = s.ftpHost  || '';
  $('s-ports').value = (s.ftpPorts && s.ftpPorts.length) ? s.ftpPorts.join(', ') : '1337, 2121, 21';
  // Username and password fields intentionally start blank — they show their
  // placeholder text until the user types. Stored credentials are used by
  // auto-connect and the connect button fallback without being displayed.
  // populate multi-path backup folder list
  localBackupPaths = s.backupPaths || (s.backupPath ? [s.backupPath] : []);
  renderLocalBackupPaths();
  $('s-payload-local').value  = s.payloadLocalPath  || '';
  $('s-payload-remote').value = s.payloadRemotePath || '/data/payloads/';
  $('s-voidshell-port').value = s.voidshellPort || 7007;
  $('s-cheats-remote').value   = s.cheatsRemotePath  || '/data/etaHEN/cheats/';
  $('s-discord-webhook').value = s.discordWebhookUrl || '';
  $('s-media-discord-notify').checked = s.mediaPsNotifyEnabled !== false; // default true
  $('media-discord-psn-detail').hidden = s.mediaPsNotifyEnabled === false;
  $('s-media-psn-download').checked = s.mediaPsNotifyDiscordDownload !== false;
  $('s-media-psn-convert').checked  = s.mediaPsNotifyDiscordConvert  !== false;
  $('s-media-psn-upload').checked   = s.mediaPsNotifyDiscordUpload   !== false;
  $('s-media-psn-done').checked     = s.mediaPsNotifyDiscordDone     !== false;
  $('s-media-psn-error').checked    = s.mediaPsNotifyDiscordError    !== false;
  $('s-auto-connect').checked = s.autoConnect === true;
  _timeFormat = s.timeFormat || '12h';
  $('s-time-format').value = _timeFormat;
  if (!background) {
    // Mirror to dashboard quick-connect only when the user intentionally opens Settings.
    $('d-host').value  = s.ftpHost  || '';
    $('d-ports').value = (s.ftpPorts && s.ftpPorts.length) ? s.ftpPorts.join(', ') : '1337, 2121, 21';
  }
  // Apply saved accent color
  applyAccent(s.accentColor || '#BB86FC');
  // Render remote game paths
  remoteGamePaths = s.remoteGamePaths || [];
  renderRemoteGamePaths();
  // Render payload sources list
  await renderSettingsPayloadSources();
  // Load system view hotkeys
  if (s.svHotkeys) _svHotkeys = { ..._svHotkeys, ...s.svHotkeys };
  const hkMap = { 'hk-mute': 'mute', 'hk-gif': 'gif', 'hk-video': 'video', 'hk-fullscreen': 'fullscreen', 'hk-popout': 'popout' };
  Object.entries(hkMap).forEach(([id, action]) => {
    const el = $(id); if (el) el.value = _svHotkeys[action] || '';
  });

  // ── Conversion settings ────────────────────────────────────────────────────
  const convMode = s.gameConversionMode || 'pfs';
  const modeRadio = document.querySelector(`input[name="conv-mode"][value="${convMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  applyConvModeUI(convMode);

  $('s-conv-ufs2-path').value    = s.ufs2ToolPath    || '';
  $('s-conv-exfat-path').value   = s.osfmountPath || s.exfatToolPath || '';
  $('s-conv-output-dir').value   = s.convOutputDir   || '';
  $('s-conv-temp-dir').value     = s.convTempDir     || '';
  $('s-conv-ftp-upload').checked  = !!s.convFtpUpload;
  $('s-conv-delete-after').checked = !!s.convDeleteAfter;
  $('conv-delete-after-row').hidden = false;
  $('s-conv-delete-after').disabled  = !s.convFtpUpload;
  $('conv-delete-after-row').style.opacity = s.convFtpUpload ? '' : '0.45';

  $('s-conv-psn-enabled').checked  = s.convPsNotifyEnabled !== false;
  $('conv-psn-detail').hidden      = !s.convPsNotifyEnabled;
  $('s-conv-psn-queued').checked   = s.convPsNotifyOnGameQueued  !== false;
  $('s-conv-psn-batch').checked    = s.convPsNotifyOnBatchQueued !== false;
  $('s-conv-psn-copy').checked     = s.convPsNotifyOnCopyStart   !== false;
  $('s-conv-psn-convert').checked  = s.convPsNotifyOnConvertStart!== false;
  $('s-conv-psn-done').checked     = s.convPsNotifyOnJobDone     !== false;

  await refreshConvToolStatus();

  // ── Web UI Server ──────────────────────────────────────────────────────
  if ($('s-hash-concurrency')) $('s-hash-concurrency').value = s.hashConcurrency || 8;
  if ($('s-webui-port')) $('s-webui-port').value = s.webUiPort || 6967;
  await refreshWebuiStatus();

  // ── Language / i18n ──────────────────────────────────────────────────
const _langCode = s.language || 'en';
  try {
    await refreshLangDropdown(_langCode);
  } catch (_) {}
  // Load and apply translations (always, including English)
  await window.i18n.load(_langCode);
}

// FTP / path fields → debounced auto-save
['s-host', 's-ports', 's-hash-concurrency'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('input', scheduleSettingsSave);
});

// ── Language helpers ──────────────────────────────────────────────────────────
async function refreshLangDropdown(selectedCode) {
  const langs   = await window.pork.langList();
  const langSel = $('s-language');
  langSel.innerHTML = langs.map(l => {
    const label = l.source === 'imported' ? `${escHtml(l.name)} ✦` : escHtml(l.name);
    return `<option value="${escHtml(l.code)}"${l.code === selectedCode ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

// ── Language switcher ──────────────────────────────────────────────────────────
$('s-language').addEventListener('change', async function() {
  const code = this.value;
  await window.pork.setSettings({ language: code });
  await window.i18n.load(code);
  setStatus('Language changed', 'ok');
});

$('btn-import-lang').addEventListener('click', async () => {
  const btn = $('btn-import-lang');
  btn.disabled = true;
  try {
    const res = await window.pork.langImport();
    if (res.canceled) return;
    // Refresh dropdown so the new language (or updated override) appears
    const currentCode = $('s-language').value;
    await refreshLangDropdown(currentCode);
    setStatus(`${window.t('lang.importDone', 'Language imported')}: ${res.name}`, 'ok');
    // If imported file is the active language, reload translations immediately
    if (res.code === currentCode) await window.i18n.load(res.code);
  } catch (e) {
    setStatus(`${window.t('lang.importError', 'Import failed')}: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('btn-export-lang').addEventListener('click', async () => {
  const btn = $('btn-export-lang');
  btn.disabled = true;
  try {
    const res = await window.pork.langExportBase();
    if (!res.canceled) setStatus(window.t('lang.exportDone', 'English base file exported.'), 'ok');
  } catch (e) {
    setStatus(`${window.t('lang.exportError', 'Export failed')}: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});
// Dashboard host/ports fields mirror settings fields and auto-save
$('d-host').addEventListener('input', () => {
  $('s-host').value = $('d-host').value;
  scheduleSettingsSave();
});
$('d-ports').addEventListener('input', () => {
  $('s-ports').value = $('d-ports').value;
  scheduleSettingsSave();
});
// Credential fields set their dirty flag before scheduling save
$('s-user').addEventListener('input', () => { _userDirty = true; scheduleSettingsSave(); });
$('s-pass').addEventListener('input', () => { _passDirty = true; scheduleSettingsSave(); });

// ── Game Source Folders (multi-path backup) ────────────────────────────────────

function renderLocalBackupPaths() {
  const cont = $('settings-backup-paths-list');
  if (!cont) return;
  if (!localBackupPaths.length) {
    cont.innerHTML = '<p class="hint" style="margin:6px 0">No folders added yet. Click &ldquo;+ Add Folder&hellip;&rdquo; to get started.</p>';
    return;
  }
  cont.innerHTML = localBackupPaths.map((p, i) => `
    <div class="remote-path-row" data-backup-idx="${i}">
      <span class="remote-path-value" title="${escHtml(p)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p)}</span>
      <button class="btn btn-sm btn-backup-path-remove" style="margin-left:auto;flex-shrink:0">&#10005;</button>
    </div>
  `).join('');
}

async function saveLocalBackupPaths() {
  await window.pork.setSettings({
    backupPaths: localBackupPaths,
    backupPath:  localBackupPaths[0] || '',
  });
  setStatus('Settings saved', 'ok');
}

$('settings-backup-paths-list').addEventListener('click', async e => {
  const row = e.target.closest('[data-backup-idx]');
  if (!row || !e.target.closest('.btn-backup-path-remove')) return;
  const idx = Number(row.dataset.backupIdx);
  const ok = await showConfirm(`Remove "${escHtml(localBackupPaths[idx])}" from game source folders?`);
  if (!ok) return;
  localBackupPaths = localBackupPaths.filter((_, i) => i !== idx);
  await saveLocalBackupPaths();
  renderLocalBackupPaths();
});

$('btn-add-backup-path').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  if (localBackupPaths.includes(folder)) { setStatus('That folder is already in the list', 'ok'); return; }
  localBackupPaths = [...localBackupPaths, folder];
  await saveLocalBackupPaths();
  renderLocalBackupPaths();
});

// Payload local folder browse
$('btn-browse-payload-local').addEventListener('click', async () => {
  const folder = await window.pork.selectFolder();
  if (!folder) return;
  $('s-payload-local').value = folder;
  await commitSettingsSave();
});

// Payload remote path — debounced
$('s-payload-remote').addEventListener('input', scheduleSettingsSave);

// Cheats remote path — debounced
$('s-cheats-remote').addEventListener('input', scheduleSettingsSave);

// Discord webhook URL — debounced
$('s-discord-webhook').addEventListener('input', scheduleSettingsSave);

$('btn-browse-cheats-remote').addEventListener('click', async () => {
  const cur = $('s-cheats-remote').value.trim() || '/';
  const p = await openFtpBrowser(cur);
  if (p) { $('s-cheats-remote').value = p; scheduleSettingsSave(); }
});

// Auto-connect toggle — save immediately on change
$('s-auto-connect').addEventListener('change', commitSettingsSave);

// Time format toggle — save and re-render media grid immediately
$('s-time-format').addEventListener('change', e => {
  _timeFormat = e.target.value;
  commitSettingsSave();
  renderMediaGrid();
});

// Media Discord PS Notify — master toggle shows/hides per-step sub-section
$('s-media-discord-notify').addEventListener('change', function() {
  $('media-discord-psn-detail').hidden = !this.checked;
  commitSettingsSave();
});

// Media Discord PS Notify — per-step toggles
[
  ['s-media-psn-download', 'mediaPsNotifyDiscordDownload'],
  ['s-media-psn-convert',  'mediaPsNotifyDiscordConvert'],
  ['s-media-psn-upload',   'mediaPsNotifyDiscordUpload'],
  ['s-media-psn-done',     'mediaPsNotifyDiscordDone'],
  ['s-media-psn-error',    'mediaPsNotifyDiscordError'],
].forEach(([id, key]) => {
  $(id).addEventListener('change', function() {
    window.pork.setSettings({ [key]: this.checked });
  });
});

// ── Conversion settings helpers & event handlers ──────────────────────────────

function applyConvModeUI(mode) {
  const isPfs   = mode === 'pfs';
  const isFfpkg = mode === 'ffpkg';
  const isExfat = mode === 'exfat';
  const isConv  = !isPfs;

  $('conv-ffpkg-fields').hidden   = !isFfpkg;
  $('conv-exfat-fields').hidden   = !isExfat;
  $('conv-shared-fields').hidden  = !isConv;
  $('conv-notify-fields').hidden  = !isConv;

  // Update the conv queue panel badge when mode changes
  const badge = $('conv-queue-mode-badge');
  if (badge) badge.textContent = isPfs ? 'Raw Dumps' : isFfpkg ? 'FFPKG' : 'ExFAT';
}

async function refreshConvToolStatus() {
  const mode = document.querySelector('input[name="conv-mode"]:checked')?.value || 'pfs';
  if (mode === 'ffpkg') {
    try {
      const info  = await window.pork.convToolInfo();
      const el    = $('s-conv-ufs2-status');
      if (!el) return;
      if (info.toolAvailable) {
        el.textContent = '✓ UFS2Tool.exe found';
        el.style.color = 'var(--green)';
      } else {
        el.textContent = info.toolPath ? '✗ File not found at configured path' : '✗ Not configured';
        el.style.color = 'var(--red)';
      }
    } catch (_) {}
  }
  if (mode === 'exfat') {
    try {
      const info = await window.pork.convExfatToolInfo();
      const el   = $('s-conv-exfat-status');
      if (!el) return;
      if (info.toolAvailable) {
        el.textContent = `✓ OSFMount found — native exFAT (${info.osfmountPath || info.toolPath})`;
        el.style.color = 'var(--green)';
      } else {
        el.textContent = '✗ OSFMount not found — install OSFMount or pick osfmount.com';
        el.style.color = 'var(--red)';
      }
    } catch (_) {}
  }
}

// Conv mode radio buttons
document.querySelectorAll('input[name="conv-mode"]').forEach(radio => {
  radio.addEventListener('change', async () => {
    const mode = radio.value;
    applyConvModeUI(mode);
    await window.pork.setSettings({ gameConversionMode: mode });
    await refreshConvToolStatus();
    setStatus('Conversion mode saved', 'ok');
  });
});

// UFS2Method radios
document.querySelectorAll('input[name="ufs2-method"]').forEach(radio => {
  radio.addEventListener('change', async () => {
    await window.pork.setSettings({ ufs2Method: radio.value });
    setStatus('UFS2 method saved', 'ok');
  });
});

// UFS2Tool.exe browse
$('btn-conv-ufs2-pick').addEventListener('click', async () => {
  const info = await window.pork.convToolPick();
  if (!info) return;
  $('s-conv-ufs2-path').value = info.toolPath || '';
  const el = $('s-conv-ufs2-status');
  if (el) {
    el.textContent = info.toolAvailable ? '✓ UFS2Tool.exe found' : '✗ File not found';
    el.style.color = info.toolAvailable ? 'var(--green)' : 'var(--red)';
  }
  setStatus('UFS2Tool path saved', 'ok');
});

// ExFAT tool folder browse
$('btn-conv-exfat-pick').addEventListener('click', async () => {
  const info = await window.pork.convExfatToolPick();
  if (!info) return;
  $('s-conv-exfat-path').value = info.toolPath || '';
  await refreshConvToolStatus();
  setStatus('ExFAT tool path saved', 'ok');
});

// Output directory browse
$('btn-conv-output-pick').addEventListener('click', async () => {
  const p = await window.pork.convPickOutputDir();
  if (!p) return;
  $('s-conv-output-dir').value = p;
  setStatus('Output directory saved', 'ok');
});

// Temp directory browse
$('btn-conv-temp-pick').addEventListener('click', async () => {
  const p = await window.pork.convPickTempDir();
  if (!p) return;
  $('s-conv-temp-dir').value = p;
  setStatus('Temp directory saved', 'ok');
});

// FTP upload checkbox
$('s-conv-ftp-upload').addEventListener('change', async function() {
  const ftpEnabled = this.checked;
  $('s-conv-delete-after').disabled  = !ftpEnabled;
  $('conv-delete-after-row').style.opacity = ftpEnabled ? '' : '0.45';
  if (!ftpEnabled) {
    $('s-conv-delete-after').checked = false;
    await window.pork.setSettings({ convFtpUpload: false, convDeleteAfter: false });
  } else {
    await window.pork.setSettings({ convFtpUpload: true });
  }
  setStatus('Settings saved', 'ok');
});

// Delete after checkbox
$('s-conv-delete-after').addEventListener('change', async function() {
  await window.pork.setSettings({ convDeleteAfter: this.checked });
  setStatus('Settings saved', 'ok');
});

// PS Notify enabled toggle
$('s-conv-psn-enabled').addEventListener('change', async function() {
  $('conv-psn-detail').hidden = !this.checked;
  await window.pork.setSettings({ convPsNotifyEnabled: this.checked });
  setStatus('Settings saved', 'ok');
});

// PS Notify detail checkboxes
[
  ['s-conv-psn-queued',  'convPsNotifyOnGameQueued'],
  ['s-conv-psn-batch',   'convPsNotifyOnBatchQueued'],
  ['s-conv-psn-copy',    'convPsNotifyOnCopyStart'],
  ['s-conv-psn-convert', 'convPsNotifyOnConvertStart'],
  ['s-conv-psn-done',    'convPsNotifyOnJobDone'],
].forEach(([id, key]) => {
  $(id).addEventListener('change', function() {
    window.pork.setSettings({ [key]: this.checked });
  });
});

// FTP port preset chips — click to append if not already present
$('settings-ftp-presets').addEventListener('click', e => {
  const btn = e.target.closest('[data-add-port]');
  if (!btn) return;
  const port    = btn.dataset.addPort;
  const current = $('s-ports').value.split(',').map(p => p.trim()).filter(Boolean);
  if (!current.includes(port)) {
    current.push(port);
    $('s-ports').value = current.join(', ');
    commitSettingsSave();
  }
});

// ── System View hotkey capture ─────────────────────────────────────────────────
{
  const hkMap = { 'hk-mute': 'mute', 'hk-gif': 'gif', 'hk-video': 'video', 'hk-fullscreen': 'fullscreen', 'hk-popout': 'popout' };
  Object.entries(hkMap).forEach(([id, action]) => {
    const input = $(id);
    if (!input) return;
    input.addEventListener('focus', () => {
      input.dataset.prev = input.value;
      input.value = '';
      input.placeholder = 'press a key…';
      input.classList.add('capturing');
    });
    input.addEventListener('blur', () => {
      if (!input.value) input.value = input.dataset.prev || '';
      input.placeholder = '—';
      input.classList.remove('capturing');
    });
    input.addEventListener('keydown', async e => {
      e.preventDefault();
      if (e.key === 'Escape') { input.value = input.dataset.prev || ''; input.blur(); return; }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      input.value = key;
      _svHotkeys[action] = key;
      input.blur();
      await window.pork.setSettings({ svHotkeys: { ..._svHotkeys } });
      setStatus('Hotkey saved', 'ok');
    });
  });
}

// ── Remote Game Locations ──────────────────────────────────────────────────────

function renderRemoteGamePaths() {
  const cont = $('settings-remote-paths-list');
  if (!remoteGamePaths.length) {
    cont.innerHTML = '<p class="hint" style="margin:6px 0">No paths configured. Scan will use standard PS5 paths.</p>';
    return;
  }
  cont.innerHTML = remoteGamePaths.map((p, i) => `
    <div class="remote-path-row" data-idx="${i}">
      <span class="remote-path-label">${escHtml(p.label)}</span>
      <span class="remote-path-value" title="${escHtml(p.path)}">${escHtml(p.path)}</span>
      <button class="btn btn-sm btn-remote-path-remove" style="margin-left:auto">&#10005;</button>
    </div>
  `).join('');
}

async function saveRemoteGamePaths() {
  await window.pork.setSettings({ remoteGamePaths });
  setStatus('Settings saved', 'ok');
}

$('btn-add-remote-path').addEventListener('click', async () => {
  const label = $('new-remote-label').value.trim();
  const path  = $('new-remote-path').value.trim();
  if (!path) { setStatus('Enter a remote path', 'error'); return; }
  remoteGamePaths = [...remoteGamePaths, { label: label || path, path }];
  await saveRemoteGamePaths();
  renderRemoteGamePaths();
  $('new-remote-label').value = '';
  $('new-remote-path').value  = '';
});

$('settings-remote-paths-list').addEventListener('click', async e => {
  const row = e.target.closest('[data-idx]');
  if (!row || !e.target.closest('.btn-remote-path-remove')) return;
  const idx = Number(row.dataset.idx);
  const ok = await showConfirm(`Remove "${escHtml(remoteGamePaths[idx]?.label)}" from remote game paths?`);
  if (!ok) return;
  remoteGamePaths = remoteGamePaths.filter((_, i) => i !== idx);
  await saveRemoteGamePaths();
  renderRemoteGamePaths();
});

// ── Web UI Server ──────────────────────────────────────────────────────────────

async function refreshWebuiStatus() {
  try {
    const status = await window.pork.webuiStatus();
    const badge  = $('webui-status-badge');
    const urlRow = $('webui-url-row');
    const urlEl  = $('webui-url');
    const toggle = $('s-webui-enabled');

    if (badge)  badge.hidden  = !status.running;
    if (toggle) toggle.checked = status.running;

    if (urlRow && urlEl) {
      if (status.running) {
        const port = status.port;
        const hosts   = Array.isArray(status.hosts) && status.hosts.length ? status.hosts : ['localhost'];
        const primary = (window.pork.isWebMode && location.hostname)
          ? location.hostname
          : hosts[0];
        const primaryUrl = `http://${primary}:${port}`;
        urlEl.textContent = primaryUrl;
        urlRow.hidden = false;
        const openBtn = $('btn-webui-open');
        if (openBtn) openBtn.onclick = () => window.pork.openShell ? window.pork.openShell(primaryUrl) : window.open(primaryUrl, '_blank');
      } else {
        urlRow.hidden = true;
      }
    }
  } catch (_) {}
}

// Toggle — enable or disable the web server
$('s-webui-enabled').addEventListener('change', async function () {
  const btn = $('btn-webui-apply');
  if (btn) btn.disabled = true;
  try {
    if (this.checked) {
      const port = Number($('s-webui-port').value) || 6967;
      await window.pork.setSettings({ webUiEnabled: true, webUiPort: port });
      const res = await window.pork.webuiStart();
      if (!res.ok) { setStatus(`Web UI failed: ${res.error}`, 'error'); this.checked = false; }
      else           setStatus('Web UI server started', 'ok');
    } else {
      await window.pork.setSettings({ webUiEnabled: false });
      const res = await window.pork.webuiStop();
      if (res.ok) setStatus('Web UI server stopped', 'ok');
    }
  } catch (e) {
    setStatus(`Web UI error: ${e.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
    await refreshWebuiStatus();
  }
});

// Apply port change without toggling
$('btn-webui-apply').addEventListener('click', async () => {
  const port = Number($('s-webui-port').value) || 6967;
  await window.pork.setSettings({ webUiPort: port });
  if ($('s-webui-enabled').checked) {
    await window.pork.webuiStop();
    const res = await window.pork.webuiStart();
    if (res.ok) setStatus(`Web UI restarted on port ${port}`, 'ok');
    else        setStatus(`Web UI restart failed: ${res.error}`, 'error');
  } else {
    setStatus('Port saved', 'ok');
  }
  await refreshWebuiStatus();
});

