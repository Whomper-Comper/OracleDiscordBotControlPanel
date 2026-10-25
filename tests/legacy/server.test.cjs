const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { run, script, startServer, opts } = require('./server.cjs');

function output() {
  return Object.assign(new EventEmitter(), { text: '', write(s) { this.text += s; } });
}
test('streams output, masks secrets, and cleans up completed process listeners', async () => {
  const res = output();
  for (let i = 0; i < 3; i++) {
    assert.equal(await run(process.execPath, ['-e', 'console.log("secret")'], res, ['secret']), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
  assert.equal(res.text, '***\n'.repeat(3));
});
test('a stalled status process is bounded and its listener is removed', async () => {
  const res = output();
  const code = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], res, [], undefined, 100);
  assert.equal(code, 124);
  assert.match(res.text, /timed out/);
  assert.equal(res.listenerCount('close'), 0);
});
test('disconnect cancels the child and prevents subsequent work', async () => {
  const res = output();
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], res, []);
  res.destroyed = true;
  res.emit('close');
  assert.equal(await pending, 1);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(await run('must-not-be-spawned', [], res, []), 1);
});
test('spawn errors are reported without leaking listeners', async () => {
  const res = output();
  assert.equal(await run('missing-panel-test-executable', [], res, []), 1);
  assert.match(res.text, /ENOENT/);
  assert.equal(res.listenerCount('close'), 0);
});
test('memory preparation precedes installs and failed npm ci is not retried', () => {
  const c = { app: 'bot', dir: '/home/opc/bot', repo: 'https://example.test/bot.git', branch: 'main', buildCmd: 'npm run build', cmdSyncCmd: 'npm run sync' };
  for (const action of ['setup', 'deploy', 'redeploy', 'npmupdate']) {
    const s = script(c, action, {});
    assert.ok(s.indexOf('SWAP_KB=') < s.indexOf(action === 'setup' ? 'sudo dnf' : action === 'npmupdate' ? 'sudo env' : 'npm ci'));
    assert.match(s, /--max-old-space-size=512/);
  }
  assert.doesNotMatch(script(c, 'deploy', {}), /npm ci[^\n]*\|\|/);
  assert.ok(opts.includes('ServerAliveCountMax=9'));
  assert.match(script(c, 'setup', {}), /--setopt=max_parallel_downloads=1 --setopt=install_weak_deps=False/);
});
test('a second panel reports an occupied port without an unhandled error', async () => {
  const { once } = require('node:events');
  const first = startServer(0, () => {});
  await once(first, 'listening');
  try {
    const messages = [];
    const second = startServer(first.address().port, message => messages.push(message));
    const [error] = await once(second, 'error');
    assert.equal(error.code, 'EADDRINUSE');
    assert.match(messages.join(''), /already in use/);
    assert.match(messages.join(''), /Ctrl\+C/);
  } finally { await new Promise(resolve => first.close(resolve)); }
});
