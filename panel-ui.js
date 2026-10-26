(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PanelUI = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function matchesBot(bot, query) {
    const text = String(query || '').trim().toLowerCase();
    return !text || [bot.name, bot.app].some(value => String(value || '').toLowerCase().includes(text));
  }

  function fleetSummary(bots, apps) {
    const counts = { total: bots.length, online: 0, offline: 0, unknown: 0 };
    for (const bot of bots) {
      if (!apps) counts.unknown++;
      else if (apps.find(app => app.name === bot.app)?.status === 'online') counts.online++;
      else counts.offline++;
    }
    return counts;
  }

  function sameStatusTarget(before, after) {
    return ['host', 'port', 'user', 'key', 'app', 'botId'].every(key => (before[key] || '') === (after[key] || ''));
  }

  function outputLevel(text) {
    return /error|✖|fail|denied|fatal|ERR!|exception|timed out/i.test(text) ? 'e'
      : /warn|⚠/i.test(text) ? 'w'
      : /✔|success|online/i.test(text) ? 'o' : '';
  }

  function matchesOutput(text, query, errorsOnly) {
    return (!errorsOnly || outputLevel(text) === 'e') && String(text).toLowerCase().includes(String(query || '').trim().toLowerCase());
  }

  function preferences(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    if (['100', '200', '500', '1000', '3000'].includes(value.logLines)) result.logLines = value.logLines;
    for (const key of ['logErrorsOnly', 'outputErrorsOnly', 'autoRefresh']) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    return result;
  }

  async function readActionResponse(response, onText) {
    if (!response.ok) {
      let message = 'Request failed (HTTP ' + response.status + ').';
      try {
        const text = await response.text();
        if ((response.headers.get('content-type') || '').includes('application/json')) message = JSON.parse(text).error || message;
        else if (text.trim()) message = text.trim();
      } catch {}
      throw new Error(message);
    }
    if (!response.body) throw new Error('The panel returned no action output.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let tail = '';
    const emit = text => { if (text) { tail = (tail + text).slice(-8192); onText(text); } };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        emit(decoder.decode(value, { stream: true }));
      }
      emit(decoder.decode());
    } finally { reader.releaseLock(); }
    const last = tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim().split('\n').pop();
    if (last === '✔ Done') return { status: 'success', code: 0 };
    const failure = last.match(/^✖ Failed \(exit (\d+)\)$/);
    if (failure) return { status: 'failed', code: Number(failure[1]) };
    return { status: 'unknown', code: null };
  }

  return { matchesBot, fleetSummary, sameStatusTarget, outputLevel, matchesOutput, preferences, readActionResponse };
});
