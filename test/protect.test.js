import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHUNK_SIZE, END_MARKER, ENTRY_HEAD_LEN, HEADER_LEN, cleanDroppedPath,
  deriveKey, encryptChunks, entryHead, newHeader, unlockPath, windowsSafeName,
} from '../lib/protect.js';

const CLI = fileURLToPath(new URL('../bin/protect.js', import.meta.url));
const PASSWORD = 'correct horse battery';
const SEALED_CHUNK = CHUNK_SIZE + 16;
const IS_WINDOWS = process.platform === 'win32';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-test-'));
process.env.PROTECT_HISTORY_DIR = path.join(base, 'history');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const workspace = () => fs.mkdtempSync(path.join(base, 'w-'));

function run(args, password = PASSWORD) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--password-stdin'], {
    input: `${password}\n`, encoding: 'utf8',
  });
  return { ...result, output: result.stdout + result.stderr };
}

function ok(args, password) {
  const result = run(args, password);
  assert.equal(result.status, 0, result.output);
  return result;
}

function fails(args, pattern, password) {
  const result = run(args, password);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, pattern);
}

function makeTree(dir) {
  const root = path.join(dir, 'secret folder');
  fs.mkdirSync(path.join(root, 'nested/deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'nested/deep/naïve ✓.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'blank'), '');
  fs.writeFileSync(path.join(root, 'big.bin'), crypto.randomBytes(3 * CHUNK_SIZE + 17));
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o750 });
  fs.symlinkSync('nested/deep', path.join(root, 'link'));
  return root;
}

function snapshot(root) {
  const out = {};
  const visit = (p, rel) => {
    const stat = fs.lstatSync(p);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) out[rel] = ['link', fs.readlinkSync(p)];
    else if (stat.isDirectory()) {
      out[rel] = ['dir', mode, Math.floor(stat.mtimeMs)];
      for (const name of fs.readdirSync(p)) visit(path.join(p, name), `${rel}/${name}`);
    } else out[rel] = ['file', mode, Math.floor(stat.mtimeMs), fs.readFileSync(p, 'hex')];
  };
  visit(root, '.');
  return out;
}

async function lockCrafted(file, pieces) {
  const header = newHeader();
  const key = await deriveKey(PASSWORD, header);
  const parts = [header];
  for await (const sealed of encryptChunks(pieces, key, header)) parts.push(sealed);
  fs.writeFileSync(file, Buffer.concat(parts));
}

const meta = { mode: 0o644, mtimeMs: 0 };
const fileEntry = (name, data) => [entryHead(1, name, { ...meta, size: data.length }), data];
const dirEntry = (name) => [entryHead(2, name, { ...meta, size: 0 })];
const linkEntry = (name, target) => [entryHead(3, name, { ...meta, size: target.length }), Buffer.from(target)];

test('a single file round-trips with its content, mode and mtime', () => {
  const dir = workspace();
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'top secret', { mode: 0o640 });
  fs.utimesSync(file, new Date(1e12), new Date(1e12));
  const before = snapshot(file);

  ok(['lock', file]);
  if (!IS_WINDOWS) assert.equal(fs.statSync(`${file}.locked`).mode & 0o777, 0o600);
  fs.rmSync(file);
  ok(['unlock', `${file}.locked`]);
  assert.deepEqual(snapshot(file), before);
});

test('a folder round-trips, including nested, empty, unicode, symlink and multi-chunk entries', () => {
  const dir = workspace();
  const root = makeTree(dir);
  const before = snapshot(root);

  ok(['lock', root]);
  fs.rmSync(root, { recursive: true });
  ok(['unlock', `${root}.locked`]);
  assert.deepEqual(snapshot(root), before);
});

test('read-only folders and files can be restored', () => {
  const dir = workspace();
  const root = path.join(dir, 'ro');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'f'), 'x', { mode: 0o400 });
  fs.chmodSync(root, 0o500);
  const before = snapshot(root);

  ok(['lock', root]);
  const dest = path.join(dir, 'dest');
  ok(['unlock', `${root}.locked`, '-o', dest]);
  assert.deepEqual(snapshot(path.join(dest, 'ro')), before);
  fs.chmodSync(path.join(dest, 'ro'), 0o700);
  fs.chmodSync(root, 0o700);
});

test('plaintext that exactly fills a chunk round-trips', async () => {
  const dir = workspace();
  const name = 'exact.bin';
  const size = CHUNK_SIZE - (1 + ENTRY_HEAD_LEN + name.length + END_MARKER.length);
  const locked = path.join(dir, 'exact.locked');
  await lockCrafted(locked, [...fileEntry(name, Buffer.alloc(size, 7)), END_MARKER]);
  assert.equal(fs.statSync(locked).size, HEADER_LEN + SEALED_CHUNK);

  await unlockPath(locked, { password: PASSWORD });
  assert.equal(fs.statSync(path.join(dir, name)).size, size);
});

test('names and contents do not appear in the locked file', () => {
  const dir = workspace();
  const root = path.join(dir, 'visible');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'hidden-filename.txt'), 'hidden-content');

  ok(['lock', root]);
  const raw = fs.readFileSync(`${root}.locked`);
  for (const needle of ['hidden-filename', 'hidden-content', 'visible']) {
    assert.equal(raw.includes(needle), false, needle);
  }
});

test('locking the same input twice produces unrelated output', () => {
  const dir = workspace();
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'same');
  ok(['lock', file, '-o', `${file}.a`]);
  ok(['lock', file, '-o', `${file}.b`]);
  assert.notDeepEqual(fs.readFileSync(`${file}.a`), fs.readFileSync(`${file}.b`));
});

test('a wrong password fails and leaves nothing behind', () => {
  const dir = workspace();
  const root = makeTree(dir);
  ok(['lock', root]);
  fs.rmSync(root, { recursive: true });

  fails(['unlock', `${root}.locked`], /Wrong password/, 'not the password');
  assert.deepEqual(fs.readdirSync(dir), ['secret folder.locked']);
});

test('tampering anywhere is detected and nothing is restored', () => {
  const dir = workspace();
  const root = makeTree(dir);
  ok(['lock', root]);
  fs.rmSync(root, { recursive: true });
  const locked = `${root}.locked`;
  const good = fs.readFileSync(locked);

  const attempt = (bytes, pattern) => {
    const copy = path.join(dir, 'attack.locked');
    fs.writeFileSync(copy, bytes);
    fails(['unlock', copy], pattern);
    fs.rmSync(copy);
    assert.deepEqual(fs.readdirSync(dir), ['secret folder.locked']);
  };
  const flip = (at) => {
    const copy = Buffer.from(good);
    copy[at] ^= 1;
    return copy;
  };
  const chunk = (i) => good.subarray(HEADER_LEN + i * SEALED_CHUNK, HEADER_LEN + (i + 1) * SEALED_CHUNK);

  attempt(flip(10), /Wrong password/); // salt
  attempt(flip(HEADER_LEN + 5), /Wrong password/); // first chunk
  attempt(flip(good.length - 1), /corrupted/); // last chunk
  attempt(flip(HEADER_LEN + SEALED_CHUNK + 5), /corrupted/); // middle chunk
  attempt(good.subarray(0, good.length - 1), /corrupted/); // truncated mid-chunk
  attempt(good.subarray(0, HEADER_LEN + SEALED_CHUNK), /corrupted|Wrong password/); // whole chunks dropped
  attempt(good.subarray(0, HEADER_LEN), /corrupted|Wrong password/); // body removed
  attempt(Buffer.concat([good, Buffer.from('x')]), /corrupted/); // appended data
  attempt(Buffer.concat([good.subarray(0, HEADER_LEN), chunk(1), chunk(0), good.subarray(HEADER_LEN + 2 * SEALED_CHUNK)]), /Wrong password/); // reordered
});

test('a non-locked file is rejected before a password is requested', () => {
  const dir = workspace();
  const file = path.join(dir, 'plain.txt');
  fs.writeFileSync(file, 'this is just some text, it is long enough to be a header');
  fails(['unlock', file], /not a file locked/);
});

test('existing files are never overwritten', () => {
  const dir = workspace();
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'original');
  ok(['lock', file]);
  const locked = fs.readFileSync(`${file}.locked`);

  fails(['lock', file], /Already exists/);
  assert.deepEqual(fs.readFileSync(`${file}.locked`), locked);
  fails(['unlock', `${file}.locked`], /Already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['f', 'f.locked']);
});

test('--remove on lock deletes the original, and on unlock deletes the locked file', () => {
  const dir = workspace();
  const root = makeTree(dir);
  const before = snapshot(root);

  ok(['lock', root, '--remove']);
  assert.deepEqual(fs.readdirSync(dir), ['secret folder.locked']);
  ok(['unlock', `${root}.locked`, '--remove']);
  assert.deepEqual(fs.readdirSync(dir), ['secret folder']);
  assert.deepEqual(snapshot(root), before);
});

test('--remove clears read-only folders', () => {
  const dir = workspace();
  const root = path.join(dir, 'ro');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub/f'), 'x', { mode: 0o400 });
  fs.chmodSync(path.join(root, 'sub'), 0o500);
  fs.chmodSync(root, 0o500);

  ok(['lock', root, '--remove']);
  assert.deepEqual(fs.readdirSync(dir), ['ro.locked']);
});

test('the command is inferred from the file when omitted', () => {
  const dir = workspace();
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'data');
  ok([file, '--remove']);
  assert.deepEqual(fs.readdirSync(dir), ['f.locked']);
  ok([`${file}.locked`, '--remove']);
  assert.deepEqual(fs.readdirSync(dir), ['f']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'data');
});

test('a missing path gives a readable error', () => {
  fails(['lock', path.join(workspace(), 'nope')], /Not found: /);
});

test('dragged paths are cleaned up per platform', () => {
  assert.equal(cleanDroppedPath('"C:\\My Files\\a.txt" ', 'win32'), 'C:\\My Files\\a.txt');
  assert.equal(cleanDroppedPath('C:\\plain\\a.txt', 'win32'), 'C:\\plain\\a.txt');
  assert.equal(cleanDroppedPath('/Users/me/My\\ Files/a.txt ', 'darwin'), '/Users/me/My Files/a.txt');
  assert.equal(cleanDroppedPath("'/Users/me/My Files/it.txt'", 'darwin'), '/Users/me/My Files/it.txt');
});

test('names Windows cannot store are made safe', () => {
  const cases = {
    'plain name.txt': 'plain name.txt',
    'what?.txt': 'what_.txt',
    'a:b|c*.txt': 'a_b_c_.txt',
    'back\\slash': 'back_slash',
    'trailing. ': 'trailing__',
    CON: '_CON',
    'aux.txt': '_aux.txt',
    'com1.log': '_com1.log',
    console: 'console',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(windowsSafeName(input), expected);
  }
});

function makeZip(dir, name, files) {
  const source = path.join(dir, 'zip-source');
  fs.mkdirSync(source);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), text);
  }
  const zip = path.join(dir, name);
  const made = IS_WINDOWS
    ? spawnSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-cf', zip, '.'], { cwd: source })
    : spawnSync('zip', ['-qr', zip, '.'], { cwd: source });
  assert.equal(made.status, 0, String(made.stderr));
  fs.rmSync(source, { recursive: true });
  return zip;
}

test('unzip extracts into a folder named after the zip', () => {
  const dir = workspace();
  const zip = makeZip(dir, 'Reports.zip', { 'a.txt': 'A', 'sub/b.txt': 'B' });
  ok(['unzip', zip]);
  assert.equal(fs.readFileSync(path.join(dir, 'Reports/sub/b.txt'), 'utf8'), 'B');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Reports', 'Reports.zip']);
});

test('a zip holding one folder is not nested inside another', () => {
  const dir = workspace();
  const zip = makeZip(dir, 'Reports.zip', { 'Inner/a.txt': 'A', '__MACOSX/._a.txt': 'junk' });
  ok(['unzip', zip]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Inner', 'Reports.zip']);
  assert.equal(fs.readFileSync(path.join(dir, 'Inner/a.txt'), 'utf8'), 'A');
});

test('unzip never merges into something that exists', () => {
  const dir = workspace();
  const zip = makeZip(dir, 'Reports.zip', { 'a.txt': 'new' });
  fs.mkdirSync(path.join(dir, 'Reports'));
  fs.writeFileSync(path.join(dir, 'Reports/a.txt'), 'old');
  fails(['unzip', zip], /Already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'Reports/a.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Reports', 'Reports.zip']);
});

test('a damaged zip fails cleanly', () => {
  const dir = workspace();
  const zip = path.join(dir, 'bad.zip');
  fs.writeFileSync(zip, 'not a zip');
  fails(['unzip', zip], /Could not extract bad\.zip/);
  assert.deepEqual(fs.readdirSync(dir), ['bad.zip']);
});

test('unlock --unzip restores the zip and extracts it', () => {
  const dir = workspace();
  const zip = makeZip(dir, 'Reports.zip', { 'a.txt': 'A', 'b.txt': 'B' });
  ok(['lock', zip, '--remove']);
  ok(['unlock', `${zip}.locked`, '--unzip']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Reports', 'Reports.zip', 'Reports.zip.locked']);
  assert.equal(fs.readFileSync(path.join(dir, 'Reports/a.txt'), 'utf8'), 'A');
});

const history = () => fs.readFileSync(path.join(base, 'history/history.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

test('a file records who, when, what and its standard SHA-256', () => {
  const dir = workspace();
  const file = path.join(dir, 'report.txt');
  fs.writeFileSync(file, 'report body');

  const locked = ok(['lock', file]);
  assert.match(locked.stdout, new RegExp(sha('report body')));
  assert.match(locked.stdout, /First time recorded/);
  fs.rmSync(file);
  const unlocked = ok(['unlock', `${file}.locked`]);
  assert.match(unlocked.stdout, /Verified: identical/);
  assert.match(unlocked.stdout, new RegExp(`Locked by ${os.userInfo().username}`));

  const [lockEvent, unlockEvent] = history().slice(-2);
  assert.deepEqual(
    [lockEvent.action, lockEvent.by, lockEvent.host, lockEvent.path, lockEvent.sha256],
    ['lock', os.userInfo().username, os.hostname(), fs.realpathSync(dir) === dir ? file : lockEvent.path, sha('report body')],
  );
  assert.equal(unlockEvent.action, 'unlock');
  assert.equal(unlockEvent.sha256, lockEvent.sha256);
  assert.equal(unlockEvent.status, 'verified');
  assert.ok(!Number.isNaN(Date.parse(lockEvent.at)));
});

test('the password never reaches the history', () => {
  const dir = workspace();
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'x');
  ok(['lock', file], 'a-very-distinctive-password');
  assert.equal(JSON.stringify(history()).includes('a-very-distinctive-password'), false);
});

test('locking again reports whether the content changed', () => {
  const dir = workspace();
  const file = path.join(dir, 'doc.txt');
  fs.writeFileSync(file, 'version 1');
  ok(['lock', file, '-o', `${file}.1`]);

  fs.utimesSync(file, new Date(1e12), new Date(1e12)); // touched, not changed
  assert.match(ok(['lock', file, '-o', `${file}.2`]).stdout, /Unchanged/);

  fs.writeFileSync(file, 'version 2');
  assert.match(ok(['lock', file, '-o', `${file}.3`]).stdout, /CHANGED/);
});

test('folder hashes ignore location and timestamps but not contents or names', () => {
  const dir = workspace();
  const make = (name) => {
    const root = path.join(dir, name);
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub/a.txt'), 'A');
    return root;
  };
  const shaOf = (target) => /SHA-256: (\w+)/.exec(ok(['hash', target]).stdout)[1];
  const first = make('one');
  const second = make('two');
  fs.utimesSync(path.join(second, 'sub/a.txt'), new Date(1e12), new Date(1e12));
  assert.equal(shaOf(first), shaOf(second));

  fs.renameSync(path.join(second, 'sub/a.txt'), path.join(second, 'sub/b.txt'));
  assert.notEqual(shaOf(first), shaOf(second));
  fs.writeFileSync(path.join(first, 'sub/a.txt'), 'B');
  assert.notEqual(shaOf(first), shaOf(second));
});

test('hash and history find earlier records of the same content', () => {
  const dir = workspace();
  const file = path.join(dir, 'tracked.txt');
  fs.writeFileSync(file, 'tracked content');
  const unknown = ok(['hash', file]);
  assert.match(unknown.stdout, /no record/);

  ok(['lock', file]);
  const copy = path.join(dir, 'renamed copy.txt');
  fs.copyFileSync(file, copy);
  assert.match(ok(['hash', copy]).stdout, /same content as lock by/);
  assert.match(ok(['history', 'tracked.txt']).stdout, /LOCK {2}by/);
  assert.match(ok(['history', 'no-such-entry']).stdout, /No matching history/);
});

test('verify needs the password, restores nothing and compares across machines', () => {
  const dir = workspace();
  const file = path.join(dir, 'deed.txt');
  fs.writeFileSync(file, 'land record');
  ok(['lock', file]);
  const locked = `${file}.locked`;
  fs.rmSync(file);
  const listing = fs.readdirSync(dir);

  fails(['verify', locked], /Wrong password/, 'not the right password');

  const plain = ok(['verify', locked]);
  assert.match(plain.stdout, new RegExp(sha('land record')));
  assert.match(plain.stdout, new RegExp(`Locked by ${os.userInfo().username}`));

  assert.match(ok(['verify', locked, '--against', sha('land record').toUpperCase()]).stdout, /MATCH: identical/);
  fails(['verify', locked, '--against', sha('edited')], /DOES NOT MATCH/);
  assert.deepEqual(fs.readdirSync(dir), listing);

  const unchanged = path.join(dir, 'from other machine.txt');
  fs.writeFileSync(unchanged, 'land record');
  assert.match(ok(['verify', locked, '--against', unchanged]).stdout, /MATCH: identical/);
  fs.writeFileSync(unchanged, 'land record, altered');
  fails(['verify', locked, '--against', unchanged], /DOES NOT MATCH/);
  assert.equal(history().at(-1).status, 'mismatch');
});

test('verify sees the same SHA-256 as hashing the original folder', () => {
  const dir = workspace();
  const root = makeTree(dir);
  const original = /SHA-256: (\w+)/.exec(ok(['hash', root]).stdout)[1];
  ok(['lock', root]);
  assert.match(ok(['verify', `${root}.locked`, '--against', original]).stdout, /MATCH: identical/);
});

test('a file whose metadata disagrees with its contents is rejected', async () => {
  const dir = workspace();
  const file = path.join(dir, 'crafted.locked');
  const meta = Buffer.from(JSON.stringify({ sha256: 'wrong' }));
  const head = Buffer.alloc(5);
  head[0] = 4;
  head.writeUInt32BE(meta.length, 1);
  await lockCrafted(file, [...fileEntry('a', Buffer.from('x')), head, meta, END_MARKER]);
  await assert.rejects(unlockPath(file, { password: PASSWORD }), /corrupted/);
  assert.deepEqual(fs.readdirSync(dir), ['crafted.locked']);
});

test('files locked before history existed still unlock', async () => {
  const dir = workspace();
  const file = path.join(dir, 'old.locked');
  await lockCrafted(file, [...fileEntry('old.txt', Buffer.from('old')), END_MARKER]);
  const result = await unlockPath(file, { password: PASSWORD });
  assert.equal(result.meta, null);
  assert.equal(result.sha256, sha('old'));
  assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'old');
});

test('the locked file cannot be written inside the folder being locked', () => {
  const dir = workspace();
  const root = makeTree(dir);
  const before = snapshot(root);
  fails(['lock', root, '-o', path.join(root, 'x.locked'), '--remove'], /cannot be saved inside/);
  assert.deepEqual(snapshot(root), before);
});

test('symlink and special-file inputs are refused without losing the source', () => {
  const dir = workspace();
  const link = path.join(dir, 'link');
  fs.symlinkSync('/etc/hosts', link);
  fails(['lock', link, '--remove'], /symlink/);
  assert.ok(fs.lstatSync(link).isSymbolicLink());

  if (IS_WINDOWS) return; // no named pipes in the filesystem
  const root = path.join(dir, 'with-fifo');
  fs.mkdirSync(root);
  spawnSync('mkfifo', [path.join(root, 'pipe')]);
  fails(['lock', root, '--remove'], /special file/);
  assert.ok(fs.existsSync(path.join(root, 'pipe')));
  assert.equal(fs.existsSync(`${root}.locked`), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link', 'with-fifo']);
});

test('short and empty passwords are refused when locking', () => {
  const dir = workspace();
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'x');
  fails(['lock', file], /at least 8/, 'short');
  fails(['lock', file], /cannot be empty/, '');
  assert.deepEqual(fs.readdirSync(dir), ['f']);
});

test('crafted archives cannot write outside the destination', async (t) => {
  const cases = {
    'parent traversal': [...dirEntry('a'), ...fileEntry('a/../../evil', Buffer.from('x'))],
    'absolute path': fileEntry('/tmp/protect-evil', Buffer.from('x')),
    'root traversal': fileEntry('..', Buffer.from('x')),
    'second root': [...dirEntry('a'), ...fileEntry('b', Buffer.from('x'))],
    'undeclared parent': [...dirEntry('a'), ...fileEntry('a/b/c', Buffer.from('x'))],
    'file through symlink': [...dirEntry('a'), ...linkEntry('a/out', '/tmp'), ...fileEntry('a/out/evil', Buffer.from('x'))],
    'symlink through symlink': [...dirEntry('a'), ...linkEntry('a/out', '/tmp'), ...linkEntry('a/out/evil', 'x')],
    'missing end marker': { noEnd: fileEntry('a', Buffer.from('x')) },
    'trailing data': { trailing: [...fileEntry('a', Buffer.from('x')), END_MARKER, Buffer.from('x')] },
  };
  for (const [name, spec] of Object.entries(cases)) {
    await t.test(name, async () => {
      const dir = workspace();
      const file = path.join(dir, 'crafted.locked');
      const pieces = spec.noEnd ?? spec.trailing ?? [...spec, END_MARKER];
      await lockCrafted(file, pieces);
      await assert.rejects(unlockPath(file, { password: PASSWORD }), /unsafe path|corrupted/);
      assert.deepEqual(fs.readdirSync(dir), ['crafted.locked']);
    });
  }
});
