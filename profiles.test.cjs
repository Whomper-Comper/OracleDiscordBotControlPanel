const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { once } = require('events');
const profiles = require('./profiles.cjs');
const { createServer, ecosystem, script } = require('./server.cjs');
const legacy = { name: 'Original bot', host: '', user: 'opc', port: '22', key: 'private-key', token: 'test-token', repo: 'https://example.test/old.git', app: 'original', dir: '/home/opc/original', buildCmd: 'npm run build', cmdSyncCmd: 'npm run sync', localEnv: 'old.env', localBot: 'old-folder' };
const initial = () => profiles.normalize(legacy, {});
test('migration preserves existing settings and does not move or rename the running bot', () => {
  const store = initial(), c = profiles.active(store);
  for (const [key, value] of Object.entries(legacy)) assert.equal(c[key], value);
  assert.equal(c.managed, false);
  assert.deepEqual(profiles.normalize(store, {}), store);
});
test('new bots have isolated settings and collision-free paths and app names', () => {
  const first = profiles.add(initial(), { name: 'Music Bot', repo: 'https://example.test/music.git' });
  const second = profiles.add(first, { name: 'Music Bot' });
  assert.equal(profiles.active(first).app, 'music-bot');
  assert.equal(profiles.active(second).app, 'music-bot-2');
  assert.equal(profiles.active(first).dir, '/home/opc/bots/music-bot');
  assert.equal(profiles.active(first).localEnv, '');
  assert.equal(profiles.active(first).cmdSyncCmd, '');
  assert.equal(profiles.active(first).token, 'test-token');
  assert.equal(first.bots[0].repo, legacy.repo);
  assert.equal(profiles.active(profiles.add(initial(), { name: 'all' })).app, 'bot-all');
});
test('editing one profile preserves other profiles and shares connection settings', () => {
  const store = profiles.add(initial(), { name: 'Music' });
  const next = profiles.update(store, { botId: store.activeBotId, repo: 'music.git', host: 'new-host', managed: false });
  assert.equal(next.bots[0].repo, legacy.repo);
  assert.equal(profiles.active(next).repo, 'music.git');
  assert.equal(profiles.active(next).managed, true);
  assert.equal(profiles.active(next, 'legacy').host, 'new-host');
  assert.throws(() => profiles.update(store, { app: 'original' }), /different PM2/);
  assert.throws(() => profiles.update(store, { dir: '/home/opc/original/subdir' }), /non-nested/);
  assert.throws(() => profiles.update(store, { botId: 'missing' }), /Unknown/);
});
test('generated launch config preserves repo settings but isolates the selected app', () => {
  const c = profiles.active(profiles.add(initial(), { name: 'Music' }));
  const run = apps => {
    const context = { module: { exports: {} }, require: name => name === 'fs' ? { existsSync: () => !!apps } : name === 'path' ? path.posix : { apps } };
    vm.runInNewContext(ecosystem(c), context);
    return context.module.exports.apps;
  };
  const result = run([{ name: 'old-repo-name', script: 'dist/main.js', env: { MODE: 'bot' }, max_memory_restart: '200M' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'music');
  assert.equal(result[0].cwd, c.dir);
  assert.equal(result[0].max_memory_restart, '200M');
  assert.equal(result[0].env.MODE, 'bot');
  assert.equal(run(null)[0].script, 'npm');
  assert.throws(() => run([{ name: 'one' }, { name: 'two' }]), /multiple apps/);
  c.entryFile = 'dist/custom.js';
  assert.equal(run(null)[0].script, 'dist/custom.js');
  const start = script(c, 'start', {});
  assert.match(start, /\.bot-panel\//);
  assert.match(start, /--only "\$APP"/);
  assert.doesNotMatch(script({ ...c, otherApps: ['original'] }, 'solo', {}), /pm2 stop all/);
});
test('profile API persists creation, selection and edits, preserving a legacy backup', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-profiles-test-'));
  const file = path.join(folder, 'config.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = profiles.repository(file, {}), server = createServer(store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (endpoint, body) => {
    const r = await fetch(base + endpoint, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const original = await (await fetch(base + '/api/config')).json();
    assert.equal(original.app, 'original');
    const added = await post('/api/profiles', { action: 'add', name: 'Music' });
    assert.equal(added.status, 200); assert.equal(added.body.bots.length, 2);
    const id = added.body.activeBotId;
    assert.equal((await post('/api/config', { botId: id, repo: 'music.git' })).status, 200);
    assert.equal((await post('/api/profiles', { action: 'select', id: 'legacy' })).body.repo, legacy.repo);
    assert.equal((await post('/api/profiles', { action: 'select', id })).body.repo, 'music.git');
    assert.equal((await post('/api/config', { botId: id, app: 'original' })).status, 400);
    assert.equal((await post('/api/profiles', { action: 'select', id: 'missing' })).status, 400);
    assert.equal(profiles.active(store.read()).app, 'music');
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.pre-profiles.bak', 'utf8')), legacy);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
