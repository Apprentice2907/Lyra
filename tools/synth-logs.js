/* Synthetic listening logs, calibrated to real behaviour.

   node tools/synth-logs.js [--users 500] [--days 21] [--warmup 30] [--seed 3]
                            [--policy encore|proxy] [--params data/synthetic/params.json]
                            [--out data/synthetic/plays.jsonl] [--exports data/synthetic/exports]
                            [--no-pace]   (Encore without artist pacing, for comparisons)
   node tools/synth-logs.js --calibrate data/public/yambda/stats.json [--rounds 6]
                            [--cal-users 200] [--cal-days 14] [--warmup 30]
                            [--save data/synthetic/params.json]

   Generate in the regime you calibrated (by default: 30 days of warm-up,
   then 21 logged days). Simulated listeners keep changing over longer
   horizons (their library of repeats grows), so for 60 logged days,
   calibrate with --cal-days 60 first.

   What it makes: listeners with hidden traits play songs from a synthetic
   catalogue, day after day, in sessions. Each play becomes an Encore play
   record (the format of the app's "Export data"), so every tool that reads
   your own exports reads these too.

   Two kinds of numbers go in:
   - CALIBRATED to real logs (tools/logstats.js on research/yambda_to_encore.py
     output): listen-through, how fast skips happen, how streaky skipping is,
     session lengths, how often people replay songs and return to old ones,
     same-artist runs, likes, own choices vs recommendations, time of day,
     and how different listeners are from each other.
   - ASSUMED from the literature, because public logs carry no audio
     features: calmer music late at night (Park et al. 2019), mood
     regulation styles (matchers and lifters), sensitivity to big jumps in
     sound. These are the levers Encore's audio features act on.

   Recommendations come from:
   - encore  Encore's real model (js/encore/model.js), one per listener,
             learning online exactly like the app, with propensities logged
   - proxy   a softmax over each listener's true preferences, used while
             calibrating (fast) and as a stand-in for a strong recommender

   Every record carries truth.p: the listener's true chance of hearing it
   through (engaged state). Real logs never have this; it lets you check
   whether an off-policy estimate (IPS, doubly robust) gets the right answer. */
'use strict';
var fs = require('fs');
var path = require('path');
var P = require('../js/encore/profile.js');
var M = require('../js/encore/model.js');
var LS = require('./logstats.js');

/* ───────────── random numbers ───────────── */

function rngOf(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sig(x) { return 1 / (1 + Math.exp(-x)); }
function logit(p) { p = clamp(p, 1e-4, 1 - 1e-4); return Math.log(p / (1 - p)); }
function hash(a, b) {
  var h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
// a fixed standard-normal-ish number for a (listener, thing) pair, without storing it
function hnoise(a, b) { return (hash(a, b) + hash(a, b + 7919) + hash(a + 104729, b) - 1.5) * 2; }
function pickWeighted(r, items, w) {
  var tot = 0, i;
  for (i = 0; i < w.length; i++) tot += w[i];
  var x = r() * tot;
  for (i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return items[i]; }
  return items[items.length - 1];
}

/* ───────────── parameters ─────────────
   Defaults are the result of `--calibrate` (200 listeners per try, 30-day
   warm-up, 14 logged days) against 229,743 real Yambda plays (200 listeners,
   their last 60 days); re-run it on other data to replace them.
   Calibration overfits the listeners it sees (the search exploits their
   quirks): the fit matched on its 200 (seed 1) but a fresh 500 played ~4
   points less through. So bMean was then re-centred on a fresh population
   (seed 2: 0.9 → 1.1), and generation defaults to a third, untouched one
   (seed 3). */

var DEFAULTS = {
  bMean: 1.1, bSd: 1.3,            // how easily each listener is pleased (spread = how different listeners are)
  startBrowse: 0.9,                // a session starts in "browsing" mode (looking for something)
  browsePenalty: 2.9,              // browsing: most songs get skipped
  toBrowse: 0.76, toEngage: 0.59,  // a skip tips into browsing; a full listen settles in
  qBase: 0.06, qSkip: 0,           // chance the session stops after a song (+ after a skip)
  quickA: -0.3, quickB: 0.54,      // a skip is a fast one (< 10 s) more often when the song is far off
  quickMean: 8.83,                 // seconds before a fast skip (capped at 10 s)
  midSkip: 0.17,                   // of the other skips: just after the intro (10-30 s); the rest mid-song
  firstBias: -0.54,                // the first song of a session (often a quick sample, a resume)
  newBias: 0.54,                   // a song the listener has never heard
  pickShare: 0.515,                // sessions the listener drives (own picks); the rest are a recommendation stream
  mixedShare: 0.182,               // sessions that hop between own picks and recommendations (the rest never do)
  modeSwitch: 0.08,                // in a mixed session: chance per song of switching
  sessSd: 0.8,                     // how much one session goes better or worse than another
  repeatPick: 0.54, favPick: 0,    // own choices: an old favourite, a favourite artist, or something new
  albumRun: 0.03,                  // own choices: another song by the artist just played (an album, a playlist)
  albumSession: 0.156,             // own sessions that play one artist or album through
  replay: 0.014,                   // chance a loved song is played again right away
  like: 0.0011, dislike: 0.0053,
  wFav: 1.0, wFam: 0.74, fatigue: 0.4, wMood: 0.35, noise: 0.38,
  recTemp: 0.358,                  // proxy recommender: lower = closer to the listener's true taste
  recDiversity: 1.7,               // proxy recommender: avoids the artist just played (real ones diversify)
  sessPerDay: 1.1,
  blockBias: [-0.37, 0.14, 0.2, 0.06, -0.21]
};

// what calibration may move, with bounds and starting steps
var SPACE = [
  ['bMean', -1, 3, 0.4], ['bSd', 0.3, 3, 0.3], ['startBrowse', 0, 1, 0.15], ['browsePenalty', 0, 5, 0.5],
  ['toBrowse', 0, 1, 0.15], ['toEngage', 0, 1, 0.15], ['qBase', 0.005, 0.3, 0.02], ['qSkip', 0, 0.3, 0.03],
  ['quickA', -3, 4, 0.5], ['quickB', 0, 3, 0.3], ['quickMean', 0.5, 15, 1.5], ['midSkip', 0, 1, 0.1],
  ['firstBias', -3, 2, 0.3], ['newBias', -2, 2, 0.3], ['recDiversity', 0, 5, 0.4],
  ['pickShare', 0.05, 0.95, 0.08], ['mixedShare', 0, 1, 0.1], ['modeSwitch', 0, 0.5, 0.04], ['sessSd', 0, 3, 0.3],
  ['albumRun', 0, 0.8, 0.05], ['albumSession', 0, 0.8, 0.05],
  ['repeatPick', 0, 0.95, 0.1], ['favPick', 0, 0.9, 0.1], ['replay', 0, 0.6, 0.04],
  ['like', 0, 0.05, 0.003], ['dislike', 0, 0.05, 0.003], ['wFav', 0, 3, 0.3], ['wFam', 0, 2, 0.2], ['fatigue', 0, 2, 0.2],
  ['recTemp', 0.05, 2, 0.1], ['noise', 0.1, 1.5, 0.15],
  ['blockBias.0', -1.5, 1, 0.15], ['blockBias.1', -1, 1, 0.15], ['blockBias.2', -1, 1, 0.15], ['blockBias.3', -1, 1, 0.15], ['blockBias.4', -1.5, 1, 0.15]
];

function getP(th, k) { var p = k.split('.'); return p.length > 1 ? th[p[0]][+p[1]] : th[k]; }
function setP(th, k, v) { var p = k.split('.'); if (p.length > 1) th[p[0]][+p[1]] = v; else th[k] = v; }
function copyTheta(th) { return JSON.parse(JSON.stringify(th)); }

// session starts by local hour: from the real logs (Yambda, clock estimated, see research/yambda_to_encore.py)
var HOUR_CURVE = [55843, 39766, 29097, 24435, 25142, 26899, 38877, 61579, 90496, 92596, 99566, 106858,
                  113396, 117216, 121383, 124796, 124087, 123857, 120906, 120322, 108691, 105174, 89913, 71228];

// assumed (literature): what energy / mood listeners reach for in each time block
var POP_ENERGY = [0.33, 0.55, 0.6, 0.55, 0.42];
var POP_VALENCE = [0.38, 0.55, 0.55, 0.5, 0.42];

/* ───────────── catalogue ───────────── */

var LANGS = [['hindi', 0.5], ['punjabi', 0.15], ['english', 0.2], ['tamil', 0.08], ['telugu', 0.07]];

function catalogue(seed, nArtists) {
  var r = rngOf(seed * 7 + 11), artists = [], songs = [], byArtist = [], byLang = {};
  nArtists = nArtists || 600;
  for (var a = 0; a < nArtists; a++) {
    var lang = pickWeighted(r, LANGS.map(function (l) { return l[0]; }), LANGS.map(function (l) { return l[1]; }));
    var art = {
      i: a, lang: lang, e: 0.15 + r() * 0.7, v: 0.15 + r() * 0.7, bpm: clamp(112 + gauss(r) * 25, 65, 180),
      timbre: [0, 0, 0, 0, 0, 0, 0, 0, 0].map(function () { return gauss(r); }),
      pop: 1 / Math.pow(a + 1, 1.05), year: 1985 + Math.floor(Math.pow(r(), 0.6) * 41)
    };
    artists.push(art);
    byArtist.push([]);
    var n = 4 + Math.floor(r() * 10 + art.pop * 300 / (1 + art.pop * 30));
    for (var k = 0; k < n; k++) {
      var e = clamp(art.e + gauss(r) * 0.1, 0.03, 0.98), v = clamp(art.v + gauss(r) * 0.1, 0.03, 0.98), bpm = clamp(art.bpm + gauss(r) * 8, 60, 190);
      var idx = songs.length;
      var feat = {
        energy: e, valence: v, arousal: clamp(0.6 * e + 0.4 * (bpm - 60) / 120 + gauss(r) * 0.05, 0, 1), bpm: bpm, tempoConf: 0.8,
        camelot: (1 + Math.floor(r() * 12)) + (r() < 0.55 ? 'A' : 'B'), dance: clamp(0.5 + gauss(r) * 0.15, 0, 1), acoustic: clamp(1 - e + gauss(r) * 0.1, 0, 1),
        timbre: art.timbre.map(function (t) { return t + gauss(r) * 0.3; }), intro: Math.floor(-Math.log(1 - r() * 0.95) * 12), hook: 30
      };
      var t = {
        id: 'sy:' + idx, title: 'Song ' + idx, artist: 'Artist ' + a, artistIds: ['a' + a], language: lang,
        album: 'Album ' + a + '-' + (k % 3), year: String(art.year), duration: Math.round(clamp(215 + gauss(r) * 50, 90, 480) / 5) * 5,
        playCount: Math.round(1e8 * art.pop * Math.pow(10, gauss(r) * 0.4)), explicit: false
      };
      songs.push({ i: idx, a: a, t: t, feat: feat, pop: art.pop * Math.exp(gauss(r) * 0.5) });
      byArtist[a].push(idx);
      (byLang[lang] = byLang[lang] || []).push(idx);
    }
  }
  return { artists: artists, songs: songs, byArtist: byArtist, byLang: byLang };
}

/* ───────────── listeners ───────────── */

function makeUser(i, th, cat, r) {
  var main = pickWeighted(r, LANGS.map(function (l) { return l[0]; }), LANGS.map(function (l) { return l[1]; }));
  var langW = {};
  LANGS.forEach(function (l) { langW[l[0]] = l[0] === main ? 1 : r() < 0.35 ? 0.3 + r() * 0.5 : 0; });
  // favourite artists: popular ones in their languages, plus a couple of niche ones
  var pool = cat.artists.filter(function (a) { return langW[a.lang] > 0; });
  var favs = {}, nf = 5 + Math.floor(r() * 8);
  for (var k = 0; k < nf && pool.length; k++) {
    var a = pickWeighted(r, pool, pool.map(function (x) { return Math.pow(x.pop, 0.6) * langW[x.lang]; }));
    favs[a.i] = 1;
  }
  return {
    id: 'sy' + i, n: i, seed: 1000003 * (i + 1), langs: langW, main: main, favs: favs, favList: Object.keys(favs).map(Number),
    b: th.bMean + th.bSd * gauss(r), chrono: gauss(r) * 1.5, sessRate: th.sessPerDay * Math.exp(0.5 * gauss(r)),
    pick: clamp(th.pickShare + 0.15 * gauss(r), 0.03, 0.97), quit: sig(logit(th.qBase) + 0.5 * gauss(r)),
    energy: POP_ENERGY.map(function (e) { return clamp(e + 0.1 * gauss(r), 0.05, 0.95); }),
    valence: POP_VALENCE.map(function (v) { return clamp(v + 0.1 * gauss(r), 0.05, 0.95); }),
    lifter: r() < 0.4, tau: r() * 1.2, novelty: 0.3 * gauss(r),
    likeP: th.like * Math.exp(0.7 * gauss(r)), dislikeP: th.dislike * Math.exp(0.7 * gauss(r)), replayP: th.replay * Math.exp(0.5 * gauss(r)),
    heard: {}, fav: []                 // track index → { n, last }, and the most-heard list
  };
}

function artistLove(u, th, cat, a) {
  var art = cat.artists[a];
  if (u.favs[a]) return th.wFav + 0.3 * hnoise(u.seed, a);
  return (u.langs[art.lang] ? 0.35 * u.langs[art.lang] - 0.2 : -0.8) + 0.4 * hnoise(u.seed, a);
}
function trackLove(u, th, cat, s) { return artistLove(u, th, cat, s.a) + 0.45 * hnoise(u.seed + 17, s.i); }

/* The listener's true expected utility of song s now (no mood swings, no
   browsing): the policy-independent "how good is this pick". */
function utility(u, th, cat, s, ctx, prev, now) {
  var f = s.feat, b = ctx.block, v = u.b + th.blockBias[b] + trackLove(u, th, cat, s);
  v += th.wMood * ((0.25 - Math.abs(f.energy - u.energy[b])) / 0.25 * 0.6 + (0.25 - Math.abs(f.valence - u.valence[b])) / 0.25 * 0.4);
  if (prev) {
    v -= u.tau * 1.2 * P.soundGap(prev.feat, f);
    if (prev.feat.valence < 0.4) {
      var dv = f.valence - prev.feat.valence;
      v += u.lifter ? 0.5 * clamp(dv / 0.2, -1, 1.5) : -0.4 * Math.abs(dv) / 0.2;
    }
  }
  var h = u.heard[s.i];
  if (h) {
    v += th.wFam * Math.min(1, Math.log(1 + h.n) / 2);
    if (now - h.last < 2 * 3600e3) v -= th.fatigue;
  } else {
    v += th.newBias;
    if (!u.artistHeard || !u.artistHeard[s.a]) v += u.novelty;
  }
  return v;
}

/* ───────────── choosing songs ───────────── */

function ownChoice(u, th, cat, r, cur, albumMode) {
  if (cur && r() < (albumMode ? 0.8 : th.albumRun)) {
    // keep going with the same artist (an album, an artist's playlist)
    var same = cat.byArtist[cur.a];
    return cat.songs[same[Math.floor(r() * same.length)]];
  }
  var x = r();
  if (x < th.repeatPick && u.fav.length) {
    // an old favourite: the most-heard songs, most often
    var top = u.fav.slice(0, 60);
    return cat.songs[pickWeighted(r, top, top.map(function (i) { return Math.sqrt(u.heard[i].n); }))];
  }
  if (x < th.repeatPick + th.favPick) {
    var a = u.favList[Math.floor(r() * u.favList.length)], list = cat.byArtist[a];
    return cat.songs[list[Math.floor(r() * list.length)]];
  }
  // something new in their language, popular songs more likely (search, charts)
  var langs = Object.keys(u.langs).filter(function (l) { return u.langs[l] > 0; });
  var lang = pickWeighted(r, langs, langs.map(function (l) { return u.langs[l]; }));
  var pool = cat.byLang[lang];
  for (var tries = 0; tries < 8; tries++) {
    var s = cat.songs[pool[Math.floor(r() * pool.length)]];
    if (r() < 0.15 + Math.pow(s.pop, 0.4)) return s;
  }
  return cat.songs[pool[Math.floor(r() * pool.length)]];
}

// the same kind of candidate pool Encore builds in the app (encore.js _sources)
function candidates(u, cat, cur, ses, r) {
  var out = [], seen = {};
  function add(i, src) {
    if (seen[i] || ses.ids.indexOf(i) >= 0 || (cur && i === cur.i)) return;
    seen[i] = 1;
    var s = cat.songs[i];
    out.push({ t: s.t, feat: s.feat, src: src, s: s });
  }
  if (cur) cat.byArtist[cur.a].slice(0, 12).forEach(function (i) { add(i, 'artist'); });
  u.favList.slice(0, 3).forEach(function (a) { cat.byArtist[a].slice(0, 6).forEach(function (i) { add(i, 'taste'); }); });
  u.fav.slice(0, 20).forEach(function (i) { add(i, 'familiar'); });
  var pool = cat.byLang[cur ? cur.t.language : u.main], k;
  for (k = 0; k < 15; k++) add(pool[Math.floor(r() * pool.length)], 'context');
  for (k = 0; k < 10; k++) add(Math.floor(r() * cat.songs.length), 'explore');
  return out;
}

/* ───────────── one listener's days ───────────── */

var DAY = 864e5;

function simulateUser(u, th, cat, opts, r, emit) {
  var start = opts.start, enc = opts.policy === 'encore', prof = null, model = null;
  var hourW = HOUR_CURVE.slice();
  if (enc) { prof = P.create(start); model = M.create(); }
  u.artistHeard = {};
  // warm-up: the listener (and Encore) live through `warmup` days before logging
  // starts, like the real sample, which is the last weeks of long histories
  var warm = opts.warmup || 0, logged = emit;
  for (var d = -warm; d < opts.days; d++) {
    emit = d >= 0 ? logged : function () {};
    // sessions today: Poisson(sessRate)
    var nS = 0, L = Math.exp(-u.sessRate), pp = 1, x = r();
    while (x > L && nS < 8) { nS++; pp *= r(); x = pp; }
    var times = [];
    for (var k = 0; k < nS; k++) {
      var h = pickWeighted(r, HOUR_CURVE.map(function (_, i) { return i; }), hourW);
      times.push(start + d * DAY + ((h + u.chrono + r() + 24) % 24) * 3600e3);
    }
    times.sort(function (a, b) { return a - b; });
    var lastEnd = 0;
    times.forEach(function (t0, si) {
      var t = Math.max(t0, lastEnd + 31 * 60e3);      // keep sessions apart (the converter splits at 30 min)
      var ses = { id: u.id + '-' + d + '-' + si, ids: [], artists: [], skips: [], titles: [], valence: null, energy: null, pos: 0, prevSkip: false };
      var browsing = r() < th.startBrowse, cur = null, prevPlay = null, replayNext = false;
      // a session is either driven by the listener's own picks or a recommendation stream;
      // most sessions stay that way, a few ("mixed") hop between the two
      var ownMode = r() < u.pick, mixed = r() < th.mixedShare;
      // own sessions sometimes play one artist or album through
      var albumMode = ownMode && r() < th.albumSession;
      // some sessions just go better or worse than others (mood, setting, attention)
      var sessBias = th.sessSd * gauss(r);
      for (var guard = 0; guard < 250; guard++) {
        var ctx = P.context(t), song, how, src, recInfo = null, x0 = null, stateAt = null, cand = null;
        // switching keeps this listener's own balance: out of own picks ∝ (1 − pick), back ∝ pick
        if (mixed && guard > 0 && r() < 2 * th.modeSwitch * (ownMode ? 1 - u.pick : u.pick)) ownMode = !ownMode;
        if (replayNext && cur) { song = cur; how = 'pick'; src = 'organic'; }
        else if (ownMode) { song = ownChoice(u, th, cat, r, cur, albumMode); how = 'pick'; src = 'organic'; }
        else {
          var cands = candidates(u, cat, cur, ses, r);
          if (!cands.length) { song = ownChoice(u, th, cat, r, cur, false); how = 'pick'; src = 'organic'; }
          else if (enc) {
            stateAt = { ctx: ctx, prof: prof, cur: cur ? cur.t : null, curFeat: cur ? cur.feat : null, session: ses, liked: function () { return false; }, inPlaylist: function () { return false; }, mode: 'auto' };
            var res = M.rank(model, stateAt, cands, { rng: r, draws: opts.draws, margin: 0.1, pace: opts.pace !== false });
            var top = res.list[0];
            song = top.cand.s; cand = top.cand; x0 = top.x; how = 'encore'; src = 'rec';
            recInfo = { prop: top.prop, rank: res.list.slice().sort(function (a, b) { return b.mean - a.mean; }).indexOf(top), n: res.list.length, src: top.cand.src, lam: Math.round(res.lam * 1e4) / 1e4 };
          } else {
            // proxy: softmax over the listener's true utility, steering away from the artist just played
            var us = cands.map(function (c) {
              return (utility(u, th, cat, c.s, ctx, cur, t) - (cur && c.s.a === cur.a ? th.recDiversity : 0)) / th.recTemp;
            });
            var mx = Math.max.apply(null, us), w = us.map(function (v) { return Math.exp(v - mx); }), tot = w.reduce(function (a, b) { return a + b; }, 0);
            var c = pickWeighted(r, cands, w), ci = cands.indexOf(c);
            song = c.s; how = 'encore'; src = 'rec'; recInfo = { prop: Math.round(w[ci] / tot * 1e4) / 1e4, n: cands.length, src: c.src };
          }
        }
        replayNext = false;

        var util = utility(u, th, cat, song, ctx, cur, t);
        var real = util + sessBias + (browsing ? -th.browsePenalty : 0) + (ses.pos === 0 ? th.firstBias : 0) + th.noise * gauss(r);
        var dur = song.t.duration, through = r() < sig(real), heard, quick = false;
        // skips: fast (under 10 s), just after the intro (10-30 s), or somewhere mid-song
        if (through) heard = dur;
        else if (r() < sig(th.quickA - th.quickB * real)) { quick = true; heard = Math.min(9.9, 0.5 + -Math.log(1 - r() * 0.999) * th.quickMean); }
        else if (r() < th.midSkip) heard = Math.min(dur * 0.9, 10 + r() * 20);
        else heard = dur * (0.12 + r() * 0.78);
        heard = Math.round(heard * 10) / 10;
        var stop = r() < u.quit + (through ? 0 : th.qSkip);
        var rec = {
          uid: u.id, tid: song.t.id, title: song.t.title, artist: song.t.artist, artists: ['a' + song.a], artistIds: song.t.artistIds,
          lang: song.t.language, album: song.t.album, year: song.t.year, dur: dur, pc: song.t.playCount,
          heard: heard, maxPos: heard, end: through ? 'ended' : stop ? 'close' : 'next', how: how, src: src,
          ctx: ctx, sess: ses.id, pos: ses.pos, prevSkip: ses.prevSkip,
          replay: ses.ids.indexOf(song.i) >= 0, restarts: 0, seekBack: through && real > 1.5 && r() < 0.15 ? 1 : 0,
          seekFwd: 0, seekFwdEarly: 0, pauses: r() < 0.03 ? 1 : 0, liked: 0,
          truth: { p: Math.round(sig(util) * 1e4) / 1e4 }
        };
        if (recInfo) rec.rec = recInfo;
        if (through && r() < u.likeP * 2 * sig(2 * (util - 1))) rec.liked = 1;
        if (quick && r() < u.dislikeP * 2 * sig(-util - 1)) { rec.liked = -1; rec.disliked = true; }
        if (enc && x0) rec.x = Array.prototype.map.call(x0, function (v) { return Math.round(v * 1e4) / 1e4; });
        emit(rec);

        // the listener's memory
        var hh = u.heard[song.i] || (u.heard[song.i] = { n: 0, last: 0 });
        if (heard >= 30 || through) { hh.n++; if (u.fav.indexOf(song.i) < 0) u.fav.push(song.i); }
        hh.last = t;
        u.artistHeard[song.a] = 1;
        if (u.fav.length > 300 || (u.fav.length > 1 && hh.n > 1)) {
          u.fav.sort(function (a, b) { return u.heard[b].n - u.heard[a].n; });
          if (u.fav.length > 300) u.fav.length = 300;
        }

        // Encore learns exactly as in the app
        if (enc) {
          var rw = P.reward(rec, prof);
          P.update(prof, rec, rw, song.feat, prevPlay ? prevPlay.feat : null, song.t);
          if (x0) M.update(model, x0, rw.r, 1);
          else if (how === 'pick') {
            var xs = M.featurize({ ctx: ctx, prof: prof, cur: cur ? cur.t : null, curFeat: cur ? cur.feat : null, session: ses,
              liked: function () { return false; }, inPlaylist: function () { return false; }, mode: 'auto' }, { t: song.t, feat: song.feat, chosen: 1 });
            M.update(model, xs, rw.r, 0.5);
          }
          if (opts.pace !== false && cur && !rec.replay) M.pace(model, cur.a === song.a, how === 'pick');
        }

        var skipped = LS.isSkip(rec);
        ses.ids.push(song.i); ses.artists.push(P.lc(song.t.artist)); ses.titles.push(P.titleKey(song.t.title)); ses.skips.push(skipped ? 1 : 0);
        if (!skipped) ses.valence = ses.valence == null ? song.feat.valence : ses.valence * 0.6 + song.feat.valence * 0.4;
        ses.prevSkip = skipped; ses.pos++;
        if (skipped && r() < th.toBrowse) browsing = true;
        if (through && r() < th.toEngage) browsing = false;
        if (through && r() < u.replayP * 2 * sig(util - 1)) replayNext = true;
        prevPlay = song; cur = song;
        t += heard * 1000 + (2 + r() * 8) * 1000;
        if (stop) break;
      }
      lastEnd = t;
    });
  }
  return { prof: prof, model: model };
}

/* ───────────── a whole population ───────────── */

// The catalogue stays the same across seeds (opts.catalogueSeed, default 1), so
// a new seed means new listeners in the same world: held-out checks compare like with like.
function generate(opts, th, emit) {
  th = th || DEFAULTS;
  var cat = catalogue(opts.catalogueSeed || 1, opts.artists), r = rngOf(opts.seed * 31 + 5), out = [];
  for (var i = 0; i < opts.users; i++) {
    var u = makeUser(i, th, cat, r);
    var res = simulateUser(u, th, cat, opts, rngOf(opts.seed * 7919 + i * 104729), emit);
    if (opts.onUser) opts.onUser(u, res);
  }
  return cat;
}

/* ───────────── calibration ─────────────
   Coordinate search over SPACE, minimising a weighted distance between the
   synthetic statistics and the real ones (tools/logstats.js). Common random
   numbers (the same seed every time) keep comparisons fair. */

var LOSS = [
  ['through', 8], ['skip', 2], ['early10', 3], ['early30', 3], ['throughAfterSkip', 6], ['throughAfterThrough', 6],
  ['pickShare', 3], ['throughPick', 3], ['throughRec', 3], ['repeatShare', 4], ['throughRepeat', 2], ['throughFirst', 3],
  ['sameArtistShare', 4], ['throughSameArtist', 2], ['replayRate', 3], ['userThroughP10', 3], ['userThroughP50', 3], ['userThroughP90', 3],
  // how behaviour clusters by session (what the two-sample test found)
  ['sessAllOwn', 3], ['sessAllRec', 3], ['sessNoSameArtist', 3], ['sessNoFastSkip', 3], ['sessFastMedian', 3], ['sessRepeatMedian', 2]
];

function loss(s, T) {
  var L = 0, parts = {};
  LOSS.forEach(function (w) { if (T[w[0]] != null && s[w[0]] != null) { var d = (s[w[0]] - T[w[0]]) * w[1]; L += d * d; parts[w[0]] = d * d; } });
  // session length on a log scale, rare events as ratios
  ['sessMean', 'sessMedian'].forEach(function (k) { var d = Math.log((s[k] || 1) / (T[k] || 1)) * 1.5; L += d * d; parts[k] = d * d; });
  ['likeRate', 'dislikeRate'].forEach(function (k) { var d = Math.log(((s[k] || 0) + 1e-4) / ((T[k] || 0) + 1e-4)) * 0.5; L += d * d; parts[k] = d * d; });
  // how much of the song was heard: each bin (the middle ones are small but tell skip timing apart)
  s.fracHist.forEach(function (v, i) { var d = (v - T.fracHist[i]) * (i === 0 || i === 7 ? 3 : 6); L += d * d; });
  s.sessHist.forEach(function (v, i) { var d = (v - T.sessHist[i]) * 2; L += d * d; });
  var d0 = (s.throughByPos[0] - T.throughByPos[0]) * 4; L += d0 * d0;
  s.throughByBlock.forEach(function (v, i) { if (v != null && T.throughByBlock[i] != null) { var d = (v - T.throughByBlock[i]) * 3; L += d * d; } });
  return { L: L, parts: parts };
}

function evaluate(th, cal) {
  var plays = [];
  generate({ users: cal.users, days: cal.days, seed: cal.seed, start: cal.start, policy: 'proxy', artists: cal.artists, warmup: cal.warmup }, th, function (r) { plays.push(r); });
  var s = LS.statsOfPlays(plays);
  return { s: s, l: loss(s, cal.target) };
}

function calibrate(target, opts) {
  var cal = { users: opts.calUsers || 200, days: opts.calDays || 14, seed: opts.seed || 1, start: opts.start, artists: opts.artists, warmup: opts.warmup == null ? 30 : opts.warmup, target: target };
  var th = copyTheta(opts.theta || DEFAULTS), best = evaluate(th, cal), steps = {};
  SPACE.forEach(function (sp) { steps[sp[0]] = sp[3]; });
  var t0 = Date.now();
  console.log('start loss ' + best.l.L.toFixed(4));
  for (var round = 0; round < (opts.rounds || 6); round++) {
    var improved = 0;
    SPACE.forEach(function (sp) {
      var k = sp[0];
      [1, -1].some(function (dir) {
        var trial = copyTheta(th), v = clamp(getP(th, k) + dir * steps[k], sp[1], sp[2]);
        if (v === getP(th, k)) return false;
        setP(trial, k, Math.round(v * 1e4) / 1e4);
        var ev = evaluate(trial, cal);
        if (ev.l.L < best.l.L - 1e-6) { th = trial; best = ev; improved++; return true; }
        return false;
      });
    });
    SPACE.forEach(function (sp) { steps[sp[0]] *= improved ? 0.8 : 0.5; });
    console.log('round ' + (round + 1) + ': loss ' + best.l.L.toFixed(4) + ', ' + improved + ' moves, ' + Math.round((Date.now() - t0) / 1000) + ' s');
  }
  return { theta: th, stats: best.s, loss: best.l };
}

module.exports = { DEFAULTS: DEFAULTS, SPACE: SPACE, catalogue: catalogue, makeUser: makeUser, generate: generate, calibrate: calibrate, loss: loss, utility: utility, rngOf: rngOf };

/* ───────────── command line ───────────── */

if (require.main === module) {
  var argv = process.argv.slice(2), o = {};
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].slice(0, 2) === '--') { var k = argv[i].slice(2), v = argv[i + 1]; if (v == null || v.slice(0, 2) === '--') o[k] = true; else { o[k] = v; i++; } }
  }
  var root = path.join(__dirname, '..', 'data', 'synthetic');
  var start = new Date(2026, 8, 1, 0, 0, 0).getTime();
  var theta = copyTheta(DEFAULTS);
  if (o.params) { var loaded = JSON.parse(fs.readFileSync(o.params, 'utf8')); Object.keys(loaded).forEach(function (k) { theta[k] = loaded[k]; }); }

  if (o.calibrate) {
    var target = JSON.parse(fs.readFileSync(o.calibrate, 'utf8'));
    var res = calibrate(target, { rounds: +(o.rounds || 6), seed: +(o.seed || 1), start: start, theta: theta, calUsers: +(o['cal-users'] || 200), calDays: +(o['cal-days'] || 14), warmup: +(o.warmup || 30) });
    var save = o.save || path.join(root, 'params.json');
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.writeFileSync(save, JSON.stringify(res.theta, null, 1));
    console.log('\n' + LS.table(['real', 'synthetic'], [target, res.stats]));
    console.log('\nparameters -> ' + path.relative(process.cwd(), save));
  } else {
    var users = +(o.users || 500), days = +(o.days || 21), seed = +(o.seed || 3), policy = o.policy || 'encore';   // seed 3: listeners calibration never saw
    var out = o.out || path.join(root, 'plays.jsonl');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    var fd = fs.openSync(out, 'w'), n = 0, t0 = Date.now(), buf = [];
    var exportsDir = o.exports === true ? path.join(root, 'exports') : o.exports;
    if (exportsDir) fs.mkdirSync(exportsDir, { recursive: true });
    var userPlays = [];
    generate({ users: users, days: days, seed: seed, start: start, policy: policy, draws: +(o.draws || 16), warmup: +(o.warmup || 30), pace: !o['no-pace'],
      onUser: function (u, res) {
        if (exportsDir) {
          fs.writeFileSync(path.join(exportsDir, u.id + '.json'), JSON.stringify({
            exported: new Date().toISOString(), synthetic: true, policy: policy, seed: seed,
            version: { profile: P.VERSION, model: M.VERSION }, features: M.FEATURES.map(function (f) { return f[0]; }),
            plays: userPlays, profile: res.prof, model: res.model ? { weights: M.weights(res.model), n: res.model.n } : null
          }));
        }
        userPlays = [];
        if ((u.n + 1) % 25 === 0 || u.n + 1 === users) process.stdout.write('\r' + (u.n + 1) + '/' + users + ' listeners, ' + n.toLocaleString('en-US') + ' plays');
      }
    }, theta, function (rec) {
      n++;
      buf.push(JSON.stringify(rec));
      if (exportsDir) userPlays.push(rec);
      if (buf.length >= 2000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
    });
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
    fs.closeSync(fd);
    console.log('\n' + n.toLocaleString('en-US') + ' plays -> ' + path.relative(process.cwd(), out) + ' (' + policy + ', ' + Math.round((Date.now() - t0) / 1000) + ' s)');
  }
}
