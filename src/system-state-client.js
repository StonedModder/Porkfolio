'use strict';

const COMMANDS = Object.freeze({
  reboot: 'REBOOT',
  shutdown: 'SHUTDOWN',
  restmode: 'RESTMODE',
  eject: 'EJECT',
  status: 'STATUS',
});

function normalizeSystemStateCommand(action) {
  const command = COMMANDS[String(action || '').toLowerCase()];
  if (!command) throw new Error(`Unsupported system-state action: ${action}`);
  return command;
}

function parseSystemStateResponse(text) {
  const line = String(text || '').trim();
  if (line.startsWith('OK')) return { ok: true, response: line.slice(2).trim() };
  if (line.startsWith('ERR')) return { ok: false, response: line.slice(3).trim() };
  return { ok: false, response: line || 'No response from SystemStateManager.' };
}

module.exports = { normalizeSystemStateCommand, parseSystemStateResponse, COMMANDS };
