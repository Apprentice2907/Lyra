/* Encore DSP: what a song sounds like, measured on the device.

   Input: mono samples. The app decodes JioSaavn's 12 kbps stream (about
   440 KB a song), which carries almost nothing above ~3.8 kHz, so the work
   happens at 11025 Hz without losing anything that is there.

   analyze(samples, sampleRate) → raw measurements (versioned, cacheable)
   describe(raw)                → 0..1 descriptors (energy, valence, …) made
                                  from the raw values and the reference stats
                                  in REF, so recalibrating never needs a
                                  re-analysis.

   Everything here is plain signal processing with documented formulas. The
   high-level descriptors (energy, danceability, acousticness, arousal,
   valence) are interpretable heuristics from the music-psychology
   literature; a trained model can replace them later without touching the
   recommender, which only reads describe()'s output.

   Runs in a Web Worker (dsp-worker.js) and in Node for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EncoreDSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var SR = 11025;
  var NYQ_USED = 3800;            // the 12 kbps stream is empty above ~3.8 kHz

  /* Reference statistics of raw values over a sample of the catalogue
     (tools/calibrate-dsp.js prints this block). Used only by describe(). */
  var REF = {
    n: 48,                        // 48 songs from the app's playlists + mood searches, 12 kbps, 2026-11-11
    bpm:       { m: 116,    s: 27 },
    pulse:     { m: 0.445,  s: 0.12 },
    onsetRate: { m: 6.17,   s: 0.59 },
    kickRate:  { m: 5.95,   s: 1.2 },
    perc:      { m: 0.332,  s: 0.085 },
    loud:      { m: -11.5,  s: 2 },
    dyn:       { m: 6.62,   s: 3.2 },
    centroid:  { m: 1040,   s: 170 },
    flat:      { m: 0.0306, s: 0.02 },
    bright:    { m: 0.0875, s: 0.057 },
    harm:      { m: 0.0892, s: 0.021 }
  };

  var NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Krumhansl–Kessler key profiles (probe-tone ratings, 1982)
  var KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
  function round(v, d) { var k = Math.pow(10, d || 0); return Math.round(v * k) / k; }

  /* ───────────── FFT (radix-2, complex, in place) ───────────── */

  var plans = {};
  function plan(n) {
    if (plans[n]) return plans[n];
    var bits = Math.round(Math.log(n) / Math.LN2);
    var rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), i;
    for (i = 0; i < n; i++) {
      var r = 0, x = i;
      for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    for (i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    var win = new Float64Array(n), wsum = 0;
    for (i = 0; i < n; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); wsum += win[i]; }
    return (plans[n] = {
      n: n, rev: rev, cos: cos, sin: sin, win: win,
      norm: 2 / wsum,                       // a full-scale sine reads as magnitude 1
      re: new Float64Array(n), im: new Float64Array(n)
    });
  }

  function fft(p, re, im) {
    var n = p.n, rev = p.rev, i, j, k, t;
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (i = 0; i < n; i += size) {
        for (j = 0, k = 0; j < half; j++, k += step) {
          var a = i + j, b = a + half, wr = p.cos[k], wi = p.sin[k];
          var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /* Magnitude spectra (bins 0..n/2) of two real frames starting at s1 and s2,
     from one complex FFT: frame 1 in the real part, frame 2 in the imaginary
     part, then  F1 = (X[k] + conj X[n−k]) / 2,  F2 = (X[k] − conj X[n−k]) / 2i.
     s2 < 0 means "no second frame". */
  function spectra2(p, x, s1, s2, m1, m2) {
    var n = p.n, re = p.re, im = p.im, win = p.win, len = x.length, i, a, b;
    for (i = 0; i < n; i++) {
      a = s1 + i;
      b = s2 + i;
      re[i] = a >= 0 && a < len ? x[a] * win[i] : 0;
      im[i] = s2 >= 0 && b >= 0 && b < len ? x[b] * win[i] : 0;
    }
    fft(p, re, im);
    var h = n >> 1, nm = p.norm * 0.5;
    for (var k = 0; k <= h; k++) {
      var nk = (n - k) & (n - 1);
      var xr = re[k], xi = im[k], yr = re[nk], yi = im[nk];
      var ar = xr + yr, ai = xi - yi, br = xi + yi, bi = yr - xr;
      m1[k] = Math.sqrt(ar * ar + ai * ai) * nm;
      if (m2) m2[k] = Math.sqrt(br * br + bi * bi) * nm;
    }
  }

  /* ───────────── helpers ───────────── */

  // Any sample rate → 11025 Hz. The source is band-limited to ~3.8 kHz, so a
  // short averaging pre-filter plus linear interpolation is enough.
  function resample(x, sr) {
    if (sr === SR) return x;
    var ratio = sr / SR, n = Math.floor(x.length / ratio), out = new Float32Array(n);
    var taps = Math.max(1, Math.round(ratio));
    for (var i = 0; i < n; i++) {
      var pos = i * ratio, j = Math.floor(pos), f = pos - j, acc = 0, c = 0;
      for (var t = 0; t < taps; t++) {
        var q = j + t - (taps >> 1);
        if (q >= 0 && q + 1 < x.length) { acc += x[q] * (1 - f) + x[q + 1] * f; c++; }
      }
      out[i] = c ? acc / c : 0;
    }
    return out;
  }

  function percentile(arr, q) {
    if (!arr.length) return 0;
    var s = Array.prototype.slice.call(arr).sort(function (a, b) { return a - b; });
    var pos = clamp(q, 0, 1) * (s.length - 1), i = Math.floor(pos), f = pos - i;
    return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i];
  }

  function meanStd(arr) {
    var n = arr.length, m = 0, v = 0, i;
    if (!n) return { m: 0, s: 0 };
    for (i = 0; i < n; i++) m += arr[i];
    m /= n;
    for (i = 0; i < n; i++) v += (arr[i] - m) * (arr[i] - m);
    return { m: m, s: Math.sqrt(v / n) };
  }

  function movingAverage(x, half) {
    var n = x.length, out = new Float64Array(n), acc = 0, lo = 0, hi = -1;
    for (var i = 0; i < n; i++) {
      var a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
      while (hi < b) acc += x[++hi];
      while (lo < a) acc -= x[lo++];
      out[i] = acc / (hi - lo + 1);
    }
    return out;
  }

  function db(p) { return 10 * Math.log(p + 1e-12) / Math.LN10; }

  // median of the first `count` values of src (insertion sort; count is small)
  var tmpSort = new Float64Array(64);
  function medianOf(src, count) {
    for (var i = 0; i < count; i++) {
      var v = src[i], j = i - 1;
      while (j >= 0 && tmpSort[j] > v) { tmpSort[j + 1] = tmpSort[j]; j--; }
      tmpSort[j + 1] = v;
    }
    return tmpSort[count >> 1];
  }

  /* ───────────── tempo ───────────── */

  /* Global tempo from the autocorrelation of the onset envelope, weighted by
     a log-normal prior around 120 BPM (σ = 1 octave), as in librosa's
     estimator; the peak is refined by parabolic interpolation.
     pulse = normalised autocorrelation at the beat lag (pulse clarity). */
  function tempo(env, fps) {
    var n = env.length;
    var minLag = Math.floor(fps * 60 / 220), maxLag = Math.ceil(fps * 60 / 40);
    if (n < maxLag * 4) return { bpm: 0, pulse: 0, alt: 0 };
    var ms = meanStd(env), e = new Float64Array(n), i, lag;
    for (i = 0; i < n; i++) e[i] = env[i] - ms.m;
    var ac = new Float64Array(maxLag + 2);
    for (lag = 0; lag <= maxLag + 1; lag++) {
      var s = 0;
      for (i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
      ac[lag] = s / (n - lag);
    }
    var r0 = ac[0] || 1, best = -1, bestScore = -Infinity, peaks = [];
    for (lag = minLag; lag <= maxLag; lag++) {
      var r = ac[lag] / r0;
      if (!(ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue;
      var bpm = 60 * fps / lag, oct = Math.log(bpm / 120) / Math.LN2;
      var score = r * Math.exp(-0.5 * oct * oct);
      peaks.push({ lag: lag, score: score });
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    if (best < 0) return { bpm: 0, pulse: 0, alt: 0 };
    var y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1], den = y0 - 2 * y1 + y2;
    var lagF = best + (den < 0 ? clamp(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0);
    var bpmBest = 60 * fps / lagF;
    // the strongest peak that is not the same beat (for octave-robust matching)
    var alt = 0, altScore = -Infinity;
    peaks.forEach(function (p) {
      var b = 60 * fps / p.lag;
      if (Math.abs(Math.log(b / bpmBest) / Math.LN2) > 0.15 && p.score > altScore) { altScore = p.score; alt = b; }
    });
    return { bpm: bpmBest, pulse: clamp(ac[best] / r0, 0, 1), alt: alt };
  }

  /* Onsets per second: local maxima above a local mean plus a margin, and
     above an absolute floor so a steady pad's tiny wiggles never count
     (measured: a sustained pad stays under 0.05 full-band / 0.2 low-band,
     a real ballad's onsets sit at 0.13–0.36 / 0.4–0.7). */
  function onsetRate(env, fps, activeSec, absFloor, relFloor) {
    var n = env.length, ms = meanStd(env), loc = movingAverage(env, Math.round(fps * 0.25));
    // salient peaks only: above the absolute floor and a share of the song's own strongest onsets
    var floor = Math.max(absFloor, relFloor * percentile(env, 0.99));
    var minGap = Math.round(fps * 0.07), last = -minGap, count = 0, w = 3;
    for (var i = w; i < n - w; i++) {
      var v = env[i];
      if (v < floor || v <= loc[i] + 0.35 * ms.s) continue;
      var isMax = true;
      for (var k = 1; k <= w && isMax; k++) if (env[i - k] > v || env[i + k] > v) isMax = false;
      if (!isMax || i - last < minGap) continue;
      last = i;
      count++;
    }
    return activeSec > 1 ? count / activeSec : 0;
  }

  /* ───────────── key ───────────── */

  function pearson(a, b, rot) {
    var ma = 0, mb = 0, i;
    for (i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    var num = 0, da = 0, dbb = 0;
    for (i = 0; i < 12; i++) {
      var x = a[(i + rot) % 12] - ma, y = b[i] - mb;
      num += x * y; da += x * x; dbb += y * y;
    }
    return da && dbb ? num / Math.sqrt(da * dbb) : 0;
  }

  // Krumhansl–Schmuckler: correlate the chroma with all 24 rotated profiles.
  function keyOf(chroma) {
    var scores = [];
    for (var k = 0; k < 12; k++) {
      scores.push({ key: k, mode: 1, r: pearson(chroma, KK_MAJOR, k) });
      scores.push({ key: k, mode: 0, r: pearson(chroma, KK_MINOR, k) });
    }
    scores.sort(function (a, b) { return b.r - a.r; });
    return { key: scores[0].key, mode: scores[0].mode, strength: scores[0].r, conf: scores[0].r - scores[1].r };
  }

  // Camelot wheel position: 1..12 plus A (minor) / B (major).
  function camelot(key, mode) {
    var majorNum = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];  // C, C#, D, … in major
    var num = mode ? majorNum[key] : majorNum[(key + 3) % 12];   // relative major
    return { num: num, letter: mode ? 'B' : 'A' };
  }

  /* ───────────── analysis ───────────── */

  function analyze(input, sampleRate) {
    var x = resample(input, sampleRate || SR);
    var len = x.length, dur = len / SR, i, k, f;
    if (dur < 8) throw new Error('too short to analyse');

    /* Pass A: 512-point frames, 128 hop (86 frames/s) → onset envelope,
       low-band (kick) flux, and frame loudness. HPSS excerpts are taken
       from the same spectra. */
    var pA = plan(512), hopA = 128, fpsA = SR / hopA, binHz = SR / 512;
    var kTop = Math.round(NYQ_USED / binHz), kLow = Math.round(150 / binHz);
    var nA = Math.floor(len / hopA) + 1;
    var env = new Float32Array(nA), kick = new Float32Array(nA), rmsDb = new Float32Array(nA);
    var m1 = new Float64Array(257), m2 = new Float64Array(257);
    var prev = new Float64Array(257), cur = new Float64Array(257), first = true;

    // HPSS excerpts: three 15 s windows (30 %, 55 %, 80 % into the song), every other frame
    var exLen = Math.min(Math.round(15 * fpsA / 2), Math.floor(nA / 8));
    var exStarts = [0.3, 0.55, 0.8].map(function (q) { return Math.max(0, Math.round(nA * q) - exLen); });
    var exMat = new Float32Array(3 * exLen * kTop), exAt = new Int32Array(nA).fill(-1);
    exStarts.forEach(function (s, e) { for (var j = 0; j < exLen && s + 2 * j < nA; j++) exAt[s + 2 * j] = e * exLen + j; });

    for (i = 0; i < nA; i++) {
      var a = i * hopA - hopA / 2, p = 0;
      for (k = 0; k < hopA; k++) { var q = a + k; if (q >= 0 && q < len) p += x[q] * x[q]; }
      rmsDb[i] = db(p / hopA);
    }

    function onFrameA(fi, mag) {
      var flux = 0, lowFlux = 0, j;
      for (j = 1; j < kTop; j++) {
        cur[j] = Math.log(1 + 1000 * mag[j]);
        if (!first) {
          var d = cur[j] - prev[j];
          if (d > 0) { flux += d; if (j <= kLow) lowFlux += d; }
        }
      }
      env[fi] = first ? 0 : flux / kTop;
      kick[fi] = first ? 0 : lowFlux / kLow;
      first = false;
      var t = prev; prev = cur; cur = t;
      var row = exAt[fi];
      if (row >= 0) for (j = 0; j < kTop; j++) exMat[row * kTop + j] = mag[j];
    }
    for (f = 0; f < nA; f += 2) {
      var has2 = f + 1 < nA;
      spectra2(pA, x, f * hopA - 256, has2 ? (f + 1) * hopA - 256 : -1, m1, has2 ? m2 : null);
      onFrameA(f, m1);
      if (has2) onFrameA(f + 1, m2);
    }

    /* Loudness: gated mean power, like a simplified loudness meter
       (absolute gate −60 dBFS, then a relative gate 20 dB below that). */
    var gated = [], pw = 0, cnt = 0;
    for (i = 0; i < nA; i++) if (rmsDb[i] > -60) { pw += Math.pow(10, rmsDb[i] / 10); cnt++; }
    var l1 = cnt ? db(pw / cnt) : -90;
    pw = 0; cnt = 0;
    for (i = 0; i < nA; i++) if (rmsDb[i] > l1 - 20) { pw += Math.pow(10, rmsDb[i] / 10); cnt++; gated.push(rmsDb[i]); }
    var loud = cnt ? db(pw / cnt) : -90;
    var silentFrames = 0;
    for (i = 0; i < nA; i++) if (rmsDb[i] < -50) silentFrames++;
    var activeSec = (nA - silentFrames) / fpsA;

    // per-second loudness and onset density (for structure)
    var secs = Math.floor(dur), secDb = new Float64Array(secs), secOn = new Float64Array(secs);
    for (var s = 0; s < secs; s++) {
      var a0 = Math.round(s * fpsA), a1 = Math.min(nA, Math.round((s + 1) * fpsA)), sp = 0, so = 0;
      for (i = a0; i < a1; i++) { sp += Math.pow(10, rmsDb[i] / 10); so += env[i]; }
      secDb[s] = db(sp / Math.max(1, a1 - a0));
      secOn[s] = so / Math.max(1, a1 - a0);
    }
    var smooth = movingAverage(secDb, 1);
    var loudSecs = [];
    for (s = 0; s < secs; s++) if (secDb[s] > -50) loudSecs.push(secDb[s]);
    var p90 = percentile(loudSecs, 0.9), thr = p90 - 6;
    var dyn = percentile(loudSecs, 0.95) - percentile(loudSecs, 0.1);

    var intro = 0;
    for (s = 0; s + 2 < secs; s++) if (smooth[s] >= thr && smooth[s + 1] >= thr && smooth[s + 2] >= thr) { intro = s; break; }
    var outro = secs;
    for (s = secs - 1; s >= 0; s--) if (smooth[s] >= thr) { outro = s + 1; break; }

    // hook: the 15 s window with the most loudness + rhythmic activity
    var zDb = meanStd(loudSecs), zOn = meanStd(secOn), hook = intro, W = 15, wScores = [];
    var lo = Math.min(intro, Math.max(0, secs - W)), hi = Math.max(lo, Math.min(outro, secs) - W);
    for (s = lo; s <= hi; s++) {
      var sc = 0;
      for (var t = s; t < s + W && t < secs; t++) {
        sc += (secDb[t] - zDb.m) / (zDb.s || 1) + 0.5 * (secOn[t] - zOn.m) / (zOn.s || 1);
      }
      wScores.push(sc);
    }
    if (wScores.length) {
      var wMax = Math.max.apply(null, wScores), wMin = Math.min.apply(null, wScores);
      for (s = 0; s < wScores.length; s++) {
        if (wMax === wMin || (wScores[s] - wMin) / (wMax - wMin) >= 0.85) { hook = lo + s; break; }
      }
    }

    // energy curve: 32 segments, 0..99 over a 30 dB window under the loudness
    var curve = [];
    for (var c = 0; c < 32; c++) {
      var c0 = Math.floor(c * nA / 32), c1 = Math.max(c0 + 1, Math.floor((c + 1) * nA / 32)), cp = 0;
      for (i = c0; i < c1; i++) cp += Math.pow(10, rmsDb[i] / 10);
      curve.push(Math.round(clamp((db(cp / (c1 - c0)) - (loud - 30)) / 30, 0, 0.99) * 100));
    }

    /* Tempo and rhythm from the onset envelope. */
    var tp = tempo(env, fpsA);
    var onsets = onsetRate(env, fpsA, activeSec, 0.1, 0.15);
    var kicks = onsetRate(kick, fpsA, activeSec, 0.3, 0.3);

    /* HPSS-lite on the excerpts (Fitzgerald 2010): harmonic = median across
       time, percussive = median across frequency, soft masks → share of
       energy that is percussive (drums, plucks, hits). */
    var hpE = 0, ppE = 0, L = 8, win = new Float64Array(2 * L + 1);
    for (var e = 0; e < 3; e++) {
      var base = e * exLen;
      for (var r = 0; r < exLen; r++) {
        for (k = 1; k < kTop; k++) {
          var v = exMat[(base + r) * kTop + k];
          if (!v) continue;
          var zz;
          for (zz = 0; zz <= 2 * L; zz++) win[zz] = exMat[(base + clamp(r - L + zz, 0, exLen - 1)) * kTop + k];
          var h = medianOf(win, 2 * L + 1);
          for (zz = 0; zz <= 2 * L; zz++) win[zz] = exMat[(base + r) * kTop + clamp(k - L + zz, 1, kTop - 1)];
          var pc = medianOf(win, 2 * L + 1);
          var h2 = h * h, p2 = pc * pc, tot = h2 + p2 || 1, v2 = v * v;
          hpE += v2 * h2 / tot;
          ppE += v2 * p2 / tot;
        }
      }
    }
    var perc = hpE + ppE ? ppE / (hpE + ppE) : 0;

    /* Pass B: 2048-point frames, 1024 hop → chroma, spectral shape, bands. */
    var pB = plan(2048), hopB = 1024, binB = SR / 2048, nB = Math.floor(len / hopB) + 1;
    var kTopB = Math.round(NYQ_USED / binB);
    var pcOf = new Int8Array(1025), pcW = new Float64Array(1025);
    for (k = 1; k <= 1024; k++) {
      var fr = k * binB;
      if (fr < 80 || fr > 1800) { pcOf[k] = -1; continue; }
      var midi = 69 + 12 * Math.log(fr / 440) / Math.LN2, near = Math.round(midi);
      pcOf[k] = ((near % 12) + 12) % 12;
      pcW[k] = Math.max(0, 1 - 2 * Math.abs(midi - near));      // triangular weight around the note
    }
    var edges = [20, 60, 250, 500, 2000, NYQ_USED], bandK = edges.map(function (hz) { return Math.round(hz / binB); });
    var kBright = Math.round(1500 / binB), k60 = Math.round(60 / binB);

    var chroma = new Float64Array(12), bands = new Float64Array(5);
    var cenAcc = 0, rollAcc = 0, flatAcc = 0, brightAcc = 0, wAcc = 0, harmAcc = 0, harmN = 0;
    var prevC = null;
    var b1 = new Float64Array(1025), b2 = new Float64Array(1025);

    function onFrameB(mag) {
      var tot = 0, j;
      for (j = 2; j < kTopB; j++) tot += mag[j] * mag[j];
      // with this window and normalisation, Σ mag² ≈ 3 × the frame's mean power (Parseval)
      if (db(tot / 3) < loud - 30) return;                        // skip near-silence
      var w = Math.sqrt(tot), cen = 0, msum = 0, logs = 0, ar = 0, nfl = 0, bright = 0;
      for (j = 2; j < kTopB; j++) {
        var m = mag[j], pp = m * m;
        cen += j * binB * m; msum += m;
        if (j >= k60) { logs += Math.log(pp + 1e-12); ar += pp; nfl++; }
        if (j >= kBright) bright += pp;
      }
      var acc = 0, roll = 0;
      for (j = 2; j < kTopB; j++) { acc += mag[j] * mag[j]; if (acc >= 0.85 * tot) { roll = j * binB; break; } }
      for (var bnd = 0; bnd < 5; bnd++) {
        var bs = 0;
        for (j = Math.max(1, bandK[bnd]); j < bandK[bnd + 1]; j++) bs += mag[j] * mag[j];
        bands[bnd] += bs / tot * w;
      }
      var cf = new Float64Array(12), csum = 0;
      for (j = 1; j <= 1024; j++) if (pcOf[j] >= 0) { cf[pcOf[j]] += mag[j] * pcW[j]; }
      for (j = 0; j < 12; j++) csum += cf[j];
      if (csum > 0) {
        for (j = 0; j < 12; j++) { cf[j] /= csum; chroma[j] += cf[j] * w; }
        if (prevC) {
          var dot = 0, na = 0, nb = 0;
          for (j = 0; j < 12; j++) { dot += cf[j] * prevC[j]; na += cf[j] * cf[j]; nb += prevC[j] * prevC[j]; }
          harmAcc += 1 - dot / Math.sqrt(na * nb || 1);
          harmN++;
        }
        prevC = cf;
      }
      cenAcc += (msum ? cen / msum : 0) * w;
      rollAcc += roll * w;
      flatAcc += (nfl && ar ? Math.exp(logs / nfl) / (ar / nfl) : 0) * w;
      brightAcc += bright / tot * w;
      wAcc += w;
    }
    for (f = 0; f < nB; f += 2) {
      var two = f + 1 < nB;
      spectra2(pB, x, f * hopB - 1024, two ? (f + 1) * hopB - 1024 : -1, b1, two ? b2 : null);
      onFrameB(b1);
      if (two) onFrameB(b2);
    }
    wAcc = wAcc || 1;
    var chromaArr = [], cmax = 0;
    for (k = 0; k < 12; k++) cmax = Math.max(cmax, chroma[k]);
    for (k = 0; k < 12; k++) chromaArr.push(round(cmax ? chroma[k] / cmax : 0, 3));
    var ky = keyOf(chromaArr), cam = camelot(ky.key, ky.mode);

    return {
      v: VERSION,
      dur: round(dur, 1),
      bpm: round(tp.bpm, 1),
      bpmAlt: round(tp.alt, 1),
      pulse: round(tp.pulse, 3),
      onsetRate: round(onsets, 2),
      kickRate: round(kicks, 2),
      perc: round(perc, 3),
      loud: round(loud, 1),
      dyn: round(dyn, 1),
      centroid: Math.round(cenAcc / wAcc),
      rolloff: Math.round(rollAcc / wAcc),
      flat: round(flatAcc / wAcc, 4),
      bright: round(brightAcc / wAcc, 4),
      bands: Array.prototype.map.call(bands, function (b) { return round(b / wAcc, 4); }),
      chroma: chromaArr,
      key: ky.key,
      mode: ky.mode,
      keyStrength: round(ky.strength, 3),
      keyConf: round(ky.conf, 3),
      camelot: cam.num + cam.letter,
      harm: round(harmN ? harmAcc / harmN : 0, 3),
      intro: intro,
      outro: outro,
      hook: hook,
      silence: round(silentFrames / nA, 3),
      curve: curve
    };
  }

  /* ───────────── descriptors ───────────── */

  function z(v, r) { return (v - r.m) / (r.s || 1); }

  /* 0..1 descriptors from raw values. Weights follow what the literature
     reports as the strongest cues (Gabrielsson & Lindström 2010; Eerola 2011):
       arousal ← tempo, loudness, onset density, brightness
       valence ← mode (major/minor), tempo, brightness  (weakest from audio
                 alone: expect r ≈ 0.4–0.5 against human ratings at best) */
  function describe(raw) {
    if (!raw || raw.v !== VERSION) return null;
    var R = REF;
    // with no clear pulse (pads, rubato ballads) the tempo number means little
    var tempoConf = clamp((raw.pulse - 0.05) / 0.2, 0, 1);
    var perceived = raw.bpm || R.bpm.m;
    while (perceived >= 150) perceived /= 2;
    while (perceived < 75) perceived *= 2;
    var zt = (perceived - 108) / 20 * tempoConf, zl = z(raw.loud, R.loud), zo = z(raw.onsetRate, R.onsetRate);
    var zp = z(raw.perc, R.perc), zc = z(raw.centroid, R.centroid), zf = z(raw.flat, R.flat);
    var zpu = z(raw.pulse, R.pulse), zk = z(raw.kickRate, R.kickRate), zb = z(raw.bright, R.bright);
    var modeSigned = (raw.mode ? 1 : -1) * clamp(0.4 + raw.keyConf * 6, 0.4, 1);
    // dance tempo bell: 90–130 BPM (octave-folded)
    var bpm = raw.bpm || 110;
    while (bpm > 150) bpm /= 2;
    while (bpm < 75) bpm *= 2;
    var bell = Math.exp(-0.5 * Math.pow((bpm - 112) / 22, 2));
    return {
      energy: round(sigmoid(0.45 * zl + 0.25 * zo + 0.2 * zp + 0.15 * zc + 0.15 * zk), 3),
      arousal: round(sigmoid(0.35 * zt + 0.35 * zl + 0.3 * zo + 0.15 * zb), 3),
      valence: round(sigmoid(0.8 * modeSigned + 0.35 * zt + 0.2 * zb + 0.1 * zl), 3),
      dance: round(sigmoid(0.6 * zpu + 0.35 * zk + 0.25 * zp - 0.3) * (0.55 + 0.45 * bell), 3),
      acoustic: round(sigmoid(-0.55 * zp - 0.35 * zf - 0.3 * zl - 0.2 * zk), 3),
      bpm: raw.bpm,
      tempoConf: round(tempoConf, 2),
      key: NOTES[raw.key] + (raw.mode ? ' major' : ' minor'),
      camelot: raw.camelot,
      // timbre fingerprint for "sounds similar" distance (all roughly z-scaled)
      timbre: [zc, zf, zb, zp].concat(raw.bands.map(function (b) { return b * 4; })).map(function (v) { return round(v, 3); }),
      intro: raw.intro,
      hook: raw.hook
    };
  }

  /* Octave-robust tempo distance in octaves (0 = same, 1 = an octave apart):
     120 vs 60 BPM is a small step for a listener, 120 vs 90 is a big one. */
  function tempoDistance(a, b) {
    if (!a || !b) return 0;
    var d = Math.abs(Math.log(a / b) / Math.LN2) % 1;
    return Math.min(d, 1 - d) * 2;            // 0..1, 1 = a tritone of tempo (×1.41)
  }

  // Steps around the Camelot wheel (0 = same key; adjacent keys mix well).
  function keyDistance(ca, cb) {
    if (!ca || !cb) return 0;
    var na = parseInt(ca, 10), nb = parseInt(cb, 10), la = ca.slice(-1), lb = cb.slice(-1);
    var d = Math.abs(na - nb) % 12;
    d = Math.min(d, 12 - d);
    return d + (la === lb ? 0 : 1);           // 0..7
  }

  return {
    VERSION: VERSION, SR: SR, REF: REF, NOTES: NOTES,
    analyze: analyze, describe: describe, resample: resample,
    tempoDistance: tempoDistance, keyDistance: keyDistance, camelot: camelot,
    _internal: { fft: fft, plan: plan, spectra2: spectra2, tempo: tempo, keyOf: keyOf, onsetRate: onsetRate }
  };
});
