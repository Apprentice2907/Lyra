/* The synthetic log generator and the shared statistics.  node --test tests/*.test.js */
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var S = require('../tools/synth-logs.js');
var LS = require('../tools/logstats.js');
var P = require('../js/encore/profile.js');

var START = new Date(2026, 8, 1).getTime();

function gen(opts) {
  var plays = [];
  S.generate(Object.assign({ users: 6, days: 5, seed: 3, start: START, policy: 'proxy' }, opts), S.DEFAULTS, function (r) { plays.push(r); });
  return plays;
}

test('records have the app\'s play format and give finite rewards', function () {
  var plays = gen({});
  assert.ok(plays.length > 100, 'plays ' + plays.length);
  var prof = P.create(START);
  plays.forEach(function (r) {
    ['uid', 'tid', 'dur', 'heard', 'end', 'how', 'ctx', 'sess', 'pos'].forEach(function (k) { assert.ok(r[k] != null, k + ' missing'); });
    assert.ok(r.heard >= 0 && r.heard <= r.dur, 'heard within the song');
    assert.ok(['ended', 'next', 'close'].indexOf(r.end) >= 0);
    assert.ok(r.truth.p > 0 && r.truth.p < 1, 'ground truth is a probability');
    var rw = P.reward(r, prof);
    assert.ok(isFinite(rw.r));
  });
});

test('same seed, same data; another seed, other data', function () {
  var a = gen({}), b = gen({}), c = gen({ seed: 4 });
  assert.equal(JSON.stringify(a.slice(0, 50)), JSON.stringify(b.slice(0, 50)));
  assert.notEqual(JSON.stringify(a.slice(0, 50)), JSON.stringify(c.slice(0, 50)));
});

test('the encore policy logs propensities and feature vectors like the app', function () {
  var recs = gen({ users: 3, days: 4, policy: 'encore', draws: 8 }).filter(function (r) { return r.how === 'encore'; });
  assert.ok(recs.length > 20);
  recs.forEach(function (r) {
    assert.ok(r.rec.prop > 0 && r.rec.prop <= 1, 'propensity ' + r.rec.prop);
    assert.ok(Array.isArray(r.x) && r.x.length > 40);
  });
});

test('warm-up days are lived but not logged', function () {
  var plays = gen({ users: 4, days: 3, warmup: 10 });
  assert.ok(plays.length > 0);
  plays.forEach(function (r) { assert.ok(r.ctx.t >= START, 'a warm-up play leaked into the log'); });
  assert.notEqual(JSON.stringify(plays.slice(0, 20)), JSON.stringify(gen({ users: 4, days: 3 }).slice(0, 20)), 'the warm-up changes what follows');
});

test('own choices vs recommendations follow pickShare', function () {
  var th = JSON.parse(JSON.stringify(S.DEFAULTS));
  th.pickShare = 0.2;
  var plays = [];
  S.generate({ users: 10, days: 6, seed: 5, start: START, policy: 'proxy' }, th, function (r) { plays.push(r); });
  var s = LS.statsOfPlays(plays);
  assert.ok(s.pickShare < 0.4, 'pick share ' + s.pickShare);
});

test('statistics: definitions on a hand-made log', function () {
  var base = { uid: 'u', dur: 200, how: 'encore', ctx: { block: 2 }, artists: ['a1'] };
  function p(o) { return Object.assign({}, base, o); }
  var plays = [
    p({ tid: 't1', sess: 's1', pos: 0, heard: 200, end: 'ended' }),
    p({ tid: 't2', sess: 's1', pos: 1, heard: 4, end: 'next' }),
    p({ tid: 't3', sess: 's1', pos: 2, heard: 50, end: 'next', how: 'pick' }),
    p({ tid: 't1', sess: 's1', pos: 3, heard: 190, end: 'ended', replay: true }),
    p({ tid: 't4', sess: 's2', pos: 0, heard: 20, end: 'close' })
  ];
  var s = LS.statsOfPlays(plays);
  assert.equal(s.plays, 5);
  assert.equal(s.sessions, 2);
  assert.equal(s.through, 2 / 5);
  assert.equal(s.skip, 2 / 5, 'stopping the app (close) is not a skip');
  assert.equal(s.early10, 1 / 2);
  assert.equal(s.repeatShare, 1 / 5);
  assert.equal(s.throughAfterSkip, 1 / 2);
  assert.equal(s.sessHist[0], 1 / 2, 'one single-song session out of two');
  assert.equal(s.sameArtistShare, 1);

  // same-artist follow-ups, split into own choices and recommendations, replays left out
  var mix = LS.statsOfPlays([
    p({ tid: 'x1', sess: 'm', pos: 0, heard: 200, end: 'ended', how: 'pick' }),
    p({ tid: 'x2', sess: 'm', pos: 1, heard: 200, end: 'ended', artists: ['a2'] }),
    p({ tid: 'x3', sess: 'm', pos: 2, heard: 200, end: 'ended', artists: ['a2'] }),
    p({ tid: 'x3', sess: 'm', pos: 3, heard: 200, end: 'ended', artists: ['a2'], replay: true }),
    p({ tid: 'x4', sess: 'm', pos: 4, heard: 200, end: 'ended', artists: ['a3'], how: 'pick' })
  ]);
  assert.equal(mix.sameArtistRec, 1 / 2);
  assert.equal(mix.sameArtistOwn, 0);
});
