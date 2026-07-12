// ── Hash verification ──────────────────────────────────────────────────────────
let hashingInProgress = false;

window.pork.on('hash:progress', ({ percent }) => {
  const fill  = $('hash-progress-fill');
  const label = $('hash-progress-label');
  if (fill)  fill.style.width = `${percent}%`;
  if (label) label.textContent = `Hashing… ${percent}%`;
});

async function renderHashSection(game_id, backups) {
  const section = $('modal-hash-section');
  const badge   = $('modal-hash-community-badge');
  badge.hidden    = true;
  badge.className = 'hash-badge'; // reset class each render

  // Include both local and backpork backups — all game files deserve verification.
  if (!backups.length) { section.hidden = true; return; }
  section.hidden = false;

  const { localHashes, communityMatches, communityMismatch } = await window.pork.hashStatus(game_id);
  const communitySet = new Set(communityMatches.map(h => h.file_hash));

  // Badge above hash list: mismatch warning takes priority over verified check.
  const allInCommunity = localHashes.length > 0 && communityMatches.length === localHashes.length;
  if (communityMismatch && localHashes.length > 0) {
    badge.hidden    = false;
    badge.className = 'hash-badge hash-mismatch';
    badge.textContent = '⚠ Community Hash Mismatch — files may be modified or contain brick code';
  } else if (allInCommunity) {
    badge.hidden    = false;
    badge.className = 'hash-badge hash-community';
    badge.textContent = 'Community Verified ✓';
  }

  // Each backup is a folder — show aggregate hash status for the whole folder.
  $('modal-hash-list').innerHTML = backups.map(b => {
    const folderName     = b.backup_path.replace(/\\/g, '/').split('/').pop();
    const hashedCount    = localHashes.length;
    const communityCount = communityMatches.length;

    if (hashedCount === 0) {
      return `
        <div class="hash-entry">
          <div class="hash-entry-info">
            <span class="hash-filename">${escHtml(folderName)}</span>
            <span class="hash-badge hash-none">Not hashed</span>
          </div>
          <div class="hash-entry-status">
            <button class="btn btn-sm btn-teal hash-btn-add"
                    data-path="${escHtml(b.backup_path)}"
                    data-game="${escHtml(game_id)}"
                    data-source="${escHtml(b.source || 'local')}">Hash All Files</button>
          </div>
        </div>`;
    }

    const allCommunity = communityCount === hashedCount;
    const statusBadge  = allCommunity
      ? `<span class="hash-badge hash-community">${communityCount} file${communityCount !== 1 ? 's' : ''} community ✓</span>`
      : communityMismatch
        ? `<span class="hash-badge hash-mismatch">⚠ Hash Mismatch — ${hashedCount} local hash${hashedCount !== 1 ? 'es' : ''} don't match community list</span>`
        : `<span class="hash-badge hash-local">${hashedCount} file${hashedCount !== 1 ? 's' : ''} hashed</span>`
          + (communityCount > 0 ? ` <span class="hash-badge hash-community">${communityCount} community ✓</span>` : '');

    return `
      <div class="hash-entry">
        <div class="hash-entry-info">
          <span class="hash-filename">${escHtml(folderName)}</span>
          ${statusBadge}
        </div>
        <div class="hash-entry-status">
          <button class="btn btn-sm hash-btn-reverify"
                  data-path="${escHtml(b.backup_path)}"
                  data-game="${escHtml(game_id)}"
                  data-source="${escHtml(b.source || 'local')}">Re-verify All</button>
        </div>
      </div>`;
  }).join('');
}

async function runHash(backup_path, game_id, verified = 1, hash_type = 'game') {
  if (hashingInProgress) return;
  hashingInProgress = true;

  // Disable all hash buttons while running
  $('modal-hash-list').querySelectorAll('button').forEach(b => b.disabled = true);

  const prog = $('modal-hash-progress');
  const fill = $('hash-progress-fill');
  fill.style.width = '0%';
  prog.hidden = false;

  try {
    const { hashes } = await window.pork.hashCompute(backup_path, game_id);
    let communityCount = 0;
    for (const h of hashes) {
      const { communityMatch } = await window.pork.hashAdd({
        game_id, file_hash: h.file_hash, file_size: h.file_size, backup_path: h.backup_path, verified, hash_type,
      });
      if (communityMatch) communityCount++;
    }

    prog.hidden = true;
    if (communityCount > 0) {
      setStatus(`${hashes.length} file(s) hashed — ${communityCount} community match(es) ✓`, 'ok');
    } else {
      setStatus(`${hashes.length} file(s) hashed — will appear in the next community update`, 'ok');
    }

    // Re-render the hash section with fresh data
    const backups = await window.pork.listBackups(game_id);
    await renderHashSection(game_id, backups);
  } catch (e) {
    prog.hidden = true;
    setStatus(`Hash failed: ${e.message}`, 'error');
    // Re-enable buttons on error
    $('modal-hash-list').querySelectorAll('button').forEach(b => b.disabled = false);
  } finally {
    hashingInProgress = false;
  }
}

// Hash button delegation — attached once on the hash list container
$('modal-hash-list').addEventListener('click', async e => {
  if (hashingInProgress) return;

  // ── Hash & Add (not yet in DB) ─────────────────────────────────────────────
  const addBtn = e.target.closest('.hash-btn-add');
  if (addBtn) {
    await runHash(addBtn.dataset.path, addBtn.dataset.game, 1, addBtn.dataset.source === 'backpork' ? 'backpork' : 'game');
    return;
  }

  // ── Re-verify (already in DB) — show inline confirm first ─────────────────
  const reverifyBtn = e.target.closest('.hash-btn-reverify');
  if (reverifyBtn) {
    const statusEl = reverifyBtn.closest('.hash-entry-status');
    const path     = reverifyBtn.dataset.path;
    const game     = reverifyBtn.dataset.game;
    const source   = reverifyBtn.dataset.source;

    // Replace button with inline confirm
    reverifyBtn.style.display = 'none';
    const confirm = document.createElement('div');
    confirm.className = 'hash-confirm';
    confirm.innerHTML = `
      <span class="hash-confirm-msg">Game works?</span>
      <button class="btn btn-sm btn-teal hash-confirm-yes">Yes, verify</button>
      <button class="btn btn-sm hash-confirm-no">Cancel</button>`;
    statusEl.appendChild(confirm);

    confirm.querySelector('.hash-confirm-yes').addEventListener('click', async () => {
      confirm.remove();
      await runHash(path, game, 1, source === 'backpork' ? 'backpork' : 'game');
    });
    confirm.querySelector('.hash-confirm-no').addEventListener('click', () => {
      confirm.remove();
      reverifyBtn.style.display = '';
    });
    return;
  }
});

