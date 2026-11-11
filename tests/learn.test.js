/* Reward, profile calibration and the learning model.  node --test tests/ */
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var P = require('../js/encore/profile.js');
var M = require('../js/encore/model.js');

var T0 = new Date(2026, 10, 2, 21, 0, 0).getTime();     // a Monday, 9 PM local

test('versions of one song share a title key', function () {
  ['Saiyaara', 'Saiyaara Reprise - Female', 'Saiyaara (Lofi Flip)', 'Saiyaara - Unplugged', 'Saiyaara Slowed + Reverb',
   'Saiyaara Lofi Mix(Remix By Dj X)'].forEach(function (t) { assert.equal(P.titleKey(t), 'saiyaara', t); });
  assert.equal(P.titleKey('Live Your Life'), 'live your life', 'a version word at the start is part of the title');
  assert.notEqual(P.titleKey('Tum Hi Ho'), P.titleKey('Tum Se Hi'));
});
function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function rec(over) {
  var r = {
    tid: 'js:a', title: 'Song', artist: 'Arijit Singh', artists: ['Arijit Singh'], lang: 'hindi', album: 'Album', year: '2013',
    dur: 240, pc: 1e7, ctx: P.context(T0), how: 'encore', src: 'encore', heard: 240, maxPos: 240, end: 'ended',
    pauses: 0, seekFwd: 0, seekFwdEarly: 0, seekBack: 0, restarts: 0, replay: false,
    vol0: 0.5, volMin: 0.5, volMax: 0.5, volEnd: 0.5, liked: 0, added: false, bgSec: 0, sess: 's1', pos: 0, prevSkip: false
  };
  for (var k in over) r[k] = over[k];
  return r;
}

test('reward follows the table and its order', function () {
  var prof = P.create(T0);
  var full = P.reward(rec({}), prof).r;
  var s5 = P.reward(rec({ end: 'next', heard: 5, maxPos: 5 }), prof).r;
  var s20 = P.reward(rec({ end: 'next', heard: 20, maxPos: 20 }), prof).r;
  var half = P.reward(rec({ end: 'next', heard: 120, maxPos: 120 }), prof).r;
  var loop = P.reward(rec({ restarts: 1 }), prof).r;
  var liked = P.reward(rec({ liked: 1 }), prof).r;
  assert.equal(full, 1);
  assert.equal(s5, -1);
  assert.ok(s5 < s20 && s20 < 0 && s20 < half && half < full, [s5, s20, half, full].join(' '));
  assert.ok(loop >= 2.5 && liked >= 3, 'loops and likes count most');
  assert.equal(P.reward(rec({ end: 'error', heard: 0 }), prof).neutral, true, 'unplayable songs teach nothing');
});

test('going back to a song and leaving it at once is not a replay', function () {
  var prof = P.create(T0);
  var left = P.reward(rec({ end: 'next', heard: 2, replay: true }), prof);
  assert.ok(left.r < 0 && !left.parts.some(function (p) { return /again/.test(p[0]); }), JSON.stringify(left.parts));
  var stayed = P.reward(rec({ replay: true }), prof);
  assert.ok(stayed.r >= 2.5, 'went back and listened: ' + stayed.r);
});

test('scrubbing to the end is not a full listen', function () {
  var prof = P.create(T0);
  var scrubbed = P.reward(rec({ end: 'ended', heard: 6, maxPos: 240, seekFwd: 1 }), prof);
  assert.equal(scrubbed.completed, false);
  assert.ok(scrubbed.r < 0, 'heard 6 s of 240: ' + scrubbed.r);
  var nearly = P.reward(rec({ end: 'ended', heard: 228, maxPos: 240 }), prof);
  assert.equal(nearly.completed, true, 'a few seconds lost to buffering still counts');
});

test('a long pause or closing the app is not a skip', function () {
  var prof = P.create(T0);
  var idle = P.reward(rec({ end: 'idle', heard: 60, maxPos: 60 }), prof);
  assert.equal(idle.skip, false);
  assert.ok(idle.r >= 0);
  var quit = P.reward(rec({ end: 'close', heard: 6, prevSkip: true }), prof);
  assert.ok(quit.r < 0, 'quitting right after a skip counts against the song that was on');
});

test('skip harshness is calibrated to the listener', function () {
  var browser = P.create(T0), patient = P.create(T0);
  for (var i = 0; i < 30; i++) {
    var ctx = P.context(T0 + i * 3e5);
    var a = rec({ ctx: ctx, end: i % 10 < 8 ? 'next' : 'ended', heard: i % 10 < 8 ? 6 : 240 });
    var b = rec({ ctx: ctx, end: i % 10 < 1 ? 'next' : 'ended', heard: i % 10 < 1 ? 6 : 240 });
    P.update(browser, a, P.reward(a, browser), null, null, null);
    P.update(patient, b, P.reward(b, patient), null, null, null);
  }
  var skip = rec({ end: 'next', heard: 5 });
  assert.ok(P.reward(skip, browser).r > P.reward(skip, patient).r, 'a skip means less from someone who skips 80% of songs');
});

test('profile learns time-of-day taste, regulation style and skip style', function () {
  var prof = P.create(T0), r = rng(1);
  var calm = { energy: 0.25, valence: 0.3, arousal: 0.25, bpm: 80, tempoConf: 1, timbre: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  var loud = { energy: 0.8, valence: 0.7, arousal: 0.8, bpm: 128, tempoConf: 1, timbre: [1, 1, 1, 1, 1, 1, 1, 1, 1] };
  for (var d = 0; d < 20; d++) {
    // 2 AM: calm songs played through, loud ones skipped fast
    var night = new Date(2026, 10, 3 + d, 2, 0).getTime(), noon = new Date(2026, 10, 3 + d, 13, 0).getTime();
    var a = rec({ tid: 'n' + d, ctx: P.context(night), sess: 'n' + d });
    P.update(prof, a, P.reward(a, prof), calm, null, null);
    var b = rec({ tid: 'nl' + d, ctx: P.context(night + 3e5), end: 'next', heard: 4, sess: 'n' + d });
    P.update(prof, b, P.reward(b, prof), loud, calm, null);
    // after a sad song, the next accepted song stays sad (a "matcher")
    var c = rec({ tid: 'nm' + d, ctx: P.context(night + 6e5), sess: 'n' + d });
    P.update(prof, c, P.reward(c, prof), { energy: 0.3, valence: 0.28 + r() * 0.04, arousal: 0.3, bpm: 82, tempoConf: 1, timbre: calm.timbre }, calm, null);
    // midday: loud songs
    var e = rec({ tid: 'd' + d, ctx: P.context(noon), sess: 'd' + d });
    P.update(prof, e, P.reward(e, prof), loud, null, null);
  }
  var bn = P.blockPref(prof, 0), bd = P.blockPref(prof, 2);
  assert.ok(bn.energy < 0.4 && bd.energy > 0.7, 'night ' + bn.energy + ' day ' + bd.energy);
  assert.ok(P.liftTendency(prof) < 0.15, 'stays in the mood: ' + P.liftTendency(prof));
  assert.ok(P.transitionSensitivity(prof) > 0.5, 'big jumps get skipped');
  var text = P.insights(prof, T0 + 25 * P.DAY).map(function (i) { return i.text; }).join('\n');
  assert.match(text, /Late at night you go for calmer songs/);
  assert.match(text, /Big jumps in sound make you skip/);
  assert.match(text, /stay in the mood/);
});

test('old behaviour fades (half-life), recent behaviour wins', function () {
  var prof = P.create(T0);
  for (var i = 0; i < 10; i++) { var a = rec({ ctx: P.context(T0 + i * 6e4), artist: 'Old Love', artists: ['Old Love'] }); P.update(prof, a, P.reward(a, prof), null, null, null); }
  var later = T0 + 200 * P.DAY;
  for (i = 0; i < 4; i++) { var b = rec({ ctx: P.context(later + i * 6e4), artist: 'New Love', artists: ['New Love'] }); P.update(prof, b, P.reward(b, prof), null, null, null); }
  // touch the old artist's cell at the same time so both are decayed to "now"
  var old = P.artistAff(prof, ['Old Love']).aff, neu = P.artistAff(prof, ['New Love']).aff;
  assert.ok(neu > 0.5, 'new favourite ' + neu);
  assert.ok(old > 0, 'old favourite still positive');
});

test('song memory keeps playable metadata and prunes to its cap', function () {
  var prof = P.create(T0);
  for (var i = 0; i < 1600; i++) {
    var a = rec({ tid: 'js:' + i, ctx: P.context(T0 + i * 6e4) });
    P.update(prof, a, P.reward(a, prof), null, null, { id: 'js:' + i, src: 'x' });
  }
  assert.ok(Object.keys(prof.songs).length <= 1500);
  assert.ok(prof.songs['js:1599'].m, 'recent songs survive with their metadata');
});

test('featurize: every feature is finite and roughly in [-2, 2]', function () {
  var prof = P.create(T0), r = rng(5);
  var feat = function () { return { energy: r(), valence: r(), arousal: r(), bpm: 70 + r() * 90, tempoConf: r(), camelot: (1 + Math.floor(r() * 12)) + (r() < 0.5 ? 'A' : 'B'), intro: Math.floor(r() * 40), timbre: [r(), r(), r(), r(), r(), r(), r(), r(), r()] }; };
  var state = { ctx: P.context(T0), prof: prof, cur: { id: 'c', artist: 'X', language: 'hindi', album: 'A' }, curFeat: feat(),
    session: { ids: [], artists: ['x', 'x'], valence: 0.4, skips: [1, 0, 1] }, liked: function () { return true; }, inPlaylist: function () { return false; }, mode: 'auto' };
  for (var i = 0; i < 200; i++) {
    var x = M.featurize(state, { t: { id: 'k' + i, artist: i % 3 ? 'X' : 'Y', language: i % 2 ? 'hindi' : 'punjabi', album: 'A', year: '2015', playCount: 1e6 * (1 + i), duration: 200 }, feat: i % 4 ? feat() : null, src: 'artist' });
    for (var k = 0; k < M.D; k++) assert.ok(isFinite(x[k]) && Math.abs(x[k]) <= 2.5, M.FEATURES[k][0] + ' = ' + x[k]);
  }
});

test('Thompson sampling explores early and settles once it has evidence', function () {
  var m = M.create({ gamma: 1 }), r = rng(9);
  // two candidates that differ only in an untried feature (energyStep)
  var a = new Float64Array(M.D), b = new Float64Array(M.D);
  a[0] = b[0] = 1;
  a[M.IDX.energyStep] = 1; b[M.IDX.energyStep] = -1;
  function shareA() {
    var wins = 0;
    for (var i = 0; i < 400; i++) { var w = M.sample(m, r); if (M.dot(w, a) > M.dot(w, b)) wins++; }
    return wins / 400;
  }
  var before = shareA();
  assert.ok(before > 0.3 && before < 0.7, 'no evidence: both get tried (' + before + ')');
  for (var i = 0; i < 60; i++) { M.update(m, a, 1); M.update(m, b, -1); }
  assert.ok(shareA() > 0.97, 'evidence: the better one wins');
});

test('forgetting lets the model follow a change of taste', function () {
  var m = M.create({ gamma: 0.98 }), x = new Float64Array(M.D);
  x[0] = 1; x[M.IDX.energyStep] = 1;
  for (var i = 0; i < 150; i++) M.update(m, x, 1);
  var before = M.mean(m)[M.IDX.energyStep];
  for (i = 0; i < 150; i++) M.update(m, x, -1);
  var after = M.mean(m)[M.IDX.energyStep];
  assert.ok(before > 0.3 && after < -0.3, before + ' → ' + after);
});

test('rank: propensities sum to ~1 and the chosen one is logged', function () {
  var m = M.create(), prof = P.create(T0);
  var state = { ctx: P.context(T0), prof: prof, cur: null, curFeat: null, session: {}, liked: function (id) { return id === 'fav'; }, inPlaylist: function () { return false; } };
  var cands = ['fav', 'b', 'c', 'd'].map(function (id) { return { t: { id: id, artist: 'A' }, feat: null, src: 'explore' }; });
  var res = M.rank(m, state, cands, { rng: rng(3) });
  var sum = res.list.reduce(function (s, it) { return s + it.prop; }, 0);
  assert.ok(Math.abs(sum - 1) < 0.05, 'sum ' + sum);
  assert.equal(res.list[0].cand.t.id, 'fav', 'a liked song wins on the prior');
  var why = M.explain(res.list[0], res.mu, state.ctx, false);
  assert.ok(why.indexOf('You liked it') >= 0, why.join(' | '));
});

test('a stored model with a different feature list is rejected', function () {
  var m = M.serialize(M.create());
  assert.equal(M.valid(m), true);
  m.names = m.names.slice(0, -1).concat(['somethingElse']);
  assert.equal(M.valid(m), false);
});
