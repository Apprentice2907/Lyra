/* Artist pacing: how often Encore stays with the artist playing now.  node --test tests/ */
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var M = require('../js/encore/model.js');

function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// a candidate with a known feature vector: by the artist playing now or not, and how much the listener likes it
function cand(id, same, aff) {
  var x = new Float64Array(M.D);
  x[0] = 1;
  x[M.IDX.sameArtist] = same ? 1 : 0;
  x[M.IDX.songAff] = aff;
  return { t: { id: id }, x: x, src: same ? 'artist' : 'taste' };
}

// same-artist songs the model clearly prefers (higher affinity and the sameArtist prior)
function pool() {
  return [cand('s1', 1, 0.8), cand('s2', 1, 0.75), cand('s3', 1, 0.7),
    cand('o1', 0, 0.45), cand('o2', 0, 0.4), cand('o3', 0, 0.4), cand('o4', 0, 0.35), cand('o5', 0, 0.3)];
}

// let Encore pick n songs in a row; own picks in between teach it the listener's habit
function run(m, n, opts) {
  var r = rng(opts.seed || 1), same = 0, counted = 0;
  for (var i = 0; i < n; i++) {
    if (opts.ownShare != null) M.pace(m, r() < opts.ownShare, true);
    var top = M.rank(m, {}, pool(), { rng: r, draws: 0, margin: 0.1, pace: opts.pace }).list[0];
    var s = top.x[M.IDX.sameArtist] > 0;
    if (opts.pace !== false) M.pace(m, s, false);
    if (i >= n / 2) { counted++; if (s) same++; }
  }
  return same / counted;
}

test('without pacing, the model keeps choosing the same artist', function () {
  assert.ok(run(M.create(), 600, { pace: false }) > 0.9);
});

test('pacing holds same-artist picks near the target', function () {
  var m = M.create(), share = run(m, 1200, {});
  assert.ok(Math.abs(share - M.PACE.target) < 0.05, 'share ' + share + ', target ' + M.PACE.target);
  assert.ok(M.pacing(m).lam > 0, 'the penalty is on');
});

test('the target follows the listener\'s own picks, within its bounds', function () {
  var album = M.create(), share = run(album, 1500, { ownShare: 0.3 });
  assert.ok(Math.abs(M.paceTarget(album) - 0.3) < 0.04, 'target ' + M.paceTarget(album));
  assert.ok(Math.abs(share - 0.3) < 0.06, 'an album listener gets more of the same artist: ' + share);
  var always = M.create();
  for (var i = 0; i < 2000; i++) M.pace(always, true, true);
  assert.equal(M.paceTarget(always), M.PACE.max);
  var never = M.create();
  for (i = 0; i < 2000; i++) M.pace(never, false, true);
  assert.equal(M.paceTarget(never), M.PACE.min);
});

test('the penalty relaxes to zero when the model stops repeating', function () {
  var m = M.create();
  M.pacing(m).lam = 1;
  for (var i = 0; i < 400; i++) M.pace(m, false, false);
  assert.equal(M.pacing(m).lam, 0);
});

test('pacing is a penalty, not a ban, and propensities include it', function () {
  var m = M.create();
  M.pacing(m).lam = 0.3;
  var much = [cand('s', 1, 1.5), cand('o', 0, 0.2)];
  assert.equal(M.rank(m, {}, much, { rng: rng(2), draws: 0, margin: 0.1 }).list[0].cand.t.id, 's', 'a clearly better song by the same artist still wins');
  // s is ahead by less than the penalty: pacing (with the safety margin) moves on to another artist
  var close = [cand('s', 1, 0.55), cand('o', 0, 0.5)];
  var res = M.rank(m, {}, close, { rng: rng(2), draws: 64, margin: 0.1 });
  assert.equal(res.list[0].cand.t.id, 'o', 'a small lead goes to a change of artist');
  var s = res.list.filter(function (it) { return it.cand.t.id === 's'; })[0];
  assert.equal(s.pen, 0.3);
  assert.ok(s.mean > res.list[0].mean, 'mean is still the expected reward, without the penalty');
  var sum = res.list.reduce(function (a, it) { return a + it.prop; }, 0);
  assert.ok(Math.abs(sum - 1) < 0.05 && s.prop < 0.05, 'propensities: ' + res.list.map(function (it) { return it.cand.t.id + ' ' + it.prop; }).join(', '));
  var off = M.rank(m, {}, close, { rng: rng(2), draws: 64, margin: 0.1, pace: false });
  assert.equal(off.list[0].cand.t.id, 's', 'without pacing the same artist wins');
  assert.ok(off.list[0].prop > 0.9, 'and the logged propensity says so');
});

test('a stored model keeps its pacing, and an old one starts at zero', function () {
  var m = M.create();
  M.pace(m, true, false);
  var saved = JSON.parse(JSON.stringify(M.serialize(m)));
  assert.ok(M.valid(saved) && saved.pace.lam > 0 && saved.pace.recN === 1);
  var old = JSON.parse(JSON.stringify(M.serialize(M.create())));
  assert.equal(old.pace, undefined);
  assert.equal(M.rank(old, {}, pool(), { rng: rng(1), draws: 0 }).lam, 0);
});
