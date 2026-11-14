/* Compare two synthetic runs of the same listeners, listener by listener.

   node tools/compare-runs.js before.jsonl after.jsonl

   Both files must come from tools/synth-logs.js with the same --seed and
   --users (the same listeners), for example with and without --no-pace.
   For each listener with at least 20 recommendations in both runs, it takes
   the difference after − before, then reports the mean difference across
   listeners with a 95% interval. A paired comparison is much tighter than
   comparing two population averages, because listeners differ far more
   from each other than a policy change moves any one of them. */
'use strict';
var fs = require('fs');
var readline = require('readline');
var LS = require('./logstats.js');

function load(file) {
  var users = {}, prev = {};
  return new Promise(function (resolve, reject) {
    var rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    rl.on('line', function (line) {
      if (!line.trim()) return;
      var p = JSON.parse(line), u = users[p.uid] || (users[p.uid] = { rec: [0, 0], truth: [0, 0], same: [0, 0], all: [0, 0] });
      var t = LS.through(p) ? 1 : 0, pv = prev[p.uid];
      u.all[0]++; u.all[1] += t;
      if (p.how === 'encore') {
        u.rec[0]++; u.rec[1] += t;
        if (p.truth) { u.truth[0]++; u.truth[1] += p.truth.p; }
        if (pv && pv.sess === p.sess && !p.replay && pv.tid !== p.tid) { u.same[0]++; if (pv.artists[0] === p.artists[0]) u.same[1]++; }
      }
      prev[p.uid] = p;
    });
    rl.on('close', function () { resolve(users); });
    rl.on('error', reject);
  });
}

function rate(pair) { return pair[0] ? pair[1] / pair[0] : null; }

function compare(a, b) {
  var ids = Object.keys(a).filter(function (k) { return b[k] && a[k].rec[0] >= 20 && b[k].rec[0] >= 20; });
  return [['recommendations by the same artist', 'same'], ['recommendations played through', 'rec'],
    ['recommendations, true p (truth.p)', 'truth'], ['all plays played through', 'all']].map(function (row) {
    var k = row[1], d = [], pa = [0, 0], pb = [0, 0];
    ids.forEach(function (id) {
      var ra = rate(a[id][k]), rb = rate(b[id][k]);
      pa[0] += a[id][k][0]; pa[1] += a[id][k][1]; pb[0] += b[id][k][0]; pb[1] += b[id][k][1];
      if (ra != null && rb != null) d.push(100 * (rb - ra));
    });
    var n = d.length, m = d.reduce(function (s, v) { return s + v; }, 0) / (n || 1);
    var v = d.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / Math.max(1, n - 1);
    return { label: row[0], before: rate(pa), after: rate(pb), diff: m, ci: 1.96 * Math.sqrt(v / (n || 1)), n: n };
  });
}

module.exports = { load: load, compare: compare };

if (require.main === module) {
  var files = process.argv.slice(2);
  if (files.length !== 2) { console.error('usage: node tools/compare-runs.js before.jsonl after.jsonl'); process.exit(1); }
  Promise.all(files.map(load)).then(function (runs) {
    var rows = compare(runs[0], runs[1]);
    console.log('statistic'.padEnd(36) + 'before'.padStart(9) + 'after'.padStart(9) + '   per listener (95%)');
    rows.forEach(function (r) {
      var pct = function (v) { return v == null ? '—' : (100 * v).toFixed(1) + '%'; };
      console.log(r.label.padEnd(36) + pct(r.before).padStart(9) + pct(r.after).padStart(9) + '   ' +
        (r.diff >= 0 ? '+' : '') + r.diff.toFixed(2) + ' ± ' + r.ci.toFixed(2) + ' pts');
    });
    console.log('(' + rows[0].n + ' listeners with 20+ recommendations in both runs)');
  });
}
