/* Behaviour statistics of a play log, the same way for every source:
   real public logs (research/yambda_to_encore.py), synthetic logs
   (tools/synth-logs.js) and the app's own "Export data".

   node tools/logstats.js <plays.jsonl | export.json> [more files...]

   Prints a table (one column per file) and, with --json <out>, writes the
   numbers. tools/synth-logs.js calibrates against these same numbers, so
   "the synthetic data matches the real data" always means these statistics.

   Definitions (shared with profile.js):
     listen-through   heard >= 90 % of the track
     skip             not listened through, and the listener moved on
                      (end = next / prev / pick); stopping the app is not a skip */
'use strict';
var fs = require('fs');
var readline = require('readline');

var FRAC_EDGES = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9];               // played-fraction bins
var SKIP_EDGES = [5, 10, 20, 30, 60, 120];                          // seconds heard before a skip
var SESS_EDGES = [2, 4, 8, 16, 32];                                 // songs per session: 1, 2-3, 4-7, 8-15, 16-31, 32+
var POS_EDGES = [1, 2, 3, 5, 10, 20];                               // position in session: 0, 1, 2, 3-4, 5-9, 10-19, 20+

function bin(v, edges) { for (var i = 0; i < edges.length; i++) if (v < edges[i]) return i; return edges.length; }
function frac(r) { return r.dur > 0 ? Math.min(1, (r.heard || 0) / r.dur) : 0; }
function through(r) { return frac(r) >= 0.9; }
function isSkip(r) { return !through(r) && (r.end === 'next' || r.end === 'prev' || r.end === 'pick'); }

function Acc() {
  this.n = 0; this.users = {}; this.sessions = {};
  this.through = 0; this.skips = 0; this.early10 = 0; this.early30 = 0;
  this.fracHist = new Array(FRAC_EDGES.length + 1).fill(0);
  this.skipHist = new Array(SKIP_EDGES.length + 1).fill(0);
  this.pos = POS_EDGES.concat([Infinity]).map(function () { return [0, 0]; });   // [plays, through]
  this.blocks = [0, 1, 2, 3, 4].map(function () { return [0, 0]; });
  this.how = { pick: [0, 0], rec: [0, 0] };
  this.likes = 0; this.dislikes = 0; this.replays = 0; this.seekBack = 0;
  this.afterSkip = [0, 0]; this.afterThrough = [0, 0];               // [plays, through]
  this.repeat = [0, 0]; this.first = [0, 0];
  this.sameArtist = [0, 0]; this.newArtist = [0, 0];
  this.artistBy = { pick: [0, 0], rec: [0, 0] };                    // [follow-ups, same artist], replays left out
  this._last = {};                                                   // per user: previous play
  this._heard = {};                                                  // per user: tracks heard
}

Acc.prototype.add = function (r) {
  if (!r || !r.tid || !(r.dur > 0) || r.end === 'error') return;
  var uid = r.uid || 'me', t = through(r) ? 1 : 0, sk = isSkip(r);
  this.n++;
  this.users[uid] = this.users[uid] || [0, 0];
  this.users[uid][0]++; this.users[uid][1] += t;
  var sid = uid + '|' + r.sess;
  var se = this.sessions[sid] || (this.sessions[sid] = { n: 0, own: 0, fast: 0, same: 0, trans: 0, rep: 0 });
  se.n++;
  if (r.how === 'pick') se.own++;
  if (sk && r.heard < 10) se.fast++;
  this.through += t;
  if (sk) {
    this.skips++;
    if (r.heard < 10) this.early10++;
    if (r.heard < 30) this.early30++;
    this.skipHist[bin(r.heard, SKIP_EDGES)]++;
  }
  this.fracHist[bin(frac(r), FRAC_EDGES)]++;
  var p = this.pos[bin(r.pos || 0, POS_EDGES)];
  p[0]++; p[1] += t;
  if (r.ctx && r.ctx.block != null) { var b = this.blocks[r.ctx.block]; b[0]++; b[1] += t; }
  var h = this.how[r.how === 'pick' ? 'pick' : 'rec'];
  h[0]++; h[1] += t;
  if (r.liked > 0) this.likes++;
  if (r.disliked || r.liked < 0) this.dislikes++;
  if (r.replay || r.restarts > 0) this.replays++;
  if (r.seekBack > 0) this.seekBack++;

  var prev = this._last[uid];
  if (prev && prev.sess === r.sess) {
    var a = prev.skip ? this.afterSkip : this.afterThrough;
    a[0]++; a[1] += t;
    var arts = r.artists || [], same = arts.length && prev.artists.length && arts[0] === prev.artists[0];
    var s = same ? this.sameArtist : this.newArtist;
    s[0]++; s[1] += t;
    se.trans++;
    if (same) se.same++;
    if (!r.replay && r.tid !== prev.tid) { var ab = this.artistBy[r.how === 'pick' ? 'pick' : 'rec']; ab[0]++; if (same) ab[1]++; }
  }
  var heard = this._heard[uid] || (this._heard[uid] = {});
  var rep = heard[r.tid] ? this.repeat : this.first;
  rep[0]++; rep[1] += t;
  if (heard[r.tid]) se.rep++;
  heard[r.tid] = 1;
  this._last[uid] = { sess: r.sess, skip: sk, artists: r.artists || [], tid: r.tid };
};

function rate(pair) { return pair[0] ? pair[1] / pair[0] : null; }
function norm(arr) { var s = arr.reduce(function (a, b) { return a + b; }, 0) || 1; return arr.map(function (v) { return v / s; }); }

Acc.prototype.result = function () {
  var self = this, all = Object.keys(this.sessions).map(function (k) { return self.sessions[k]; });
  var sess = all.map(function (s) { return s.n; }).sort(function (a, b) { return a - b; });
  var sessHist = new Array(SESS_EDGES.length + 1).fill(0);
  sess.forEach(function (s) { sessHist[bin(s, SESS_EDGES)]++; });
  // how behaviour clusters by session (sessions of 3+ songs)
  var big = all.filter(function (s) { return s.n >= 3; }), nb = big.length || 1;
  function share(fn) { return big.filter(fn).length / nb; }
  function medianOf(fn) { var v = big.map(fn).sort(function (a, b) { return a - b; }); return v.length ? v[v.length >> 1] : null; }
  var userRates = Object.keys(this.users).filter(function (u) { return self.users[u][0] >= 20; })
    .map(function (u) { return self.users[u][1] / self.users[u][0]; }).sort(function (a, b) { return a - b; });
  function q(arr, p) { return arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null; }
  var blockPlays = this.blocks.map(function (b) { return b[0]; });
  return {
    plays: this.n, users: Object.keys(this.users).length, sessions: sess.length,
    through: this.through / (this.n || 1),
    skip: this.skips / (this.n || 1),
    early10: this.skips ? this.early10 / this.skips : null,
    early30: this.skips ? this.early30 / this.skips : null,
    fracHist: norm(this.fracHist),
    skipHist: norm(this.skipHist),
    sessMean: sess.length ? this.n / sess.length : null, sessMedian: q(sess, 0.5), sessP90: q(sess, 0.9),
    sessHist: norm(sessHist),
    throughByPos: this.pos.map(rate),
    blockShare: norm(blockPlays), throughByBlock: this.blocks.map(rate),
    throughPick: rate(this.how.pick), throughRec: rate(this.how.rec),
    pickShare: (this.how.pick[0]) / (this.n || 1),
    likeRate: this.likes / (this.n || 1), dislikeRate: this.dislikes / (this.n || 1),
    replayRate: this.replays / (this.n || 1), seekBackRate: this.seekBack / (this.n || 1),
    throughAfterSkip: rate(this.afterSkip), throughAfterThrough: rate(this.afterThrough),
    repeatShare: this.repeat[0] / (this.n || 1), throughRepeat: rate(this.repeat), throughFirst: rate(this.first),
    sameArtistShare: (this.sameArtist[0]) / ((this.sameArtist[0] + this.newArtist[0]) || 1),
    throughSameArtist: rate(this.sameArtist), throughNewArtist: rate(this.newArtist),
    sameArtistOwn: this.artistBy.pick[0] ? this.artistBy.pick[1] / this.artistBy.pick[0] : null,
    sameArtistRec: this.artistBy.rec[0] ? this.artistBy.rec[1] / this.artistBy.rec[0] : null,
    userThroughP10: q(userRates, 0.1), userThroughP50: q(userRates, 0.5), userThroughP90: q(userRates, 0.9),
    sessAllOwn: share(function (s) { return s.own === s.n; }), sessAllRec: share(function (s) { return s.own === 0; }),
    sessNoSameArtist: share(function (s) { return s.same === 0; }), sessNoFastSkip: share(function (s) { return s.fast === 0; }),
    sessFastMedian: medianOf(function (s) { return s.fast / s.n; }), sessRepeatMedian: medianOf(function (s) { return s.rep / s.n; })
  };
};

/* Plays from a file: JSONL (one play per line) or an Encore export (JSON with .plays). */
function readPlays(file, onPlay) {
  if (/\.json$/i.test(file)) {
    var j = JSON.parse(fs.readFileSync(file, 'utf8'));
    (j.plays || j).forEach(onPlay);
    return Promise.resolve();
  }
  return new Promise(function (resolve, reject) {
    var rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    rl.on('line', function (line) { if (line.trim()) onPlay(JSON.parse(line)); });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

function statsOf(file) {
  var acc = new Acc();
  return readPlays(file, function (r) { acc.add(r); }).then(function () { return acc.result(); });
}

function statsOfPlays(plays) { var acc = new Acc(); plays.forEach(function (r) { acc.add(r); }); return acc.result(); }

/* Rows for printing / comparing: [label, key, format] */
var ROWS = [
  ['plays', 'plays', 'int'], ['listeners', 'users', 'int'], ['sessions', 'sessions', 'int'],
  ['listen-through', 'through', 'pct'], ['skip rate', 'skip', 'pct'],
  ['skips in < 10 s', 'early10', 'pct'], ['skips in < 30 s', 'early30', 'pct'],
  ['songs per session (mean)', 'sessMean', 'num'], ['songs per session (median)', 'sessMedian', 'num'], ['songs per session (p90)', 'sessP90', 'num'],
  ['listener choice share', 'pickShare', 'pct'], ['through, own choice', 'throughPick', 'pct'], ['through, recommended', 'throughRec', 'pct'],
  ['through after a skip', 'throughAfterSkip', 'pct'], ['through after a full listen', 'throughAfterThrough', 'pct'],
  ['repeat listens', 'repeatShare', 'pct'], ['through, repeat', 'throughRepeat', 'pct'], ['through, first listen', 'throughFirst', 'pct'],
  ['same artist as previous', 'sameArtistShare', 'pct'], ['through, same artist', 'throughSameArtist', 'pct'],
  ['same artist, own (no replays)', 'sameArtistOwn', 'pct'], ['same artist, recs (no replays)', 'sameArtistRec', 'pct'],
  ['likes per play', 'likeRate', 'pct'], ['dislikes per play', 'dislikeRate', 'pct'], ['replays per play', 'replayRate', 'pct'],
  ['listener through, p10', 'userThroughP10', 'pct'], ['listener through, median', 'userThroughP50', 'pct'], ['listener through, p90', 'userThroughP90', 'pct'],
  ['sessions: all own choices', 'sessAllOwn', 'pct'], ['sessions: all recommended', 'sessAllRec', 'pct'],
  ['sessions: no same-artist run', 'sessNoSameArtist', 'pct'], ['sessions: no fast skip', 'sessNoFastSkip', 'pct'],
  ['session fast-skip share (median)', 'sessFastMedian', 'pct'], ['session repeat share (median)', 'sessRepeatMedian', 'pct']
];

function fmt(v, kind) {
  if (v == null) return '—';
  if (kind === 'int') return Math.round(v).toLocaleString('en-US');
  if (kind === 'pct') return (v * 100).toFixed(1) + '%';
  return v.toFixed(1);
}

function table(names, results) {
  var w = Math.max.apply(null, names.map(function (n) { return n.length; }).concat([10]));
  var lines = ['statistic'.padEnd(32) + names.map(function (n) { return n.padStart(w + 2); }).join('')];
  ROWS.forEach(function (row) {
    lines.push(row[0].padEnd(32) + results.map(function (r) { return fmt(r[row[1]], row[2]).padStart(w + 2); }).join(''));
  });
  var pos = ['0', '1', '2', '3-4', '5-9', '10-19', '20+'];
  lines.push('through by position:');
  pos.forEach(function (p, i) { lines.push(('  song ' + p).padEnd(28) + results.map(function (r) { return fmt(r.throughByPos[i], 'pct').padStart(w + 2); }).join('')); });
  var blocks = ['night 0-5', 'morning 5-11', 'afternoon 11-17', 'evening 17-21', 'late 21-24'];
  lines.push('share of plays / through by time of day:');
  blocks.forEach(function (b, i) {
    lines.push(('  ' + b).padEnd(28) + results.map(function (r) { return (fmt(r.blockShare[i], 'pct') + ' / ' + fmt(r.throughByBlock[i], 'pct')).padStart(w + 2); }).join(''));
  });
  var fb = ['<5%', '5-10%', '10-20%', '20-30%', '30-50%', '50-70%', '70-90%', '90%+'];
  lines.push('how much of the song was heard:');
  fb.forEach(function (b, i) { lines.push(('  ' + b).padEnd(28) + results.map(function (r) { return fmt(r.fracHist[i], 'pct').padStart(w + 2); }).join('')); });
  var sb = ['1', '2-3', '4-7', '8-15', '16-31', '32+'];
  lines.push('songs per session:');
  sb.forEach(function (b, i) { lines.push(('  ' + b).padEnd(28) + results.map(function (r) { return fmt(r.sessHist[i], 'pct').padStart(w + 2); }).join('')); });
  return lines.join('\n');
}

module.exports = { Acc: Acc, statsOf: statsOf, statsOfPlays: statsOfPlays, readPlays: readPlays, table: table, ROWS: ROWS, frac: frac, through: through, isSkip: isSkip };

if (require.main === module) {
  var args = process.argv.slice(2), jsonOut = null;
  var k = args.indexOf('--json');
  if (k >= 0) { jsonOut = args[k + 1]; args.splice(k, 2); }
  if (!args.length) { console.error('usage: node tools/logstats.js <plays.jsonl | export.json> [...] [--json out.json]'); process.exit(1); }
  Promise.all(args.map(statsOf)).then(function (res) {
    var names = args.map(function (f) { return f.replace(/\\/g, '/').split('/').slice(-2).join('/'); });
    console.log(table(names, res));
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res.length === 1 ? res[0] : res, null, 1));
  });
}
