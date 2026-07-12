// System State Controls

let pendingSystemAction = null;
const systemStateLabels = {
  shutdown: 'Shutdown', reboot: 'Reboot', restmode: 'Enter Rest Mode', eject: 'Eject Disc',
};

function systemStateStatus(text, error = false) {
  const el = $('system-state-status');
  el.textContent = text;
  el.style.color = error ? 'var(--red)' : '';
}

async function refreshSystemStateStatus() {
  systemStateStatus('Checking service...');
  const result = await window.pork.systemStateStatus();
  systemStateStatus(result.connected ? `Service ready: ${result.response || 'port 9112'}` : (result.error || result.response || 'Service unavailable.'), !result.connected);
}

$('btn-system-state-status').addEventListener('click', () => refreshSystemStateStatus().catch(error => systemStateStatus(error.message, true)));

$('btn-system-state-deploy').addEventListener('click', async () => {
  const button = $('btn-system-state-deploy');
  button.disabled = true;
  systemStateStatus('Sending payload to loader port 9021...');
  try {
    const result = await window.pork.systemStateDeploy();
    systemStateStatus(`${result.message} (${result.bytes} bytes)`);
  } catch (error) {
    systemStateStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('.system-state-action').forEach((button) => button.addEventListener('click', () => {
  pendingSystemAction = button.dataset.systemAction;
  const command = pendingSystemAction === 'restmode' ? 'RESTMODE' : pendingSystemAction.toUpperCase();
  $('system-state-confirm-title').textContent = `Confirm: ${systemStateLabels[pendingSystemAction]}`;
  $('system-state-confirm-copy').textContent = `This sends ${command} to SystemStateManager on your PS5. Type "CONFIRM ${command}" exactly to enable the action.`;
  $('system-state-confirm-input').value = '';
  $('system-state-confirm').hidden = false;
  $('system-state-confirm-input').focus();
}));

$('system-state-confirm-input').addEventListener('input', () => {
  if (!pendingSystemAction) return;
  const command = pendingSystemAction === 'restmode' ? 'RESTMODE' : pendingSystemAction.toUpperCase();
  $('btn-system-state-confirm').disabled = $('system-state-confirm-input').value !== `CONFIRM ${command}`;
});

$('btn-system-state-cancel').addEventListener('click', () => {
  pendingSystemAction = null;
  $('system-state-confirm').hidden = true;
});

$('btn-system-state-confirm').addEventListener('click', async () => {
  if (!pendingSystemAction) return;
  const action = pendingSystemAction;
  const command = action === 'restmode' ? 'RESTMODE' : action.toUpperCase();
  const button = $('btn-system-state-confirm');
  button.disabled = true;
  systemStateStatus(`Sending ${command}...`);
  try {
    const result = await window.pork.systemStateCommand({ action, confirmation: `CONFIRM ${command}` });
    systemStateStatus(`${systemStateLabels[action]} command accepted: ${result.response || 'OK'}`);
    $('system-state-confirm').hidden = true;
    pendingSystemAction = null;
  } catch (error) {
    systemStateStatus(error.message, true);
    button.disabled = false;
  }
});
