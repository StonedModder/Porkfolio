// ── PS Notify page ────────────────────────────────────────────────────────────

async function loadPsNotify() {
  // Populate settings fields from store
  try {
    const s = await window.pork.getSettings();
    $('psn-enabled').checked = s.psnotifyEnabled !== false;
    $('psn-port').value      = s.psnotifyPort || 6969;
  } catch (_) {}
  await renderPsnHistory();
}

async function renderPsnHistory() {
  const hist    = await window.pork.psnotifyHistory();
  const list    = $('psn-history');
  const empty   = $('psn-history-empty');
  if (!hist.length) {
    list.innerHTML = '';
    empty.hidden   = false;
    return;
  }
  empty.hidden   = true;
  list.innerHTML = hist.slice().reverse().map(e => {
    const cls = e.ok !== false ? 'psn-ok' : 'psn-fail';
    const ts  = new Date(e.ts).toLocaleTimeString();
    const sub = e.subMessage ? `<span class="psn-entry-sub">\u2014 ${escHtml(e.subMessage)}</span>` : '';
    return `<div class="psn-entry ${cls}">
      <span class="psn-entry-ts">${ts}</span>
      <span class="psn-entry-msg">${escHtml(e.message)}</span>${sub}
    </div>`;
  }).join('');
}

$('btn-psn-send').addEventListener('click', async () => {
  const msg = $('psn-message').value.trim();
  const sub = $('psn-submessage').value.trim();
  if (!msg) { $('psn-status').textContent = 'Message is required.'; return; }
  const btn = $('btn-psn-send');
  btn.disabled = true;
  $('psn-status').textContent = 'Sending\u2026';
  try {
    await window.pork.psnotifySend(msg, sub);
    $('psn-status').textContent = 'Sent \u2713';
    $('psn-message').value    = '';
    $('psn-submessage').value = '';
    await renderPsnHistory();
  } catch (e) {
    $('psn-status').textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
});

$('btn-psn-test').addEventListener('click', async () => {
  const btn = $('btn-psn-test');
  btn.disabled = true;
  $('psn-status').textContent = 'Sending test\u2026';
  try {
    await window.pork.psnotifyTest();
    $('psn-status').textContent = 'Test sent \u2713';
    await renderPsnHistory();
  } catch (e) {
    $('psn-status').textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
});

$('btn-psn-save-settings').addEventListener('click', async () => {
  const port = parseInt($('psn-port').value) || 6969;
  await window.pork.setSettings({
    psnotifyEnabled: $('psn-enabled').checked,
    psnotifyPort:    port,
  });
  $('psn-port').value = port;
  $('psn-status').textContent = 'Settings saved \u2713';
});

$('btn-psn-refresh-history').addEventListener('click', renderPsnHistory);

// ── PS Notify colour/encoding experiments ────────────────────────────────────────

async function _sendExp(msg, sub = '') {
  const el = $('psn-exp-status');
  el.textContent = 'Sending…';
  try {
    await window.pork.psnotifySend(msg, sub);
    el.textContent = 'Sent \u2713 — check your PS5';
    await renderPsnHistory();
  } catch (e) {
    el.textContent = 'Error: ' + e.message;
  }
}

$('btn-psn-push-payload').addEventListener('click', async () => {
  const btn = $('btn-psn-push-payload');
  const st  = $('psn-push-status');
  btn.disabled = true;
  st.textContent = 'Queuing upload\u2026';
  try {
    const res = await window.pork.psnotifyPushPayload();
    st.textContent = `Queued \u2713 \u2014 sending to ${res.remotePath}. Reload the payload on your PS5 then emoji will work.`;
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
});

// HTML markup
$('btn-psn-exp-html-red').addEventListener('click', () =>
  _sendExp('<font color="red">This is red text</font>', 'HTML <font color> test'));

$('btn-psn-exp-html-multi').addEventListener('click', () =>
  _sendExp('<font color="red">Red</font> <font color="green">Green</font> <font color="blue">Blue</font>', 'HTML multi-colour test'));

$('btn-psn-exp-sony-tag').addEventListener('click', () =>
  _sendExp('$[color=ff0000]Red$[/color] $[color=00ff00]Green$[/color]', 'Sony $[color] tag test'));

// Emoji colour squares (4-byte UTF-8 — need TextDecoder patch in customPSNotify.js to arrive intact)
$('btn-psn-exp-sq-red').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE5 Red notification', 'Emoji \uD83D\uDFE5 (U+1F7E5, 4-byte UTF-8)'));

$('btn-psn-exp-sq-green').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE9 Green notification', 'Emoji \uD83D\uDFE9 (U+1F7E9, 4-byte UTF-8)'));

$('btn-psn-exp-sq-blue').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE6 Blue notification', 'Emoji \uD83D\uDFE6 (U+1F7E6, 4-byte UTF-8)'));

$('btn-psn-exp-sq-yellow').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE8 Yellow notification', 'Emoji \uD83D\uDFE8 (U+1F7E8, 4-byte UTF-8)'));

$('btn-psn-exp-sq-all').addEventListener('click', () =>
  _sendExp('\uD83D\uDFE5\uD83D\uDFE7\uD83D\uDFE8\uD83D\uDFE9\uD83D\uDFE6\uD83D\uDFEA Colour squares test', 'All 6 colour squares'));

// ANSI escape codes
$('btn-psn-exp-ansi-red').addEventListener('click', () =>
  _sendExp('\x1b[31mRed ANSI text\x1b[0m', 'ANSI \\x1b[31m colour test'));

$('btn-psn-exp-ansi-bold').addEventListener('click', () =>
  _sendExp('\x1b[1mBold ANSI text\x1b[0m', 'ANSI \\x1b[1m bold test'));

