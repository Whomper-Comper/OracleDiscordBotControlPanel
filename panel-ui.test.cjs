const { test } = require('node:test');
const assert = require('node:assert/strict');
const ui = require('./panel-ui.js');

test('dashboard output removes ANSI colors split across streamed network chunks', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const nodes = new Map();
  const element = () => ({ children: [], dataset: {}, value: '', checked: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, append(child) { this.children.push(child); } });
  const getNode = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const document = { querySelector: getNode, querySelectorAll: () => [], createElement: element,
    addEventListener() {}, body: element() };
  const context = vm.createContext({ document, PanelUI: ui, fetch: () => new Promise(() => {}),
    addEventListener() {}, setInterval() {}, clearInterval() {} });
  vm.runInContext(fs.readFileSync(require.resolve('./dashboard.js'), 'utf8'), context);
  vm.runInContext("put('\\x1b['); put('31mBuild failed\\x1b'); put('[0m\\r\\n'); put('\\x1b[3'); put('2mFinished\\x1b[0m'); flush();", context);
  assert.deepEqual(nodes.get('#t').children.map(node => node.textContent), ['Build failed', 'Finished']);
  assert.equal(nodes.get('#t').children[0].className, 'e');
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
