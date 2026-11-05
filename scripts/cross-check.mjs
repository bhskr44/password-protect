// Proves locked files move between operating systems, using the built apps.
//   node scripts/cross-check.mjs lock <program> <work-dir> <label>
//   node scripts/cross-check.mjs unlock <program> <work-dir> <label>
// `lock` writes <label>.locked and <label>.sha256 to <work-dir>; `unlock` reads
// those on the other OS, and fails unless the contents come back identical.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PASSWORD = 'cross-platform check ✓';
const [mode, program, workDir, label] = process.argv.slice(2);
const IS_WINDOWS = process.platform === 'win32';

function sampleFiles(forWindows) {
  const binary = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + (i >> 8)) & 0xff;
  const files = {
    'plain.txt': Buffer.from('line one\r\nline two\n'),
    'नमस्ते ✓/naïve file.txt': Buffer.from('unicode names'),
    'nested/deep/data.bin': binary,
    'nested/empty.txt': Buffer.alloc(0),
  };
  if (!forWindows) files['what?.txt'] = Buffer.from('a name Windows cannot store');
  return files;
}

function run(args) {
  const result = spawnSync(path.resolve(program), [...args, '--password-stdin'], {
    input: PASSWORD, encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  console.log(output);
  assert.equal(result.status, 0, output);
  return result.stdout;
}

const shaIn = (text) => /SHA-256: ([a-f0-9]{64})/.exec(text)[1];
const locked = path.resolve(workDir, `${label}.locked`);
const shaFile = path.resolve(workDir, `${label}.sha256`);

if (mode === 'lock') {
  fs.mkdirSync(workDir, { recursive: true });
  const root = path.resolve(workDir, 'Cross Check');
  for (const [rel, data] of Object.entries(sampleFiles(IS_WINDOWS))) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  }
  fs.writeFileSync(shaFile, shaIn(run(['lock', root, '-o', locked, '--remove'])));
} else {
  const expected = fs.readFileSync(shaFile, 'utf8').trim();
  assert.match(run(['verify', locked, '--against', expected]), /MATCH: identical/);

  const dest = path.resolve(workDir, 'restored');
  const unlocked = run(['unlock', locked, '-o', dest]);
  assert.equal(shaIn(unlocked), expected);
  assert.match(unlocked, /Verified: identical/);

  const madeOnWindows = label === 'windows';
  for (const [rel, data] of Object.entries(sampleFiles(madeOnWindows))) {
    const local = IS_WINDOWS ? rel.replace('what?', 'what_') : rel;
    assert.deepEqual(fs.readFileSync(path.join(dest, 'Cross Check', local)), data, rel);
  }
  console.log(`Cross-platform check passed: locked on ${label}, unlocked on ${process.platform}`);
}
