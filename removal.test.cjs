const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const profiles = require('./profiles.cjs');
const { createServer, removalScript } = require('./server.cjs');
const initial = () => profiles.normalize({ name: 'Original', app: 'original', dir: '/home/opc/original', host: 'example.test', user: 'opc', port: '22', token: '', key: '' }, {});

test('removal preserves other bots and shared settings and selects a remaining bot', () => {
  const before = profiles.add(initial(), { name: 'Music' });
  const after = profiles.remove(before, before.activeBotId);
  assert.deepEqual(after.bots, [before.bots[0]]);
  assert.deepEqual(after.server, before.server);
  assert.equal(after.activeBotId, 'legacy');
  assert.equal(before.bots.length, 2);
  const third = profiles.add(before, { name: 'Third' });
  assert.equal(profiles.remove(third, 'legacy').activeBotId, third.activeBotId);
  assert.throws(() => profiles.remove(before, 'missing'), /Unknown bot/);
});

test('removing the last bot persists an empty list without resurrecting the legacy bot', () => {
  const empty = profiles.remove(initial(), 'legacy');
  assert.equal(empty.activeBotId, '');
  assert.deepEqual(profiles.normalize(empty, {}), empty);
  const edited = profiles.update(empty, { host: 'new.example.test', name: 'Ignored' });
  assert.equal(edited.server.host, 'new.example.test');
  assert.deepEqual(edited.bots, []);
  assert.throws(() => profiles.update(empty, { botId: 'legacy' }), /Unknown bot/);
  assert.equal(profiles.add(edited, { name: 'Replacement' }).bots.length, 1);
});

async function panel(t, remote) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-removal-test-'));
  const store = profiles.repository(path.join(folder, 'config.json'), {});
  store.write(profiles.add(initial(), { name: 'Music' }));
  const server = createServer(store, remote);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(folder, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (endpoint, data) => {
    if (endpoint === '/api/profiles' && data.action === 'remove' && !Object.hasOwn(data, 'revision')) {
      const current = await (await fetch(base + '/api/config')).json();
      data = { ...data, revision: current.removalRevision };
    }
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const bot = profiles.active(store.read());
  return { store, post, bot, base };
}

test('profile-only removal works offline and the last profile can be removed through the API', async t => {
  const { store, post, bot } = await panel(t, () => assert.fail('Profile-only removal must not connect to SSH'));
  store.write(profiles.update(store.read(), { host: '' }));
  const removed = await post('/api/profiles', { action: 'remove', id: bot.id, mode: 'profile', confirmation: bot.app });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.activeBotId, 'legacy');
  const last = await post('/api/profiles', { action: 'remove', id: 'legacy', mode: 'profile', confirmation: 'original' });
  assert.equal(last.status, 200);
  assert.deepEqual(last.body.bots, []);
  assert.deepEqual(store.read().bots, []);
  assert.equal((await post('/api/profiles', { action: 'add', name: 'New' })).body.bots.length, 1);
});

test('removal rejects unknown IDs, modes and missing confirmations before SSH', async t => {
  let calls = 0;
  const { store, post, bot } = await panel(t, async () => { calls++; return 0; });
  for (const changes of [{ id: 'missing' }, { id: undefined }, { id: '' }, { id: null }, { mode: 'invalid' }, { confirmation: '' }, { mode: 'delete' }, { revision: '' }]) {
    const result = await post('/api/profiles', { action: 'remove', id: bot.id, mode: 'uninstall', confirmation: bot.app, ...changes });
    assert.equal(result.status, 400);
    assert.equal(store.read().bots.length, 2);
    assert.equal(calls, 0);
  }
});

test('a removal dialog cannot delete a bot moved to another host or folder after opening', async t => {
  let calls = 0;
  const { store, post, bot, base } = await panel(t, async () => { calls++; return 0; });
  const snapshot = await (await fetch(base + '/api/config')).json();
  store.write(profiles.update(store.read(), { botId: bot.id, host: 'different.example.test', dir: '/home/opc/bots/moved' }));
  const result = await post('/api/profiles', { action: 'remove', id: bot.id, mode: 'uninstall', confirmation: bot.app, revision: snapshot.removalRevision });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /settings.*changed/i);
  assert.equal(calls, 0);
  assert.equal(store.read().bots.length, 2);
});

test('saving a tab bot returns its own confirmation revision after another tab changes selection', async t => {
  const { post, bot, store } = await panel(t, async () => 0);
  await post('/api/profiles', { action: 'select', id: 'legacy' });
  const saved = await post('/api/config', { botId: bot.id, name: 'Music' });
  assert.equal(saved.body.app, 'music');
  const removed = await post('/api/profiles', { action: 'remove', id: bot.id, revision: saved.body.removalRevision, mode: 'uninstall', confirmation: bot.app });
  assert.equal(removed.status, 200);
  assert.equal(store.read().activeBotId, 'legacy');
  assert.equal(store.read().bots.length, 1);
});

test('remote cleanup uses saved settings and failure keeps the bot available for retry', async t => {
  let code = 1, calls = 0;
  const { store, post, bot } = await panel(t, async (c, shell, output) => {
    calls++;
    assert.equal(c.app, 'music');
    assert.equal(c.dir, '/home/opc/bots/music');
    output.write('Cleanup output\n');
    return code;
  });
  const request = { action: 'remove', id: bot.id, mode: 'uninstall', confirmation: bot.app, cfg: { app: 'other', dir: '/' } };
  const failed = await post('/api/profiles', request);
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /profile.*kept/i);
  assert.equal(store.read().bots.length, 2);
  code = 0;
  const success = await post('/api/profiles', request);
  assert.equal(success.status, 200);
  assert.match(success.body.output, /Cleanup output/);
  assert.equal(store.read().bots.length, 1);
  assert.equal(calls, 2);
});

test('other requests cannot change a bot while its remote removal is running', async t => {
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  const { store, post, bot } = await panel(t, async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = post('/api/profiles', { action: 'remove', id: bot.id, mode: 'uninstall', confirmation: bot.app });
  await Promise.race([running, pending.then(() => assert.fail('Removal must start SSH cleanup'))]);
  try {
    assert.equal((await post('/api/config', { botId: bot.id, app: 'changed' })).status, 400);
    assert.equal((await post('/api/run', { action: 'start', cfg: { botId: bot.id } })).status, 400);
    assert.equal(store.read().bots.length, 2);
  } finally { release(0); }
  assert.equal((await pending).status, 200);
});

test('removal waits until an already active request finishes', async t => {
  const { request } = require('node:http');
  let calls = 0;
  const { store, post, bot, base } = await panel(t, async () => { calls++; return 0; });
  const data = JSON.stringify({ botId: bot.id, name: 'Music' });
  const open = request(base + '/api/config', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Length': Buffer.byteLength(data) } });
  const finished = new Promise((resolve, reject) => { open.on('response', response => { response.resume(); response.on('end', resolve); }); open.on('error', reject); });
  open.flushHeaders();
  await (await fetch(base + '/api/config')).json();
  try {
    const removed = await post('/api/profiles', { action: 'remove', id: bot.id, mode: 'uninstall', confirmation: bot.app });
    assert.equal(removed.status, 400);
    assert.match(removed.body.error, /another.*request|another.*action/i);
    assert.equal(calls, 0);
    assert.equal(store.read().bots.length, 2);
  } finally { open.end(data); await finished; }
});

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : '/bin/bash';
const posix = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
test('uninstall removes only the selected PM2 app, forces persistence, and keeps bot data', { skip: !fs.existsSync(bash) }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-uninstall-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'bots/music'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.env'), 'fixture');
  const c = { ...profiles.active(initial()), id: 'music-id', app: 'music', dir: posix(dir), managed: true };
  const run = list => spawnSync(bash, ['--noprofile', '--norc', '-c', `export HOME='${posix(root)}'; pm2(){ if [ "$1" = jlist ]; then printf '%s' '${JSON.stringify(list)}'; else printf '%s\\n' "$*"; fi; }; ${removalScript(c, [], false)}`], { encoding: 'utf8' });
  const present = run([{ name: 'music' }, { name: 'original' }]);
  assert.equal(present.status, 0, present.stderr + present.stdout);
  assert.match(present.stdout, /delete music/);
  assert.match(present.stdout, /save --force/);
  assert.doesNotMatch(present.stdout, /delete original/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'fixture');
  const absent = run([{ name: 'original' }]);
  assert.equal(absent.status, 0, absent.stderr + absent.stdout);
  assert.doesNotMatch(absent.stdout, /delete music/);
});

test('file cleanup deletes only a bot subfolder and refuses home, shared folders, symlinks and overlapping bots', { skip: !fs.existsSync(bash) }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-delete-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'bots/music'), other = path.join(root, 'bots/other');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'fixture'); fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
  const c = { ...profiles.active(initial()), id: 'music-id', app: 'music', dir: posix(dir), managed: true };
  const run = (target, others = [posix(other)]) => spawnSync(bash, ['--noprofile', '--norc', '-c', `export HOME='${posix(root)}'; pm2(){ if [ "$1" = jlist ]; then echo '[]'; else echo "$*"; fi; }; ${removalScript({ ...c, dir: target }, others, true)}`], { encoding: 'utf8' });
  for (const target of [posix(root), posix(path.join(root, 'bots')), posix(path.join(root, '.ssh')), '/etc', '/']) {
    const result = run(target);
    assert.notEqual(result.status, 0, 'Must refuse unsafe folder ' + target);
    assert.doesNotMatch(result.stdout, /save --force/);
  }
  assert.notEqual(run(posix(dir), [posix(path.join(dir, 'nested'))]).status, 0);
  const symlink = path.join(root, 'bots/link');
  fs.symlinkSync(other, symlink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(run(posix(symlink)).status, 0);
  const success = run(posix(dir));
  assert.equal(success.status, 0, success.stderr + success.stdout);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(run(posix(dir)).status, 0, 'Retrying an absent bot folder is safe');
});
