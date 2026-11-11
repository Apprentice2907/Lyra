/* VinylEngine — a small, deterministic lo-fi song synthesiser.
   Every dummy track is generated live with the Web Audio API from the
   parameters in tracks.js, so playback, pause, seek, skip and volume are
   real audio operations with no media files to download.

   Signal path:
   voices → session gain → bus → tone (lowpass) → glue comp ─┬→ analyser
                       └→ fx send → delay ─┘                 └→ volume → limiter → out
*/
(function () {
  'use strict';

  var SCALES = {
    minor:  [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    major:  [0, 2, 4, 5, 7, 9, 11]
  };
  var PENTA = { minor: [0, 3, 5, 7, 10], dorian: [0, 3, 5, 7, 10], major: [0, 2, 4, 7, 9] };

  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Deterministic hash → [0, 1). Same inputs always give the same song.
  function mix(h) {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return h ^ (h >>> 16);
  }
  function rnd(a, b, c, d) {
    var h = mix((a + 0x9e3779b9) | 0);
    h = mix((h + b) | 0);
    h = mix((h + c) | 0);
    h = mix((h + d) | 0);
    return (h >>> 0) / 4294967296;
  }

  /* ───────────────────────── Song (arrangement) ───────────────────────── */

  function Song(def) {
    var m = def.music;
    this.def = def;
    this.m = m;
    this.seed = m.seed;
    this.duration = def.duration;
    this.step = 60 / m.bpm / 4;                 // one 16th note
    this.barDur = this.step * 16;
    this.bars = Math.max(8, Math.floor((def.duration - 3.5) / this.barDur));
    this.totalSteps = this.bars * 16;
    this.scale = SCALES[m.mode] || SCALES.minor;
    this.penta = PENTA[m.mode] || PENTA.minor;
    this.leadBase = m.root;
    while (this.leadBase < 60) this.leadBase += 12;
    while (this.leadBase >= 72) this.leadBase -= 12;
    this._motifs = {};
  }

  Song.prototype.deg = function (d) {
    var s = this.scale;
    return s[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  };

  Song.prototype.chordDeg = function (bar) {
    var p = this.m.prog;
    return p[Math.floor(bar / this.m.chordLen) % p.length];
  };

  // Rootless 9th voicing (3-5-7-9) folded into one octave around the key.
  Song.prototype.keysChord = function (bar) {
    var d = this.chordDeg(bar), root = this.m.root, lo = root - 2, out = [];
    for (var k = 1; k <= 4; k++) {
      var n = root + this.deg(d + 2 * k);
      while (n < lo) n += 12;
      while (n >= lo + 12) n -= 12;
      out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  };

  Song.prototype.triad = function (bar) {
    var d = this.chordDeg(bar), root = this.m.root - 12, out = [];
    for (var k = 0; k < 3; k++) {
      var n = root + this.deg(d + 2 * k);
      while (n < root - 3) n += 12;
      while (n >= root + 9) n -= 12;
      out.push(n);
    }
    return out;
  };

  Song.prototype.bassNote = function (bar) {
    var n = this.m.root + this.deg(this.chordDeg(bar));
    while (n < 36) n += 12;
    while (n >= 48) n -= 12;
    return n;
  };

  Song.prototype.section = function (b) {
    var B = this.bars;
    if (b < 0 || b >= B) return null;
    if (b < 2) return { keys: 0.75, pad: 0.8, hats: 0, drums: 0, bass: 0, lead: 0 };
    if (b < 4) return { keys: 0.9, pad: 1, hats: 0.7, drums: 0, bass: 1, lead: 0 };
    if (b >= B - 2) {
      var k = (B - b) / 2;
      return { keys: 0.9 * k, pad: k, hats: b === B - 2 ? 0.6 : 0, drums: 0, bass: b === B - 2 ? 0.8 : 0, lead: 0, last: b === B - 1 };
    }
    var ph = Math.floor((b - 4) / 8), inPh = (b - 4) % 8, brk = ph % 4 === 2;
    return {
      keys: 1, pad: 1,
      hats: brk ? 0.6 : 1,
      drums: brk ? 0 : 1,
      bass: brk ? 0.7 : 1,
      lead: (ph % 2 === 1 || brk) ? 1 : 0,
      fill: !brk && inPh === 7
    };
  };

  // Key (chord) hits for a bar: [{ s, len, v, notes }]
  Song.prototype.keyHits = function (b) {
    var sec = this.section(b);
    if (!sec) return [];
    var chord = this.keysChord(b), seed = this.seed, hits = [];
    if (sec.last) return [{ s: 0, len: 30, v: sec.keys, notes: chord }];
    switch (this.m.keys) {
      case 'sustain':
        if (rnd(seed, b, 0, 71) < 0.4) {
          hits.push({ s: 0, len: 8, v: sec.keys, notes: chord });
          hits.push({ s: 8, len: 8, v: sec.keys * 0.55, notes: chord });
        } else {
          hits.push({ s: 0, len: 16, v: sec.keys, notes: chord });
        }
        break;
      case 'arp':
        hits.push({ s: 0, len: 16, v: sec.keys * 0.42, notes: chord });
        var order = [0, 1, 2, 3, 2, 1, 3, 2];
        for (var i = 0; i < 8; i++) {
          hits.push({ s: i * 2, len: 3, v: sec.keys * (i % 2 ? 0.5 : 0.68), notes: [chord[order[i]] + 12] });
        }
        break;
      default: // 'stabs'
        var push = rnd(seed, b, 0, 72) < 0.35 ? 7 : 6;
        hits.push({ s: 0, len: push, v: sec.keys, notes: chord });
        hits.push({ s: push, len: 10 - push, v: sec.keys * 0.55, notes: chord });
        hits.push({ s: 10, len: 6, v: sec.keys * 0.75, notes: chord });
    }
    return hits;
  };

  // One bar of melody: a random walk on the pentatonic scale, cached per motif
  // so phrases repeat (call & response every two bars) like a real hook.
  Song.prototype.leadBar = function (b) {
    var cyc = (b - 4) % 4, variant = Math.floor((b - 4) / 16) % 2;
    var key = (cyc % 2) + '|' + (cyc >= 2 ? 'r' : 'c') + '|' + variant;
    if (this._motifs[key]) return this._motifs[key];
    var seed = this.seed, dens = this.m.lead, idx = 3, bar = [];
    var a = 300 + (cyc % 2) * 7 + variant * 31, alt = cyc >= 2;
    for (var s = 0; s < 16; s++) bar.push(null);
    for (s = 0; s < 16; s += 2) {
      var tag = alt && s >= 10 ? a + 101 : a;
      var r = rnd(seed, tag, s, 1);
      var p = dens * (s % 4 === 0 ? 1.15 : 0.75);
      if (r > p) continue;
      var stepMove = Math.floor(rnd(seed, tag, s, 2) * 5) - 2;
      idx = clamp(idx + stepMove, 0, 7);
      var n = this.leadBase + this.penta[idx % 5] + 12 * Math.floor(idx / 5);
      var len = rnd(seed, tag, s, 3) < 0.4 ? 4 : 2;
      bar[s] = { n: n, len: len, v: 0.75 + rnd(seed, tag, s, 4) * 0.25 };
    }
    this._motifs[key] = bar;
    return bar;
  };

  Song.prototype.schedule = function (syn, n, t) {
    var b = n >> 4, s = n & 15, sec = this.section(b);
    if (!sec) return;
    var m = this.m, st = this.step, seed = this.seed;
    var swing = (s % 4 === 2) ? m.swing * st * 2 : (s & 1) ? m.swing * st : 0;
    var T = t + swing + rnd(seed, b, s, 9) * 0.006;   // swing + a little human lag
    var i, h;

    // keys
    var hits = this.keyHits(b);
    for (i = 0; i < hits.length; i++) {
      h = hits[i];
      if (h.s === s) syn.keys(T, h.notes, h.len * st, h.v);
    }

    // pad at the start of each chord
    if (m.pad && s === 0 && b % m.chordLen === 0 && sec.pad > 0) {
      var padLen = sec.last ? this.barDur * 1.6 : this.barDur * m.chordLen;
      syn.pad(t, this.triad(b), padLen, sec.pad);
    }

    // bass
    if (sec.bass > 0) {
      var pat = BASS[m.bassPat] || BASS.long, bn = this.bassNote(b);
      for (i = 0; i < pat.length; i++) {
        if (pat[i][0] === s) syn.bass(T, hz(bn + pat[i][2]), pat[i][1] * st, sec.bass);
      }
    }

    // drums
    if (sec.drums > 0 || sec.hats > 0) this.drums(syn, b, s, T, sec);

    // melody
    if (sec.lead > 0) {
      var note = this.leadBar(b)[s];
      if (note) syn.lead(T, hz(note.n), note.len * st, note.v * sec.lead);
    }
  };

  var BASS = {
    long:  [[0, 7, 0], [8, 5, 0], [14, 2, 7]],
    walk:  [[0, 5, 0], [6, 2, 12], [8, 5, 0], [13, 3, 7]],
    drive: [[0, 3, 0], [4, 2, 0], [6, 2, 0], [8, 3, 0], [12, 2, 0], [14, 2, 7]]
  };

  Song.prototype.drums = function (syn, b, s, T, sec) {
    var seed = this.seed, style = this.m.drums, r = rnd(seed, b, s, 33);
    var D = sec.drums, Hh = sec.hats;
    if (style === 'four') {
      if (D && s % 4 === 0) syn.kick(T, 0.95 * D);
      if (D && (s === 4 || s === 12)) syn.snare(T, 0.78 * D);
      if (Hh) {
        if (s % 4 === 2) syn.hat(T, 0.5 * Hh, r < 0.5);
        else syn.hat(T, (s % 2 ? 0.16 : 0.24) * Hh, false);
      }
    } else if (style === 'half') {
      if (D && (s === 0 || (s === 11 && r < 0.8) || (s === 3 && r < 0.3))) syn.kick(T, (s === 0 ? 1 : 0.62) * D);
      if (D && s === 8) syn.snare(T, 0.9 * D);
      if (Hh) {
        if (s % 2 === 0) syn.hat(T, (s % 4 === 0 ? 0.38 : 0.28) * Hh, s === 14 && r < 0.3);
        else if (r < 0.22) syn.hat(T, 0.13 * Hh, false);
      }
    } else { // 'boom'
      if (D && (s === 0 || s === 10 || (s === 7 && r < 0.4) || (s === 15 && r < 0.18))) syn.kick(T, (s === 0 ? 1 : s === 10 ? 0.82 : 0.48) * D);
      if (D && (s === 4 || s === 12)) syn.snare(T, D);
      if (Hh && s % 2 === 0) syn.hat(T, (s % 4 === 0 ? 0.52 : 0.38 + r * 0.1) * Hh, s === 14 && r < 0.25);
    }
    if (sec.fill && D) {
      if (s === 13) syn.snare(T, 0.4);
      if (s === 14) syn.snare(T, 0.55);
      if (s === 15) syn.snare(T, 0.72);
    }
  };

  // Re-trigger anything that should already be sounding when playback
  // starts mid-note (after a seek, resume or skip).
  Song.prototype.resume = function (syn, pos, t) {
    var b = Math.floor(pos / this.barDur), sec = this.section(b);
    if (!sec) return;
    var inBar = pos - b * this.barDur, st = this.step, hits = this.keyHits(b), i;
    for (i = 0; i < hits.length; i++) {
      var h = hits[i], start = h.s * st, end = start + h.len * st;
      if (start < inBar - 0.01 && end - inBar > 0.25) syn.keys(t, h.notes, end - inBar, h.v * 0.8);
    }
    if (this.m.pad && sec.pad > 0) {
      var cb = b - (b % this.m.chordLen), cStart = cb * this.barDur, cEnd = cStart + this.m.chordLen * this.barDur;
      if (pos - cStart > 0.05 && cEnd - pos > 0.4) syn.pad(t, this.triad(b), cEnd - pos, sec.pad * 0.85);
    }
  };

  /* ───────────────────────── Synth (voices) ───────────────────────── */

  function Synth(ctx) {
    this.ctx = ctx;
    var sr = ctx.sampleRate, len = sr * 2, buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    this.crackle = makeCrackle(ctx);
    this.out = null;
    this.fx = null;
    this.wow = null;
  }

  function makeCrackle(ctx) {
    var sr = ctx.sampleRate, len = Math.floor(sr * 6), buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    var lp = 0, i, k, j;
    for (i = 0; i < len; i++) {
      lp += ((Math.random() * 2 - 1) - lp) * 0.2;
      d[i] = lp * 0.018;
    }
    for (k = 0; k < 60; k++) {
      var p = Math.floor(Math.random() * (len - 200));
      var big = Math.random() < 0.12;
      var amp = (big ? 0.42 : 0.12) * (0.4 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1);
      var L = 6 + Math.floor(Math.random() * (big ? 60 : 24));
      for (j = 0; j < L; j++) d[p + j] += amp * Math.exp(-j / (L / 4)) * (Math.random() * 0.6 + 0.4);
    }
    // seam-less loop: fade the last 20 ms into the first
    var f = Math.floor(sr * 0.02);
    for (i = 0; i < f; i++) d[len - f + i] = d[len - f + i] * (1 - i / f) + d[i] * (i / f);
    return buf;
  }

  Synth.prototype._osc = function (type, freq, detune) {
    var o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    if (this.wow) {
      var w = this.wow;
      w.connect(o.detune);
      o.onended = function () { try { w.disconnect(o.detune); } catch (e) { /* already gone */ } };
    }
    return o;
  };

  Synth.prototype._noise = function (t, dur) {
    var src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 1.5, dur);
    return src;
  };

  Synth.prototype.kick = function (t, v) {
    var c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
    o.connect(g); g.connect(this.out);
    o.start(t); o.stop(t + 0.5);
  };

  Synth.prototype.snare = function (t, v) {
    var c = this.ctx;
    var n = this._noise(t, 0.3), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(bp); bp.connect(g); g.connect(this.out);
    var send = c.createGain(); send.gain.value = 0.25; g.connect(send); send.connect(this.fx);

    var o = c.createOscillator(), og = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(196, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.2 * v, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(og); og.connect(this.out);
    o.start(t); o.stop(t + 0.13);
  };

  Synth.prototype.hat = function (t, v, open) {
    var c = this.ctx, dur = open ? 0.3 : 0.05;
    var n = this._noise(t, dur + 0.02), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'highpass'; hp.frequency.value = 7200;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((open ? 0.09 : 0.12) * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(this.out);
  };

  // Soft electric-piano: sine + triangle body with a short bell partial.
  Synth.prototype.keys = function (t, notes, dur, v) {
    var c = this.ctx, lp = c.createBiquadFilter(), g = c.createGain(), send = c.createGain();
    var peak = 0.085 * v * (notes.length === 1 ? 1.5 : 1), end = t + dur, stop = end + 0.7;
    lp.type = 'lowpass'; lp.frequency.value = 2300; lp.Q.value = 0.3;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.setTargetAtTime(peak * 0.42, t + 0.012, 0.35);
    g.gain.setTargetAtTime(0, end, 0.11);
    lp.connect(g); g.connect(this.out);
    send.gain.value = 0.28; g.connect(send); send.connect(this.fx);
    for (var i = 0; i < notes.length; i++) {
      var f = hz(notes[i]);
      var o1 = this._osc('sine', f, -3), o2 = this._osc('triangle', f, 4), og = c.createGain();
      og.gain.value = 0.35;
      o1.connect(lp); o2.connect(og); og.connect(lp);
      var bell = this._osc('sine', f * 4, 0), bg = c.createGain();
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      bell.connect(bg); bg.connect(lp);
      o1.start(t); o2.start(t); bell.start(t);
      o1.stop(stop); o2.stop(stop); bell.stop(t + 0.5);
    }
  };

  Synth.prototype.pad = function (t, notes, dur, v) {
    var c = this.ctx, lp = c.createBiquadFilter(), g = c.createGain();
    var end = t + dur, stop = end + 2.2, peak = 0.02 * v;
    lp.type = 'lowpass'; lp.Q.value = 0.5;
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.linearRampToValueAtTime(1100, t + Math.min(dur, 4));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(0.9, dur * 0.4));
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, 0.45);
    lp.connect(g); g.connect(this.out);
    for (var i = 0; i < notes.length; i++) {
      var f = hz(notes[i]);
      var a = this._osc('sawtooth', f, -8), b = this._osc('sawtooth', f, 8);
      a.connect(lp); b.connect(lp);
      a.start(t); b.start(t); a.stop(stop); b.stop(stop);
    }
  };

  Synth.prototype.bass = function (t, f, dur, v) {
    var c = this.ctx, lp = c.createBiquadFilter(), g = c.createGain();
    var o1 = this._osc('sine', f, 0), o2 = this._osc('triangle', f, 0), og = c.createGain();
    var end = t + dur, stop = end + 0.35;
    lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.4;
    og.gain.value = 0.5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4 * v, t + 0.012);
    g.gain.setTargetAtTime(0.28 * v, t + 0.05, 0.3);
    g.gain.setTargetAtTime(0, end, 0.05);
    o1.connect(lp); o2.connect(og); og.connect(lp); lp.connect(g); g.connect(this.out);
    o1.start(t); o2.start(t); o1.stop(stop); o2.stop(stop);
  };

  Synth.prototype.lead = function (t, f, dur, v) {
    var c = this.ctx, lp = c.createBiquadFilter(), g = c.createGain(), send = c.createGain();
    var o = this._osc('triangle', f, 0), o2 = this._osc('sine', f * 2, 2), o2g = c.createGain();
    var vib = c.createOscillator(), vg = c.createGain();
    var end = t + dur, stop = end + 0.6, peak = 0.11 * v;
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    o2g.gain.value = 0.18;
    vib.frequency.value = 5.2;
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(f * 0.006, t + 0.25);
    vib.connect(vg); vg.connect(o.frequency); vg.connect(o2.frequency);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.setTargetAtTime(peak * 0.7, t + 0.05, 0.2);
    g.gain.setTargetAtTime(0, end, 0.09);
    o.connect(lp); o2.connect(o2g); o2g.connect(lp); lp.connect(g); g.connect(this.out);
    send.gain.value = 0.55; g.connect(send); send.connect(this.fx);
    o.start(t); o2.start(t); vib.start(t);
    o.stop(stop); o2.stop(stop); vib.stop(stop);
  };

  /* ───────────────────────── Engine (transport) ───────────────────────── */

  function Engine() {
    this.ctx = null;
    this.track = null;
    this.song = null;
    this.playing = false;
    this.offset = 0;
    this.session = null;
    this.volume = 0.5;
    this.timer = 0;
    this._listeners = {};
    this._freq = null;
    this._tickBound = this._tick.bind(this);
  }

  Engine.prototype.on = function (name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
  };
  Engine.prototype._emit = function (name) {
    var l = this._listeners[name] || [];
    for (var i = 0; i < l.length; i++) l[i](this);
  };

  Engine.prototype.init = function () {
    if (this.ctx) return this.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* unsupported */ }
    var c;
    try { c = new AC({ latencyHint: 'playback' }); } catch (e) { c = new AC(); }
    this.ctx = c;
    this.syn = new Synth(c);

    this.bus = c.createGain();
    this.bus.gain.value = 0.45;
    this.tone = c.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 9000;
    this.tone.Q.value = 0.2;
    this.glue = c.createDynamicsCompressor();
    this.glue.threshold.value = -20;
    this.glue.knee.value = 12;
    this.glue.ratio.value = 3;
    this.glue.attack.value = 0.01;
    this.glue.release.value = 0.25;
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.78;
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.vol = c.createGain();
    this.vol.gain.value = gainFor(this.volume);
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;

    this.bus.connect(this.tone);
    this.tone.connect(this.glue);
    this.glue.connect(this.analyser);
    this.glue.connect(this.vol);
    this.vol.connect(this.limiter);
    this.limiter.connect(c.destination);

    this.delay = c.createDelay(2);
    this.fb = c.createGain();
    this.fb.gain.value = 0.32;
    this.dlp = c.createBiquadFilter();
    this.dlp.type = 'lowpass';
    this.dlp.frequency.value = 2600;
    this.wet = c.createGain();
    this.wet.gain.value = 0.3;
    this.delay.connect(this.dlp);
    this.dlp.connect(this.fb);
    this.fb.connect(this.delay);
    this.dlp.connect(this.wet);
    this.wet.connect(this.tone);

    var self = this;
    document.addEventListener('visibilitychange', function () { if (self.session) self._tick(); });
    this._applyTrack();
    return c;
  };

  // Knob position → gain. Perceptual curve: 50% ≈ comfortable, 100% ≈ +7 dB.
  function gainFor(v) { return v <= 0.001 ? 0 : 1.6 * Math.pow(v, 1.2); }

  Engine.prototype._applyTrack = function () {
    if (!this.ctx || !this.song) return;
    var now = this.ctx.currentTime, m = this.song.m;
    this.tone.frequency.setTargetAtTime(m.tone || 9000, now, 0.05);
    this.delay.delayTime.setValueAtTime(0.75 * 60 / m.bpm, now);
  };

  Engine.prototype.load = function (track, autoplay) {
    if (this.session) this._stopSession();
    this.playing = false;
    this.track = track;
    this.song = new Song(track);
    this.offset = 0;
    this._applyTrack();
    this._emit('track');
    if (autoplay) this.play(); else this._emit('state');
  };

  Engine.prototype.play = function () {
    this.init();
    if (this.ctx.state !== 'running') this.ctx.resume();
    if (this.playing) return;
    if (this.offset >= this.song.duration - 0.05) this.offset = 0;
    this.playing = true;
    this._startSession(this.offset);
    this._emit('state');
  };

  Engine.prototype.pause = function () {
    if (!this.playing) return;
    this.offset = this.position();
    this.playing = false;
    this._stopSession();
    this._emit('state');
  };

  Engine.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };

  Engine.prototype.seek = function (t) {
    if (!this.song) return;
    t = clamp(t, 0, this.song.duration - 0.05);
    if (this.playing) {
      this._stopSession();
      this.offset = t;
      this._startSession(t);
    } else {
      this.offset = t;
    }
    this._emit('seek');
  };

  Engine.prototype.setVolume = function (v) {
    this.volume = clamp(v, 0, 1);
    if (this.vol) this.vol.gain.setTargetAtTime(gainFor(this.volume), this.ctx.currentTime, 0.03);
    this._emit('volume');
  };

  Engine.prototype.position = function () {
    var s = this.session;
    if (s && this.ctx) return clamp(s.p0 + Math.max(0, this.ctx.currentTime - s.t0), 0, this.song.duration);
    return this.offset;
  };

  Engine.prototype.duration = function () { return this.song ? this.song.duration : 0; };

  // Six band levels in 0..1 for the waveform bars.
  var BANDS = [[1, 3], [3, 7], [7, 14], [14, 30], [30, 70], [70, 180]];
  var BAND_GAIN = [0.85, 1.0, 1.15, 1.35, 1.7, 2.4];
  Engine.prototype.levels = function (out) {
    if (!this.analyser || !this.playing) { for (var z = 0; z < 6; z++) out[z] = 0; return out; }
    this.analyser.getByteFrequencyData(this._freq);
    var f = this._freq;
    for (var i = 0; i < 6; i++) {
      var a = BANDS[i][0], b = Math.min(BANDS[i][1], f.length), sum = 0;
      for (var k = a; k < b; k++) sum += f[k];
      out[i] = clamp((sum / (b - a) / 255) * BAND_GAIN[i], 0, 1);
    }
    return out;
  };

  Engine.prototype._startSession = function (pos) {
    var c = this.ctx, syn = this.syn, song = this.song, now = c.currentTime;
    var out = c.createGain(), fx = c.createGain(), extra = [];
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + 0.03);
    out.connect(this.bus);
    fx.connect(this.delay);

    var s = { out: out, fx: fx, t0: now + 0.05, p0: pos, n: Math.ceil(pos / song.step - 1e-6), extra: extra };
    syn.out = out;
    syn.fx = fx;

    if (song.m.wow) {
      var lfo = c.createOscillator(), depth = c.createGain();
      lfo.frequency.value = 0.55;
      depth.gain.value = song.m.wow;
      lfo.connect(depth);
      lfo.start(now);
      extra.push(lfo);
      syn.wow = depth;
    } else {
      syn.wow = null;
    }

    // vinyl surface noise for the whole side, including the run-out groove
    var cr = c.createBufferSource(), hp = c.createBiquadFilter(), cg = c.createGain();
    cr.buffer = syn.crackle;
    cr.loop = true;
    hp.type = 'highpass';
    hp.frequency.value = 380;
    cg.gain.value = 0.5 * (song.m.crackle || 1);
    cr.connect(hp); hp.connect(cg); cg.connect(out);
    cr.start(s.t0, (pos * 1.37) % 6);
    extra.push(cr);

    song.resume(syn, pos, s.t0);
    this.session = s;
    this._tick();
    clearInterval(this.timer);
    this.timer = setInterval(this._tickBound, 25);
  };

  Engine.prototype._stopSession = function () {
    var s = this.session;
    if (!s) return;
    this.session = null;
    clearInterval(this.timer);
    var now = this.ctx.currentTime;
    s.out.gain.cancelScheduledValues(now);
    s.out.gain.setValueAtTime(s.out.gain.value, now);
    s.out.gain.linearRampToValueAtTime(0, now + 0.06);
    s.fx.gain.setTargetAtTime(0, now, 0.02);
    setTimeout(function () {
      s.extra.forEach(function (n) { try { n.stop(); } catch (e) { /* not started */ } });
      s.out.disconnect();
      s.fx.disconnect();
    }, 150);
  };

  Engine.prototype._tick = function () {
    var s = this.session;
    if (!s) return;
    var c = this.ctx, song = this.song, now = c.currentTime;
    var until = now + (document.hidden ? 1.6 : 0.2);
    while (s.n < song.totalSteps) {
      var at = s.t0 + (s.n * song.step - s.p0);
      if (at > until) break;
      if (at >= now - 0.02) song.schedule(this.syn, s.n, Math.max(at, now));
      s.n++;
    }
    if (this.position() >= song.duration - 0.01) {
      this._stopSession();
      this.playing = false;
      this.offset = song.duration;
      this._emit('state');
      this._emit('ended');
    }
  };

  window.VinylEngine = Engine;
  window.VinylSong = Song;
  window.VinylSynth = Synth;
})();
