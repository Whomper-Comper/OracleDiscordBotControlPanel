const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const profiles = require('./profiles.cjs');
const { createServer } = require('./server.cjs');

const initial = () => profiles.normalize({
  name: 'Music Bot', app: 'music-bot', dir: '/home/opc/bots/music-bot',
  host: 'example.test', user: 'opc', port: '22', key: 'fixture-key', token: 'fixture-token',
  repo: 'https://example.test/music.git', branch: 'production', buildCmd: 'npm run release',
  cmdSyncCmd: 'npm run sync', entryFile: 'dist/music.js', localEnv: 'music.env', localBot: 'music-folder'
}, {});

test('duplicating a saved bot copies deployment preferences into a separate managed profile', () => {
  const before = initial();
  before.bots[0].entryFile = 'dist/music.js';
  // A malformed old profile must not leak shared credentials into the new bot object.
  before.bots[0].key = 'old-profile-key';
  before.bots[0].token = 'old-profile-token';
  const snapshot = structuredClone(before);
  const next = profiles.duplicate(before, { id: 'legacy', name: 'Music Bot' });
  const bot = next.bots.find(b => b.id === next.activeBotId);
  assert.match(bot.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(bot.name, 'Music Bot');
  assert.equal(bot.app, 'music-bot-2');
  assert.equal(bot.dir, '/home/opc/bots/music-bot-2');
  assert.equal(bot.managed, true);
  assert.equal(bot.repo, 'https://example.test/music.git');
  assert.equal(bot.branch, 'production');
  assert.equal(bot.buildCmd, 'npm run release');
  assert.equal(bot.cmdSyncCmd, 'npm run sync');
  assert.equal(bot.entryFile, 'dist/music.js');
  assert.equal(bot.localEnv, '');
  assert.equal(bot.localBot, '');
  for (const key of ['host', 'port', 'user', 'key', 'token']) assert.equal(Object.hasOwn(bot, key), false);
  assert.deepEqual(next.server, snapshot.server);
  assert.deepEqual(next.bots[0], snapshot.bots[0]);
  assert.deepEqual(before, snapshot);
  const third = profiles.duplicate(next, { id: 'legacy', name: 'Music Bot' });
  assert.equal(profiles.active(third).app, 'music-bot-3');
  assert.equal(profiles.active(third).dir, '/home/opc/bots/music-bot-3');
  assert.notEqual(third.activeBotId, next.activeBotId);
});

test('duplication uses an explicit saved source and only accepts string overrides', () => {
  const before = profiles.add(initial(), { name: 'Other' });
  const selectedId = before.activeBotId;
  const next = profiles.duplicate(before, {
    id: 'legacy', name: ' Copy ', repo: ' https://example.test/copy.git ', entryFile: ' app.js ',
    branch: 'ignored', app: 'music-bot', dir: '/home/opc/bots/music-bot', managed: false,
    localEnv: 'ignored.env', localBot: 'ignored-folder', host: 'ignored.example.test'
  });
  const bot = profiles.active(next);
  assert.equal(bot.name, 'Copy');
  assert.equal(bot.repo, 'https://example.test/copy.git');
  assert.equal(bot.entryFile, 'app.js');
  assert.equal(bot.branch, 'production');
  assert.equal(bot.app, 'copy');
  assert.equal(bot.dir, '/home/opc/bots/copy');
  assert.equal(bot.managed, true);
  assert.equal(bot.localEnv, '');
  assert.equal(bot.localBot, '');
  assert.equal(bot.host, 'example.test');
  assert.equal(before.activeBotId, selectedId);
  const cleared = profiles.active(profiles.duplicate(before, { id: 'legacy', name: 'Empty repo', repo: '', entryFile: '' }));
  assert.equal(cleared.repo, '');
  assert.equal(cleared.entryFile, '');
  for (const id of [undefined, null, '', 'missing', 123]) {
    assert.throws(() => profiles.duplicate(before, { id, name: 'Copy' }), /profile/i);
  }
  for (const name of [undefined, null, '', '   ', 123, {}]) {
    assert.throws(() => profiles.duplicate(before, { id: 'legacy', name }), /name/i);
  }
  for (const field of ['repo', 'entryFile']) {
    for (const value of [null, 123, {}]) {
      assert.throws(() => profiles.duplicate(before, { id: 'legacy', name: 'Copy', [field]: value }), /string/i);
    }
  }
});

async function panel(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-duplicate-test-'));
  const store = profiles.repository(path.join(folder, 'fixture.json'), {});
  store.write(initial());
  const server = createServer(store, () => assert.fail('Duplicating a profile must not run SSH or provision files'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(folder, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async data => {
    const response = await fetch(base + '/api/profiles', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  return { store, post, base };
}

test('duplicate API saves and selects the copy without provisioning or changing the source', async t => {
  const { store, post } = await panel(t);
  const before = store.read();
  const result = await post({ action: 'duplicate', id: 'legacy', name: 'Music Bot' });
  assert.equal(result.status, 200);
  assert.equal(result.body.bots.length, 2);
  assert.equal(result.body.app, 'music-bot-2');
  assert.equal(result.body.branch, 'production');
  assert.equal(result.body.localEnv, '');
  assert.equal(result.body.localBot, '');
  assert.equal(result.body.managed, true);
  assert.notEqual(result.body.activeBotId, 'legacy');
  assert.equal(store.read().activeBotId, result.body.activeBotId);
  assert.deepEqual(store.read().bots[0], before.bots[0]);
  assert.deepEqual(store.read().server, before.server);
  const persisted = store.read();
  for (const changes of [{ id: 'missing' }, { id: undefined }, { name: '' }, { repo: {} }, { entryFile: null }]) {
    const invalid = await post({ action: 'duplicate', id: 'legacy', name: 'Copy', ...changes });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.error);
    assert.deepEqual(store.read(), persisted);
  }
});

test('only the two explicit browser scripts are served as JavaScript without exposing other source files', async t => {
  const { base } = await panel(t);
  for (const file of ['panel-ui.js', 'dashboard.js']) {
    const response = await fetch(base + '/' + file);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript;charset=utf-8');
    assert.equal(await response.text(), fs.readFileSync(path.join(__dirname, file), 'utf8'));
  }
  const other = await fetch(base + '/profiles.cjs');
  assert.equal(other.headers.get('content-type'), 'text/html;charset=utf-8');
  assert.match(await other.text(), /<!doctype html>/i);
});
