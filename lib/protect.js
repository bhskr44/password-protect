// Core of `protect`: encrypts a file or folder into one .locked file and back.
//
// File layout:
//   header: magic(6) logN(1) r(1) p(1) salt(16) noncePrefix(7)
//   body:   AES-256-GCM chunks, each CHUNK_SIZE plaintext bytes plus a 16-byte
//           tag; the final chunk is shorter (possibly empty).
//
// Every chunk authenticates the header, its position and whether it is the
// last one, so edits, reordering and truncation are all detected.
//
// The plaintext is a small archive: entries of type, mode, mtime, name, size,
// data, then a metadata record (who locked it, when, and its SHA-256), closed by
// an end marker. Names live inside the encryption. Files from before metadata
// existed have no such record and still unlock.

import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { appendHistory, compareWithHistory, identity, readHistory } from './history.js';

const scrypt = promisify(crypto.scrypt);
const execFile = promisify(execFileCallback);

export const MAGIC = Buffer.from('PROTC1', 'latin1');
export const HEADER_LEN = MAGIC.length + 3 + 16 + 7;
export const CHUNK_SIZE = 1024 * 1024;
export const ENTRY_HEAD_LEN = 24; // everything after the type byte
const TAG_LEN = 16;
const MAX_NAME_LEN = 64 * 1024;
const KDF = { logN: 17, r: 8, p: 1 }; // 128 MiB per attempt

const TYPE = { END: 0, FILE: 1, DIR: 2, LINK: 3, META: 4 };
const EMPTY = Buffer.alloc(0);
const IS_WINDOWS = process.platform === 'win32';

const CORRUPT = 'The file is corrupted or has been tampered with.';
const WRONG = 'Wrong password, or the file is corrupted.';

// Paths that hold partial output, removed on failure or Ctrl-C. Unlock's temp
// folder contains decrypted data, so it must not be left behind.
const tempPaths = new Set();

function removeTemps() {
  for (const p of tempPaths) fs.rmSync(p, { recursive: true, force: true });
  tempPaths.clear();
}

// SIGHUP is how Windows reports the console window being closed.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    removeTemps();
    process.exit(code);
  });
}

// --- encryption ------------------------------------------------------------

export function newHeader() {
  return Buffer.concat([
    MAGIC,
    Buffer.from([KDF.logN, KDF.r, KDF.p]),
    crypto.randomBytes(16),
    crypto.randomBytes(7),
  ]);
}

function parseHeader(buf) {
  if (buf.length < HEADER_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This is not a file locked by protect.');
  }
  const [logN, r, p] = buf.subarray(MAGIC.length, MAGIC.length + 3);
  // Bounded because these are read before the file can be authenticated.
  if (logN < 14 || logN > 22 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new Error(CORRUPT);
  }
  const salt = buf.subarray(MAGIC.length + 3, MAGIC.length + 19);
  const noncePrefix = buf.subarray(MAGIC.length + 19, HEADER_LEN);
  return { raw: buf.subarray(0, HEADER_LEN), logN, r, p, salt, noncePrefix };
}

export function deriveKey(password, header) {
  const { logN, r, p, salt } = parseHeader(header);
  const N = 2 ** logN;
  const maxmem = 128 * r * (N + p + 2) + 32 * 1024 * 1024;
  return scrypt(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem });
}

function nonceFor(noncePrefix, counter, last) {
  if (counter > 0xffffffff) throw new Error('Input is too large to encrypt.');
  const nonce = Buffer.alloc(12);
  noncePrefix.copy(nonce);
  nonce.writeUInt32BE(counter, 7);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

export async function* encryptChunks(plain, key, header) {
  const { raw, noncePrefix } = parseHeader(header);
  let counter = 0;
  const seal = (chunk, last) => {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceFor(noncePrefix, counter++, last));
    cipher.setAAD(raw);
    return Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()]);
  };
  let pending = EMPTY;
  for await (const piece of plain) {
    pending = pending.length ? Buffer.concat([pending, piece]) : piece;
    // Strictly greater: the final chunk is held back so it can be marked last.
    while (pending.length > CHUNK_SIZE) {
      yield seal(pending.subarray(0, CHUNK_SIZE), false);
      pending = pending.subarray(CHUNK_SIZE);
    }
  }
  yield seal(pending, true);
}

async function* decryptChunks(sealed, key, header) {
  const { raw, noncePrefix } = parseHeader(header);
  let counter = 0;
  const open = (chunk, last) => {
    if (chunk.length < TAG_LEN) throw new Error(CORRUPT);
    const split = chunk.length - TAG_LEN;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(noncePrefix, counter, last));
    decipher.setAAD(raw);
    decipher.setAuthTag(chunk.subarray(split));
    try {
      const plain = Buffer.concat([decipher.update(chunk.subarray(0, split)), decipher.final()]);
      counter++;
      return plain;
    } catch {
      throw new Error(counter === 0 ? WRONG : CORRUPT);
    }
  };
  const sealedSize = CHUNK_SIZE + TAG_LEN;
  let pending = EMPTY;
  for await (const piece of sealed) {
    pending = pending.length ? Buffer.concat([pending, piece]) : piece;
    while (pending.length > sealedSize) {
      yield open(pending.subarray(0, sealedSize), false);
      pending = pending.subarray(sealedSize);
    }
  }
  yield open(pending, true);
}

async function readHeader(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await handle.read(buf, 0, HEADER_LEN, 0);
    parseHeader(buf.subarray(0, bytesRead));
    return buf;
  } finally {
    await handle.close();
  }
}

async function decryptFile(file, password) {
  const header = await readHeader(file);
  const key = await deriveKey(password, header);
  const body = fs.createReadStream(file, { start: HEADER_LEN, highWaterMark: CHUNK_SIZE });
  return decryptChunks(body, key, header);
}

// --- archive ---------------------------------------------------------------

async function* walk(abs, rel) {
  const stat = await fsp.lstat(abs);
  if (stat.isDirectory()) {
    yield { type: TYPE.DIR, abs, rel, stat };
    for (const name of (await fsp.readdir(abs)).sort()) {
      yield* walk(path.join(abs, name), `${rel}/${name}`);
    }
  } else if (stat.isFile()) {
    yield { type: TYPE.FILE, abs, rel, stat };
  } else if (stat.isSymbolicLink()) {
    yield { type: TYPE.LINK, abs, rel, stat };
  } else {
    throw new Error(`Cannot lock special file (socket, pipe or device): ${abs}`);
  }
}

export function entryHead(type, name, { mode, mtimeMs, size }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(1 + ENTRY_HEAD_LEN);
  head[0] = type;
  head.writeUInt32BE(mode, 1);
  head.writeDoubleBE(mtimeMs, 5);
  head.writeUInt32BE(nameBuf.length, 13);
  head.writeBigUInt64BE(BigInt(size), 17);
  return Buffer.concat([head, nameBuf]);
}

export const END_MARKER = Buffer.from([TYPE.END]);

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Identifies content regardless of where it lives or when it was touched. A
// single file gets its plain SHA-256, so shasum or certutil gives the same
// answer. A folder hashes each item's relative path and contents, so renaming
// the folder itself or changing timestamps does not alter it.
class Fingerprint {
  lines = crypto.createHash('sha256');
  single = null;
  result = null;
  files = 0;
  bytes = 0;

  add(type, name, digest, size) {
    const rel = name.split('/').slice(1).join('/').normalize('NFC');
    if (type === TYPE.FILE) {
      if (!rel) this.single = digest;
      this.files += 1;
      this.bytes += size;
    }
    this.lines.update(`${type} ${JSON.stringify(rel)} ${digest}\n`);
  }

  digest() {
    this.result ??= this.single ?? this.lines.digest('hex');
    return this.result;
  }
}

function metaEntry(record) {
  const json = Buffer.from(JSON.stringify(record), 'utf8');
  const head = Buffer.alloc(5);
  head[0] = TYPE.META;
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
}

async function* readExactly(file, size) {
  if (size === 0) return;
  let seen = 0;
  for await (const piece of fs.createReadStream(file, { end: size - 1, highWaterMark: CHUNK_SIZE })) {
    seen += piece.length;
    yield piece;
  }
  if (seen !== size) throw new Error(`File changed while being locked: ${file}`);
}

async function* archive(root, manifest, fingerprint) {
  for await (const entry of walk(root, path.basename(root))) {
    const { type, abs, rel, stat } = entry;
    manifest.push(describe(entry));
    const meta = { mode: storedMode(stat), mtimeMs: stat.mtimeMs };
    if (type === TYPE.FILE) {
      yield entryHead(type, rel, { ...meta, size: stat.size });
      const hash = crypto.createHash('sha256');
      yield* hashing(readExactly(abs, stat.size), hash);
      fingerprint.add(type, rel, hash.digest('hex'), stat.size);
    } else if (type === TYPE.LINK) {
      const target = Buffer.from(await fsp.readlink(abs), 'utf8');
      yield entryHead(type, rel, { ...meta, size: target.length });
      yield target;
      fingerprint.add(type, rel, sha256(target), target.length);
    } else {
      yield entryHead(type, rel, { ...meta, size: 0 });
      fingerprint.add(type, rel, '', 0);
    }
  }
  yield metaEntry({
    ...identity(),
    at: new Date().toISOString(),
    sha256: fingerprint.digest(),
    files: fingerprint.files,
    bytes: fingerprint.bytes,
  });
  yield END_MARKER;
}

// Windows has no permission bits: it reports 0o666 for everything, which would
// restore as world-writable on macOS. Only its read-only flag is meaningful.
function storedMode(stat) {
  if (!IS_WINDOWS) return stat.mode & 0o777;
  if (stat.isDirectory()) return 0o755;
  return stat.mode & 0o200 ? 0o644 : 0o444;
}

const describe = ({ type, rel, stat }) => `${type}\0${rel}\0${stat.size}\0${stat.mtimeMs}`;

class ByteReader {
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    this.buffer = EMPTY;
  }

  async fill() {
    const { done, value } = await this.iterator.next();
    if (done) return false;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    return true;
  }

  async take(n) {
    while (this.buffer.length < n) {
      if (!(await this.fill())) throw new Error(CORRUPT);
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async *stream(n) {
    while (n > 0) {
      while (!this.buffer.length) {
        if (!(await this.fill())) throw new Error(CORRUPT);
      }
      const out = this.buffer.subarray(0, Math.min(n, this.buffer.length));
      this.buffer = this.buffer.subarray(out.length);
      n -= out.length;
      yield out;
    }
  }

  async atEnd() {
    while (!this.buffer.length) {
      if (!(await this.fill())) return true;
    }
    return false;
  }
}

function checkEntryName(name, root) {
  const parts = name.split('/');
  const unsafe = parts.some((part) =>
    part === '' || part === '.' || part === '..' || part.includes('\0'));
  if (unsafe || (root !== null && parts[0] !== root)) {
    throw new Error(`Refusing unsafe path inside locked file: ${JSON.stringify(name)}`);
  }
  return parts;
}

// macOS allows names that Windows cannot store, such as "what?.txt" or "aux.txt".
// Backslash and colon must go too: Windows would treat them as path syntax.
export function windowsSafeName(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, (tail) => '_'.repeat(tail.length));
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

async function assertAbsent(target) {
  const existing = await fsp.lstat(target).catch(() => null);
  if (existing) throw new Error(`Already exists, not overwriting: ${target}`);
}

async function readEntryHead(reader) {
  const type = (await reader.take(1))[0];
  if (type === TYPE.END) return { type };
  if (type === TYPE.META) {
    const length = (await reader.take(4)).readUInt32BE(0);
    if (length > MAX_NAME_LEN) throw new Error(CORRUPT);
    return { type, meta: JSON.parse((await reader.take(length)).toString('utf8')) };
  }
  if (![TYPE.FILE, TYPE.DIR, TYPE.LINK].includes(type)) throw new Error(CORRUPT);
  const head = await reader.take(ENTRY_HEAD_LEN);
  const nameLen = head.readUInt32BE(12);
  const size = Number(head.readBigUInt64BE(16));
  if (nameLen === 0 || nameLen > MAX_NAME_LEN || !Number.isSafeInteger(size)) throw new Error(CORRUPT);
  if (type === TYPE.LINK && size > MAX_NAME_LEN) throw new Error(CORRUPT);
  return {
    type,
    size,
    mode: head.readUInt32BE(0) & 0o777,
    mtime: new Date(head.readDoubleBE(4)),
    name: (await reader.take(nameLen)).toString('utf8'),
  };
}

// Restores into a private temp folder and moves it into place only once every
// chunk has authenticated, so a bad file never produces partial output.
async function extract(plain, destDir) {
  const reader = new ByteReader(plain);
  const temp = await fsp.mkdtemp(path.join(destDir, '.protect-'));
  tempPaths.add(temp);

  const dirs = new Map();
  const links = [];
  const warnings = [];
  const fingerprint = new Fingerprint();
  let meta = null;
  let root = null;
  let localRoot = null;

  // Requiring a declared real parent means nothing can be written through a
  // symlink. Symlinks are created last for the same reason.
  const placeUnder = (name, parts) => {
    if (parts.length > 1 && !dirs.has(parts.slice(0, -1).join('/'))) {
      throw new Error(`Refusing unsafe path inside locked file: ${JSON.stringify(name)}`);
    }
    if (!IS_WINDOWS) return parts;
    const local = parts.map(windowsSafeName);
    if (local.join('/') !== name) warnings.push(`Renamed for Windows: ${name} -> ${local.join('/')}`);
    return local;
  };

  for (;;) {
    const entry = await readEntryHead(reader);
    const { type, name, size, mode, mtime } = entry;
    if (type === TYPE.END) break;
    if (type === TYPE.META) {
      meta = entry.meta;
      continue;
    }
    const parts = checkEntryName(name, root);
    if (root === null) {
      if (parts.length !== 1) throw new Error(CORRUPT);
      root = name;
    }
    const local = placeUnder(name, parts);
    if (localRoot === null) {
      localRoot = local[0];
      await assertAbsent(path.join(destDir, localRoot));
    }
    const target = path.join(temp, ...local);

    if (type === TYPE.DIR) {
      await fsp.mkdir(target);
      dirs.set(name, { local, mode, mtime });
      fingerprint.add(type, name, '', 0);
    } else if (type === TYPE.FILE) {
      const handle = await fsp.open(target, 'wx', 0o600);
      try {
        const hash = crypto.createHash('sha256');
        for await (const piece of hashing(reader.stream(size), hash)) await handle.writeFile(piece);
        fingerprint.add(type, name, hash.digest('hex'), size);
        await handle.utimes(mtime, mtime);
        await handle.chmod(mode);
      } finally {
        await handle.close();
      }
    } else {
      const linkBytes = await reader.take(size);
      fingerprint.add(type, name, sha256(linkBytes), size);
      links.push({ name, linkPath: target, linkTarget: linkBytes.toString('utf8') });
    }
  }
  if (root === null || !(await reader.atEnd())) throw new Error(CORRUPT);
  const digest = fingerprint.digest();
  if (meta && meta.sha256 !== digest) throw new Error(CORRUPT);

  for (const { name, linkPath, linkTarget } of links) {
    try {
      await fsp.symlink(linkTarget, linkPath);
    } catch (error) {
      // Windows only lets administrators or Developer Mode create symlinks.
      if (!IS_WINDOWS || error.code !== 'EPERM') throw error;
      warnings.push(`Skipped symlink (Windows needs Developer Mode): ${name} -> ${linkTarget}`);
    }
  }

  const final = path.join(destDir, localRoot);
  await assertAbsent(final);
  await moveIntoPlace(path.join(temp, localRoot), final);
  await fsp.rmdir(temp);
  tempPaths.delete(temp);

  // Applied last and deepest first: a read-only folder cannot be filled or moved.
  for (const { local, mode, mtime } of [...dirs.values()].reverse()) {
    const dir = path.join(destDir, ...local);
    await fsp.utimes(dir, mtime, mtime);
    await fsp.chmod(dir, mode);
  }
  return {
    path: final, warnings, meta, sha256: digest, files: fingerprint.files, bytes: fingerprint.bytes,
  };
}

// --- public operations -----------------------------------------------------

// Antivirus and search indexers briefly hold new files open on Windows.
async function moveIntoPlace(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      const busy = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!IS_WINDOWS || !busy || attempt === 20) throw error;
      await sleep(100);
    }
  }
}

// Read-only folders would otherwise stop the delete partway through.
async function removeTree(root) {
  for await (const { type, abs, stat } of walk(root, '')) {
    if (type !== TYPE.LINK && !(stat.mode & 0o200)) await fsp.chmod(abs, (stat.mode & 0o777) | 0o200);
  }
  await fsp.rm(root, { recursive: true });
}

async function* hashing(source, hash) {
  for await (const piece of source) {
    hash.update(piece);
    yield piece;
  }
}

// Proves the source is safe to delete: the locked file on disk must decrypt to
// exactly what was written, and the source must not have changed since.
async function assertSafeToRemove(source, output, password, expectedHash, manifest) {
  const hash = crypto.createHash('sha256');
  for await (const piece of await decryptFile(output, password)) hash.update(piece);
  if (!hash.digest().equals(expectedHash)) {
    throw new Error('Verification failed; the original was not removed.');
  }
  const current = [];
  for await (const entry of walk(source, path.basename(source))) current.push(describe(entry));
  if (current.join('\n') !== manifest.join('\n')) {
    throw new Error(`${source} changed during locking; the original was not removed.`);
  }
}

function isInside(child, parent) {
  // Windows and default macOS volumes ignore case; Linux is the only exception.
  const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());
  return fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + path.sep);
}

// The operation has already succeeded by now, so a log that cannot be written
// is reported rather than treated as a failure.
async function logEvent(record) {
  try {
    await appendHistory({ at: new Date().toISOString(), ...identity(), ...record });
    return [];
  } catch (error) {
    return [`Could not update the history log: ${error.message}`];
  }
}

// Reads a locked file with the password and reports what is inside, writing
// nothing to disk. `against` is a SHA-256, or a path whose content to compare.
export async function verifyLocked(file, { password, against }) {
  const src = path.resolve(file);
  const reader = new ByteReader(await decryptFile(src, password));
  const fingerprint = new Fingerprint();
  let meta = null;
  for (;;) {
    const entry = await readEntryHead(reader);
    if (entry.type === TYPE.END) break;
    if (entry.type === TYPE.META) {
      meta = entry.meta;
    } else if (entry.type === TYPE.DIR) {
      fingerprint.add(entry.type, entry.name, '', 0);
    } else {
      const hash = crypto.createHash('sha256');
      for await (const piece of hashing(reader.stream(entry.size), hash)) void piece;
      fingerprint.add(entry.type, entry.name, hash.digest('hex'), entry.size);
    }
  }
  if (!(await reader.atEnd())) throw new Error(CORRUPT);
  const digest = fingerprint.digest();
  if (meta && meta.sha256 !== digest) throw new Error(CORRUPT);

  let expected = null;
  if (against) {
    expected = /^[a-f0-9]{64}$/i.test(against) ? against.toLowerCase() : (await hashPath(against)).sha256;
  }
  const status = expected === null ? 'checked' : expected === digest ? 'match' : 'mismatch';
  const warnings = await logEvent({
    action: 'verify', path: src, lockedFile: src, sha256: digest, status,
    files: fingerprint.files, bytes: fingerprint.bytes,
    lockedBy: meta?.by, lockedOn: meta?.host, lockedAt: meta?.at,
  });
  return {
    sha256: digest, expected, status, meta, warnings, files: fingerprint.files, bytes: fingerprint.bytes,
  };
}

export async function hashPath(target) {
  const src = path.resolve(target);
  const fingerprint = new Fingerprint();
  await fsp.lstat(src);
  for await (const piece of archive(src, [], fingerprint)) void piece;
  const digest = fingerprint.digest();
  const matches = (await readHistory()).filter((record) => record.sha256 === digest);
  return { sha256: digest, files: fingerprint.files, bytes: fingerprint.bytes, matches };
}

export async function lockPath(source, { password, output, remove = false }) {
  const src = path.resolve(source);
  const stat = await fsp.lstat(src);
  if (stat.isSymbolicLink()) {
    throw new Error(`${src} is a symlink. Lock what it points to instead.`);
  }
  if (!path.basename(src)) throw new Error('Cannot lock the filesystem root.');

  const out = path.resolve(output ?? `${src}.locked`);
  const outDir = await fsp.realpath(path.dirname(out));
  // Would otherwise archive itself, and --remove would delete the result.
  if (isInside(path.join(outDir, path.basename(out)), await fsp.realpath(src))) {
    throw new Error('The locked file cannot be saved inside what is being locked.');
  }
  await assertAbsent(out);

  const header = newHeader();
  const key = await deriveKey(password, header);
  const manifest = [];
  const fingerprint = new Fingerprint();
  const hash = crypto.createHash('sha256');
  const temp = `${out}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  tempPaths.add(temp);
  try {
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(header);
      const plain = hashing(archive(src, manifest, fingerprint), hash);
      for await (const sealed of encryptChunks(plain, key, header)) await handle.writeFile(sealed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await moveIntoPlace(temp, out);
    tempPaths.delete(temp);
    const digest = fingerprint.digest();
    const status = compareWithHistory(await readHistory(), src, digest);
    const warnings = await logEvent({
      action: 'lock', path: src, lockedFile: out, sha256: digest, status,
      files: fingerprint.files, bytes: fingerprint.bytes,
    });
    if (remove) {
      await assertSafeToRemove(src, out, password, hash.digest(), manifest);
      await removeTree(src);
    }
    return { path: out, sha256: digest, status, warnings };
  } finally {
    removeTemps();
  }
}

export async function unlockPath(file, { password, output, remove = false }) {
  const src = path.resolve(file);
  const destDir = path.resolve(output ?? path.dirname(src));
  await readHeader(src); // reject the wrong kind of file before doing any work
  await fsp.mkdir(destDir, { recursive: true });
  try {
    const result = await extract(await decryptFile(src, password), destDir);
    if (remove) await fsp.rm(src);
    const status = result.meta
      ? 'verified'
      : compareWithHistory(await readHistory(), result.path, result.sha256);
    const warnings = await logEvent({
      action: 'unlock', path: result.path, lockedFile: src, sha256: result.sha256, status,
      files: result.files, bytes: result.bytes,
      lockedBy: result.meta?.by, lockedOn: result.meta?.host, lockedAt: result.meta?.at,
    });
    return { ...result, status, warnings: [...result.warnings, ...warnings] };
  } finally {
    removeTemps();
  }
}

// Extracts a zip beside itself. Goes through a temp folder so that a damaged zip
// leaves nothing behind, and so that existing files are never merged into.
export async function unzipFile(file) {
  const src = path.resolve(file);
  const parent = path.dirname(src);
  const temp = await fsp.mkdtemp(path.join(parent, '.protect-'));
  tempPaths.add(temp);
  try {
    try {
      if (process.platform === 'darwin') await execFile('/usr/bin/ditto', ['-x', '-k', src, temp]);
      // The full path avoids Git's tar, which cannot read zips or C:\ paths.
      else await execFile(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', src, '-C', temp]);
    } catch {
      throw new Error(`Could not extract ${path.basename(src)}. It may be damaged or have its own password.`);
    }
    await fsp.rm(path.join(temp, '__MACOSX'), { recursive: true, force: true });

    const items = await fsp.readdir(temp);
    if (!items.length) throw new Error(`${path.basename(src)} is empty.`);
    // A zip holding one folder would otherwise become Name/Name.
    const lone = items.length === 1 && (await fsp.lstat(path.join(temp, items[0]))).isDirectory();
    const from = lone ? path.join(temp, items[0]) : temp;
    const final = path.join(parent, lone ? items[0] : path.basename(src).replace(/\.zip$/i, ''));
    await assertAbsent(final);
    if (!lone) await fsp.chmod(temp, 0o755); // mkdtemp makes it private
    await moveIntoPlace(from, final);
    return final;
  } finally {
    removeTemps();
  }
}

export { readHeader };

export async function isLockedFile(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  try {
    await readHeader(file);
    return true;
  } catch {
    return false;
  }
}

// What a terminal types when something is dragged onto it: Windows wraps the
// path in double quotes, and macOS backslash-escapes spaces.
export function cleanDroppedPath(text, platform = process.platform) {
  const trimmed = text.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  if (quoted) return quoted[2];
  return platform === 'win32' ? trimmed : trimmed.replace(/\\(.)/g, '$1');
}
