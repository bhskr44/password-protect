// The local record of what was locked and unlocked on this computer: one JSON
// object per line, append-only. Passwords are never written here.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function historyDir() {
  if (process.env.PROTECT_HISTORY_DIR) return process.env.PROTECT_HISTORY_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'PasswordProtect');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Password Protect');
  }
  return path.join(os.homedir(), '.local', 'state', 'password-protect');
}

export const historyFile = () => path.join(historyDir(), 'history.jsonl');

export function identity() {
  return { by: os.userInfo().username, host: os.hostname() };
}

export async function readHistory() {
  const text = await fsp.readFile(historyFile(), 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return []; // one damaged line should not hide the rest
    }
  });
}

export async function appendHistory(record) {
  await fsp.mkdir(historyDir(), { recursive: true, mode: 0o700 });
  await fsp.appendFile(historyFile(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// How this content compares with what was recorded before: the same path if it
// has been seen, otherwise anywhere, so a moved or renamed item still matches.
export function compareWithHistory(records, itemPath, sha256) {
  const previous = records.findLast((record) => record.path === itemPath);
  if (previous) return previous.sha256 === sha256 ? 'unchanged' : 'changed';
  return records.some((record) => record.sha256 === sha256) ? 'unchanged' : 'new';
}
