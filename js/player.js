/* StreamEngine plays API songs through an <audio> element, exposing the same
   interface as VinylEngine (the offline demo synth). Player picks the right
   one per track so the UI never needs to know which is in use. */
(function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // iOS pauses Web Audio when the screen locks, so there we keep the plain
  // <audio> element (and animate the waveform without an analyser).
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function StreamEngine() {
    this.audio = null;
    this.track = null;
    this.playing = false;
    this.volume = 0.5;
    this.graphMode = !IOS && !!(window.AudioContext || window.webkitAudioContext);
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this._freq = null;
    this._listeners = {};
    this._retried = false;
  }

  StreamEngine.prototype.on = function (name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
  };
  StreamEngine.prototype._emit = function (name) {
    var l = this._listeners[name] || [];
    for (var i = 0; i < l.length; i++) l[i](this);
  };

  StreamEngine.prototype._make = function () {
    var self = this, a = new Audio();
    a.preload = 'metadata';            // don't stream a whole song until it's played
    if (this.graphMode) a.crossOrigin = 'anonymous';
    a.addEventListener('ended', function () {
      if (a !== self.audio) return;
      self.playing = false;
      self._emit('state');
      self._emit('ended');
    });
    a.addEventListener('error', function () {
      if (a !== self.audio || !a.getAttribute('src')) return;
      self._failed();
    });
    // keep in sync with OS media keys, headphones being unplugged, etc.
    // (events are queued, so check the element's real state when they arrive)
    a.addEventListener('pause', function () {
      if (a === self.audio && self.playing && a.paused && !a.ended) { self.playing = false; self._emit('state'); }
    });
    a.addEventListener('play', function () {
      if (a === self.audio && !self.playing && !a.paused) { self.playing = true; self._emit('state'); }
    });
    a.addEventListener('loadedmetadata', function () { if (a === self.audio) self._emit('seek'); });
    this.audio = a;
    this.graphed = false;
    this._applyVolume();
    return a;
  };

  // Route the element through an analyser so the waveform follows the music.
  StreamEngine.prototype._graph = function () {
    if (!this.graphMode || this.graphed || !this.audio) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var c = this.ctx = this.ctx || new AC();
      var src = c.createMediaElementSource(this.audio);
      if (!this.analyser) {
        this.analyser = c.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.78;
        this._freq = new Uint8Array(this.analyser.frequencyBinCount);
        this.gain = c.createGain();
        this.analyser.connect(this.gain);
        this.gain.connect(c.destination);
      }
      src.connect(this.analyser);
      this.graphed = true;
      this._applyVolume();
    } catch (e) {
      this.graphMode = false;
    }
  };

  // A host without CORS headers can't be analysed: retry once on a plain element.
  StreamEngine.prototype._failed = function () {
    var t = this.track, wanted = this.playing;
    if (this.graphMode && !this._retried && t) {
      this._retried = true;
      this.graphMode = false;
      try { this.audio.pause(); } catch (e) { /* ignore */ }
      this._make();
      this.audio.src = t.src;
      if (wanted) this.play();
      return;
    }
    this.playing = false;
    this._emit('state');
    this._emit('error');
  };

  StreamEngine.prototype._applyVolume = function () {
    var g = this.volume <= 0.001 ? 0 : Math.pow(this.volume, 0.85);
    if (this.graphed && this.gain) {
      this.audio.volume = 1;
      this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    } else if (this.audio) {
      this.audio.volume = clamp(g, 0, 1);
    }
  };

  StreamEngine.prototype.load = function (track, autoplay) {
    var a = this.audio || this._make();
    a.pause();
    this.track = track;
    this.playing = false;
    this._retried = false;
    a.src = track.src;
    this._emit('track');
    if (autoplay) this.play(); else this._emit('state');
  };

  StreamEngine.prototype.play = function () {
    if (!this.track) return;
    var self = this, a = this.audio || this._make();
    this._graph();
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
    if (a.ended) a.currentTime = 0;
    this.playing = true;
    this._emit('state');
    var p = a.play();
    if (p && p.catch) {
      p.catch(function (err) {
        if (err && err.name === 'AbortError') return;          // superseded by a newer load
        if (a !== self.audio) return;
        self.playing = false;
        self._emit('state');
      });
    }
  };

  StreamEngine.prototype.pause = function () {
    if (!this.audio) return;
    this.audio.pause();
    if (this.playing) { this.playing = false; this._emit('state'); }
  };

  StreamEngine.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };

  StreamEngine.prototype.seek = function (t) {
    if (!this.audio || !this.track) return;
    var d = this.duration();
    try { this.audio.currentTime = clamp(t, 0, Math.max(0, d - 0.25)); } catch (e) { /* not seekable yet */ }
    this._emit('seek');
  };

  StreamEngine.prototype.setVolume = function (v) {
    this.volume = clamp(v, 0, 1);
    this._applyVolume();
    this._emit('volume');
  };

  StreamEngine.prototype.position = function () {
    return this.audio ? this.audio.currentTime || 0 : 0;
  };

  StreamEngine.prototype.duration = function () {
    var d = this.audio && this.audio.duration;
    return isFinite(d) && d > 0 ? d : (this.track ? this.track.duration : 0);
  };

  var BANDS = [[1, 3], [3, 7], [7, 14], [14, 30], [30, 70], [70, 180]];
  var BAND_GAIN = [0.8, 0.95, 1.1, 1.3, 1.6, 2.2];
  StreamEngine.prototype.levels = function (out) {
    var i;
    if (!this.playing) { for (i = 0; i < 6; i++) out[i] = 0; return out; }
    if (this.graphed && this.analyser) {
      this.analyser.getByteFrequencyData(this._freq);
      var f = this._freq;
      for (i = 0; i < 6; i++) {
        var a = BANDS[i][0], b = Math.min(BANDS[i][1], f.length), sum = 0;
        for (var k = a; k < b; k++) sum += f[k];
        out[i] = clamp((sum / (b - a) / 255) * BAND_GAIN[i], 0, 1);
      }
      return out;
    }
    // no analyser available: a gentle, music-like motion
    var t = this.position();
    var beat = Math.exp(-((t * 1.6) % 1) * 5);
    for (i = 0; i < 6; i++) {
      out[i] = clamp(0.32 + 0.22 * Math.sin(t * (2.1 + i * 0.73) + i * 1.9) +
                     0.16 * Math.sin(t * (5.3 + i * 0.41) + i) + 0.3 * beat * (i < 2 ? 1 : 0.5), 0, 1);
    }
    return out;
  };

  /* ───────────── Player: one interface over both engines ───────────── */

  function Player() {
    var self = this;
    this.stream = new StreamEngine();
    this.synth = new window.VinylEngine();
    this.cur = this.stream;
    this._listeners = {};
    ['track', 'state', 'seek', 'volume', 'ended', 'error'].forEach(function (ev) {
      [self.stream, self.synth].forEach(function (eng) {
        eng.on(ev, function () { if (eng === self.cur) self._emit(ev); });
      });
    });
  }

  Player.prototype.on = StreamEngine.prototype.on;
  Player.prototype._emit = StreamEngine.prototype._emit;

  Object.defineProperty(Player.prototype, 'playing', { get: function () { return this.cur.playing; } });
  Object.defineProperty(Player.prototype, 'track', { get: function () { return this.cur.track; } });
  Object.defineProperty(Player.prototype, 'volume', { get: function () { return this.cur.volume; } });

  Player.prototype.load = function (track, autoplay) {
    var eng = track.src ? this.stream : this.synth;
    if (eng !== this.cur) {
      this.cur.pause();
      this.cur = eng;
    }
    eng.load(track, autoplay);
  };
  Player.prototype.play = function () { this.cur.play(); };
  Player.prototype.pause = function () { this.cur.pause(); };
  Player.prototype.toggle = function () { this.cur.toggle(); };
  Player.prototype.seek = function (t) { this.cur.seek(t); };
  Player.prototype.position = function () { return this.cur.position(); };
  Player.prototype.duration = function () { return this.cur.duration(); };
  Player.prototype.levels = function (out) { return this.cur.levels(out); };
  Player.prototype.setVolume = function (v) {
    var other = this.cur === this.stream ? this.synth : this.stream;
    other.volume = clamp(v, 0, 1);
    if (other === this.stream) other._applyVolume(); else if (other.vol) other.setVolume(v);
    this.cur.setVolume(v);
  };

  window.VinylPlayer = Player;
})();
