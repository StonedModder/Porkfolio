// ── PS5 Autoloader ─────────────────────────────────────────────────────────────
let _alSequence = []; // { type: 'payload'|'delay', filename?: string, ms?: number }
let _alHeader   = ''; // comment block preserved from original file

const _AL_DEFAULT_HEADER =
`#
# ps5_autoloader - autoload.txt
# Edited with Porkfolio
# -----------------------------------------------------------------------------------------
# Usage:
# - Put one filename per line (e.g., payload.elf or script.js).
# - Supported payload types: .elf, .bin, .js
# - Lines starting with '!' are sleep commands (example: !1000 sleeps for 1000 ms).
# -----------------------------------------------------------------------------------------
`;

function _alParse(content) {
  if (!content) return { header: _AL_DEFAULT_HEADER, entries: [] };
  const lines = content.split(/\r?\n/);
  const headerLines = [];
  const entries = [];
  let headerDone = false;
  for (const line of lines) {
    const t = line.trim();
    if (!headerDone) {
      if (t.startsWith('#') || t === '') { headerLines.push(line); continue; }
      headerDone = true;
    }
    if (t === '' || t.startsWith('#')) continue;
    if (t.startsWith('!')) {
      const ms = parseInt(t.slice(1), 10);
      if (!isNaN(ms)) entries.push({ type: 'delay', ms });
    } else {
      entries.push({ type: 'payload', filename: t });
    }
  }
  const header = headerLines.join('\n').trimEnd() + '\n\n';
  return { header: header || _AL_DEFAULT_HEADER, entries };
}

function _alSerialize(header, entries) {
  const lines = [header.trimEnd(), ''];
  for (const e of entries)
    lines.push(e.type === 'delay' ? `!${e.ms}` : e.filename);
  return lines.join('\n') + '\n';
}

// drag-and-drop state
let _alDragIdx = -1;

function _alSecsFmt(ms) {
  const s = ms / 1000;
  return s === Math.floor(s) ? s.toFixed(1) + 's' : s.toFixed(2) + 's';
}

function _alBuildRow(entry, i) {
  const del = `<button class="al-del" data-al="remove" data-idx="${i}" title="Remove">&#10005;</button>`;
  if (entry.type === 'delay') {
    const capped = Math.min(entry.ms, 10000);
    const presets = [250, 500, 1000, 2000, 3000, 5000].map(p => {
      const lbl = p < 1000 ? `${p}ms` : `${p / 1000}s`;
      const active = entry.ms === p ? ' al-preset-active' : '';
      return `<button class="al-preset${active}" data-al="preset" data-idx="${i}" data-ms="${p}">${lbl}</button>`;
    }).join('');
    return `<div class="al-row al-delay" draggable="true" data-idx="${i}">
      <span class="al-grip" title="Drag to reorder">&#8942;&#8942;</span>
      <span class="al-delay-clock">&#9201;</span>
      <div class="al-delay-body">
        <div class="al-delay-top">
          <span class="al-delay-lbl">Wait</span>
          <input class="al-delay-num" type="number" min="0" max="60000" step="50"
                 value="${entry.ms}" data-al="delay-num" data-idx="${i}">
          <span class="al-delay-ms">ms</span>
          <span class="al-delay-secs" data-idx="${i}">(${_alSecsFmt(entry.ms)})</span>
          <div class="al-presets">${presets}</div>
        </div>
        <input class="al-slider" type="range" min="0" max="10000" step="50"
               value="${capped}" data-al="delay-slider" data-idx="${i}">
      </div>
      ${del}
    </div>`;
  }
  const ext = (entry.filename.split('.').pop() || '').toLowerCase();
  const extClass = { elf: 'al-ext-elf', bin: 'al-ext-bin', js: 'al-ext-js' }[ext] || '';
  return `<div class="al-row al-payload" draggable="true" data-idx="${i}">
    <span class="al-grip" title="Drag to reorder">&#8942;&#8942;</span>
    <span class="al-ext ${extClass}">${escHtml(ext || '?')}</span>
    <span class="al-name" title="${escHtml(entry.filename)}">${escHtml(entry.filename)}</span>
    <button class="al-ins-delay" data-al="ins-delay" data-idx="${i}" title="Insert delay after this payload">&#43;&#9201;</button>
    ${del}
  </div>`;
}

function _alRenderSequence() {
  const seq = $('autoloader-sequence');
  if (!seq) return;
  if (!_alSequence.length) {
    seq.innerHTML = `<div class="al-empty">
      <div class="al-empty-icon">&#128196;</div>
      <div>No entries yet.</div>
      <div class="al-empty-hint">Click a file on the left to add it to the sequence.</div>
    </div>`;
    return;
  }
  seq.innerHTML = _alSequence.map(_alBuildRow).join('');
  // attach drag-and-drop
  seq.querySelectorAll('.al-row[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => {
      _alDragIdx = parseInt(row.dataset.idx, 10);
      row.classList.add('al-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('al-dragging');
      seq.querySelectorAll('.al-drag-over').forEach(r => r.classList.remove('al-drag-over'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      seq.querySelectorAll('.al-drag-over').forEach(r => r.classList.remove('al-drag-over'));
      if (parseInt(row.dataset.idx, 10) !== _alDragIdx) row.classList.add('al-drag-over');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      let toIdx = parseInt(row.dataset.idx, 10);
      if (_alDragIdx === -1 || _alDragIdx === toIdx) return;
      const [item] = _alSequence.splice(_alDragIdx, 1);
      // Removing the dragged item shifts everything after it down by one, so for a
      // downward drag the target index must be decremented to land on the target's slot.
      if (_alDragIdx < toIdx) toIdx--;
      _alSequence.splice(toIdx, 0, item);
      _alDragIdx = -1;
      _alRenderSequence();
      $('btn-autoloader-save').disabled = false;
    });
  });
}

function _alRenderFiles(files) {
  const list = $('autoloader-file-list');
  if (!list) return;
  const payloads = files.filter(f => !f.isDir && /\.(elf|bin|js)$/i.test(f.name));
  if (!payloads.length) {
    list.innerHTML = '<p class="hint autoloader-empty-hint">No .elf / .bin / .js files found in /data/ps5_autoloader.</p>';
    return;
  }
  list.innerHTML = payloads.map(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const extClass = { elf: 'al-ext-elf', bin: 'al-ext-bin', js: 'al-ext-js' }[ext] || '';
    return `<div class="al-file-card" data-al-add="${escHtml(f.name)}" title="Click to add to sequence">
      <span class="al-ext ${extClass}">${escHtml(ext)}</span>
      <span class="al-file-name">${escHtml(f.name)}</span>
      <button class="btn-al-save-local" data-filename="${escHtml(f.name)}" title="Save to local payloads folder">&#8675;</button>
      <span class="al-file-add">&#43;</span>
    </div>`;
  }).join('');
}

async function loadAutoloader() {
  const btn    = $('btn-autoloader-refresh');
  const status = $('autoloader-status');
  btn.disabled = true;
  status.textContent = 'Loading…';
  try {
    // Sequential — basic-ftp rejects concurrent operations on the same client
    const files   = await window.pork.autoloaderList();
    const content = await window.pork.autoloaderRead();
    const { header, entries } = _alParse(content);
    _alHeader   = header;
    _alSequence = entries;
    _alRenderFiles(files);
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
    status.textContent = content
      ? `Loaded \u2014 ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
      : 'autoload.txt not found \u2014 sequence is empty';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function saveAutoloader() {
  const btn    = $('btn-autoloader-save');
  const status = $('autoloader-status');
  btn.disabled = true;
  status.textContent = 'Saving\u2026';
  try {
    const content = _alSerialize(_alHeader, _alSequence);
    await window.pork.autoloaderSave(content);
    status.textContent = 'Saved to PS5 \u2713';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    btn.disabled = false;
  }
}

$('btn-autoloader-refresh').addEventListener('click', loadAutoloader);
$('btn-autoloader-save').addEventListener('click', saveAutoloader);

$('btn-autoloader-add-delay').addEventListener('click', () => {
  _alSequence.push({ type: 'delay', ms: 1000 });
  _alRenderSequence();
  $('btn-autoloader-save').disabled = false;
});

// Sequence: clicks (remove, preset, insert-delay)
$('autoloader-sequence').addEventListener('click', e => {
  const btn = e.target.closest('[data-al]');
  if (!btn) return;
  const action = btn.dataset.al;
  const idx    = parseInt(btn.dataset.idx, 10);
  if (action === 'remove') {
    _alSequence.splice(idx, 1);
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
  } else if (action === 'preset') {
    const ms = parseInt(btn.dataset.ms, 10);
    _alSequence[idx].ms = ms;
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
  } else if (action === 'ins-delay') {
    // Insert a 1-second delay immediately after this payload
    _alSequence.splice(idx + 1, 0, { type: 'delay', ms: 1000 });
    _alRenderSequence();
    $('btn-autoloader-save').disabled = false;
  }
});

// Sequence: live slider / number sync (no full re-render needed)
$('autoloader-sequence').addEventListener('input', e => {
  const el  = e.target;
  const al  = el.dataset.al;
  if (!al) return;
  const idx = parseInt(el.dataset.idx, 10);
  if (al === 'delay-num' || al === 'delay-slider') {
    const ms = Math.max(0, parseInt(el.value, 10) || 0);
    _alSequence[idx].ms = ms;
    const row    = el.closest('.al-row');
    const num    = row.querySelector('[data-al="delay-num"]');
    const slider = row.querySelector('[data-al="delay-slider"]');
    const secs   = row.querySelector('.al-delay-secs');
    if (num)    num.value    = ms;
    if (slider) slider.value = Math.min(ms, 10000);
    if (secs)   secs.textContent = `(${_alSecsFmt(ms)})`;
    // Update active preset highlights without re-render
    row.querySelectorAll('.al-preset').forEach(p =>
      p.classList.toggle('al-preset-active', parseInt(p.dataset.ms, 10) === ms)
    );
    $('btn-autoloader-save').disabled = false;
  }
});

// ── Autoloader Snapshots ─────────────────────────────────────────────────────────────────────────────
async function renderAutoloaderSnapshots() {
  const list = $('snapshot-list');
  if (!list) return;
  list.innerHTML = '<p class="hint autoloader-empty-hint">Loading…</p>';
  try {
    const snaps = await window.pork.snapshotList();
    if (!snaps.length) {
      list.innerHTML = '<p class="hint autoloader-empty-hint">No snapshots yet. Take one above.</p>';
      return;
    }
    list.innerHTML = snaps.map(s => {
      const d       = new Date(s.createdAt);
      const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const fc      = (s.files || []).length;
      const alStr   = s.hasAutoload ? ' + autoload.txt' : '';
      return `<div class="snapshot-card">
        <div class="snapshot-card-info">
          <span class="snapshot-card-label">${escHtml(s.label || 'Snapshot')}</span>
          <span class="snapshot-card-meta">${dateStr} \u2014 ${fc} payload${fc !== 1 ? 's' : ''}${alStr}</span>
        </div>
        <div class="snapshot-card-actions">
          <button class="btn btn-teal btn-sm btn-snap-restore" data-snap-id="${escHtml(s.id)}">&uarr; Restore</button>
          <button class="btn btn-sm btn-snap-export" data-snap-id="${escHtml(s.id)}" title="Export snapshot to .porksnap file">&#8600; Export</button>
          <button class="btn btn-sm btn-snap-delete" data-snap-id="${escHtml(s.id)}" title="Delete snapshot">&#10005;</button>
        </div>
      </div>`;
    }).join('');

    // Attach direct listeners to each button — avoids event-delegation issues
    list.querySelectorAll('.btn-snap-restore').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id  = btn.dataset.snapId;
        const ok  = await showConfirm('Restore this snapshot to your PS5?\n\nAll payload files and autoload.txt will be uploaded back to /data/ps5_autoloader, overwriting whatever is currently there.');
        if (!ok) return;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⋯ Uploading…';
        try {
          const res = await window.pork.snapshotRestore(id);
          btn.textContent = '✓ Restored';
          const errNote = res.errors?.length ? ` (${res.errors.length} file${res.errors.length !== 1 ? 's' : ''} failed)` : '';
          showToast(`Snapshot restored ✓ — ${res.fileCount} file${res.fileCount !== 1 ? 's' : ''} uploaded to PS5${errNote}`, res.errors?.length ? 'info' : 'ok');
          setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
        } catch (er) {
          btn.textContent = orig;
          btn.disabled = false;
          showToast('Restore failed: ' + er.message, 'error');
        }
      });
    });

    list.querySelectorAll('.btn-snap-export').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id   = btn.dataset.snapId;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⋯';
        try {
          const res = await window.pork.snapshotExport(id);
          if (res?.canceled) { btn.textContent = orig; btn.disabled = false; return; }
          btn.textContent = '✓ Exported';
          showToast('Snapshot exported ✓', 'ok');
          setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
        } catch (er) {
          btn.textContent = orig;
          btn.disabled = false;
          showToast('Export failed: ' + er.message, 'error');
        }
      });
    });

    list.querySelectorAll('.btn-snap-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.snapId;
        const ok = await showConfirm('Delete this snapshot? This cannot be undone.');
        if (!ok) return;
        try {
          await window.pork.snapshotDelete(id);
          await renderAutoloaderSnapshots();
        } catch (er) {
          showToast('Delete failed: ' + er.message, 'error');
        }
      });
    });

  } catch (e) {
    list.innerHTML = `<p class="hint autoloader-empty-hint" style="color:var(--red)">Error: ${escHtml(e.message)}</p>`;
  }
}

// (Snapshot restore/delete/export listeners are attached directly inside renderAutoloaderSnapshots)

$('btn-snapshot-import').addEventListener('click', async () => {
  const btn    = $('btn-snapshot-import');
  const status = $('snapshot-take-status');
  const orig   = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⋯ Importing…';
  status.textContent = '';
  try {
    let res = await window.pork.snapshotImport();
    if (res?.canceled) { btn.textContent = orig; btn.disabled = false; return; }
    // ZIP import requires a label — prompt the user then re-submit
    if (res?.needsLabel) {
      const label = await showPrompt('Enter a label for this snapshot:', 'Imported ZIP');
      if (label === null) { btn.textContent = orig; btn.disabled = false; return; } // user cancelled
      res = await window.pork.snapshotImport({ label: label.trim() || 'Imported ZIP', filePath: res.filePath });
      if (res?.canceled) { btn.textContent = orig; btn.disabled = false; return; }
    }
    status.textContent = `Imported ✓ — "${res.meta.label}"`;
    await renderAutoloaderSnapshots();
  } catch (e) {
    status.textContent = 'Import failed: ' + e.message;
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
});

$('btn-snapshot-take').addEventListener('click', async () => {
  const btn    = $('btn-snapshot-take');
  const status = $('snapshot-take-status');
  const label  = $('snapshot-label').value.trim() || 'Snapshot';
  btn.disabled = true;
  status.textContent = 'Downloading from PS5\u2026';
  try {
    const { meta } = await window.pork.snapshotTake(label);
    const fc    = meta.files.length;
    const alStr = meta.hasAutoload ? ' + autoload.txt' : '';
    status.textContent = `Saved \u2713 \u2014 ${fc} payload${fc !== 1 ? 's' : ''}${alStr}`;
    $('snapshot-label').value = '';
    await renderAutoloaderSnapshots();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

