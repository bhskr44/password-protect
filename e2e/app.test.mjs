// Drives the real desktop app. Runs engine work through Electron's own crypto
// and crosses it with the command line, which uses Node's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

delete process.env.ELECTRON_RUN_AS_NODE; // set inside VS Code terminals

// No trailing separator: on Windows, \" in a command line escapes the quote.
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = path.join(ROOT, 'bin/protect.js');
const PASSWORD = 'long enough password ✓';
const SHOTS = process.env.SHOT_DIR;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protect-app-')));
const history = path.join(base, 'history');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
let app;
let page;

function cli(args, password = PASSWORD) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--password-stdin'], {
    input: password, encoding: 'utf8', env: { ...process.env, PROTECT_HISTORY_DIR: history },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

const workspace = () => fs.mkdtempSync(path.join(base, 'w-'));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const tab = (name) => page.locator('nav').getByRole('button', { name, exact: true }).click();
// Last match: a form's submit button comes after a choice with the same name.
const press = (name) => page.locator('main').getByRole('button', { name, exact: true }).last().click();
const fill = (label, value) => page.getByLabel(label, { exact: true }).fill(value);

async function choose(paths, button = 'Choose file') {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
  await press(button);
}

async function home() {
  await tab('Protect');
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible()) await done.click();
}

before(async () => {
  // PACKAGED_APP tests the built app rather than the source.
  // Its own profile, so that a copy of the app already open does not stop it.
  const profile = `--user-data-dir=${path.join(base, 'profile')}`;
  const target = process.env.PACKAGED_APP
    ? { executablePath: path.resolve(process.env.PACKAGED_APP), args: [profile] }
    : { args: [ROOT, profile] };
  app = await electron.launch({
    ...target,
    env: { ...process.env, PROTECT_HISTORY_DIR: history },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 980, height: 700 });
  await page.getByRole('heading', { name: 'Drop a file or folder here' }).waitFor();
});

after(async () => {
  await app?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('home screen', async () => {
  await shot('1-home');
});

test('the window has no access to Node', async () => {
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.equal(await page.evaluate(() => typeof process), 'undefined');
});

test('locks a file, shows its seal and SHA-256, and the command line can unlock it', async () => {
  const dir = workspace();
  const file = path.join(dir, 'Land record.txt');
  fs.writeFileSync(file, 'plot 42');
  await choose([file]);
  await page.getByRole('heading', { name: 'Lock Land record.txt' }).waitFor();
  await shot('2-lock-form');
  await fill('Password', PASSWORD);
  await fill('Enter it again', PASSWORD);
  await press('Lock');
  await page.getByRole('heading', { name: 'Locked Land record.txt' }).waitFor();
  await page.getByText(sha('plot 42')).waitFor();
  assert.ok(await page.locator('.result .seal').isVisible());
  await page.waitForTimeout(350);
  await shot('3-locked');
  await press('Done');

  fs.rmSync(file);
  assert.match(cli(['unlock', `${file}.locked`]), /Verified/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'plot 42');
});

test('unlocks what the command line locked', async () => {
  const dir = workspace();
  const root = path.join(dir, 'Records');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub/a.txt'), 'A');
  cli(['lock', root, '--remove']);

  await choose([`${root}.locked`]);
  await page.getByRole('heading', { name: 'Unlock Records.locked' }).waitFor();
  await shot('4-unlock-form');
  await fill('Password', PASSWORD);
  await press('Unlock');
  await page.locator('#stage').getByText('Identical to what was locked').waitFor();
  await home();
  assert.equal(fs.readFileSync(path.join(root, 'sub/a.txt'), 'utf8'), 'A');
});

test('refuses short and mismatched passwords without locking', async () => {
  const dir = workspace();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  await choose([file]);
  await fill('Password', 'short');
  await fill('Enter it again', 'short');
  await press('Lock');
  await page.getByRole('alert').getByText('at least 8 characters').waitFor();
  await fill('Password', PASSWORD);
  await fill('Enter it again', 'different password');
  await press('Lock');
  await page.locator('#stage').getByText('The two passwords do not match').waitFor();
  await shot('5-mismatch-error');
  assert.deepEqual(fs.readdirSync(dir), ['f.txt']);
  await press('Cancel');
});

test('a wrong password explains itself and allows another try', async () => {
  const dir = workspace();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  cli(['lock', file, '--remove']);
  await choose([`${file}.locked`]);
  await fill('Password', 'not the password');
  await press('Unlock');
  await page.locator('#stage').getByText('Wrong password').waitFor();
  await fill('Password', PASSWORD);
  await press('Unlock');
  await page.locator('#stage').getByText('Identical to what was locked').waitFor();
  await home();
});

test('deletes the original only when asked', async () => {
  const dir = workspace();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'remove me');
  await choose([file]);
  await fill('Password', PASSWORD);
  await fill('Enter it again', PASSWORD);
  await page.getByLabel('Delete the original once the locked copy has been checked').check();
  await press('Lock');
  await page.getByRole('heading', { name: 'Locked f.txt' }).waitFor();
  await home();
  assert.deepEqual(fs.readdirSync(dir), ['f.txt.locked']);
});

test('checks a locked file without unlocking, against right and wrong SHA-256', async () => {
  const dir = workspace();
  const file = path.join(dir, 'deed.txt');
  fs.writeFileSync(file, 'deed');
  cli(['lock', file, '--remove']);
  const locked = `${file}.locked`;

  await choose([locked]);
  await press('Check without unlocking');
  await fill('Password', PASSWORD);
  await fill('SHA-256 from the other computer', sha('deed').toUpperCase());
  await shot('6-verify-form');
  await press('Check');
  await page.locator('#stage').getByText('Match: identical content').waitFor();
  await page.waitForTimeout(350);
  await shot('7-verify-match');
  await press('Done');

  await choose([locked]);
  await press('Check without unlocking');
  await fill('Password', PASSWORD);
  await fill('SHA-256 from the other computer', sha('altered'));
  await press('Check');
  await page.locator('#stage').getByText('Does not match').waitFor();
  await page.waitForTimeout(350);
  await shot('8-verify-mismatch');
  await press('Done');
  assert.deepEqual(fs.readdirSync(dir), ['deed.txt.locked']);
});

test('a plain zip can be extracted, and a locked zip extracts on unlock', async () => {
  const dir = workspace();
  const source = path.join(dir, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'z.txt'), 'zipped');
  const zip = path.join(dir, 'Bundle.zip');
  const made = process.platform === 'win32'
    ? spawnSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-a', '-cf', zip, '.'], { cwd: source })
    : spawnSync('zip', ['-qr', zip, '.'], { cwd: source });
  assert.equal(made.status, 0);
  fs.rmSync(source, { recursive: true });

  await choose([zip]);
  await page.getByRole('heading', { name: 'Extract Bundle.zip' }).waitFor();
  await press('Extract');
  await page.getByRole('heading', { name: 'Extracted' }).waitFor();
  await press('Done');
  assert.equal(fs.readFileSync(path.join(dir, 'Bundle/z.txt'), 'utf8'), 'zipped');
  fs.rmSync(path.join(dir, 'Bundle'), { recursive: true });

  cli(['lock', zip, '--remove']);
  await choose([`${zip}.locked`]);
  await fill('Password', PASSWORD);
  await press('Unlock');
  await page.locator('#stage').getByText('Extracted to').waitFor();
  await home();
  assert.equal(fs.readFileSync(path.join(dir, 'Bundle/z.txt'), 'utf8'), 'zipped');
});

test('the Check tab hashes a file and compares it', async () => {
  const dir = workspace();
  const file = path.join(dir, 'copy.txt');
  fs.writeFileSync(file, 'plot 42');
  await tab('Check');
  await choose([file]);
  await page.locator('#check-result').getByText(sha('plot 42')).waitFor();
  await page.locator('#check-result').getByText('This content appears in the history').waitFor();
  await page.getByLabel('Compare with a SHA-256').fill(sha('plot 42'));
  await page.locator('#check-result').getByText('Match: identical content').waitFor();
  await page.waitForTimeout(350);
  await shot('9-check');
  await page.getByLabel('Compare with a SHA-256').fill(sha('other'));
  await page.locator('#check-result').getByText('Does not match').waitFor();
});

test('History lists who did what and can be searched', async () => {
  await tab('History');
  await page.locator('#history-list').getByText('Land record.txt').first().waitFor();
  assert.ok(await page.locator('#history-list').getByText(os.userInfo().username).first().isVisible());
  await shot('10-history');
  await page.getByLabel('Search history').fill('zzz-nothing');
  await page.locator('#history-list').getByText('Nothing in the history matches').waitFor();
  await page.getByLabel('Search history').fill('Land record');
  await page.locator('#history-list').getByText('Land record.txt').first().waitFor();
});

test('Help explains how to lock and unlock', async () => {
  await tab('Help');
  await page.getByRole('heading', { name: 'Lock (encrypt) a file or folder' }).waitFor();
  await page.getByRole('heading', { name: 'Unlock (decrypt) a file or folder' }).waitFor();
  await shot('11-help');
});

test('opening the app again brings a minimised window back', async () => {
  const restored = await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window.minimize();
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    electronApp.emit('second-instance', {}, []);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    return !window.isMinimized() && window.isVisible();
  });
  assert.equal(restored, true);
});

test('opening a file from the system goes to the right screen', async () => {
  const dir = workspace();
  const file = path.join(dir, 'opened.txt');
  fs.writeFileSync(file, 'x');
  cli(['lock', file, '--remove']);
  await tab('Protect');
  await app.evaluate(({ app: electronApp }, target) => {
    electronApp.emit('open-file', { preventDefault() {} }, target);
  }, `${file}.locked`);
  await page.getByRole('heading', { name: 'Unlock opened.txt.locked' }).waitFor();
});
