// ── Y2JB Update Generator ───────────────────────────────────────────────────

const y2jbGen = { entries: [], payloads: [] };

function y2jbGenRender() {
  const list = $('y2jbgen-list');
  if (!list) return;
  if (!y2jbGen.entries.length) {
    list.innerHTML = '<p class="hint autoloader-empty-hint">No entries yet. Add payload files, then order payloads, delays, and messages.</p>';
    return;
  }
  list.innerHTML = y2jbGen.entries.map((entry, index) => {
    const value = escHtml(entry.value || '');
    const title = entry.type === 'payload' ? 'Payload' : entry.type === 'delay' ? 'Delay (ms)' : 'Message';
    const placeholder = entry.type === 'payload' ? 'payload.elf' : entry.type === 'delay' ? '1000' : 'Shown during autoload';
    return `<div class="autoloader-row" data-y2jb-index="${index}">
      <span class="autoload-row-num">${index + 1}</span>
      <select class="y2jbgen-type" data-y2jb-type="${index}" aria-label="Y2JB entry type">
        <option value="payload" ${entry.type === 'payload' ? 'selected' : ''}>Payload</option>
        <option value="delay" ${entry.type === 'delay' ? 'selected' : ''}>Delay</option>
        <option value="message" ${entry.type === 'message' ? 'selected' : ''}>Message</option>
      </select>
      <input class="y2jbgen-value" data-y2jb-value="${index}" value="${value}" placeholder="${placeholder}" aria-label="${title}">
      <button class="btn btn-xs" data-y2jb-up="${index}" title="Move up">&#8593;</button>
      <button class="btn btn-xs" data-y2jb-down="${index}" title="Move down">&#8595;</button>
      <button class="btn btn-xs" data-y2jb-remove="${index}" title="Remove">&#10005;</button>
    </div>`;
  }).join('');
}

function y2jbGenSetStatus(text, type = '') {
  const status = $('y2jbgen-status');
  status.textContent = text;
  status.className = `hint ${type}`;
}

$('btn-y2jbgen-add-payloads').addEventListener('click', async () => {
  const btn = $('btn-y2jbgen-add-payloads');
  btn.disabled = true;
  y2jbGenSetStatus('Choosing payload files…');
  try {
    const chosen = await window.pork.y2jbGenSelectPayloads();
    let added = 0;
    for (const payload of chosen || []) {
      if (y2jbGen.payloads.some((item) => item.name === payload.name)) continue;
      y2jbGen.payloads.push(payload);
      y2jbGen.entries.push({ type: 'payload', value: payload.name });
      added += 1;
    }
    y2jbGenRender();
    y2jbGenSetStatus(added ? `Added ${added} payload file${added === 1 ? '' : 's'} ✓` : 'No new payload files selected.');
  } catch (error) {
    y2jbGenSetStatus(`Error: ${error.message}`, 'error');
  }
  btn.disabled = false;
});

$('btn-y2jbgen-add-delay').addEventListener('click', () => {
  y2jbGen.entries.push({ type: 'delay', value: '1000' });
  y2jbGenRender();
});

$('btn-y2jbgen-add-message').addEventListener('click', () => {
  y2jbGen.entries.push({ type: 'message', value: 'Starting next payload' });
  y2jbGenRender();
});

$('y2jbgen-list').addEventListener('input', (event) => {
  const index = Number(event.target.dataset.y2jbValue);
  if (Number.isInteger(index) && y2jbGen.entries[index]) y2jbGen.entries[index].value = event.target.value;
});

$('y2jbgen-list').addEventListener('change', (event) => {
  const index = Number(event.target.dataset.y2jbType);
  if (Number.isInteger(index) && y2jbGen.entries[index]) {
    y2jbGen.entries[index].type = event.target.value;
    if (event.target.value === 'delay' && !/^\d+$/.test(y2jbGen.entries[index].value)) y2jbGen.entries[index].value = '1000';
    y2jbGenRender();
  }
});

$('y2jbgen-list').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const up = Number(button.dataset.y2jbUp);
  const down = Number(button.dataset.y2jbDown);
  const remove = Number(button.dataset.y2jbRemove);
  if (Number.isInteger(up) && y2jbGen.entries[up] && up > 0) {
    [y2jbGen.entries[up - 1], y2jbGen.entries[up]] = [y2jbGen.entries[up], y2jbGen.entries[up - 1]];
  } else if (Number.isInteger(down) && y2jbGen.entries[down] && down < y2jbGen.entries.length - 1) {
    [y2jbGen.entries[down + 1], y2jbGen.entries[down]] = [y2jbGen.entries[down], y2jbGen.entries[down + 1]];
  } else if (Number.isInteger(remove) && y2jbGen.entries[remove]) {
    y2jbGen.entries.splice(remove, 1);
  } else {
    return;
  }
  y2jbGenRender();
});

$('btn-y2jbgen-build').addEventListener('click', async () => {
  const btn = $('btn-y2jbgen-build');
  btn.disabled = true;
  y2jbGenSetStatus('Validating and building ZIP…');
  try {
    const result = await window.pork.y2jbGenBuild({ entries: y2jbGen.entries, payloads: y2jbGen.payloads });
    if (result?.canceled) {
      y2jbGenSetStatus('Save cancelled.');
    } else {
      y2jbGenSetStatus(`Built ✓ ${result.outputZip} (${result.entryCount} entries)`);
    }
  } catch (error) {
    y2jbGenSetStatus(`Error: ${error.message}`, 'error');
  }
  btn.disabled = false;
});
