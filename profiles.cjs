const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const SHARED = ['host', 'port', 'user', 'key', 'token'];
const BOT = ['name', 'repo', 'branch', 'dir', 'app', 'buildCmd', 'cmdSyncCmd', 'localEnv', 'localBot', 'entryFile'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => typeof o[k] === 'string').map(k => [k, o[k]]));
function normalize(raw, defaults) {
  if (raw.version === 2 && Array.isArray(raw.bots)) return raw;
  const old = { ...defaults, ...raw };
  return { version: 2, server: pick(old, SHARED), activeBotId: 'legacy', bots: [{ ...pick(old, BOT), id: 'legacy', managed: false, entryFile: '' }] };
}
function active(store, id = store.activeBotId) {
  const bot = store.bots.find(b => b.id === id);
  if (!bot) throw new Error('Bot profile no longer exists. Refresh the panel.');
  return { ...store.server, ...bot, botId: bot.id };
}
function validate(store) {
  const apps = new Set(), dirs = [];
  for (const b of store.bots) {
    if (!b.name.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(b.app) || /^\d+$/.test(b.app) || b.app === 'all') throw new Error('Use a bot name and a nonnumeric PM2 name containing letters, numbers, hyphens or underscores (not "all").');
    if (!b.dir.startsWith('/') || b.dir === '/' || b.dir.split('/').includes('..')) throw new Error('Each bot needs its own absolute install folder.');
    const dir = path.posix.normalize(b.dir).replace(/\/$/, '');
    if (apps.has(b.app) || dirs.some(d => d === dir || d.startsWith(dir + '/') || dir.startsWith(d + '/'))) throw new Error('Bots must have different PM2 names and separate, non-nested install folders.');
    apps.add(b.app); dirs.push(dir);
  }
}
function update(store, input) {
  const next = structuredClone(store), id = input.botId || next.activeBotId;
  const bot = next.bots.find(b => b.id === id);
  if (!bot && (id || next.bots.length)) throw new Error('Unknown bot profile.');
  Object.assign(next.server, pick(input, SHARED));
  if (bot) Object.assign(bot, pick(input, BOT));
  validate(next); return next;
}
function add(store, input) {
  const next = structuredClone(store), name = String(input.name || '').trim();
  if (!name) throw new Error('Enter a bot name.');
  let slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'bot';
  if (/^\d+$/.test(slug) || slug === 'all') slug = 'bot-' + slug;
  const home = next.server.user === 'root' ? '/root' : '/home/' + (next.server.user || 'opc');
  const base = slug;
  for (let n = 2; next.bots.some(b => b.app === slug || b.dir === home + '/bots/' + slug); n++) slug = base + '-' + n;
  const bot = { id: randomUUID(), name, app: slug, dir: home + '/bots/' + slug, repo: String(input.repo || '').trim(), branch: 'main', buildCmd: 'npm run build --if-present', cmdSyncCmd: '', localEnv: '', localBot: '', entryFile: String(input.entryFile || '').trim(), managed: true };
  next.bots.push(bot); next.activeBotId = bot.id; validate(next); return next;
}
function repository(file, defaults) {
  const read = () => {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; raw = {}; }
    return normalize(raw, defaults);
  };
  const write = store => {
    validate(store);
    if (fs.existsSync(file) && !fs.existsSync(file + '.pre-profiles.bak')) fs.copyFileSync(file, file + '.pre-profiles.bak');
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  };
  return { read, write };
}
function remove(store, id) {
  const next = structuredClone(store);
  if (!next.bots.some(b => b.id === id)) throw new Error('Unknown bot profile.');
  next.bots = next.bots.filter(b => b.id !== id);
  if (next.activeBotId === id) next.activeBotId = next.bots[0]?.id || '';
  validate(next); return next;
}
module.exports = { normalize, active, validate, update, add, remove, repository };
