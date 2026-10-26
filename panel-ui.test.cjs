const { test } = require('node:test');
const assert = require('node:assert/strict');
const ui = require('./panel-ui.js');

function dashboard({ writeText = async () => {} } = {}) {
  const fs = require('node:fs'), vm = require('node:vm');
  const nodes = new Map(), timers = new Map();
  let nextTimer = 0;
  const element = () => ({ children: [], dataset: {}, attributes: {}, value: '', textContent: '', checked: false, disabled: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {},
    append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; } });
  const getNode = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  getNode('#cp').textContent = 'Copy all';
  const document = { querySelector: getNode, querySelectorAll: () => [], createElement: element,
    addEventListener() {}, body: element() };
  const context = vm.createContext({ document, PanelUI: ui, fetch: () => new Promise(() => {}),
    navigator: { clipboard: { writeText } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, addEventListener() {}, setInterval() {}, clearInterval() {} });
  vm.runInContext(fs.readFileSync(require.resolve('./dashboard.js'), 'utf8'), context);
  return { node: getNode, run: source => vm.runInContext(source, context), timers };
}

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
