const { test } = require('node:test');
const assert = require('node:assert/strict');
const ui = require('./panel-ui.js');

function dashboard({ writeText = async () => {}, fetch = () => new Promise(() => {}), storage = new Map(), storageError = false } = {}) {
  const fs = require('node:fs'), vm = require('node:vm');
  const nodes = new Map(), timers = new Map(), listeners = new Map();
  let nextTimer = 0;
  const element = () => ({ children: [], dataset: {}, attributes: {}, value: '', textContent: '', checked: false, disabled: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  const getNode = selector => {
    if (selector === 'dialog[open]') return null;
    selector = selector.replace(/\[data-([ak])="([^"]+)"\]/g, '[data-$1=$2]');
    if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector);
  };
  getNode('#cp').textContent = 'Copy all';
  getNode('#ll').value = '200'; getNode('#auto').checked = true;
  const fields = ['host', 'port', 'user', 'key', 'token', 'name', 'app', 'dir', 'localEnv', 'localBot', 'entryFile'].map(key => {
    const node = getNode('[data-k=' + key + ']'); node.dataset.k = key; return node;
  });
  const document = { querySelector: getNode, querySelectorAll: selector => selector === '[data-k]' ? fields : [], createElement: element,
    createTextNode: text => ({ textContent: text }),
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); }, body: element() };
  const localStorage = {
    getItem(key) { if (storageError) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageError) throw new Error('Storage unavailable'); storage.set(key, value); },
    removeItem(key) { if (storageError) throw new Error('Storage unavailable'); storage.delete(key); }
  };
  const context = vm.createContext({ document, PanelUI: ui, fetch, localStorage, AbortController, DOMException,
    navigator: { clipboard: { writeText } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, addEventListener() {}, setInterval() {}, clearInterval() {} });
  vm.runInContext(fs.readFileSync(require.resolve('./dashboard.js'), 'utf8'), context);
  return { node: getNode, run: source => vm.runInContext(source, context), timers, storage,
    dispatch: (name, target) => { for (const listener of listeners.get(name) || []) listener({ target }); } };
}

const preferencesKey = 'oracle-bot-panel.preferences.v1';

function keydown(node, key, options = {}) {
  const event = { key, target: node, prevented: false, preventDefault() { this.prevented = true; }, ...options };
  node.onkeydown?.(event);
  return event;
}

function readyCommands(options = {}) {
  const requests = [];
  const panel = dashboard({ ...options, fetch: (url, request) => {
    if (!request) return new Promise(() => {});
    requests.push({ url, ...request });
    if (url === '/api/config') return Promise.resolve({ ok: true, json: async () => ({ bots: [{ id: 'one', name: 'One', app: 'one' }] }) });
    if (url === '/api/run') return Promise.resolve(streamed([new TextEncoder().encode('✔ Done\n')]));
    throw new Error('Unexpected request: ' + url);
  } });
  panel.run("loaded = true; botId = 'one'; bots = [{ id: 'one', name: 'One', app: 'one' }]; setBusy(false);");
  return { ...panel, requests };
}

async function flushMicrotasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fireTimers(panel) {
  const pending = [...panel.timers];
  for (const [id, timer] of pending) { panel.timers.delete(id); timer.callback(); }
}

test('blank custom commands stay disabled and cannot save settings or send an action', async () => {
  const { node, run, requests } = readyCommands();
  assert.equal(node('[data-a=custom]').disabled, true);
  for (const value of ['', '   \t\n']) {
    node('#cmd').value = value; node('#cmd').oninput?.();
    assert.equal(node('[data-a=custom]').disabled, true);
    keydown(node('#cmd'), 'Enter');
    await run(`run('custom', { cmd: ${JSON.stringify(value)} })`);
  }
  await flushMicrotasks();
  assert.deepEqual(requests, []);
  node('#cmd').value = 'pwd'; node('#cmd').oninput?.();
  assert.equal(node('[data-a=custom]').disabled, false);
  run('setBusy(true)'); assert.equal(node('[data-a=custom]').disabled, true);
  run('setBusy(false)'); assert.equal(node('[data-a=custom]').disabled, false);
});

test('command history recalls submitted commands and restores the unfinished draft without persisting it', async () => {
  const { node, run, requests, storage } = readyCommands();
  await run("run('custom', { cmd: 'pwd' })");
  await run("run('custom', { cmd: 'ls -al' })");
  node('#cmd').value = 'unfinished command';
  assert.equal(keydown(node('#cmd'), 'ArrowUp').prevented, true);
  assert.equal(node('#cmd').value, 'ls -al');
  keydown(node('#cmd'), 'ArrowUp'); assert.equal(node('#cmd').value, 'pwd');
  keydown(node('#cmd'), 'ArrowUp'); assert.equal(node('#cmd').value, 'pwd');
  keydown(node('#cmd'), 'ArrowDown'); assert.equal(node('#cmd').value, 'ls -al');
  keydown(node('#cmd'), 'ArrowDown'); assert.equal(node('#cmd').value, 'unfinished command');
  keydown(node('#cmd'), 'ArrowDown'); assert.equal(node('#cmd').value, 'unfinished command');
  assert.equal(requests.filter(request => request.url === '/api/run').length, 2);
  node('#rememberprefs').checked = true; node('#rememberprefs').onchange();
  assert.equal(storage.get(preferencesKey).includes('pwd'), false);
  assert.equal(storage.get(preferencesKey).includes('unfinished command'), false);
  const nextTab = readyCommands({ storage });
  nextTab.node('#cmd').value = 'new tab draft';
  keydown(nextTab.node('#cmd'), 'ArrowUp');
  assert.equal(nextTab.node('#cmd').value, 'new tab draft');
});

test('Enter submits the typed command and history navigation keeps the Run button consistent with a blank draft', async () => {
  const { node, requests } = readyCommands();
  node('#cmd').value = 'pwd'; node('#cmd').oninput();
  assert.equal(keydown(node('#cmd'), 'Enter').prevented, true);
  await flushMicrotasks();
  assert.equal(requests.filter(request => request.url === '/api/run').length, 1);
  assert.equal(JSON.parse(requests.find(request => request.url === '/api/run').body).params.cmd, 'pwd');
  await flushMicrotasks();
  node('#cmd').value = ''; node('#cmd').oninput();
  assert.equal(node('[data-a=custom]').disabled, true);
  keydown(node('#cmd'), 'ArrowUp');
  assert.equal(node('#cmd').value, 'pwd'); assert.equal(node('[data-a=custom]').disabled, false);
  keydown(node('#cmd'), 'ArrowDown');
  assert.equal(node('#cmd').value, ''); assert.equal(node('[data-a=custom]').disabled, true);
});

test('command history keeps the latest 50 commands and ignores modified or composing navigation and Enter', async () => {
  const { node, run, requests } = readyCommands();
  for (let i = 1; i <= 52; i++) await run(`run('custom', { cmd: 'command-${i}' })`);
  node('#cmd').value = 'draft';
  for (let i = 0; i < 60; i++) keydown(node('#cmd'), 'ArrowUp');
  assert.equal(node('#cmd').value, 'command-3');
  for (let i = 0; i < 50; i++) keydown(node('#cmd'), 'ArrowDown');
  assert.equal(node('#cmd').value, 'draft');
  const count = requests.length;
  for (const option of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter']) {
      assert.equal(keydown(node('#cmd'), key, { [option]: true }).prevented, false);
      assert.equal(node('#cmd').value, 'draft');
    }
  }
  assert.equal(keydown(node('#cmd'), 'Enter', { keyCode: 229 }).prevented, false);
  await flushMicrotasks();
  assert.equal(requests.length, count);
});

test('path previews debounce input and send only the current local paths with panel protection', async () => {
  const requests = [];
  const panel = dashboard({ fetch: (url, request) => {
    if (!request) return new Promise(() => {});
    requests.push({ url, ...request });
    return Promise.resolve({ ok: true, json: async () => ({
      key: { resolved: 'C:\\home\\id.pub', error: '', warning: 'Choose the private key.' },
      localEnv: { resolved: 'C:\\project\\<img>.env', error: 'File does not exist.', warning: '' },
      localBot: { resolved: 'C:\\project\\bot', error: '', warning: '' }
    }) });
  } });
  panel.run('loaded = true');
  panel.node('[data-k=token]').value = 'private-token';
  panel.node('[data-k=key]').value = 'old-key'; panel.dispatch('input', panel.node('[data-k=key]'));
  panel.node('[data-k=key]').value = '~/.ssh/id.pub'; panel.dispatch('input', panel.node('[data-k=key]'));
  panel.node('[data-k=localEnv]').value = '"<img>.env"'; panel.dispatch('input', panel.node('[data-k=localEnv]'));
  panel.node('[data-k=localBot]').value = './bot'; panel.dispatch('input', panel.node('[data-k=localBot]'));
  assert.equal(requests.length, 0);
  fireTimers(panel); await flushMicrotasks();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/paths'); assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers['X-Panel'], '1'); assert.equal(requests[0].cache, 'no-store');
  assert.deepEqual(JSON.parse(requests[0].body), { key: '~/.ssh/id.pub', localEnv: '"<img>.env"', localBot: './bot' });
  assert.match(panel.node('#path-key').textContent, /C:\\home\\id.pub.*private key/);
  assert.match(panel.node('#path-key').className, /\bw\b/);
  assert.match(panel.node('#path-localEnv').textContent, /<img>.env.*does not exist/);
  assert.match(panel.node('#path-localEnv').className, /\be\b/);
  assert.equal(panel.node('#path-localEnv').innerHTML, undefined);
  assert.match(panel.node('#path-localBot').textContent, /C:\\project\\bot/);
});

test('saving and previewing preserve quoted paths and significant spaces after configuration reload', async () => {
  const requests = [];
  const panel = dashboard({ fetch: (url, request) => {
    if (!request) return new Promise(() => {});
    requests.push({ url, body: JSON.parse(request.body) });
    return Promise.resolve({ ok: true, json: async () => url === '/api/config' ? { bots: [{ id: 'one', name: 'One', app: 'one' }] } : {
      key: { resolved: 'C:\\project\\ folder\\key' }, localEnv: { resolved: 'C:\\project\\ env\\.env' }, localBot: { resolved: 'C:\\project\\ bots\\source' }
    } });
  } });
  for (const paths of [
    { key: '" folder/key"', localEnv: '" env/.env"', localBot: '" bots/source"' },
    { key: ' folder/key', localEnv: ' env/.env', localBot: ' bots/source' }
  ]) {
    const config = { activeBotId: 'one', bots: [{ id: 'one', name: 'One', app: 'one' }], host: '  example.test  ', name: '  One  ', ...paths };
    panel.run(`loaded = true; applyConfig(${JSON.stringify(config)});`);
    fireTimers(panel); await flushMicrotasks();
    await panel.run('save()');
    const preview = requests.filter(request => request.url === '/api/paths').at(-1).body;
    const saved = requests.filter(request => request.url === '/api/config').at(-1).body;
    assert.deepEqual(preview, paths);
    assert.deepEqual({ key: saved.key, localEnv: saved.localEnv, localBot: saved.localBot }, paths);
    assert.equal(saved.host, 'example.test'); assert.equal(saved.name, 'One');
  }
});

test('loading or switching profiles refreshes path previews and stale responses cannot replace the selected paths', async () => {
  const pending = [];
  const panel = dashboard({ fetch: (url, request) => {
    if (!request) return new Promise(() => {});
    return new Promise(resolve => pending.push({ request, resolve }));
  } });
  panel.run("loaded = true; applyConfig({ activeBotId: 'first', bots: [{ id: 'first', name: 'First', app: 'first' }], key: 'first-key', localEnv: 'first.env', localBot: 'first-bot' });");
  fireTimers(panel); await flushMicrotasks();
  assert.equal(pending.length, 1);
  panel.run("applyConfig({ activeBotId: 'second', bots: [{ id: 'second', name: 'Second', app: 'second' }], key: '', localEnv: '', localBot: 'second-bot' });");
  assert.match(panel.node('#path-key').textContent, /agent|default/i);
  assert.match(panel.node('#path-localEnv').textContent, /optional/i);
  fireTimers(panel); await flushMicrotasks();
  assert.equal(pending.length, 2);
  pending[1].resolve({ ok: true, json: async () => ({ key: { resolved: null, error: null, warning: null }, localEnv: { resolved: null, error: null, warning: null }, localBot: { resolved: 'C:\\second-bot', error: null, warning: null } }) });
  await flushMicrotasks();
  pending[0].resolve({ ok: true, json: async () => ({ key: { resolved: 'C:\\first-key' }, localEnv: { resolved: 'C:\\first.env' }, localBot: { resolved: 'C:\\first-bot' } }) });
  await flushMicrotasks();
  assert.match(panel.node('#path-localBot').textContent, /C:\\second-bot/);
  assert.match(panel.node('#path-key').textContent, /agent|default/i);
  assert.equal(panel.node('[data-k=localBot]').value, 'second-bot');
});

test('path previews report failures without cancelling an action or preventing later input', async () => {
  let rejectPreview, actionSignal;
  const panel = dashboard({ fetch: (url, request) => request ? new Promise((resolve, reject) => { rejectPreview = reject; }) : new Promise(() => {}) });
  actionSignal = panel.run('loaded = true; ctl = new AbortController(); setBusy(true); ctl.signal');
  panel.node('[data-k=key]').value = 'key'; panel.dispatch('input', panel.node('[data-k=key]'));
  fireTimers(panel); await flushMicrotasks();
  assert.equal(typeof rejectPreview, 'function');
  rejectPreview(new Error('Local panel unavailable')); await flushMicrotasks();
  assert.match(panel.node('#path-key').textContent, /unavailable/i);
  assert.equal(actionSignal.aborted, false);
  panel.node('[data-k=key]').value = ''; panel.dispatch('input', panel.node('[data-k=key]'));
  assert.match(panel.node('#path-key').textContent, /agent|default/i);
});

test('preferences stay in the session until opted in and save only the four allowed choices', () => {
  const { node, storage } = dashboard();
  assert.equal(node('#rememberprefs').checked, false);
  node('#ll').value = '500'; node('#ll').onchange?.();
  node('#le').checked = true; node('#le').onchange?.();
  assert.equal(storage.size, 0);
  node('[data-k=token]').value = 'private-token'; node('[data-k=key]').value = 'private-key-path';
  node('#outputsearch').value = 'private output'; node('#lf').value = 'private logs';
  node('#botsearch').value = 'private bot'; node('#cmd').value = 'private command';
  node('#rememberprefs').checked = true; node('#rememberprefs').onchange?.();
  assert.deepEqual(JSON.parse(storage.get(preferencesKey) ?? 'null'), { logLines: '500', logErrorsOnly: true, outputErrorsOnly: false, autoRefresh: true });
  node('#auto').checked = false; node('#auto').onchange();
  assert.equal(JSON.parse(storage.get(preferencesKey)).autoRefresh, false);
  node('#outputerrors').checked = true; node('#outputerrors').onchange();
  assert.equal(JSON.parse(storage.get(preferencesKey)).outputErrorsOnly, true);
  assert.match(node('#prefnote').textContent, /browser/i);
});

test('saved preferences restore valid choices without applying unknown or invalid data', () => {
  const storage = new Map([[preferencesKey, JSON.stringify({ logLines: '3000', logErrorsOnly: true, outputErrorsOnly: true, autoRefresh: false, token: 'injected', outputsearch: 'injected' })]]);
  const { node } = dashboard({ storage });
  assert.equal(node('#rememberprefs').checked, true);
  assert.equal(node('#ll').value, '3000'); assert.equal(node('#le').checked, true);
  assert.equal(node('#outputerrors').checked, true); assert.equal(node('#auto').checked, false);
  assert.equal(node('[data-k=token]').value, ''); assert.equal(node('#outputsearch').value, '');
  const invalid = dashboard({ storage: new Map([[preferencesKey, JSON.stringify({ logLines: '200000', logErrorsOnly: 'true', outputErrorsOnly: true, autoRefresh: 0 })]]) });
  assert.equal(invalid.node('#ll').value, '200'); assert.equal(invalid.node('#le').checked, false);
  assert.equal(invalid.node('#outputerrors').checked, true); assert.equal(invalid.node('#auto').checked, true);
});

test('turning off remembered preferences clears only this panel key and keeps the current session choices', () => {
  const storage = new Map([[preferencesKey, JSON.stringify({ logLines: '1000', logErrorsOnly: true, outputErrorsOnly: true, autoRefresh: false })], ['another-app', 'keep me']]);
  const { node } = dashboard({ storage });
  node('#rememberprefs').checked = false; node('#rememberprefs').onchange?.();
  assert.equal(storage.has(preferencesKey), false); assert.equal(storage.get('another-app'), 'keep me');
  assert.equal(node('#ll').value, '1000'); assert.equal(node('#le').checked, true);
  assert.equal(node('#outputerrors').checked, true); assert.equal(node('#auto').checked, false);
  node('#ll').value = '100'; node('#ll').onchange();
  assert.equal(storage.has(preferencesKey), false);
});

test('corrupt or unavailable preference storage leaves the dashboard usable with session defaults', () => {
  for (const options of [{ storage: new Map([[preferencesKey, '{broken']]) }, { storage: new Map([[preferencesKey, 'null']]) }, { storageError: true }]) {
    const { node, run } = dashboard(options);
    assert.equal(node('#rememberprefs').checked, false);
    assert.equal(node('#ll').value, '200'); assert.equal(node('#auto').checked, true);
    assert.match(node('#prefnote').textContent, /could not|unavailable/i);
    node('#rememberprefs').checked = true;
    assert.doesNotThrow(() => node('#rememberprefs').onchange());
    node('#rememberprefs').checked = false;
    assert.doesNotThrow(() => node('#rememberprefs').onchange());
    run("line('Still usable');"); assert.equal(node('#t').children[0].textContent, 'Still usable');
  }
});

test('dashboard output removes ANSI colors split across streamed network chunks', () => {
  const { node, run } = dashboard();
  run("put('\\x1b['); put('31mBuild failed\\x1b'); put('[0m\\r\\n'); put('\\x1b[3'); put('2mFinished\\x1b[0m'); flush();");
  assert.deepEqual(node('#t').children.map(node => node.textContent), ['Build failed', 'Finished']);
  assert.equal(node('#t').children[0].className, 'e');
});

test('output tools follow available lines and distinguish empty output from hidden results', () => {
  const { node, run } = dashboard();
  for (const id of ['#cp', '#sv', '#cl']) assert.equal(node(id).disabled, true);
  assert.equal(node('#outempty').hidden, false);
  assert.match(node('#outempty').textContent, /run an action/i);
  const emptyMessage = node('#outempty').textContent;

  run("line('Build completed');");
  for (const id of ['#cp', '#sv', '#cl']) assert.equal(node(id).disabled, false);
  assert.equal(node('#outempty').hidden, true);
  node('#outputsearch').value = 'missing';
  node('#outputsearch').oninput();
  assert.equal(node('#outempty').hidden, false);
  assert.notEqual(node('#outempty').textContent, emptyMessage);
  assert.match(node('#outempty').textContent, /filters/i);
  assert.equal(node('#outputcount').textContent, '0/1 lines');
  assert.equal(node('#cp').disabled, false);

  node('#cl').onclick();
  assert.equal(node('#t').children.length, 0);
  assert.equal(node('#outempty').textContent, emptyMessage);
  for (const id of ['#cp', '#sv', '#cl']) assert.equal(node(id).disabled, true);
});

test('copy reports pending and success accessibly, preserves all output, and resets its label', async () => {
  let finishCopy, copied;
  const { node, run, timers } = dashboard({ writeText: text => { copied = text; return new Promise(resolve => { finishCopy = resolve; }); } });
  run("line('First line'); line('Second line');");
  node('#outputsearch').value = 'First';
  node('#outputsearch').oninput();
  const copying = node('#cp').onclick();
  assert.equal(node('#cp').textContent, 'Copying…');
  assert.equal(node('#cp').disabled, true);
  assert.equal(node('#cp').attributes['aria-live'], 'polite');
  assert.equal(copied, 'First line\nSecond line');
  run("line('More output while copying');");
  assert.equal(node('#cp').disabled, true);
  finishCopy();
  await copying;
  assert.equal(node('#cp').textContent, 'Copied!');
  assert.equal(node('#cp').disabled, false);
  const reset = [...timers.values()].find(timer => timer.delay === 2000);
  assert.ok(reset, 'Copy feedback resets after two seconds');
  reset.callback();
  assert.equal(node('#cp').textContent, 'Copy all');
});

test('failed copy leaves a readable error in output and restores the copy control', async () => {
  const { node, run } = dashboard({ writeText: async () => { throw new Error('Clipboard denied'); } });
  run("line('Build completed');");
  await node('#cp').onclick();
  assert.equal(node('#cp').textContent, 'Copy all');
  assert.equal(node('#cp').disabled, false);
  const failure = node('#t').children.at(-1);
  assert.match(failure.textContent, /Could not copy output: Clipboard denied/);
  assert.equal(failure.className, 'e');
});

test('fleet search matches display names and PM2 names without changing the saved list', () => {
  const bots = [{ name: 'Music bot', app: 'music-prod' }, { name: 'Moderator', app: 'mod' }];
  assert.deepEqual(bots.filter(b => ui.matchesBot(b, '  MUSIC  ')), [bots[0]]);
  assert.deepEqual(bots.filter(b => ui.matchesBot(b, 'prod')), [bots[0]]);
  assert.equal(bots.filter(b => ui.matchesBot(b, 'missing')).length, 0);
  assert.equal(bots.filter(b => ui.matchesBot(b, '')).length, 2);
});

test('fleet counts include only saved bots and distinguish unchecked status from offline bots', () => {
  const bots = [{ app: 'one' }, { app: 'two' }, { app: 'three' }];
  assert.deepEqual(ui.fleetSummary(bots, null), { total: 3, online: 0, offline: 0, unknown: 3 });
  assert.deepEqual(ui.fleetSummary(bots, [{ name: 'one', status: 'online' }, { name: 'two', status: 'errored' }, { name: 'unrelated', status: 'online' }]), { total: 3, online: 1, offline: 2, unknown: 0 });
});

test('cached status is invalidated when the SSH target or selected PM2 app changes', () => {
  const before = { host: 'first.example.test', port: '22', user: 'opc', key: 'first-key', app: 'music', botId: 'music-id', name: 'Music' };
  for (const change of [{ host: 'second.example.test' }, { port: '2222' }, { user: 'other' }, { key: 'second-key' }, { app: 'moderator' }, { botId: 'other-id' }]) {
    assert.equal(ui.sameStatusTarget(before, { ...before, ...change }), false);
  }
  assert.equal(ui.sameStatusTarget(before, { ...before, name: 'Renamed music', buildCmd: 'npm run build' }), true);
});

test('output filtering combines search and errors without discarding the original output', () => {
  assert.equal(ui.matchesOutput('npm ERR! build failed', 'BUILD', true), true);
  assert.equal(ui.matchesOutput('✔ build completed', 'build', true), false);
  assert.equal(ui.matchesOutput('npm ERR! build failed', 'ssh', false), false);
  assert.equal(ui.matchesOutput('Waiting for server', '', false), true);
  assert.equal(ui.outputLevel('SSH connection timed out'), 'e');
});

function streamed(chunks) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

test('action results use the final server outcome even when earlier command output says success', async () => {
  const encoder = new TextEncoder(), parts = [];
  const result = await ui.readActionResponse(streamed([encoder.encode('✔ Done\nInstalling packages\n'), encoder.encode('✖ Failed (exit 137)\n')]), text => parts.push(text));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 137);
  assert.equal(parts.join(''), '✔ Done\nInstalling packages\n✖ Failed (exit 137)\n');
});

test('streaming handles split Unicode and never reports a truncated response as successful', async () => {
  const bytes = new TextEncoder().encode('All ready\n✔ Done\n'), parts = [];
  const result = await ui.readActionResponse(streamed([bytes.slice(0, 11), bytes.slice(11, 12), bytes.slice(12)]), text => parts.push(text));
  assert.equal(parts.join(''), 'All ready\n✔ Done\n');
  assert.equal(result.status, 'success');
  const truncated = await ui.readActionResponse(streamed([new TextEncoder().encode('Installing packages...')]), () => {});
  assert.equal(truncated.status, 'unknown');
});

test('API validation errors become readable failures instead of raw JSON console output', async () => {
  const response = new Response(JSON.stringify({ error: 'Choose a separate bot folder.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(ui.readActionResponse(response, () => assert.fail('No JSON should be rendered as streamed output')), /Choose a separate bot folder/);
});

test('stream errors propagate so the UI cannot mistake a dropped connection for a completed action', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('Connection lost')); } }));
  await assert.rejects(ui.readActionResponse(response, () => {}), /Connection lost/);
});
