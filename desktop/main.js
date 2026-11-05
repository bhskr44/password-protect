// Electron main process: owns the window and does all file work through the
// same engine as the command line. The window itself has no file access.
import {
  BrowserWindow, Menu, app, clipboard, dialog, ipcMain, shell,
} from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyFile, readHistory } from '../lib/history.js';
import {
  hashPath, isLockedFile, lockPath, removeTemps, unlockPath, unzipFile, verifyLocked,
} from '../lib/protect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let pendingPaths = [];
let busy = false;

const pathsFromArgv = (argv) => argv.slice(app.isPackaged ? 1 : 2)
  .filter((arg) => !arg.startsWith('-') && fs.existsSync(arg))
  .map((arg) => path.resolve(arg));

function deliverPaths(paths) {
  if (!paths.length) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('open-paths', paths);
  } else {
    pendingPaths.push(...paths);
  }
}

function friendly(error) {
  if (error.code === 'ENOENT' && error.path) return `This item could not be found: ${error.path}`;
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return `Access was denied to ${error.path ?? 'this item'}. Close any program using it and try again.`;
  }
  if (error.code === 'ENOSPC') return 'The disk is full. Free some space and try again.';
  return error.message;
}

// Results cross to the window as plain values, so that errors keep their text.
function handle(channel, work) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await work(...args) };
    } catch (error) {
      return { ok: false, error: friendly(error) };
    }
  });
}

function handleJob(channel, work) {
  handle(channel, async (...args) => {
    busy = true;
    try {
      return await work(...args);
    } finally {
      busy = false;
    }
  });
}

async function describeItem(itemPath) {
  const stat = await fsp.lstat(itemPath);
  const locked = await isLockedFile(itemPath);
  let kind = 'file';
  if (locked) kind = 'locked';
  else if (stat.isDirectory()) kind = 'folder';
  return {
    path: itemPath,
    name: path.basename(itemPath),
    kind,
    zip: /\.zip$/i.test(itemPath),
    lockedZip: /\.zip\.locked$/i.test(itemPath),
  };
}

function registerHandlers() {
  handle('take-pending', () => {
    const paths = pendingPaths;
    pendingPaths = [];
    return paths;
  });

  handle('pick', async (kind) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    return canceled ? [] : filePaths;
  });

  handle('describe', (paths) => Promise.all(paths.map(describeItem)));

  handleJob('lock', ({ itemPath, password, remove }) => lockPath(itemPath, { password, remove }));

  handleJob('unlock', async ({ itemPath, password, remove, unzip }) => {
    const result = await unlockPath(itemPath, { password, remove });
    const { warnings } = result;
    let extracted = null;
    if (unzip && /\.zip$/i.test(result.path)) {
      try {
        extracted = await unzipFile(result.path);
      } catch (error) {
        warnings.push(friendly(error));
      }
    }
    return { ...result, warnings, extracted };
  });

  handleJob('verify', ({ itemPath, password, against }) => verifyLocked(itemPath, { password, against }));
  handleJob('extract', (itemPath) => unzipFile(itemPath));
  handleJob('hash', async (itemPath) => ({ ...(await hashPath(itemPath)), name: path.basename(itemPath) }));

  handle('history', async () => ({ records: (await readHistory()).reverse(), file: historyFile() }));
  handle('show-item', (itemPath) => shell.showItemInFolder(itemPath));
  handle('copy', (text) => clipboard.writeText(text));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: '#DDE4E8',
    show: false,
    title: 'Password Protect',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  // This window only ever shows the bundled page.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!busy) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Keep working', 'Stop and close'],
      defaultId: 0,
      cancelId: 0,
      message: 'Password Protect is still working',
      detail: 'Closing now stops the job. Your originals are not affected, and partial output is removed.',
    });
    if (choice === 0) event.preventDefault();
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  window.loadFile(path.join(HERE, 'ui', 'index.html'));
  mainWindow = window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS sends this for double-clicks and Dock drops, sometimes before ready.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    deliverPaths([filePath]);
  });
  app.on('second-instance', (_event, argv) => deliverPaths(pathsFromArgv(argv)));
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', removeTemps);
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    pendingPaths.push(...pathsFromArgv(process.argv));
    registerHandlers();
    createWindow();
  });
}
