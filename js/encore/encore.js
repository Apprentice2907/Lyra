/* Encore: picks the next song and learns from every play.

   Loop for each song that starts:
   1. signals.js opens a play record; we compute its feature vector x from
      the state at that moment (previous song, session, time, profile).
   2. ~2.5 s in, we gather candidates from six sources (this artist, this
      album, your top artists, your familiar songs, a playlist that fits the
      moment, a popular pool), filter them, and rank them with one Thompson
      draw of the model (model.js). The best becomes "Up next".
   3. The shortlist's audio is analysed in the background (features.js);
      each result re-ranks with the same draw, so the pick only changes for
      a reason (new information), never by chance.
   4. When the play ends: reward (profile.js) → profile update → model
      update with x. The next decision already uses what was learned.

   Encore.init(ctx) → api used by app.js and ui.js:
     note(reason, src)  peek()  next()  previous()  notThis()
     settings  insights()  why()  forNow(n)  on(fn)  exportData()  reset() */
(function () {
  'use strict';

  var P = window.EncoreProfile, M = window.EncoreModel, F = window.EncoreFeatures, DSP = window.EncoreDSP;
  var KEYS = { profile: 'encore.profile.v1', model: 'encore.model.v1', settings: 'encore.settings.v1' };
  var BUILD_DELAY = 2500, SHORTLIST = 10, MAX_CANDS = 90;
  // safe exploration: a pick is never more than this below the best expected reward
  // (0.1 gave the best first and fourth week on the simulator)
  var MARGIN = 0.1;

  function readJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function shuffle(a, r) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]); }
  function round4(v) { return Math.round(v * 1e4) / 1e4; }

  // a playable copy of a track for the song memory (familiar candidates)
  function slim(t) {
    return { id: t.id, sid: t.sid, title: t.title, artist: t.artist, album: t.album, albumId: t.albumId, duration: t.duration,
      art: t.art, artSmall: t.artSmall, src: t.src, language: t.language, artistIds: t.artistIds, year: t.year, playCount: t.playCount, explicit: t.explicit };
  }

  /* ───────────── API cache ───────────── */

  // failures are cached too (for a shorter while), so a broken endpoint is not
  // retried for every song
  var apiCache = {}, FAIL_TTL = 20 * 60e3;
  function cached(key, ttl, fn) {
    var c = apiCache[key], now = Date.now();
    if (c && now - c.t < (c.failed ? FAIL_TTL : ttl)) return c.p;
    var entry = { t: now };
    entry.p = fn().catch(function (e) { entry.failed = true; throw e; });
    entry.p.catch(function () { /* handled by callers */ });
    apiCache[key] = entry;
    return entry.p;
  }
  var MIN = 60e3;

  function Encore(ctx) {
    var self = this;
    this.engine = ctx.engine;
    this.saved = ctx.saved;
    this.cfg = window.VINYL_CONFIG || {};
    this.api = window.MusicAPI;
    this.subs = [];
    var now = Date.now();

    var prof = readJSON(KEYS.profile, null);
    this.prof = prof && prof.v === P.VERSION ? prof : P.create(now);
    var model = readJSON(KEYS.model, null);
    this.model = M.valid(model) ? model : M.create();
    this.settings = readJSON(KEYS.settings, null) || { smart: true, mode: 'auto' };

    this.history = [];          // tracks heard this session, oldest first
    this.forward = [];          // tracks we stepped back from
    this.session = { ids: [], artists: [], skips: [], valence: null, energy: null, titles: [] };
    this.decision = null;       // the current ranking: { gen, w, cands, list, mu, cur }
    this.up = null;             // { t, item, reasons, prop, rank, n, exploring }
    this.gen = 0;
    this.unplayable = {};
    this.lastLearn = null;

    this.signals = new window.EncoreSignals(this.engine, {
      saved: this.saved,
      onStart: function (rec, t) { self._onStart(rec, t); },
      onEnd: function (rec, live) { self._onEnd(rec, live); },
      onUnplayable: function (t) { if (t) self.unplayable[t.id] = Date.now(); }
    });
    this._restoreSession();

    F.onReady(function (id) { self._onFeatures(id); });
    this.saved.on(function () { self._emit('library'); });
  }

  Encore.prototype.on = function (fn) { this.subs.push(fn); };
  Encore.prototype._emit = function (kind) { for (var i = 0; i < this.subs.length; i++) this.subs[i](kind, this); };

  Encore.prototype._save = function () {
    var self = this;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () {
      writeJSON(KEYS.profile, self.prof);
      writeJSON(KEYS.model, M.serialize(self.model));
    }, 400);
  };

  Encore.prototype.setSetting = function (k, v) {
    this.settings[k] = v;
    writeJSON(KEYS.settings, this.settings);
    if (k === 'mode' && this.decision) this._rerank();
    this._emit('settings');
  };

  // continue a session after a reload (the signals keep the session id)
  Encore.prototype._restoreSession = function () {
    var s = this.signals.session();
    if (!s || Date.now() - (s.last || 0) > 30 * MIN) return;
    var self = this;
    s.ids.slice(-20).forEach(function (id) {
      var sm = self.prof.songs[id];
      if (sm && sm.m) { self.history.push(sm.m); self.session.ids.push(id); self.session.titles.push(P.titleKey(sm.m.title)); }
    });
  };

  /* ───────────── state ───────────── */

  Encore.prototype._inPlaylistFn = function () {
    var set = {};
    this.saved.playlists().forEach(function (p) { p.tracks.forEach(function (t) { set[t.id] = true; }); });
    return function (id) { return !!set[id]; };
  };

  Encore.prototype._state = function (cur, curFeat, at) {
    var saved = this.saved;
    return {
      ctx: P.context(at || Date.now()), prof: this.prof, cur: cur, curFeat: curFeat,
      session: this.session, liked: function (id) { return saved.has(id); }, inPlaylist: this._inPlaylistFn(),
      mode: this.settings.mode
    };
  };

  /* ───────────── a play starts ───────────── */

  Encore.prototype._onStart = function (rec, t) {
    var self = this;
    if (rec.demo) return;
    // the song before this one in the session, and what we knew then
    var prev = this.history.length ? this.history[this.history.length - 1] : null;
    if (prev && prev.id === t.id) prev = this.history.length > 1 ? this.history[this.history.length - 2] : null;
    var state = this._state(prev, prev ? F.describe(prev.id) : null, rec.ctx.t);
    var src = this.up && this.up.t.id === t.id ? this.up.item.cand.src : null;
    var cand = { t: t, feat: F.describe(t.id), src: src, chosen: rec.how === 'pick' ? 1 : 0 };
    rec.x = Array.prototype.map.call(M.featurize(state, cand), round4);
    rec._snap = { state: state, cand: cand };              // to refresh x if audio arrives before the end

    if (this.up && this.up.t.id === t.id && (rec.how === 'next' || rec.how === 'auto')) {
      rec.how = 'encore';
      rec.rec = { prop: this.up.prop, rank: this.up.rank, n: this.up.n, src: src, mean: round4(this.up.item.mean), explore: this.up.exploring, lam: round4(this.up.lam || 0) };
    }

    if (rec.how === 'pick') this.forward = [];
    if (rec.how !== 'prev') this.history.push(t);
    if (this.history.length > 60) this.history.shift();
    var ses = this.session;
    ses.ids.push(t.id); ses.artists.push(P.lc(String(t.artist || '').split(/\s*,\s*/)[0]));
    ses.titles.push(P.titleKey(t.title));
    ['ids', 'artists', 'titles'].forEach(function (k) { if (ses[k].length > 40) ses[k].shift(); });
    if (rec.pos === 0) { ses.skips = []; ses.valence = null; ses.energy = null; }

    // analyse this song first; drop queued work for the last song's shortlist
    F.cancelBelow(9);
    F.request(t, 10);

    this.up = null;
    if (this.decision) this.prevDecision = this.decision;   // fallback while the new pick is being made
    this.decision = null;
    this._emit('up');
    var gen = ++this.gen;
    clearTimeout(this._buildTimer);
    this._buildTimer = setTimeout(function () {
      if (gen === self.gen && self.engine.track && self.engine.track.id === t.id) self._build(gen);
    }, BUILD_DELAY);
  };

  /* ───────────── a play ends: learn ───────────── */

  Encore.prototype._onEnd = function (rec, live) {
    if (rec.demo || !rec.tid) return;
    var rw = P.reward(rec, this.prof);
    rec.reward = rw.r;
    if (rw.neutral) { this.unplayable[rec.tid] = Date.now(); return; }
    var feat = F.describe(rec.tid);
    var prevId = this.session.ids.length > 1 ? this.session.ids[this.session.ids.length - 2] : null;
    var prevFeat = prevId && prevId !== rec.tid ? F.describe(prevId) : null;
    var t = live && live._t ? live._t : (this.prof.songs[rec.tid] && this.prof.songs[rec.tid].m);
    P.update(this.prof, rec, rw, feat, prevFeat, t && t.src ? slim(t) : null);

    // what the model saw when the song started, refreshed with any audio analysed since
    var x = rec.x;
    var snap = live && live._snap;
    if (snap) {
      snap.cand.feat = feat || snap.cand.feat;
      if (snap.state.cur && !snap.state.curFeat) snap.state.curFeat = F.describe(snap.state.cur.id);
      x = M.featurize(snap.state, snap.cand);
    }
    if (x && x.length === M.D) {
      // explicit picks and playlist order are the listener's choice, not ours: learn from them more gently
      var w = rec.how === 'pick' ? 0.5 : (rec.how === 'auto' && (rec.src === 'playlist' || rec.src === 'saved')) ? 0.7 : 1;
      M.update(this.model, x, rw.r, w);
      // artist pacing: how often this listener stays with an artist, and how often Encore just did
      if (rec.pos > 0 && !rec.replay && (rec.how === 'pick' || rec.how === 'encore')) M.pace(this.model, x[M.IDX.sameArtist] > 0, rec.how === 'pick');
    }
    this.lastLearn = { title: rec.title, r: rw.r, parts: rw.parts, at: Date.now() };

    var ses = this.session;
    ses.skips.push(rw.skip ? 1 : 0);
    if (ses.skips.length > 10) ses.skips.shift();
    if (feat && !rw.skip) {
      ses.valence = ses.valence == null ? feat.valence : ses.valence * 0.6 + feat.valence * 0.4;
      ses.energy = ses.energy == null ? feat.energy : ses.energy * 0.6 + feat.energy * 0.4;
    }
    this._save();
    this._emit('learned');
  };

  /* ───────────── candidates ───────────── */

  Encore.prototype._topArtists = function (n, exclude) {
    var prof = this.prof;
    return Object.keys(prof.artists).filter(function (a) {
      return prof.artists[a].id && exclude.indexOf(a) < 0 && P.affinity(prof.artists[a]) > 0.2;
    }).sort(function (a, b) { return P.affinity(prof.artists[b]) - P.affinity(prof.artists[a]); })
      .slice(0, n).map(function (a) { return { name: a, id: prof.artists[a].id }; });
  };

  Encore.prototype._familiar = function (n) {
    var prof = this.prof, out = [], seen = {};
    function add(t) { if (t && t.src && !seen[t.id]) { seen[t.id] = true; out.push(t); } }
    this.saved.list().forEach(add);
    this.saved.playlists().forEach(function (p) { p.tracks.forEach(add); });
    Object.keys(prof.songs).forEach(function (id) {
      var s = prof.songs[id];
      if (s.m && P.affinity(s) > 0.3) add(s.m);
    });
    return shuffle(out, Math.random).slice(0, n);
  };

  // a playlist search that fits the moment: language + time of day + session mood
  Encore.prototype._contextQuery = function (cur) {
    var ctx = P.context(Date.now()), ses = this.session, prof = this.prof;
    var lang = cur && cur.language;
    if (!lang) {
      lang = Object.keys(prof.langs).sort(function (a, b) { return (prof.langs[b].n || 0) - (prof.langs[a].n || 0); })[0] || 'hindi';
    }
    var v = ses.valence, e = ses.energy, word;
    if (e != null && e > 0.68) word = ctx.block === 1 ? 'workout' : 'party';
    else if (ctx.block === 0 || ctx.block === 4) word = v != null && v < 0.38 ? 'sad' : 'late night';
    else if (ctx.block === 1) word = 'morning';
    else if (v != null && v < 0.38) word = 'sad';
    else if (ctx.block === 3) word = 'romantic';
    else word = 'chill';
    return lang + ' ' + word + ' songs';
  };

  Encore.prototype._sources = function (cur) {
    var api = this.api, self = this, jobs = [];
    function tag(src) { return function (list) { return (list || []).map(function (t) { return { t: t, src: src }; }); }; }
    function job(p) { jobs.push(withTimeout(p, 8000).catch(function () { return []; })); }

    var curArtists = cur ? P.songArtists(cur) : [];
    if (cur && cur.artistIds && cur.artistIds[0]) {
      var aid = cur.artistIds[0];
      job(cached('a:' + aid, 30 * MIN, function () { return api.artistSongs(aid); }).then(tag('artist')));
      job(cached('ai:' + aid, 360 * MIN, function () { return api.artist(aid); }).then(function (info) {
        var sim = (info.similar || []).slice(0, 2);
        return Promise.all(sim.map(function (s) {
          return cached('a:' + s.id, 30 * MIN, function () { return api.artistSongs(s.id); }).catch(function () { return []; });
        })).then(function (g) { return tag('taste')([].concat.apply([], g).slice(0, 12)); });
      }));
    }
    if (cur && cur.albumId) {
      job(cached('al:' + cur.albumId, 60 * MIN, function () { return api.album(cur.albumId); }).then(tag('album')));
    }
    this._topArtists(3, curArtists).forEach(function (a) {
      job(cached('a:' + a.id, 30 * MIN, function () { return api.artistSongs(a.id); }).then(tag('taste')));
    });
    jobs.push(Promise.resolve(tag('familiar')(this._familiar(20))));
    var q = this._contextQuery(cur);
    job(cached('pq:' + q, 360 * MIN, function () { return api.searchPlaylists(q, 3); }).then(function (pls) {
      var pl = (pls || []).filter(function (p) { return p.count >= 8; })[0];
      if (!pl) return [];
      return cached('pl:' + pl.id, 60 * MIN, function () { return api.playlist(pl.id, 40); })
        .then(function (list) { return tag('context')(shuffle(list.slice(), Math.random).slice(0, 20)); });
    }));
    var pool = (this.cfg.explorePool || []);
    if (pool.length) {
      var pid = pool[Math.floor(Math.random() * pool.length)];
      job(cached('pl:' + pid, 60 * MIN, function () { return api.playlist(pid, 40); })
        .then(function (list) { return tag('explore')(shuffle(list.slice(), Math.random).slice(0, 12)); }));
    }
    return Promise.all(jobs).then(function (groups) { return self._filter([].concat.apply([], groups), cur); });
  };

  Encore.prototype._filter = function (cands, cur) {
    var prof = this.prof, ses = this.session, now = Date.now(), seen = {}, out = [], self = this;
    var recentIds = ses.ids.slice(-20), recentTitles = ses.titles.slice(-20);
    if (cur) { recentIds.push(cur.id); recentTitles.push(P.titleKey(cur.title)); }
    cands.forEach(function (c) {
      var t = c.t;
      if (!t || !t.src || !t.id || seen[t.id]) return;
      if (recentIds.indexOf(t.id) >= 0 || recentTitles.indexOf(P.titleKey(t.title)) >= 0) return;
      if (self.unplayable[t.id] && now - self.unplayable[t.id] < 864e5) return;
      var sm = prof.songs[t.id];
      // skipped fast twice lately (and not liked): rest it for a while
      if (sm && sm.quick && !self.saved.has(t.id) && sm.quick * Math.pow(0.5, (now - (sm.qt || now)) / (7 * P.DAY)) >= 1.5) return;
      seen[t.id] = true;
      out.push(c);
    });
    // keep the pool varied: at most 12 songs per source
    var per = {};
    return out.filter(function (c) { per[c.src] = (per[c.src] || 0) + 1; return per[c.src] <= 12 || c.src === 'familiar'; }).slice(0, MAX_CANDS);
  };

  /* ───────────── deciding ───────────── */

  Encore.prototype._build = function (gen) {
    var self = this, cur = this.engine.track;
    if (!cur || cur.music) return;
    this._sources(cur).then(function (cands) {
      if (gen !== self.gen || !cands.length) return;
      cands.forEach(function (c) { c.feat = F.describe(c.t.id); });
      var res = M.rank(self.model, self._state(cur, F.describe(cur.id)), cands, { margin: MARGIN });
      self.decision = { gen: gen, w: res.w, cands: cands, list: res.list, mu: res.mu, cur: cur };
      self._setUp(res);
      // analyse the shortlist so the final pick can use how they sound
      res.list.slice(0, SHORTLIST).forEach(function (it, i) { F.request(it.cand.t, 5 - i * 0.1); });
    });
  };

  Encore.prototype._rerank = function () {
    var d = this.decision;
    if (!d || d.gen !== this.gen) return;
    var cur = d.cur;
    d.cands.forEach(function (c) { c.feat = F.describe(c.t.id); c.x = null; });
    var res = M.rank(this.model, this._state(cur, F.describe(cur.id)), d.cands, { w: d.w, margin: MARGIN });
    d.list = res.list;
    d.mu = res.mu;
    this._setUp(res);
  };

  Encore.prototype._onFeatures = function (id) {
    var d = this.decision;
    if (!d) return;
    if (id === d.cur.id || d.cands.some(function (c) { return c.t.id === id; })) {
      clearTimeout(this._rerankTimer);
      var self = this;
      this._rerankTimer = setTimeout(function () { self._rerank(); }, 250);
    }
  };

  Encore.prototype._setUp = function (res) {
    var top = res.list[0];
    if (!top) { this.up = null; this._emit('up'); return; }
    // did it win on what we know, or on the random draw? (rank by expected reward)
    var byMean = res.list.slice().sort(function (a, b) { return b.mean - a.mean; });
    var meanRank = byMean.indexOf(top);
    // exploring = picked although clearly below the best guess (near-ties are not exploration);
    // the best guess counts the artist-pacing penalty, so a change of artist isn't called exploring
    var best = Math.max.apply(null, res.list.map(function (it) { return it.mean - (it.pen || 0); }));
    var exploring = best - (top.mean - (top.pen || 0)) > 0.05;
    var reasons = M.explain(top, res.mu, P.context(Date.now()), exploring);
    // pacing chose another artist over a song by this one that scored higher
    if (!top.pen && byMean[0].pen && byMean[0].mean - top.mean > 0.05) reasons.unshift('A change of artist');
    this.up = {
      t: top.cand.t, item: top, prop: top.prop, rank: meanRank, n: res.list.length, exploring: exploring,
      reasons: reasons, feat: top.cand.feat, lam: res.lam
    };
    this._emit('up');
  };

  /* ───────────── what the app calls ───────────── */

  Encore.prototype.note = function (reason, src) { this.signals.note(reason, src); };

  /* Before this song's pick is ready (the first seconds, or a slow network):
     the best song from the previous decision that hasn't been played yet. */
  Encore.prototype._fallback = function () {
    var d = this.prevDecision, ids = this.session.ids, cur = this.engine.track;
    if (!d) return null;
    for (var i = 0; i < d.list.length; i++) {
      var t = d.list[i].cand.t;
      if (ids.indexOf(t.id) < 0 && (!cur || t.id !== cur.id)) return t;
    }
    return null;
  };

  // what next() would return, without consuming it
  Encore.prototype.peek = function () {
    if (this.forward.length) return { t: this.forward[this.forward.length - 1], back: true };
    if (this.up) return { t: this.up.t, up: this.up };
    var fb = this._fallback();
    return fb ? { t: fb, fallback: true } : null;
  };

  Encore.prototype.next = function () {
    if (this.forward.length) return this.forward.pop();
    if (this.up) return this.up.t;
    var d = this.decision;
    if (d && d.list[0]) return d.list[0].cand.t;
    return this._fallback();
  };

  Encore.prototype.previous = function () {
    var cur = this.engine.track, h = this.history;
    var i = h.length - 1;
    while (i >= 0 && cur && h[i].id === cur.id) i--;
    if (i < 0) return null;
    if (cur) this.forward.push(cur);
    var t = h[i];
    this.history = h.slice(0, i + 1);
    return t;
  };

  // "Not this one": a clear no for the suggestion, without having to play it
  Encore.prototype.notThis = function () {
    var up = this.up, d = this.decision;
    if (!up || !d) return;
    M.update(this.model, up.item.x, -1, 1);
    var sm = this.prof.songs[up.t.id] || (this.prof.songs[up.t.id] = {});
    sm.quick = (sm.quick || 0) + 1;
    sm.qt = Date.now();
    d.cands = d.cands.filter(function (c) { return c.t.id !== up.t.id; });
    this._save();
    this._rerank();
  };

  Encore.prototype.insights = function () { return P.insights(this.prof, Date.now()); };

  Encore.prototype.stats = function () {
    return { plays: this.prof.n, analysed: F.count(), updates: this.model.n, sessions: this.prof.sessions.n };
  };

  // the features that moved furthest from the prior: what Encore learned about weighting
  Encore.prototype.learnedWeights = function (n) { return M.weights(this.model).slice(0, n || 6); };

  /* Songs for right now, without a current song (the Explore wheel):
     your familiar songs, your artists, a playlist for the moment, and a
     popular pool, ranked by the same model, at most two per artist. */
  Encore.prototype.forNow = function (n) {
    var self = this;
    if (this.prof.n < 5) return Promise.reject(new Error('not enough history yet'));
    return this._sources(null).then(function (cands) {
      if (cands.length < 8) throw new Error('too few candidates');
      cands.forEach(function (c) { c.feat = F.describe(c.t.id); });
      var res = M.rank(self.model, self._state(null, null), cands, { draws: 0, margin: 0.25 });
      var per = {}, out = [];
      res.list.forEach(function (it) {
        var a = P.lc(String(it.cand.t.artist || '').split(/\s*,\s*/)[0]);
        if ((per[a] = (per[a] || 0) + 1) <= 2 && out.length < n) out.push(it.cand.t);
      });
      return { mode: 'encore', tracks: out };
    });
  };

  // everything Encore knows, as one JSON file (for the research notebooks)
  Encore.prototype.exportData = function () {
    return {
      exported: new Date().toISOString(), version: { profile: P.VERSION, model: M.VERSION, dsp: DSP.VERSION },
      features: M.FEATURES.map(function (f) { return f[0]; }),
      plays: this.signals.log(), profile: this.prof, model: { weights: M.weights(this.model), n: this.model.n },
      audio: F.all()
    };
  };

  Encore.prototype.reset = function () {
    this.prof = P.create(Date.now());
    this.model = M.create();
    this.history = [];
    this.forward = [];
    this.session = { ids: [], artists: [], skips: [], valence: null, energy: null, titles: [] };
    this.signals.clear();
    localStorage.removeItem(KEYS.profile);
    localStorage.removeItem(KEYS.model);
    this.up = null;
    this.decision = null;
    this.prevDecision = null;
    this._emit('reset');
  };

  // Encore.instance is handy in the console: Encore.instance.decision, .up, .prof, .insights()
  window.Encore = { init: function (ctx) { return (window.Encore.instance = new Encore(ctx)); } };
})();
