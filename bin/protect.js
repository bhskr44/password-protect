#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { historyFile, readHistory } from '../lib/history.js';
import {
  cleanDroppedPath, hashPath, isLockedFile, lockPath, readHeader, unlockPath, unzipFile, verifyLocked,
} from '../lib/protect.js';

const USAGE = `Password-protect any file or folder.

Usage:
  protect                          Guided mode: asks what to do (or double-click the app)
  protect <path>                   Lock it, or unlock it if it is already locked
  protect lock <file-or-folder>    Encrypt into <name>.locked
  protect unlock <file.locked>     Restore the original next to the locked file
  protect unzip <file.zip>         Extract a zip into a folder beside it
  protect verify <file.locked>     Ask for the password and show the SHA-256 and who locked
                                   it, without unlocking anything
  protect history [text]           Show who locked and unlocked what on this computer,
                                   optionally only entries matching a path or SHA-256
  protect hash <file-or-folder>    Show its SHA-256 and whether the history has seen it

Options:
  -o, --output <path>   lock: where to write the locked file
                        unlock: folder to restore into
      --remove          lock: delete the original once the locked file is verified
                        unlock: delete the locked file after restoring
      --unzip           unlock: also extract the result if it is a zip
      --against <sha|path>  verify: compare with a SHA-256 or an unlocked copy
      --limit <n>       history: how many entries to show, newest first (default 50)
      --password-stdin  Read the password from stdin (for scripts)
  -h, --help            Show this help

Without --remove, lock leaves the unencrypted original in place.
A forgotten password cannot be recovered.
`;

const MIN_PASSWORD_LEN = 8;

function prompt(label, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    let answer = '';
    const finish = (settle, value) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      settle(value);
    };
    const onData = (text) => {
      for (const char of text) {
        if (char === '\r' || char === '\n' || char === '\x04') return finish(resolve, answer);
        if (char === '\x03') return finish(reject, new Error('Cancelled.'));
        if (char === '\x7f' || char === '\b') {
          if (answer && !hidden) stderr.write('\b \b');
          answer = [...answer].slice(0, -1).join('');
        } else if (char >= ' ') {
          answer += char;
          if (!hidden) stderr.write(char);
        }
      }
    };
    stderr.write(label);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readStdinPassword() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const piece of process.stdin) text += piece;
  return text.replace(/\r?\n$/, '');
}

async function getPassword({ fromStdin, confirm }) {
  let password;
  if (fromStdin) {
    password = await readStdinPassword();
  } else {
    if (!process.stdin.isTTY) {
      throw new Error('No terminal to ask for a password. Use --password-stdin in scripts.');
    }
    password = await prompt('Password: ', { hidden: true });
    if (confirm && password !== (await prompt('Confirm password: ', { hidden: true }))) {
      throw new Error('Passwords do not match.');
    }
  }
  if (!password) throw new Error('The password cannot be empty.');
  if (confirm && [...password].length < MIN_PASSWORD_LEN) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD_LEN} characters.`);
  }
  return password;
}

function friendly(error) {
  return error.code === 'ENOENT' && error.path ? `Not found: ${error.path}` : error.message;
}

const STATUS_TEXT = {
  new: 'First time recorded',
  unchanged: 'Unchanged: same content as the previous record',
  changed: 'CHANGED since the previous record',
  verified: 'Verified: identical to what was locked',
  checked: 'Checked with the password',
  match: 'MATCH: identical content',
  mismatch: 'DOES NOT MATCH: the content is different',
};

const whenText = (iso) => new Date(iso).toLocaleString();

async function runHistory(filter, limit) {
  const records = (await readHistory())
    .filter((r) => !filter || r.path.includes(filter) || r.sha256 === filter.toLowerCase());
  const shown = records.slice(-Number(limit ?? 50)).reverse();
  if (!shown.length) console.log('No matching history on this computer.');
  for (const r of shown) {
    console.log(`${whenText(r.at)}  ${r.action.toUpperCase()}  by ${r.by} on ${r.host}`);
    console.log(`  ${r.path}`);
    console.log(`  ${STATUS_TEXT[r.status] ?? r.status}`);
    if (r.lockedBy) console.log(`  Locked by ${r.lockedBy} on ${r.lockedOn}, ${whenText(r.lockedAt)}`);
    console.log(`  SHA-256: ${r.sha256}\n`);
  }
  console.log(`History file: ${historyFile()}`);
}

async function runHash(target) {
  const { sha256, files, bytes, matches } = await hashPath(target);
  console.log(`SHA-256: ${sha256}`);
  console.log(`Contains: ${files} file(s), ${bytes} bytes`);
  if (!matches.length) console.log('History: no record has this content.');
  for (const r of matches.slice(-5).reverse()) {
    console.log(`History: same content as ${r.action} by ${r.by} on ${r.host}, ${whenText(r.at)}`);
  }
}

async function runVerify(target, { against, fromStdin }) {
  await readHeader(path.resolve(target));
  const password = await getPassword({ fromStdin, confirm: false });
  const result = await verifyLocked(target, { password, against });
  console.log(`SHA-256: ${result.sha256}`);
  console.log(`Contains: ${result.files} file(s), ${result.bytes} bytes`);
  console.log(result.meta
    ? `Locked by ${result.meta.by} on ${result.meta.host}, ${whenText(result.meta.at)}`
    : 'Locked by: not recorded (locked by an older version)');
  if (result.expected) {
    console.log(`Compared with: ${result.expected}`);
    console.log(STATUS_TEXT[result.status]);
  }
  for (const warning of result.warnings) console.log(`Note: ${warning}`);
  if (result.status === 'mismatch') process.exitCode = 1;
}

async function runLock(target, { output, remove, fromStdin }) {
  const password = await getPassword({ fromStdin, confirm: true });
  const locked = await lockPath(target, { password, output, remove });
  console.log(`Locked: ${locked.path}`);
  console.log(`SHA-256: ${locked.sha256}`);
  console.log(STATUS_TEXT[locked.status]);
  for (const warning of locked.warnings) console.log(`Note: ${warning}`);
  console.log(remove
    ? `Removed original: ${path.resolve(target)}`
    : `The unencrypted original is still at ${path.resolve(target)}.`);
}

async function runUnlock(target, { output, remove, unzip, fromStdin }) {
  await readHeader(path.resolve(target)); // don't ask for a password for the wrong file
  const password = await getPassword({ fromStdin, confirm: false });
  const result = await unlockPath(target, { password, output, remove });
  console.log(`Unlocked: ${result.path}`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(STATUS_TEXT[result.status]);
  if (result.meta) {
    console.log(`Locked by ${result.meta.by} on ${result.meta.host}, ${whenText(result.meta.at)}`);
  }
  for (const warning of result.warnings) console.log(`Note: ${warning}`);
  if (unzip && /\.zip$/i.test(result.path)) console.log(`Extracted: ${await unzipFile(result.path)}`);
}

// For double-clicking the app, or dropping something onto it on Windows.
async function guided(given, options) {
  try {
    console.log('Password Protect: lock or unlock any file or folder.\n');
    const target = given ?? cleanDroppedPath(await prompt('Drag a file or folder here (or type history), then press Enter: '));
    if (!target) throw new Error('Nothing selected.');
    if (target.toLowerCase() === 'history') {
      await runHistory();
    } else if (await isLockedFile(target)) {
      if (/^v/i.test(await prompt('[U]nlock or [V]erify without unlocking? '))) {
        const against = await prompt('SHA-256 from the other machine (Enter to skip): ');
        await runVerify(target, { ...options, against: against.trim() || undefined });
      } else {
        await runUnlock(target, { ...options, unzip: true });
      }
    } else if (/\.zip$/i.test(target) && /^e/i.test(await prompt('[E]xtract this zip or [L]ock it? '))) {
      console.log(`Extracted: ${await unzipFile(target)}`);
    } else {
      console.log('A forgotten password cannot be recovered.');
      const answer = options.remove ? 'y' : await prompt('Delete the original after locking? [y/N] ');
      await runLock(target, { ...options, remove: /^y/i.test(answer) });
    }
  } catch (error) {
    console.error(`Error: ${friendly(error)}`);
    process.exitCode = 1;
  }
  // The window closes when the program ends, taking the result with it.
  await prompt('\nPress Enter to close.', { hidden: true }).catch(() => {});
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      remove: { type: 'boolean', default: false },
      unzip: { type: 'boolean', default: false },
      limit: { type: 'string' },
      against: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const explicit = ['lock', 'unlock', 'unzip', 'verify', 'history', 'hash'].includes(positionals[0]);
  const [target, ...extra] = explicit ? positionals.slice(1) : positionals;
  const options = {
    output: values.output, remove: values.remove, unzip: values.unzip, fromStdin: values['password-stdin'],
  };

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (positionals[0] === 'history' && !extra.length) {
    await runHistory(target, values.limit);
    return;
  }
  if (extra.length || (explicit && !target)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!explicit && process.stdin.isTTY && !options.fromStdin) {
    await guided(target, options);
    return;
  }
  if (!explicit && !target) {
    process.stdout.write(USAGE);
    return;
  }

  if (positionals[0] === 'verify') {
    await runVerify(target, { ...options, against: values.against });
    return;
  }
  if (positionals[0] === 'hash') {
    await runHash(target);
    return;
  }
  if (positionals[0] === 'unzip') {
    console.log(`Extracted: ${await unzipFile(target)}`);
    return;
  }

  const locking = explicit ? positionals[0] === 'lock' : !(await isLockedFile(target));
  await (locking ? runLock : runUnlock)(target, options);
}

main().catch((error) => {
  console.error(`Error: ${friendly(error)}`);
  process.exitCode = 1;
});
