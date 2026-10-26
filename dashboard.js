const $ = selector => document.querySelector(selector), T = $('#t'), ui = PanelUI;
const shared = ['host', 'port', 'user', 'key', 'token'];
const metrics = [['state', 'Bot'], ['up', 'Bot uptime'], ['mem', 'Bot memory'], ['cpu', 'Bot CPU'], ['rs', 'Restarts'], ['load', 'Server load'], ['ram', 'Server memory'], ['disk', 'Disk']];
let buf = '', busy = false, loaded = false, ctl = null, statusCtl = null, botId = '', bots = [], fleetApps = null;
let saveQueue = Promise.resolve(), removalRevision = '', duplicateSourceId = '', connection = '', activity = null, activityTimer, statusTarget = null;
let copying = false, copyTimer;
const post = (url, data, options = {}) => fetch(url, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data), ...options });
const cfg = () => ({ botId, ...Object.fromEntries([...document.querySelectorAll('[data-k]')].map(e => [e.dataset.k, e.value.trim()])) });
const confirmations = {
  resetrepo: 'Discard changes in the selected server checkout and match its remote branch? Untracked files will be removed, except the configured environment/database/backup exclusions.',
  stop: 'Stop the selected bot?', reboot: 'Reboot the whole server? Every running bot will disconnect.',
  flush: 'Delete PM2 logs for the selected bot?', setup: 'Run initial setup? This installs Node 22 and PM2 and prepares the selected bot.',
  solo: 'Stop the other saved bots, then start this bot? Other bots remain stopped if startup fails.'
};

document.querySelectorAll('[data-k]').forEach(e => {
  e.id = 'cfg-' + e.dataset.k;
  if (e.previousElementSibling?.tagName === 'LABEL') e.previousElementSibling.htmlFor = e.id;
});
$('#ud').setAttribute('aria-label', 'Upload destination folder');
$('#cards').innerHTML = metrics.map(([key, label]) => `<div class="c"><span>${label}</span><b id="s-${key}">-</b></div>`).join('');

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  document.querySelectorAll('[data-k]').forEach(e => { e.disabled = value || !loaded || (!botId && !shared.includes(e.dataset.k)); });
  document.querySelectorAll('[data-a]:not([data-a=abort]),#envpick,#pick,#cmd,#ud').forEach(e => { e.disabled = value || !loaded || !botId; });
  document.querySelectorAll('#botselect,#addbot,#newbotform input,#newbotform button').forEach(e => { e.disabled = value || !loaded; });
  document.querySelectorAll('#removebot,#duplicatebot,#fleet button').forEach(e => { e.disabled = value || !loaded || !botId; });
  $('[data-k=entryFile]').disabled = value || !loaded || !bots.find(b => b.id === botId)?.managed;
  $('#refresh').disabled = value || !loaded || !botId || !cfg().host || !!statusCtl;
  $('#abort').disabled = !value || !ctl;
}

async function api(url, payload, options) {
  const response = await post(url, payload, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('The local panel returned an unreadable response. Restart it and try again.'); }
  if (!response.ok || data.error) { const error = new Error(data.error || 'Request failed'); error.output = data.output; throw error; }
  return data;
}

function targetInfo() {
  const c = cfg();
  $('#nm').textContent = botId ? c.name : 'No bots saved';
  $('#targetinfo').textContent = botId ? c.app + ' · ' + c.dir : 'Use Add bot to create a profile';
}

function renderBots() {
  $('#botselect').replaceChildren(...bots.map(bot => { const option = document.createElement('option'); option.value = bot.id; option.textContent = bot.name; return option; }));
  $('#botselect').value = botId;
  const counts = ui.fleetSummary(bots, fleetApps);
  $('#fleetcounts').textContent = `${counts.total} saved · ${counts.online} online · ${counts.offline} offline` + (counts.unknown ? ` · ${counts.unknown} unchecked` : '');
  const matches = bots.filter(bot => ui.matchesBot(bot, $('#botsearch').value));
  $('#fleet').replaceChildren(...matches.map(bot => {
    const button = document.createElement('button'), small = document.createElement('small'), dot = document.createElement('span');
    const app = fleetApps?.find(item => item.name === bot.app);
    button.type = 'button'; button.disabled = busy; button.setAttribute('aria-pressed', String(bot.id === botId));
    dot.className = 'status-dot ' + (!fleetApps ? '' : app?.status === 'online' ? 'online' : 'offline'); dot.setAttribute('aria-hidden', 'true');
    button.append(dot, document.createTextNode(bot.name));
    small.textContent = !fleetApps ? 'Not checked · ' + bot.app : app ? `${app.status} · ${Math.round(app.mem / 1048576)} MB` : 'Not started · ' + bot.app;
    button.append(small); button.onclick = () => selectBot(bot.id); return button;
  }));
  if (!matches.length) $('#fleet').textContent = bots.length ? 'No bots match your search.' : 'No saved bots. Use Add bot to create one.';
  if (!bots.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No bots saved'; $('#botselect').append(option); }
}

function clearMetrics() { metrics.forEach(([key]) => { $('#s-' + key).textContent = '-'; $('#s-' + key).className = ''; }); }
function applyConfig(c) {
  const nextConnection = JSON.stringify(shared.map(key => c[key] || ''));
  if (connection !== nextConnection) { fleetApps = null; connection = nextConnection; }
  botId = c.activeBotId; bots = c.bots;
  document.querySelectorAll('[data-k]').forEach(e => { e.value = c[e.dataset.k] ?? ''; });
  statusTarget = cfg();
  $('#ud').value = ''; $('#cmd').value = ''; $('#sub').textContent = botId ? 'Selected ' + c.name : 'Use Add bot to create a profile';
  $('#statusnote').textContent = c.host && botId ? 'Status not checked for this selection' : 'Set your server connection to check status';
  clearMetrics(); targetInfo(); renderBots(); setBusy(busy);
}

function checkStatusTarget() {
  const current = cfg();
  if (statusTarget && !ui.sameStatusTarget(statusTarget, current)) {
    statusCtl?.abort(); fleetApps = null; clearMetrics(); renderBots();
    $('#statusnote').textContent = 'Status not checked — connection or bot settings changed';
    $('#sub').textContent = 'Refresh status for the updated settings';
  }
  statusTarget = current; targetInfo(); setBusy(busy);
}

function settingsState(text, error = false) { $('#saved').textContent = text; $('#saved').classList.toggle('e', error); }
function save() {
  if (!loaded) return Promise.reject(new Error('Settings have not loaded yet. Use Retry first.'));
  const snapshot = cfg(); settingsState('Saving settings…');
  const task = saveQueue.catch(() => {}).then(async () => {
    const c = await api('/api/config', snapshot);
    if (botId === snapshot.botId) { bots = c.bots; renderBots(); targetInfo(); settingsState('Saved ' + new Date().toLocaleTimeString()); }
    return c;
  });
  saveQueue = task;
  task.catch(error => settingsState('Not saved — ' + error.message, true));
  return task;
}

function nearBottom() { return T.scrollHeight - T.scrollTop - T.clientHeight < 60; }
function outputCount() {
  const total = T.children.length, shown = [...T.children].filter(e => !e.hidden).length;
  $('#outputcount').textContent = `${shown}/${total} lines`;
  $('#outempty').hidden = shown > 0;
  $('#outempty').textContent = total ? 'No output matches these filters. Change your search or turn off Errors only.' : 'No output yet. Run an action to see progress and results here.';
  $('#cp').disabled = !total || copying;
  $('#sv').disabled = $('#cl').disabled = !total;
  $('#jump').hidden = !total || nearBottom();
}
function line(text, level) {
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  const follow = $('#outputfollow').checked && nearBottom(), element = document.createElement('div');
  element.className = level || ui.outputLevel(text); element.textContent = text || ' ';
  element.hidden = !ui.matchesOutput(text, $('#outputsearch').value, $('#outputerrors').checked);
  T.append(element); while (T.children.length > 5000) T.firstChild.remove();
  if (follow) T.scrollTop = T.scrollHeight;
  outputCount();
}
function put(text) { buf += text; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(text => line(text)); }
function flush() { if (buf) { line(buf); buf = ''; } }
function filterOutput() { [...T.children].forEach(e => { e.hidden = !ui.matchesOutput(e.textContent, $('#outputsearch').value, $('#outputerrors').checked); }); outputCount(); }
const fullOutput = () => [...T.children].map(e => e.textContent).join('\n');
$('#outputsearch').oninput = filterOutput; $('#outputerrors').onchange = filterOutput; T.onscroll = outputCount;
$('#jump').onclick = () => { $('#outputfollow').checked = true; T.scrollTop = T.scrollHeight; outputCount(); };
$('#outputfollow').onchange = () => { if ($('#outputfollow').checked) { T.scrollTop = T.scrollHeight; outputCount(); } };
$('#cl').onclick = () => { T.replaceChildren(); buf = ''; outputCount(); };
$('#cp').setAttribute('aria-live', 'polite');
$('#cp').onclick = async () => {
  if (copying || !T.children.length) return;
  clearTimeout(copyTimer); copying = true; $('#cp').textContent = 'Copying…'; outputCount();
  try {
    await navigator.clipboard.writeText(fullOutput());
    $('#cp').textContent = 'Copied!';
    copyTimer = setTimeout(() => { $('#cp').textContent = 'Copy all'; }, 2000);
  } catch (error) { $('#cp').textContent = 'Copy all'; line('✖ Could not copy output: ' + error.message); }
  finally { copying = false; outputCount(); }
};
$('#sv').onclick = () => { const link = document.createElement('a'), url = URL.createObjectURL(new Blob([fullOutput()], { type: 'text/plain' })); link.href = url; link.download = 'bot-output-' + Date.now() + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

function duration(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's'; }
function startActivity(label) {
  clearInterval(activityTimer); activity = { label, started: Date.now() };
  $('#activity').dataset.state = 'running'; $('#activitytext').textContent = label + ' · Running';
  const tick = () => { $('#activitytime').textContent = duration(Date.now() - activity.started); }; tick(); activityTimer = setInterval(tick, 1000);
}
function finishActivity(result) {
  clearInterval(activityTimer);
  const labels = { success: 'Completed', failed: 'Failed', unknown: 'Incomplete — check output', cancelled: 'Cancelled' };
  $('#activity').dataset.state = result.status;
  $('#activitytext').textContent = (activity?.label || 'Action') + ' · ' + labels[result.status] + (result.code ? ' (exit ' + result.code + ')' : '');
  if (activity) $('#activitytime').textContent = duration(Date.now() - activity.started);
}
function actionError(error) { const cancelled = error.name === 'AbortError'; put(cancelled ? '\n■ Cancelled\n' : '\n✖ ' + error.message + '\n'); return { status: cancelled ? 'cancelled' : 'failed', code: null }; }

async function selectBot(id) {
  if (busy || id === botId) return;
  setBusy(true); statusCtl?.abort();
  try { await save(); applyConfig(await api('/api/profiles', { action: 'select', id })); line('Selected ' + cfg().name, 'h'); }
  catch (error) { line('✖ ' + error.message); $('#botselect').value = botId; }
  finally { setBusy(false); }
  st();
}
$('#botselect').onchange = e => selectBot(e.target.value); $('#botsearch').oninput = renderBots;

async function showNewBot(duplicate) {
  if (busy) return;
  if (duplicate && !botId) return;
  setBusy(true); statusCtl?.abort();
  try {
    if (duplicate) await save();
    const source = duplicate ? bots.find(b => b.id === botId) : null;
    duplicateSourceId = source?.id || ''; $('#newbotform').reset(); $('#newerror').hidden = true;
    $('#newtitle').textContent = source ? 'Duplicate bot setup' : 'Add a bot';
    $('#newdescription').textContent = source ? 'Copy repository, branch, build and command settings into a separate bot profile.' : 'Give it a name to generate a separate folder, PM2 name, and launch configuration. Add a repository now or later.';
    $('#newnote').textContent = source ? 'Bot files, .env credentials and local upload paths are not copied. The new profile is saved without connecting to the VM. Prepare files and upload separate bot credentials when ready.' : "Preparation copies .env.example when available. Upload this bot's credentials before deploying. It won't start automatically.";
    $('#newsubmit').textContent = source ? 'Duplicate setup' : 'Create & prepare';
    if (source) { $('#newname').value = (source.name + ' copy').slice(0, 100); $('#newrepo').value = source.repo || ''; $('#newentry').value = source.entryFile || ''; }
    $('#newbot').showModal();
  } catch (error) { line('✖ ' + error.message); }
  finally { setBusy(false); if ($('#newbot').open) { $('#newname').focus(); $('#newname').select(); } }
}
$('#addbot').onclick = () => showNewBot(false); $('#duplicatebot').onclick = () => showNewBot(true);
$('#cancelnew').onclick = () => { if (!busy) $('#newbot').close(); }; $('#newbot').oncancel = e => { if (busy) e.preventDefault(); };
$('#newbotform').onsubmit = async e => {
  e.preventDefault(); if (busy) return;
  const duplicate = !!duplicateSourceId; let created = false;
  setBusy(true); statusCtl?.abort(); $('#newerror').hidden = true;
  try {
    await save();
    const c = await api('/api/profiles', { action: duplicate ? 'duplicate' : 'add', id: duplicateSourceId, name: $('#newname').value, repo: $('#newrepo').value, entryFile: $('#newentry').value });
    $('#botsearch').value = ''; applyConfig(c); $('#newbot').close(); created = true;
    line((duplicate ? 'Duplicated setup: ' : 'Created profile: ') + cfg().name + ' → ' + cfg().dir, 'h');
  } catch (error) { $('#newerror').textContent = error.message; $('#newerror').hidden = false; line('✖ ' + error.message); }
  finally { setBusy(false); }
  if (created && !duplicate && cfg().host) run('prepare', {});
  else if (created) line('Profile saved. Use Prepare bot files and upload this bot’s own credentials before deploying.', 'w');
};

function updateRemoval() {
  const mode = $('#removemode').value;
  $('#removefileswarning').hidden = mode !== 'delete';
  $('#removenote').textContent = mode === 'profile' ? 'This only forgets the bot in this panel. It can keep running on the server.' : mode === 'uninstall' ? 'Stops and removes this bot from PM2 and its saved startup list. Bot files stay on the server.' : 'Stops and removes this bot from PM2, then deletes its install folder. File deletion requires a bot subfolder inside the SSH user home.';
  $('#removesubmit').disabled = busy || $('#removeconfirm').value !== bots.find(b => b.id === botId)?.app || (mode === 'delete' && !$('#removefilesconfirm').checked);
}
$('#removebot').onclick = async () => {
  if (busy || !botId) return;
  setBusy(true); statusCtl?.abort();
  try {
    const c = await save(), bot = bots.find(b => b.id === botId); removalRevision = c.removalRevision;
    $('#removebotform').reset(); $('#removeerror').hidden = true;
    $('#removetarget').textContent = bot.name + ' · PM2: ' + bot.app + ' · Folder: ' + bot.dir;
    $('#removeconfirm').placeholder = bot.app; $('#removebotdialog').showModal();
  } catch (error) { line('✖ ' + error.message); }
  finally { setBusy(false); updateRemoval(); }
};
$('#removemode').onchange = updateRemoval; $('#removeconfirm').oninput = updateRemoval; $('#removefilesconfirm').onchange = updateRemoval;
$('#cancelremove').onclick = () => { if (!busy) $('#removebotdialog').close(); }; $('#removebotdialog').oncancel = e => { if (busy) e.preventDefault(); };
$('#removebotform').onsubmit = async e => {
  e.preventDefault(); if (busy) return;
  const name = cfg().name, payload = { action: 'remove', id: botId, revision: removalRevision, mode: $('#removemode').value, confirmation: $('#removeconfirm').value, deleteFilesConfirmed: $('#removefilesconfirm').checked };
  setBusy(true); statusCtl?.abort(); $('#removeerror').hidden = true; startActivity('Remove ' + name);
  document.querySelectorAll('#removebotform input,#removebotform select,#removebotform button').forEach(e => { e.disabled = true; });
  let result = { status: 'failed' };
  try { const c = await api('/api/profiles', payload); if (c.output) put(c.output); applyConfig(c); $('#removebotdialog').close(); line('✔ Removed profile: ' + name, 'o'); result = { status: 'success' }; }
  catch (error) { if (error.output) put(error.output); $('#removeerror').textContent = error.message; $('#removeerror').hidden = false; line('✖ ' + error.message); }
  finally { flush(); finishActivity(result); setBusy(false); document.querySelectorAll('#removebotform input,#removebotform select,#removebotform button').forEach(e => { e.disabled = false; }); updateRemoval(); }
  st();
};

async function run(action, params = {}) {
  if (busy || !loaded || !botId) return;
  const snapshot = cfg(), controller = new AbortController(); ctl = controller; statusCtl?.abort();
  const label = document.querySelector(`[data-a="${action}"]`)?.textContent || action;
  startActivity(label + ' · ' + snapshot.name); setBusy(true);
  line('▶ [' + snapshot.name + '] ' + label + (params.cmd ? ': ' + params.cmd : '') + '   ' + new Date().toLocaleTimeString(), 'h');
  let result;
  try {
    await save(); if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    result = await ui.readActionResponse(await post('/api/run', { action, params, cfg: snapshot }, { signal: controller.signal }), put);
    if (result.status === 'unknown') put('\n⚠ The action ended without a completion result. Check the output before retrying.\n');
  } catch (error) { result = actionError(error); }
  finally { flush(); ctl = null; finishActivity(result); setBusy(false); }
  if (/^(start|stop|restart|deploy|code|setup|cmds|redeploy|solo)$/.test(action)) st();
}
document.addEventListener('click', e => {
  const button = e.target.closest('[data-a]'); if (!button) return;
  const action = button.dataset.a;
  if (action === 'abort') { ctl?.abort(); return; }
  if (busy || button.disabled) return;
  if (confirmations[action] && !confirm(confirmations[action])) return;
  const params = action === 'logs' || action === 'follow' ? { lines: $('#ll').value, filter: $('#lf').value, err: $('#le').checked } : action === 'custom' ? { cmd: $('#cmd').value } : {};
  run(action, params);
});
$('#cmd').onkeydown = e => { if (e.key === 'Enter') run('custom', { cmd: e.target.value }); };

const base = () => { const dir = cfg().dir.replace(/\/+$/, ''), target = $('#ud').value.trim().replace(/\/+$/, ''); return target ? target[0] === '/' ? target : dir + '/' + target : dir; };
async function upload(files, target) {
  if (busy || !loaded || !botId || !files.length) return;
  const snapshot = cfg(), controller = new AbortController(); ctl = controller; statusCtl?.abort();
  startActivity('Upload ' + files.length + (files.length === 1 ? ' file' : ' files') + ' · ' + snapshot.name); setBusy(true);
  let result = { status: 'success', code: 0 };
  try {
    await save();
    for (const file of files) {
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      line('▶ Upload ' + file.name, 'h');
      const response = await fetch('/api/upload', { method: 'POST', signal: controller.signal, body: file, headers: { 'X-Panel': '1', 'Content-Type': 'application/octet-stream', 'X-Cfg': encodeURIComponent(JSON.stringify(snapshot)), 'X-Target': encodeURIComponent(target(file)) } });
      result = await ui.readActionResponse(response, put); flush();
      if (result.status !== 'success') break;
    }
    if (result.status === 'unknown') put('\n⚠ Upload ended without a completion result. Check the destination before retrying.\n');
  } catch (error) { result = actionError(error); }
  finally { flush(); ctl = null; finishActivity(result); setBusy(false); }
}
$('#envpick').onclick = () => $('#envf').click();
$('#envf').onchange = e => { upload([...e.target.files], () => cfg().dir.replace(/\/+$/, '') + '/.env'); e.target.value = ''; };
$('#pick').onclick = () => $('#upf').click();
$('#upf').onchange = e => { upload([...e.target.files], file => base() + '/' + file.name); e.target.value = ''; };
const dropzone = $('#dz'); ['dragover', 'dragenter'].forEach(event => dropzone.addEventListener(event, () => dropzone.classList.add('on')));
['dragleave', 'drop'].forEach(event => dropzone.addEventListener(event, () => dropzone.classList.remove('on')));
dropzone.addEventListener('drop', e => upload([...e.dataTransfer.files], file => base() + '/' + file.name));
['dragover', 'drop'].forEach(event => addEventListener(event, e => e.preventDefault()));
document.addEventListener('input', e => { if (e.target.dataset.k) checkStatusTarget(); });
document.addEventListener('change', e => { if (e.target.dataset.k) { checkStatusTarget(); save().then(() => setBusy(busy)).catch(error => line('✖ Settings not saved: ' + error.message)); } });

const uptime = ms => { const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24); return days ? days + 'd ' + hours % 24 + 'h' : hours ? hours + 'h ' + minutes % 60 + 'm' : minutes + 'm'; };
async function st() {
  const c = cfg(); if (!loaded || !botId || !c.host || busy || statusCtl || document.querySelector('dialog[open]')) return;
  const controller = new AbortController(); statusCtl = controller; setBusy(busy);
  $('#statusnote').textContent = 'Checking status…';
  const timer = setTimeout(() => controller.abort('timeout'), 50000); let data;
  try { data = await api('/api/status', { cfg: c }, { signal: controller.signal }); }
  catch (error) {
    if (busy || (controller.signal.aborted && controller.signal.reason !== 'timeout')) return;
    data = { error: controller.signal.reason === 'timeout' ? 'Status check timed out. Use Test connection for details.' : error.message };
  } finally { clearTimeout(timer); if (statusCtl === controller) statusCtl = null; setBusy(busy); }
  if (busy || JSON.stringify(c) !== JSON.stringify(cfg())) return;
  const checked = new Date().toLocaleTimeString(); clearMetrics();
  if (data.error) { $('#s-state').textContent = 'Unreachable'; $('#s-state').className = 'e'; $('#sub').textContent = data.error; $('#statusnote').textContent = 'Last check failed · ' + checked; fleetApps = null; renderBots(); return; }
  fleetApps = data.apps || []; renderBots(); $('#statusnote').textContent = 'Last checked ' + checked;
  const app = data.app, set = (key, value, level = '') => { $('#s-' + key).textContent = value; $('#s-' + key).className = level; };
  $('#sub').textContent = c.user + '@' + c.host + ', ' + data.up;
  set('state', app ? app.status : 'Not started', app?.status === 'online' ? 'o' : 'w');
  set('up', app?.status === 'online' ? uptime(Date.now() - app.uptime) : '-'); set('mem', app ? Math.round(app.mem / 1048576) + ' MB' : '-');
  set('cpu', app ? app.cpu + '%' : '-'); set('rs', app ? app.restarts : '-'); set('load', data.load); set('ram', data.mem); set('disk', data.disk);
}
$('#refresh').onclick = st; $('#auto').onchange = () => { if ($('#auto').checked) st(); };
setInterval(() => { if ($('#auto').checked) st(); }, 30000);

async function loadConfig() {
  setBusy(true); $('#retryload').hidden = true; settingsState('Loading settings…');
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error('Could not load panel settings.');
    const c = await response.json(); if (!Array.isArray(c.bots)) throw new Error('Restart the panel terminal to load the latest version.');
    loaded = true; applyConfig(c); settingsState('Settings save automatically');
    line(c.host ? 'Ready. Select a bot or use Add bot to prepare another.' : 'Open Settings to enter your server connection, then use Test connection. Settings save automatically.', 'h');
  } catch (error) { loaded = false; $('#retryload').hidden = false; settingsState('Settings unavailable — retry when the local panel is running.', true); line('✖ ' + error.message); }
  finally { setBusy(false); }
  st();
}
$('#retryload').onclick = loadConfig;
outputCount(); loadConfig();
