'use strict';

const fs = require('fs');
const path = require('path');

function validateRelativeName(name, label) {
  if (!name || typeof name !== 'string' || name !== path.basename(name) || name.includes('..') || /[\\/\0]/.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
  return name;
}

function normalizeEntries(entries, payloadNames) {
  const lines = [];
  for (const entry of entries || []) {
    if (!entry || !entry.type) continue;
    if (entry.type === 'payload') {
      const name = validateRelativeName(entry.value, 'payload name');
      if (!payloadNames.has(name)) throw new Error(`Autoloader references a payload that was not selected: ${name}`);
      lines.push(name);
    } else if (entry.type === 'delay') {
      const value = String(entry.value || '').trim();
      if (!/^\d{1,7}$/.test(value)) throw new Error(`Delay must be a whole number of milliseconds: ${entry.value}`);
      lines.push(`!${value}`);
    } else {
      throw new Error(`Unsupported BDJB autoloader entry type: ${entry.type}`);
    }
  }
  if (!lines.some((line) => !line.startsWith('!'))) throw new Error('Add at least one payload to the BDJB autoloader sequence.');
  return `${lines.join('\n')}\n`;
}

async function copyDirectory(source, target) {
  await fs.promises.cp(source, target, { recursive: true, force: true, errorOnExist: false });
}

async function prepareBdjbWorkspace({ templateDir, workspaceDir, payloads, entries, discTitle, log = () => {} }) {
  const required = ['BDMV', 'bin', 'payload.jar', 'ps5_autoloader', 'src', 'Makefile'];
  for (const item of required) {
    if (!fs.existsSync(path.join(templateDir, item))) throw new Error(`BDJB template is incomplete: missing ${item}`);
  }
  await fs.promises.rm(workspaceDir, { recursive: true, force: true });
  log('Copying the bundled Cyberpunk BDJB template.');
  await copyDirectory(templateDir, workspaceDir);

  const staged = new Map();
  for (const payload of payloads || []) {
    const name = validateRelativeName(payload?.name, 'payload name');
    if (!payload?.path || !fs.existsSync(payload.path)) throw new Error(`Selected payload is unavailable: ${name}`);
    if (!/\.(elf|bin)$/i.test(name)) throw new Error(`BDJB autoloader accepts ELF or BIN payloads: ${name}`);
    if (staged.has(name)) throw new Error(`Duplicate payload filename: ${name}`);
    staged.set(name, payload.path);
  }
  const autoload = normalizeEntries(entries, new Set(staged.keys()));
  const destination = path.join(workspaceDir, 'ps5_autoloader');
  for (const [name, source] of staged) {
    log(`Staging payload: ${name}`);
    await fs.promises.copyFile(source, path.join(destination, name));
  }
  await fs.promises.writeFile(path.join(destination, 'autoload.txt'), autoload, 'utf8');

  const title = String(discTitle || 'Porkfolio BDJB').replace(/[<&>]/g, '').trim() || 'Porkfolio BDJB';
  const metadataPath = path.join(workspaceDir, 'BDMV', 'META', 'DL', 'bdmt_eng.xml');
  const metadata = await fs.promises.readFile(metadataPath, 'utf8');
  await fs.promises.writeFile(metadataPath, metadata
    .replace(/<di:name>[^<]*<\/di:name>/, `<di:name>${title}</di:name>`)
    .replace(/<di:titleName titleNumber="1">[^<]*<\/di:titleName>/, `<di:titleName titleNumber="1">${title}</di:titleName>`), 'utf8');
  log(`Wrote autoload sequence with ${autoload.trim().split('\n').length} entries.`);
  return { workspaceDir, payloadCount: staged.size, autoload };
}

module.exports = { prepareBdjbWorkspace, normalizeEntries, validateRelativeName };
