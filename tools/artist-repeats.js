/* Does hearing the same artist again change whether a song is played through?

   node tools/artist-repeats.js plays.jsonl [more.jsonl …]

   Works on any play log (Yambda, synthetic, an Encore export). For every
   play after the first in a session (replays of the same song left out), the
   run is how many songs in a row, ending with this one, are by the same
   artist: 1 = a new artist, 2 = the second in a row, 3+ = longer.

   Prints, for own choices and for recommendations:
   - how often the song is by the artist just played;
   - played-through rate by run;
   - the same contrast within each listener (run 2 − run 1, listeners with at
     least 5 plays of each), with a 95% interval. Listeners differ a lot in
     how much they play through, so the within-listener contrast is the
     fairer test. */
'use strict';
var LS = require('./logstats.js');

function analyse(file) {
  var plays = [];
  return LS.readPlays(file, function (p) { if (p && p.tid && p.dur > 0) plays.push(p); }).then(function () {
    var bySess = {};
    plays.forEach(function (p) { var k = (p.uid || 'me') + '|' + p.sess; (bySess[k] = bySess[k] || []).push(p); });
    var cells = {}, users = {};
    function add(key, uid, v) {
      var c = cells[key] || (cells[key] = [0, 0]); c[0]++; c[1] += v;
      var u = users[uid] || (users[uid] = {}), cu = u[key] || (u[key] = [0, 0]); cu[0]++; cu[1] += v;
    }
    Object.keys(bySess).forEach(function (k) {
      var s = bySess[k].sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); }), run = 0, prevA = null, prevT = null;
      s.forEach(function (p, i) {
        if (p.replay || p.tid === prevT) { prevT = p.tid; return; }
        var a = (p.artists || [p.artist])[0];
        run = a === prevA ? run + 1 : 1;
        if (i > 0) add((p.how === 'pick' ? 'own' : 'rec') + ' ' + (run >= 3 ? '3+' : run), p.uid || 'me', LS.through(p) ? 1 : 0);
        prevA = a; prevT = p.tid;
      });
    });
    return { cells: cells, users: users };
  });
}

function within(users, kind, a, b) {
  var d = [];
  Object.keys(users).forEach(function (uid) {
    var x = users[uid][kind + ' ' + a], y = users[uid][kind + ' ' + b];
    if (x && y && x[0] >= 5 && y[0] >= 5) d.push(100 * (x[1] / x[0] - y[1] / y[0]));
  });
  if (d.length < 3) return 'too few listeners (' + d.length + ')';
  var m = d.reduce(function (s, v) { return s + v; }, 0) / d.length;
  var v = d.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (d.length - 1);
  return (m >= 0 ? '+' : '') + m.toFixed(1) + ' ± ' + (1.96 * Math.sqrt(v / d.length)).toFixed(1) + ' points (' + d.length + ' listeners)';
}

function report(file, res) {
  var c = res.cells, pct = function (p) { return p ? (100 * p[1] / p[0]).toFixed(1) + '%' : '—'; };
  console.log('\n' + file);
  [['own', 'own choices'], ['rec', 'recommendations']].forEach(function (k) {
    var one = c[k[0] + ' 1'] || [0, 0], two = c[k[0] + ' 2'] || [0, 0], more = c[k[0] + ' 3+'] || [0, 0], n = one[0] + two[0] + more[0];
    if (!n) return;
    console.log('  ' + k[1] + ': ' + n.toLocaleString('en-US') + ' follow-ups, ' + (100 * (two[0] + more[0]) / n).toFixed(1) + '% by the artist just played');
    console.log('    played through: new artist ' + pct(one) + ', 2nd in a row ' + pct(two) + ' (' + two[0] + '), 3rd+ ' + pct(more) + ' (' + more[0] + ')');
    console.log('    within listener, 2nd in a row − new artist: ' + within(res.users, k[0], '2', '1'));
  });
}

if (require.main === module) {
  var files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/artist-repeats.js plays.jsonl [more.jsonl …]'); process.exit(1); }
  files.reduce(function (p, f) { return p.then(function () { return analyse(f).then(function (r) { report(f, r); }); }); }, Promise.resolve());
}

module.exports = { analyse: analyse, within: within };
