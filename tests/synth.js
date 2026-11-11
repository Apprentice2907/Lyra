/* Test signals with known answers (tempo, key, structure). */
'use strict';
var SR = require('../js/encore/dsp.js').SR;

function rng(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function hit(x, t, amp, freq, decay, r) {
  var s0 = Math.floor(t * SR), len = Math.floor(decay * 6 * SR);
  for (var i = 0; i < len && s0 + i < x.length; i++) {
    var tt = i / SR, env = Math.exp(-tt / decay);
    x[s0 + i] += amp * env * (freq ? Math.sin(2 * Math.PI * freq * tt * (1 + 2 * Math.exp(-tt / 0.02))) : hp(r));
  }
}

// high-passed noise (second difference): a hat has almost nothing below a few hundred Hz
var hpState = [0, 0];
function hp(r) {
  var v = r() * 2 - 1, out = (v - 2 * hpState[0] + hpState[1]) / 4;
  hpState[1] = hpState[0]; hpState[0] = v;
  return out * 2;
}

// Kick on every beat, hat on the off-beats, a little noise.
function clickTrack(bpm, seconds, seed) {
  var n = Math.floor(seconds * SR), x = new Float32Array(n), r = rng(seed || 1), period = 60 / bpm;
  for (var t = 0.05; t < seconds; t += period) {
    hit(x, t, 0.9, 60, 0.12);
    hit(x, t + period / 2, 0.35, 0, 0.03, r);
  }
  for (var i = 0; i < n; i++) x[i] += (r() - 0.5) * 0.01;
  return x;
}

// Sustained chords (three harmonics per note), one chord per bar, soft edges.
function chordProgression(chords, barSec, bars) {
  var n = Math.floor(barSec * bars * SR), x = new Float32Array(n);
  for (var b = 0; b < bars; b++) {
    var notes = chords[b % chords.length], s0 = Math.floor(b * barSec * SR), s1 = Math.floor((b + 1) * barSec * SR);
    notes.forEach(function (midi) {
      var f = 440 * Math.pow(2, (midi - 69) / 12);
      for (var i = s0; i < s1; i++) {
        var tt = (i - s0) / SR, env = Math.min(1, tt / 0.02) * Math.min(1, (s1 - i) / (0.02 * SR));
        x[i] += 0.12 * env * (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(4 * Math.PI * f * tt) + 0.2 * Math.sin(6 * Math.PI * f * tt));
      }
    });
  }
  return x;
}

module.exports = { SR: SR, rng: rng, clickTrack: clickTrack, chordProgression: chordProgression };
