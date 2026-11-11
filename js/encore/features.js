/* What songs sound like, measured in this browser.
   For each song: fetch JioSaavn's 12 kbps stream (~440 KB), decode it at
   11025 Hz, analyse it in a worker (dsp-worker.js), keep the result.

   - one analysis at a time, highest priority first (the song playing now,
     then the likeliest next songs)
   - a daily budget, and nothing at all on Save-Data or 2G connections
   - results cached in localStorage (least recently used dropped first)
   - a song that fails is not retried for a day

   EncoreFeatures.request(track, priority) → Promise<raw | null>
   EncoreFeatures.get(id) / describe(id)   → cached raw / descriptors
   EncoreFeatures.onReady(fn)              → fn(id) after each analysis */
(function () {
  'use strict';

  var KEY = 'encore.feat.v1', BUDGET_KEY = 'encore.featBudget.v1';
  var MAX = 900, DAILY = 80, SR = 11025;
  var DSP = window.EncoreDSP;

  var cache = load(), desc = {}, failed = {}, queue = [], inflight = {}, busy = false;
  var worker = null, seq = 0, waiting = {}, ready = [], saveTimer = 0;

  function load() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var ids = Object.keys(cache);
      if (ids.length > MAX) {
        ids.sort(function (a, b) { return cache[a][0] - cache[b][0]; });
        ids.slice(0, ids.length - MAX).forEach(function (id) { delete cache[id]; delete desc[id]; });
      }
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {
        // storage full: drop the oldest half and try once more
        ids = Object.keys(cache).sort(function (a, b) { return cache[a][0] - cache[b][0]; });
        ids.slice(0, ids.length >> 1).forEach(function (id) { delete cache[id]; delete desc[id]; });
        try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e2) { /* give up quietly */ }
      }
    }, 800);
  }

  function lowUrl(t) {
    return t && t.src ? String(t.src).replace(/_(\d+)\.mp4(\?.*)?$/, '_12.mp4$2') : '';
  }

  function allowed() {
    var c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return false;
    if (!window.Worker || !(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return false;
    var today = new Date().toDateString(), b;
    try { b = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null'); } catch (e) { b = null; }
    return !b || b.day !== today || b.n < DAILY;
  }

  function spend() {
    var today = new Date().toDateString(), b;
    try { b = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null'); } catch (e) { b = null; }
    if (!b || b.day !== today) b = { day: today, n: 0 };
    b.n++;
    try { localStorage.setItem(BUDGET_KEY, JSON.stringify(b)); } catch (e) { /* ignore */ }
  }

  function getWorker() {
    if (worker) return worker;
    worker = new Worker('js/encore/dsp-worker.js');
    worker.onmessage = function (e) {
      var w = waiting[e.data.id];
      delete waiting[e.data.id];
      if (w) { if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.raw); }
    };
    worker.onerror = function () {
      Object.keys(waiting).forEach(function (k) { waiting[k].reject(new Error('worker failed')); delete waiting[k]; });
    };
    return worker;
  }

  // Decode at 11025 Hz when the browser allows it, else at a common rate (the DSP resamples).
  function decode(buf) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext, ctx = null;
    [SR, 22050, 44100].some(function (rate) {
      try { ctx = new OAC(1, rate, rate); return true; } catch (e) { return false; }
    });
    if (!ctx) return Promise.reject(new Error('no audio context'));
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(buf, resolve, reject);            // old Safari: callbacks only
      if (p && p.then) p.then(resolve, reject);
    }).then(function (ab) {
      var n = ab.length, x = new Float32Array(n), ch = ab.numberOfChannels;
      for (var c = 0; c < ch; c++) {
        var d = ab.getChannelData(c);
        for (var i = 0; i < n; i++) x[i] += d[i] / ch;
      }
      return { samples: x, sr: ab.sampleRate };
    });
  }

  function analyse(t) {
    var url = lowUrl(t);
    if (!url) return Promise.reject(new Error('no stream'));
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 20000);
    return fetch(url, { signal: ctl.signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .finally(function () { clearTimeout(timer); })
      .then(decode)
      .then(function (d) {
        var id = ++seq;
        return new Promise(function (resolve, reject) {
          waiting[id] = { resolve: resolve, reject: reject };
          getWorker().postMessage({ id: id, samples: d.samples, sr: d.sr }, [d.samples.buffer]);
        });
      });
  }

  function pump() {
    if (busy || !queue.length) return;
    if (!allowed()) { queue.forEach(function (j) { j.resolve(null); }); queue = []; return; }
    queue.sort(function (a, b) { return b.prio - a.prio; });
    var job = queue.shift();
    busy = true;
    spend();
    analyse(job.t).then(function (raw) {
      cache[job.t.id] = [Date.now(), raw];
      delete desc[job.t.id];
      save();
      job.resolve(raw);
      ready.forEach(function (fn) { try { fn(job.t.id); } catch (e) { /* listener error */ } });
    }, function () {
      failed[job.t.id] = Date.now();
      job.resolve(null);
    }).then(function () {
      delete inflight[job.t.id];
      busy = false;
      setTimeout(pump, 50);
    });
  }

  function request(t, prio) {
    if (!t || !t.id || !t.src) return Promise.resolve(null);
    var c = cache[t.id];
    if (c) { c[0] = Date.now(); save(); return Promise.resolve(c[1]); }
    if (failed[t.id] && Date.now() - failed[t.id] < 864e5) return Promise.resolve(null);
    var job = inflight[t.id];
    if (job) { job.prio = Math.max(job.prio, prio || 0); return job.promise; }
    job = { t: t, prio: prio || 0 };
    job.promise = new Promise(function (resolve) { job.resolve = resolve; });
    inflight[t.id] = job;
    queue.push(job);
    setTimeout(pump, 0);
    return job.promise;
  }

  // drop queued work that is no longer wanted (a new song started, say)
  function cancelBelow(prio) {
    queue = queue.filter(function (j) {
      if (j.prio >= prio) return true;
      delete inflight[j.t.id];
      j.resolve(null);
      return false;
    });
  }

  function get(id) { var c = cache[id]; return c ? c[1] : null; }

  function describe(id) {
    if (desc[id] !== undefined) return desc[id];
    var raw = get(id);
    return (desc[id] = raw ? DSP.describe(raw) : null);
  }

  window.EncoreFeatures = {
    request: request, get: get, describe: describe, cancelBelow: cancelBelow,
    onReady: function (fn) { ready.push(fn); },
    count: function () { return Object.keys(cache).length; },
    all: function () { return cache; },
    clear: function () { cache = {}; desc = {}; try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    lowUrl: lowUrl
  };
})();
