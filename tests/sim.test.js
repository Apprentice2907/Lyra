/* End to end on synthetic listeners: the learning loop must beat simple
   policies, and weight learning must add to what the calibrated profile and
   the research priors already give (the frozen-weights baseline). Averaged
   over seeds and weeks 3–4 so the test is about the method, not one draw.
   node --test tests/ */
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var sim = require('../tools/simulate.js');
var P = require('../js/encore/profile.js');

test('Encore learns: beats random, popular and frozen weights in weeks 3–4', function () {
  var seeds = [1, 2, 3], policies = ['random', 'popular', 'encore, frozen weights', 'encore'], tot = {};
  policies.forEach(function (p) { tot[p] = 0; });
  seeds.forEach(function (seed) {
    var res = sim.run({ days: 28, seed: seed, policies: policies });
    Object.keys(res).forEach(function (persona) {
      policies.forEach(function (p) { tot[p] += (res[persona][p][2].through + res[persona][p][3].through) / 2; });
    });
  });
  var n = seeds.length * sim.PERSONAS.length, avg = {};
  policies.forEach(function (p) { avg[p] = tot[p] / n; });
  var msg = JSON.stringify(avg);
  assert.ok(avg.encore > avg.random + 0.15, msg);
  assert.ok(avg.encore > avg.popular + 0.25, msg);
  assert.ok(avg.encore > avg['encore, frozen weights'] + 0.03, msg);
});

test('the profile tells a mood matcher from a mood lifter (5 seeds)', function () {
  var lifted = 0, later = Date.now() + 400 * P.DAY;
  [1, 2, 3, 4, 5].forEach(function (seed) {
    var res = sim.run({ days: 28, seed: seed, policies: ['encore'] });
    var owl = res[sim.PERSONAS[0].name].encore.profile, runner = res[sim.PERSONAS[1].name].encore.profile;
    var lo = P.liftTendency(owl), lr = P.liftTendency(runner);
    assert.ok(lo < 0.15, 'seed ' + seed + ': the night owl stays in the mood (' + lo.toFixed(2) + ')');
    assert.ok(lr > lo + 0.25, 'seed ' + seed + ': the runner lifts more than the owl (' + lr.toFixed(2) + ' vs ' + lo.toFixed(2) + ')');
    if (lr > 0.3) lifted++;
    var owlText = P.insights(owl, later).map(function (i) { return i.text; }).join(' ');
    assert.match(owlText, /night owl/);
    assert.match(owlText, /stay in the mood/);
    if (lr > 0.3) assert.match(P.insights(runner, later).map(function (i) { return i.text; }).join(' '), /lifted up/);
  });
  assert.ok(lifted >= 4, 'the runner reads as a lifter in at least 4 of 5 seeds (' + lifted + ')');
});
