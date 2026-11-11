/* DSP checks on signals whose answers are known.  Run: node --test tests/ */
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var DSP = require('../js/encore/dsp.js');

var S = require('./synth.js');
var SR = S.SR, rng = S.rng, clickTrack = S.clickTrack, chordProgression = S.chordProgression;

test('FFT matches a naive DFT', function () {
  var p = DSP._internal.plan(64), r = rng(7), re = new Float64Array(64), im = new Float64Array(64);
  var xr = [], xi = [];
  for (var i = 0; i < 64; i++) { re[i] = r() - 0.5; im[i] = r() - 0.5; xr.push(re[i]); xi.push(im[i]); }
  DSP._internal.fft(p, re, im);
  for (var k = 0; k < 64; k++) {
    var sr = 0, si = 0;
    for (var t = 0; t < 64; t++) {
      var a = -2 * Math.PI * k * t / 64;
      sr += xr[t] * Math.cos(a) - xi[t] * Math.sin(a);
      si += xr[t] * Math.sin(a) + xi[t] * Math.cos(a);
    }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, 'bin ' + k);
  }
});

test('two real frames from one complex FFT: right peaks, unit magnitude', function () {
  var n = 2048, x = new Float32Array(n * 2), p = DSP._internal.plan(n);
  var f1 = 440, f2 = 1000;
  for (var i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f1 * i / SR);
  for (i = n; i < 2 * n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f2 * i / SR);
  var m1 = new Float64Array(n / 2 + 1), m2 = new Float64Array(n / 2 + 1);
  DSP._internal.spectra2(p, x, 0, n, m1, m2);
  function peak(m) { var b = 0; for (var k = 1; k < m.length; k++) if (m[k] > m[b]) b = k; return b; }
  assert.equal(peak(m1), Math.round(f1 * n / SR));
  assert.equal(peak(m2), Math.round(f2 * n / SR));
  assert.ok(Math.abs(m1[peak(m1)] - 1) < 0.2, 'full-scale sine ≈ 1, got ' + m1[peak(m1)]);
  assert.ok(Math.abs(m2[peak(m2)] - 0.5) < 0.1);
});

[78, 96, 120, 128, 140, 174].forEach(function (bpm) {
  test('tempo of a ' + bpm + ' BPM click track', function () {
    var f = DSP.analyze(clickTrack(bpm, 40, bpm), SR);
    var ratio = f.bpm / bpm;
    // a tempo estimator may answer in the neighbouring octave; anything else is wrong
    var ok = [0.5, 1, 2].some(function (k) { return Math.abs(ratio / k - 1) < 0.02; });
    assert.ok(ok, 'expected ' + bpm + ' (or ×½ / ×2), got ' + f.bpm);
    assert.ok(f.pulse > 0.2, 'a click track has a clear pulse, got ' + f.pulse);
    assert.ok(Math.abs(f.kickRate / (bpm / 60) - 1) < 0.15, 'one kick per beat, got ' + f.kickRate + '/s');
  });
});

test('tempo is in the same octave for typical pop tempos', function () {
  [96, 110, 120, 128].forEach(function (bpm) {
    var f = DSP.analyze(clickTrack(bpm, 40, bpm + 1), SR);
    assert.ok(Math.abs(f.bpm / bpm - 1) < 0.02, bpm + ' → ' + f.bpm);
  });
});

test('key: I–IV–V–I in all 12 major keys and i–iv–V–i in all 12 minor keys', function () {
  var bad = [];
  for (var k = 0; k < 12; k++) {
    var r = 48 + k;
    var major = [[r, r + 4, r + 7, r + 12], [r + 5, r + 9, r + 12, r + 17], [r + 7, r + 11, r + 14, r + 19], [r, r + 4, r + 7, r + 16]];
    var minor = [[r, r + 3, r + 7, r + 12], [r + 5, r + 8, r + 12, r + 17], [r + 7, r + 11, r + 14, r + 19], [r, r + 3, r + 7, r + 15]];
    var fM = DSP.analyze(chordProgression(major, 2, 8), SR);
    var fm = DSP.analyze(chordProgression(minor, 2, 8), SR);
    if (fM.key !== k % 12 || fM.mode !== 1) bad.push(DSP.NOTES[k] + ' major → ' + DSP.NOTES[fM.key] + (fM.mode ? ' major' : ' minor'));
    if (fm.key !== k % 12 || fm.mode !== 0) bad.push(DSP.NOTES[k] + ' minor → ' + DSP.NOTES[fm.key] + (fm.mode ? ' major' : ' minor'));
  }
  assert.deepEqual(bad, []);
});

test('camelot codes and key distance', function () {
  assert.equal(DSP.analyze(chordProgression([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], 2, 8), SR).camelot, '8B');
  assert.equal(DSP.keyDistance('8B', '8B'), 0);
  assert.equal(DSP.keyDistance('8B', '8A'), 1);      // relative minor
  assert.equal(DSP.keyDistance('8B', '9B'), 1);      // neighbour
  assert.equal(DSP.keyDistance('1A', '12A'), 1);     // wraps around
  assert.equal(DSP.keyDistance('8B', '2B'), 6);      // opposite side
});

test('a sustained pad has (almost) no onsets or kicks', function () {
  var pad = DSP.analyze(chordProgression([[57, 60, 64], [53, 57, 60]], 3, 10), SR);
  assert.ok(pad.onsetRate < 0.6, 'onsets ' + pad.onsetRate);   // only the chord changes
  assert.ok(pad.kickRate < 0.4, 'kicks ' + pad.kickRate);     // at most the chord changes (one per 3 s)
});

test('percussive share: drums score higher than a sustained pad', function () {
  var drums = DSP.analyze(clickTrack(120, 30, 3), SR);
  var pad = DSP.analyze(chordProgression([[57, 60, 64], [53, 57, 60]], 2, 15), SR);
  assert.ok(drums.perc > pad.perc + 0.3, 'drums ' + drums.perc + ' vs pad ' + pad.perc);
});

test('structure: a 20 s quiet intro is found, and the hook lands in the loud part', function () {
  var secs = 90, n = secs * SR, x = new Float32Array(n);
  var loud = clickTrack(120, secs, 9), pad = chordProgression([[57, 60, 64], [53, 57, 60]], 2, secs / 2);
  for (var i = 0; i < n; i++) x[i] = i < 20 * SR ? pad[i] * 0.15 : loud[i] + pad[i];
  var f = DSP.analyze(x, SR);
  assert.ok(Math.abs(f.intro - 20) <= 2, 'intro ' + f.intro);
  assert.ok(f.hook >= 18, 'hook ' + f.hook);
  assert.equal(f.curve.length, 32);
  assert.ok(f.curve[2] < f.curve[20], 'curve rises after the intro');
});

test('resampling from 44.1 kHz keeps the tempo', function () {
  var x11 = clickTrack(120, 30, 4), x44 = new Float32Array(x11.length * 4);
  for (var i = 0; i < x44.length; i++) x44[i] = x11[Math.floor(i / 4)];
  var f = DSP.analyze(x44, 44100);
  assert.ok(Math.abs(f.bpm / 120 - 1) < 0.02, 'got ' + f.bpm);
});

test('describe(): descriptors are 0..1 and ordered sensibly', function () {
  var fast = DSP.describe(DSP.analyze(clickTrack(140, 30, 5), SR));
  var slow = DSP.describe(DSP.analyze(chordProgression([[57, 60, 64], [53, 57, 60]], 3, 10), SR));
  ['energy', 'arousal', 'valence', 'dance', 'acoustic'].forEach(function (k) {
    assert.ok(fast[k] >= 0 && fast[k] <= 1 && slow[k] >= 0 && slow[k] <= 1, k);
  });
  assert.ok(fast.arousal > slow.arousal, 'drums at 140 BPM are more arousing than a slow pad');
  assert.ok(slow.acoustic > fast.acoustic);
  assert.ok(fast.dance > slow.dance);
  assert.ok(slow.tempoConf < 0.2 && fast.tempoConf === 1, 'a pad has no reliable tempo');
  assert.equal(DSP.describe({ v: 999 }), null, 'unknown versions are ignored');
});

test('tempo distance folds octaves', function () {
  assert.equal(DSP.tempoDistance(120, 120), 0);
  assert.ok(DSP.tempoDistance(120, 60) < 1e-9);
  assert.ok(DSP.tempoDistance(120, 240) < 1e-9);
  assert.ok(DSP.tempoDistance(120, 85) > 0.9);      // ~half an octave: the furthest apart
  assert.ok(DSP.tempoDistance(120, 126) < 0.2);
});

test('rejects clips that are too short', function () {
  assert.throws(function () { DSP.analyze(new Float32Array(SR * 3), SR); });
});
