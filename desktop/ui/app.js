const stage = document.getElementById('stage');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'class') node.className = value;
    else if (value !== undefined) node[key] = value;
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

const button = (label, onclick, variant = '', type = 'button') => el('button', {
  class: `button ${variant}`, type, onclick, textContent: label,
});

async function call(request) {
  const response = await request;
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

const FULL_SHA = /^[a-f0-9]{64}$/;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const formatTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const baseName = (itemPath) => itemPath.split(/[\\/]/).filter(Boolean).pop();
const SHOW_LABEL = window.api.platform === 'darwin' ? 'Show in Finder' : 'Show in File Explorer';

let fieldCount = 0;

function labelledField(label, input) {
  fieldCount += 1;
  input.id = `field-${fieldCount}`;
  return el('label', { htmlFor: input.id, textContent: label });
}

// A password stays in these inputs only until the job starts.
function passwordField(label, autocomplete) {
  const input = el('input', { type: 'password', autocomplete, spellcheck: false });
  const reveal = el('button', {
    class: 'reveal',
    type: 'button',
    textContent: 'Show',
    onclick: () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      reveal.textContent = hidden ? 'Hide' : 'Show';
    },
  });
  reveal.setAttribute('aria-label', `Show ${label.toLowerCase()}`);
  const field = el('div', { class: 'field' }, labelledField(label, input), el('div', { class: 'password' }, input, reveal));
  return { field, input };
}

// --- Protect ---------------------------------------------------------------

function showDrop() {
  stage.replaceChildren(el('div', { class: 'dropzone' },
    el('div', {}, drawEmptySeal()),
    el('div', {},
      el('h1', { textContent: 'Drop a file or folder here' }),
      el('p', { class: 'lead', textContent: 'Lock it with a password, or open something that is already locked.' }),
      el('div', { class: 'row' },
        button('Choose file', () => pick('file'), 'primary'),
        button('Choose folder', () => pick('folder'))))));
}

async function pick(kind) {
  const paths = await call(window.api.pick(kind));
  if (paths.length) await openItems(paths);
}

async function openItems(paths) {
  const items = await call(window.api.describe(paths));
  const lockedCount = items.filter((item) => item.kind === 'locked').length;
  if (lockedCount && lockedCount !== items.length) {
    showDrop();
    stage.firstChild.lastChild.append(el('p', {
      class: 'error',
      role: 'alert',
      textContent: 'That selection mixes locked and unlocked items. Add one kind at a time.',
    }));
    return;
  }
  if (lockedCount) showOpenForm(items);
  else if (items.every((item) => item.zip)) showLockForm(items, true);
  else showLockForm(items, false);
}

function itemList(items) {
  return el('ul', { class: 'items' }, ...items.map((item) => el('li', { textContent: item.path })));
}

function showError(host, message) {
  host.querySelector('.error')?.remove();
  host.append(el('p', { class: 'error', role: 'alert', textContent: message }));
}

function showWorking(message) {
  stage.replaceChildren(el('div', { class: 'working', role: 'status' },
    el('div', { class: 'seal-box' }, drawEmptySeal()),
    el('h2', { textContent: message }),
    el('div', { class: 'progress' }),
    el('p', { class: 'hint', textContent: 'Large folders can take a few minutes.' })));
}

function showLockForm(items, canExtract) {
  const title = items.length === 1 ? `Lock ${items[0].name}` : `Lock ${plural(items.length, 'item')}`;
  const heading = el('h1', { textContent: title });
  const first = passwordField('Password', 'new-password');
  const second = passwordField('Enter it again', 'new-password');
  const remove = el('input', { type: 'checkbox' });
  const form = el('form', {});
  const lockFields = el('div', {},
    first.field,
    el('p', { class: 'hint', textContent: 'At least 8 characters. A long phrase is stronger than a short, complicated word.' }),
    second.field,
    el('label', { class: 'check' }, remove,
      el('span', { textContent: 'Delete the original once the locked copy has been checked' })),
    el('p', { class: 'warning', textContent: 'If this password is forgotten, nobody can open the locked file. Keep it somewhere safe.' }),
    el('div', { class: 'row' }, button('Lock', undefined, 'primary', 'submit'), button('Cancel', showDrop, 'quiet')));
  const extractFields = el('div', { hidden: true },
    el('p', { class: 'lead', textContent: 'Extracts into a new folder next to the zip. This does not need a password.' }),
    el('div', { class: 'row' }, button('Extract', () => runExtract(items), 'primary'), button('Cancel', showDrop, 'quiet')));

  const lockChoice = el('button', { type: 'button', textContent: 'Lock' });
  const extractChoice = el('button', { type: 'button', textContent: 'Extract' });
  const setChoice = (extract) => {
    lockChoice.setAttribute('aria-pressed', String(!extract));
    extractChoice.setAttribute('aria-pressed', String(extract));
    lockFields.hidden = extract;
    extractFields.hidden = !extract;
    heading.textContent = extract ? title.replace('Lock', 'Extract') : title;
    if (!extract) first.input.focus();
  };
  lockChoice.addEventListener('click', () => setChoice(false));
  extractChoice.addEventListener('click', () => setChoice(true));

  form.append(lockFields, extractFields);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = first.input.value;
    if ([...password].length < 8) return showError(form, 'Use a password of at least 8 characters.');
    if (password !== second.input.value) return showError(form, 'The two passwords do not match. Enter them again.');
    await runLock(items, password, remove.checked);
  });

  stage.replaceChildren(el('div', { class: 'work' }, heading, itemList(items),
    canExtract ? el('div', { class: 'choice' }, extractChoice, lockChoice) : null, form));
  setChoice(canExtract);
  if (!canExtract) first.input.focus();
}

function showOpenForm(items) {
  const single = items.length === 1;
  const secret = passwordField('Password', 'current-password');
  const remove = el('input', { type: 'checkbox' });
  const expected = el('input', { type: 'text', class: 'hash', spellcheck: false, placeholder: '64 letters and numbers' });
  const form = el('form', {});
  const compare = el('div', { hidden: true },
    el('div', { class: 'field' }, labelledField('SHA-256 from the other computer', expected), expected),
    el('p', { class: 'hint', textContent: 'Leave this empty to see what is inside without comparing.' }));
  const unlockExtras = el('label', { class: 'check' }, remove,
    el('span', { textContent: 'Delete the locked file after unlocking' }));

  const lockedZip = items.some((item) => item.lockedZip);
  const unlockChoice = el('button', { type: 'button', textContent: 'Unlock' });
  const verifyChoice = el('button', { type: 'button', textContent: 'Check without unlocking' });
  const action = button('Unlock', undefined, 'primary', 'submit');
  const heading = el('h1', {});
  let verifying = false;
  const setChoice = (verify) => {
    verifying = verify;
    unlockChoice.setAttribute('aria-pressed', String(!verify));
    verifyChoice.setAttribute('aria-pressed', String(verify));
    compare.hidden = !verify;
    unlockExtras.hidden = verify;
    action.textContent = verify ? 'Check' : 'Unlock';
    const name = single ? items[0].name : plural(items.length, 'item');
    heading.textContent = `${verify ? 'Check' : 'Unlock'} ${name}`;
    secret.input.focus();
  };
  unlockChoice.addEventListener('click', () => setChoice(false));
  verifyChoice.addEventListener('click', () => setChoice(true));

  form.append(secret.field, compare, unlockExtras,
    lockedZip ? el('p', { class: 'hint', textContent: 'Zip files are extracted as well.' }) : null,
    el('div', { class: 'row' }, action, button('Cancel', showDrop, 'quiet')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = secret.input.value;
    if (!password) return showError(form, 'Enter the password.');
    const against = expected.value.replace(/\s/g, '').toLowerCase();
    if (verifying && against && !FULL_SHA.test(against)) {
      return showError(form, `A SHA-256 has 64 letters and numbers. This one has ${against.length}.`);
    }
    if (verifying) await runVerify(items, password, against || undefined);
    else await runUnlock(items, password, remove.checked);
  });

  stage.replaceChildren(el('div', { class: 'work' }, heading, itemList(items),
    single ? el('div', { class: 'choice' }, unlockChoice, verifyChoice) : null, form));
  setChoice(false);
}

// Runs the job for each item. On a failure the form returns with the message,
// and items already finished are left out of the retry.
async function runEach(items, message, job) {
  const results = [];
  for (const [index, item] of items.entries()) {
    showWorking(items.length > 1 ? `${message} ${index + 1} of ${items.length}` : `${message} ${item.name}`);
    try {
      results.push({ item, ...(await call(job(item))) });
    } catch (error) {
      return { results, failed: items.slice(index), error: error.message };
    }
  }
  return { results };
}

function afterRun({ results, failed, error }, verb, reopen) {
  if (!failed) return showResults(results, verb);
  reopen(failed);
  const prefix = results.length ? `${results.length} finished. ` : '';
  showError(stage.querySelector('form'), `${prefix}${error}`);
  return undefined;
}

async function runLock(items, password, remove) {
  const run = await runEach(items, 'Locking', (item) => window.api.lock({ itemPath: item.path, password, remove }));
  afterRun(run, 'Locked', (failed) => showLockForm(failed, false));
}

async function runUnlock(items, password, remove) {
  const run = await runEach(items, 'Unlocking', (item) => window.api.unlock({
    itemPath: item.path, password, remove, unzip: item.lockedZip,
  }));
  afterRun(run, 'Unlocked', showOpenForm);
}

async function runVerify(items, password, against) {
  const run = await runEach(items, 'Checking', (item) => window.api.verify({ itemPath: item.path, password, against }));
  afterRun(run, 'Checked', showOpenForm);
}

async function runExtract(items) {
  showWorking('Extracting');
  const results = [];
  try {
    for (const item of items) results.push({ item, path: await call(window.api.extract(item.path)) });
  } catch (error) {
    showLockForm(items, true);
    showError(stage.querySelector('.work'), error.message);
    return;
  }
  stage.replaceChildren(el('div', { class: 'work' },
    el('h1', { textContent: 'Extracted' }),
    ...results.map((result) => el('p', { class: 'lead', textContent: result.path })),
    el('div', { class: 'row' },
      button(SHOW_LABEL, () => window.api.showItem(results[0].path)),
      button('Done', showDrop, 'primary'))));
}

const VERDICTS = {
  new: ['First time recorded', ''],
  unchanged: ['Same content as the last record', 'match'],
  changed: ['Changed since the last record', 'mismatch'],
  verified: ['Identical to what was locked', 'match'],
  checked: ['Password correct', ''],
  match: ['Match: identical content', 'match'],
  mismatch: ['Does not match: the content is different', 'mismatch'],
};

function sealFor(sha256, tone) {
  const box = el('div', { class: tone === 'mismatch' ? 'is-mismatch stamped' : tone === 'match' ? 'is-match stamped' : 'stamped' });
  box.append(drawSeal(sha256));
  return box;
}

function verdict(status) {
  const [text, tone] = VERDICTS[status] ?? [status, ''];
  return el('p', { class: `verdict ${tone}`, textContent: text });
}

function shaBlock(sha256) {
  const copy = button('Copy SHA-256', async () => {
    await window.api.copy(sha256);
    copy.textContent = 'Copied';
  });
  return el('div', {}, el('p', { class: 'sha', textContent: sha256 }), el('div', { class: 'row' }, copy));
}

function resultFacts(result) {
  const facts = el('dl', { class: 'facts' });
  const add = (term, value) => facts.append(el('dt', { textContent: term }), el('dd', { textContent: value }));
  if (result.path) add('Saved as', result.path);
  if (result.extracted) add('Extracted to', result.extracted);
  if (result.meta) add('Locked by', `${result.meta.by} on ${result.meta.host}, ${formatTime(result.meta.at)}`);
  if (result.files !== undefined) add('Contains', `${plural(result.files, 'file')}, ${formatSize(result.bytes)}`);
  if (result.expected) {
    facts.append(el('dt', { textContent: 'Compared with' }), el('dd', { class: 'sha', textContent: result.expected }));
  }
  return facts;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function showResults(results, verb) {
  const done = button('Done', showDrop, 'primary');
  const notes = results.flatMap((result) => result.warnings ?? [])
    .map((text) => el('p', { class: 'note', textContent: text }));

  if (results.length === 1) {
    const [result] = results;
    const tone = VERDICTS[result.status]?.[1];
    const actions = el('div', { class: 'row' },
      result.path ? button(SHOW_LABEL, () => window.api.showItem(result.path)) : null, done);
    const body = el('div', {},
      el('h1', { textContent: `${verb} ${result.item.name}` }),
      verdict(result.status), resultFacts(result),
      el('dl', { class: 'facts' }, el('dt', { textContent: 'SHA-256' })),
      shaBlock(result.sha256), ...notes, actions);
    stage.replaceChildren(el('div', { class: 'work' },
      el('div', { class: 'result' }, sealFor(result.sha256, tone), body)));
  } else {
    stage.replaceChildren(el('div', { class: 'work' },
      el('h1', { textContent: `${verb} ${plural(results.length, 'item')}` }),
      el('div', { class: 'batch' }, ...results.map((result) => el('div', { class: 'batch-row' },
        drawSeal(result.sha256, { label: false }),
        el('div', {},
          el('div', { class: 'entry-name', textContent: result.item.name }),
          el('div', { class: 'sha', textContent: result.sha256 }))))),
      ...notes, el('div', { class: 'row' }, done)));
  }
  done.focus();
}

// --- Check -----------------------------------------------------------------

const checkResult = document.getElementById('check-result');

async function checkItem(itemPath) {
  const [item] = await call(window.api.describe([itemPath]));
  if (item.kind === 'locked') {
    switchView('protect');
    await openItems([itemPath]);
    return;
  }
  checkResult.replaceChildren(el('p', { class: 'lead', textContent: `Reading ${item.name}…` }));
  try {
    renderCheck(await call(window.api.hash(itemPath)));
  } catch (error) {
    checkResult.replaceChildren(el('p', { class: 'error', role: 'alert', textContent: error.message }));
  }
}

function renderCheck(result) {
  const expected = el('input', { type: 'text', class: 'hash', spellcheck: false, placeholder: '64 letters and numbers' });
  const seal = el('div', {}, sealFor(result.sha256));
  const outcome = el('div', { 'aria-live': 'polite' });
  const compare = () => {
    const value = expected.value.replace(/\s/g, '').toLowerCase();
    seal.className = '';
    outcome.replaceChildren();
    if (!value) return;
    if (!FULL_SHA.test(value)) {
      outcome.append(el('p', { class: 'hint', textContent: `A SHA-256 has 64 letters and numbers. This one has ${value.length}.` }));
      return;
    }
    const same = value === result.sha256;
    seal.className = same ? 'is-match' : 'is-mismatch';
    outcome.append(verdict(same ? 'match' : 'mismatch'));
  };
  expected.addEventListener('input', compare);

  const records = result.matches.slice(-5).reverse().map((record) => el('p', {
    class: 'note',
    textContent: `${capitalize(record.action)} by ${record.by} on ${record.host}, ${formatTime(record.at)}`,
  }));
  checkResult.replaceChildren(el('div', { class: 'result' }, seal, el('div', {},
    el('h2', { textContent: result.name }),
    el('p', { class: 'note', textContent: `${plural(result.files, 'file')}, ${formatSize(result.bytes)}` }),
    shaBlock(result.sha256),
    el('div', { class: 'field' }, labelledField('Compare with a SHA-256', expected), expected),
    outcome,
    records.length
      ? el('div', {}, el('p', { class: 'note', textContent: 'This content appears in the history:' }), ...records)
      : el('p', { class: 'note', textContent: 'This content is not in the history on this computer.' }))));
}

const capitalize = (text) => text[0].toUpperCase() + text.slice(1);

for (const [id, kind] of [['check-file', 'file'], ['check-folder', 'folder']]) {
  document.getElementById(id).addEventListener('click', async () => {
    const [first] = await call(window.api.pick(kind));
    if (first) await checkItem(first);
  });
}

// --- History ---------------------------------------------------------------

const historyList = document.getElementById('history-list');
const historySearch = document.getElementById('history-search');
let historyRecords = [];

const ACTION_LABEL = { lock: 'Locked', unlock: 'Unlocked', verify: 'Checked' };

function renderHistory() {
  const query = historySearch.value.trim().toLowerCase();
  const shown = historyRecords.filter((record) => !query
    || [record.path, record.by, record.host, record.sha256].some((value) => value?.toLowerCase().includes(query)));
  if (!shown.length) {
    historyList.replaceChildren(el('p', {
      class: 'empty',
      textContent: query ? 'Nothing in the history matches that search.' : 'Lock or unlock something and it will be recorded here.',
    }));
    return;
  }
  historyList.replaceChildren(...shown.slice(0, 300).map((record) => {
    const [text, tone] = VERDICTS[record.status] ?? [record.status, ''];
    const row = el('div', { class: 'entry' },
      drawSeal(record.sha256, { label: false }),
      el('div', { class: 'when' },
        el('div', { class: 'entry-name', textContent: ACTION_LABEL[record.action] ?? record.action }),
        el('div', { class: 'entry-sub', textContent: formatTime(record.at) })),
      el('div', {},
        el('div', { class: 'entry-name', textContent: baseName(record.path) }),
        el('div', { class: 'entry-sub', textContent: `${record.by} on ${record.host}` }),
        el('div', { class: 'entry-sub sha', textContent: record.sha256 })),
      el('span', { class: `badge ${tone}`, textContent: text }));
    row.title = record.path;
    return row;
  }));
}

async function loadHistory() {
  const { records, file } = await call(window.api.history());
  historyRecords = records;
  document.getElementById('history-footnote').textContent = `Recorded only on this computer, in ${file}`;
  renderHistory();
}

historySearch.addEventListener('input', renderHistory);

// --- Navigation and dropping -----------------------------------------------

let currentView = 'protect';

function switchView(view) {
  currentView = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== view;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view === 'history') loadHistory();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
}

function receive(paths) {
  if (!paths.length) return;
  if (currentView === 'check') {
    checkItem(paths[0]);
  } else {
    switchView('protect');
    openItems(paths);
  }
}

const veil = document.getElementById('drop-veil');
let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  veil.hidden = false;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    veil.hidden = true;
  }
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  receive([...event.dataTransfer.files].map((file) => window.api.pathForFile(file)).filter(Boolean));
});

window.addEventListener('unhandledrejection', (event) => {
  stage.append(el('p', { class: 'error', role: 'alert', textContent: event.reason?.message ?? String(event.reason) }));
});

window.api.onOpenPaths(receive);
showDrop();
call(window.api.takePending()).then(receive);
