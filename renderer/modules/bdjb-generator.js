// BDJB Genny

const bdjbPayloads = [];
const bdjbEntries = [];

function renderBdjbEntries() {
  const list = $('bdjbgen-list');
  if (!bdjbEntries.length) { list.innerHTML = '<p class="hint autoloader-empty-hint">No entries yet. Add payload files, then adjust their autoload order and delays.</p>'; return; }
  list.innerHTML = bdjbEntries.map((entry, index) => `<div class="autoloader-row"><span>${entry.type === 'delay' ? `Delay: ${entry.value} ms` : `Payload: ${escHtml(entry.value)}`}</span><span><button class="btn btn-sm" data-bdjb-up="${index}" ${index === 0 ? 'disabled' : ''}>Up</button><button class="btn btn-sm" data-bdjb-down="${index}" ${index === bdjbEntries.length - 1 ? 'disabled' : ''}>Down</button><button class="btn btn-sm btn-red" data-bdjb-remove="${index}">Remove</button></span></div>`).join('');
}

function bdjbLog(message) {
  const log = $('bdjbgen-log');
  log.textContent += `${message}\n`;
  log.scrollTop = log.scrollHeight;
}

$('btn-bdjbgen-add-payloads').addEventListener('click', async () => {
  const added = await window.pork.bdjbGenSelectPayloads();
  for (const payload of added) {
    if (bdjbPayloads.some((existing) => existing.name === payload.name)) { bdjbLog(`Skipped duplicate filename: ${payload.name}`); continue; }
    bdjbPayloads.push(payload); bdjbEntries.push({ type: 'payload', value: payload.name });
  }
  renderBdjbEntries();
});

$('btn-bdjbgen-add-delay').addEventListener('click', async () => {
  const value = await showPrompt('Delay in milliseconds:', '1000');
  if (value === null || value === '') return;
  bdjbEntries.push({ type: 'delay', value: String(value).trim() }); renderBdjbEntries();
});

$('bdjbgen-list').addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button) return;
  const remove = button.dataset.bdjbRemove, up = button.dataset.bdjbUp, down = button.dataset.bdjbDown;
  if (remove !== undefined) bdjbEntries.splice(Number(remove), 1);
  else if (up !== undefined) { const i = Number(up); [bdjbEntries[i - 1], bdjbEntries[i]] = [bdjbEntries[i], bdjbEntries[i - 1]]; }
  else if (down !== undefined) { const i = Number(down); [bdjbEntries[i + 1], bdjbEntries[i]] = [bdjbEntries[i], bdjbEntries[i + 1]]; }
  renderBdjbEntries();
});

window.pork.on('bdjbgen:progress', ({ stage, message, percent }) => {
  $('bdjbgen-progress').value = percent || 0;
  $('bdjbgen-status').textContent = `${stage}: ${message}`;
  bdjbLog(`[${stage}] ${message}`);
});

$('btn-bdjbgen-build').addEventListener('click', async () => {
  const button = $('btn-bdjbgen-build');
  button.disabled = true; $('bdjbgen-log').textContent = ''; $('bdjbgen-progress').value = 0;
  try {
    const result = await window.pork.bdjbGenBuild({ entries: bdjbEntries, payloads: bdjbPayloads, discTitle: $('bdjbgen-title').value });
    if (result.canceled) { $('bdjbgen-status').textContent = 'Build canceled.'; return; }
    $('bdjbgen-status').textContent = `ISO ready: ${result.outputIso} (${result.bytes} bytes)`;
    bdjbLog(`Validated ISO with ${result.payloadCount} payload(s).`);
  } catch (error) {
    $('bdjbgen-status').textContent = `Build failed: ${error.message}`;
    bdjbLog(`ERROR: ${error.message}`);
  } finally { button.disabled = false; }
});
