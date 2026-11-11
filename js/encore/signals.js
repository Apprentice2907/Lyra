/* Encore signals: watches the player and writes one detailed record per play
   (the record format is documented in profile.js).

   How things are measured:
   - heard: from position deltas every 500 ms, so buffering stalls and seeks
     never count as listening
   - seeks: a jump the clock can't explain; back to the start from > 8 s in
     is a restart (a loop), a jump forward in the first 30 s is "skipping the
     intro"
   - pauses: count and length; paused for 20 min ends the play as 'idle'
   - likes / playlist adds made while the song is on belong to that play
   - bgSec: seconds heard while the app was in the background
   - sessions: a new one after 30 min without music; survives a reload
   - closing the page saves the open play; the next visit finishes it as
     'close' so nothing is lost when a phone kills the app

   new EncoreSignals(engine, { saved, onStart(rec, track), onEnd(rec), onUnplayable(track) })
   .note(reason, src)   call right before engine.load():
                        reason 'pick' | 'next' | 'prev' | 'auto'  (why the new song starts)
   .log()               recent finished plays (newest last) */
(function () {
  'use strict';

  var P = window.EncoreProfile;
  var TICK = 500, IDLE = 20 * 60e3, GAP = 30 * 60e3;
  var KEYS = { log: 'encore.plays.v1', open: 'encore.open.v1', sess: 'encore.session.v1' };
  var LOG_MAX = 1200, X_KEEP = 300;

  function readJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or private mode */ } }
  function r2(v) { return Math.round(v * 100) / 100; }

  function Signals(engine, opts) {
    var self = this;
    this.engine = engine;
    this.saved = opts.saved;
    this.opts = opts;
    this.rec = null;            // the play in progress (started = audio actually played)
    this.next = null;           // the note for the upcoming load
    this.sess = readJSON(KEYS.sess, null);
    this._log = readJSON(KEYS.log, []);
    this.lastPos = 0;
    this.lastTick = 0;

    // a play left open by a closed tab or a killed app: finish it now
    var open = readJSON(KEYS.open, null);
    localStorage.removeItem(KEYS.open);
    if (open && open.tid) { open.end = 'close'; setTimeout(function () { self._finish(open); }, 0); }

    engine.on('track', function () { self._onTrack(); });
    engine.on('state', function () { self._onState(); });
    // The app's own 'ended' handler may run first and load the next song; then
    // the play that ended was already closed in _onTrack, and the one current now
    // is the new song at 0 s. Only end a play that is really at its end.
    engine.on('ended', function () {
      var d = engine.duration();
      if (!d || engine.position() >= d - 1.5) self._end('ended');
    });
    engine.on('error', function () { self._onError(); });
    engine.on('volume', function () { self._onVolume(); });
    this.saved.on(function (kind) { self._onLibrary(kind); });

    setInterval(function () { self._tick(); }, TICK);
    document.addEventListener('visibilitychange', function () { self._tick(); if (document.hidden) self._persistOpen(); });
    window.addEventListener('pagehide', function () { self._tick(); self._persistOpen(); });
  }

  Signals.prototype.note = function (reason, src) { this.next = { reason: reason || 'pick', src: src || null }; };

  Signals.prototype.current = function () { return this.rec && this.rec.started ? this.rec : null; };
  Signals.prototype.session = function () { return this.sess; };
  Signals.prototype.log = function () { return this._log; };

  function inAnyPlaylist(saved, id) {
    return saved.playlists().some(function (p) { return p.tracks.some(function (x) { return x.id === id; }); });
  }

  // a new song was loaded: the old one ends for the reason given in note()
  Signals.prototype._onTrack = function () {
    var note = this.next || { reason: 'pick', src: null };
    this.next = null;
    if (this.rec && this.rec.started && !this.rec.end) {
      // the player has already switched tracks: no position reading now (it would
      // read the new song's 0 s as a jump back, i.e. a fake restart)
      this._end(note.reason === 'auto' ? 'ended' : note.reason === 'prev' ? 'prev' : note.reason === 'next' ? 'next' : 'pick', true);
    }
    var t = this.engine.track;
    this.rec = t ? { _t: t, how: note.reason, src: note.src, started: false } : null;
  };

  Signals.prototype._onState = function () {
    var rec = this.rec, now = Date.now();
    if (!rec || rec.end) return;
    if (this.engine.playing) {
      if (!rec.started) this._start(rec, now);
      if (rec._pauseAt) { rec.pauseSec += (now - rec._pauseAt) / 1000; rec._pauseAt = 0; }
      this.lastPos = this.engine.position();
      this.lastTick = now;
    } else if (rec.started) {
      this._tick();
      var d = this.engine.duration();
      if (d && this.engine.position() >= d - 0.6) return;       // the song ended; not a pause
      rec.pauses++;
      rec._pauseAt = now;
    }
  };

  Signals.prototype._start = function (rec, now) {
    var t = rec._t, s = this.sess;
    if (!s || now - (s.last || 0) > GAP) s = this.sess = { id: 's' + now.toString(36), last: now, pos: 0, prevSkip: false, ids: [] };
    rec.started = true;
    rec.tid = t.id;
    rec.title = t.title;
    rec.artist = t.artist;
    rec.artists = String(t.artist || '').split(/\s*,\s*/).filter(Boolean);
    rec.artistIds = t.artistIds || [];
    rec.lang = t.language || '';
    rec.album = t.album || '';
    rec.year = t.year || '';
    rec.dur = this.engine.duration() || t.duration || 0;
    rec.pc = t.playCount || 0;
    rec.ctx = P.context(now);
    rec.ctx.mobile = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    rec.ctx.bg = document.hidden;
    rec.heard = 0; rec.maxPos = 0; rec.bgSec = 0;
    rec.pauses = 0; rec.pauseSec = 0; rec._pauseAt = 0;
    rec.seekFwd = 0; rec.seekFwdEarly = 0; rec.seekBack = 0; rec.restarts = 0;
    rec.vol0 = rec.volMin = rec.volMax = rec.volEnd = r2(this.engine.volume);
    rec.liked = 0; rec._likedAtStart = this.saved.has(t.id);
    rec.added = false; rec._inPlStart = inAnyPlaylist(this.saved, t.id);
    rec.replay = s.ids.indexOf(t.id) >= 0;
    rec.sess = s.id;
    rec.pos = s.pos++;
    rec.prevSkip = !!s.prevSkip;
    rec.demo = !!t.music;
    s.ids.push(t.id);
    if (s.ids.length > 40) s.ids.shift();
    s.last = now;
    writeJSON(KEYS.sess, s);
    this.lastPos = this.engine.position();
    this.lastTick = now;
    if (this.opts.onStart) this.opts.onStart(rec, t);
  };

  Signals.prototype._tick = function () {
    var rec = this.rec, now = Date.now();
    if (!rec || !rec.started || rec.end) return;
    var pos = this.engine.position(), dtWall = (now - (this.lastTick || now)) / 1000, d = pos - this.lastPos;
    rec._playingAtTick = this.engine.playing;
    if (this.engine.playing && d >= -0.25 && d <= dtWall + 1) {
      if (d > 0) {
        rec.heard += d;
        if (document.hidden) rec.bgSec += d;
      }
    } else if (Math.abs(d) > 1.5) {
      var from = this.lastPos, to = pos;
      if (to < 2 && from > 8) { rec.restarts++; rec._restartHeard = rec.heard; }
      else if (to < from) rec.seekBack++;
      else { rec.seekFwd++; if (from < 30) rec.seekFwdEarly++; }
    }
    rec.maxPos = Math.max(rec.maxPos, pos);
    this.lastPos = pos;
    this.lastTick = now;
    if (this.sess) this.sess.last = now;
    if (!this.engine.playing && rec._pauseAt && now - rec._pauseAt > IDLE) this._end('idle');
  };

  Signals.prototype._onVolume = function () {
    var rec = this.rec;
    if (!rec || !rec.started || rec.end) return;
    var v = r2(this.engine.volume);
    rec.volMin = Math.min(rec.volMin, v);
    rec.volMax = Math.max(rec.volMax, v);
    rec.volEnd = v;
  };

  Signals.prototype._onLibrary = function (kind) {
    var rec = this.rec;
    if (!rec || !rec.started || rec.end) return;
    if (kind === 'liked') {
      var now = this.saved.has(rec.tid);
      rec.liked = now === rec._likedAtStart ? 0 : now ? 1 : -1;
    } else if (kind === 'playlists') {
      if (!rec._inPlStart && inAnyPlaylist(this.saved, rec.tid)) rec.added = true;
    }
  };

  Signals.prototype._onError = function () {
    var rec = this.rec;
    if (rec && rec.started && !rec.end) this._end('error');
    else if (rec && this.opts.onUnplayable) this.opts.onUnplayable(rec._t);
  };

  Signals.prototype._end = function (why, switched) {
    var rec = this.rec;
    if (!rec || !rec.started || rec.end) return;
    if (!switched) this._tick();
    else if (rec._playingAtTick && this.lastTick) {
      // the bit of playback since the last reading (at most one tick)
      rec.heard += Math.min(TICK / 1000, Math.max(0, (Date.now() - this.lastTick) / 1000));
    }
    if (rec._pauseAt) { rec.pauseSec += (Date.now() - rec._pauseAt) / 1000; rec._pauseAt = 0; }
    // a restart you leave within 5 s was a double-tap on Previous, not a loop
    if (rec.restarts > 0 && rec._restartHeard != null && rec.heard - rec._restartHeard < 5 && (why === 'prev' || why === 'next' || why === 'pick')) rec.restarts--;
    rec.end = why;
    this._finish(rec);
  };

  // turn the live record into a stored one and hand it to the learner
  Signals.prototype._finish = function (rec) {
    var out = {};
    Object.keys(rec).forEach(function (k) { if (k.charAt(0) !== '_' && k !== 'started') out[k] = rec[k]; });
    out.heard = r2(out.heard || 0);
    out.maxPos = r2(out.maxPos || 0);
    out.bgSec = r2(out.bgSec || 0);
    out.pauseSec = r2(out.pauseSec || 0);
    var dur = out.dur || 0;
    var skipped = (out.end === 'next' || out.end === 'prev' || out.end === 'pick') && !(dur && (out.heard >= 0.9 * dur || out.maxPos >= dur - 8));
    if (this.sess && this.sess.id === out.sess) { this.sess.prevSkip = skipped; writeJSON(KEYS.sess, this.sess); }
    localStorage.removeItem(KEYS.open);
    if (this.opts.onEnd) {
      try { this.opts.onEnd(out, rec); } catch (e) { if (window.console) console.error('[encore] learning failed', e); }
    }
    if (!out.demo) {
      this._log.push(out);
      if (this._log.length > LOG_MAX) this._log.splice(0, this._log.length - LOG_MAX);
      // keep the feature vectors of recent plays only (space)
      for (var i = 0; i < this._log.length - X_KEEP; i++) delete this._log[i].x;
      writeJSON(KEYS.log, this._log);
    }
  };

  Signals.prototype._persistOpen = function () {
    var rec = this.rec;
    if (!rec || !rec.started || rec.end || rec.demo) return;
    var copy = {};
    Object.keys(rec).forEach(function (k) { if (k.charAt(0) !== '_' && k !== 'started') copy[k] = rec[k]; });
    writeJSON(KEYS.open, copy);
  };

  Signals.prototype.clear = function () {
    this._log = [];
    this.sess = null;
    [KEYS.log, KEYS.open, KEYS.sess].forEach(function (k) { localStorage.removeItem(k); });
  };

  window.EncoreSignals = Signals;
})();
