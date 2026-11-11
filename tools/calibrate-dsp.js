/* Calibrate the DSP's reference statistics on real catalogue songs.

   node tools/calibrate-dsp.js <work-dir> [songs=48]

   Pulls songs from the app's configured playlists (plus a few mood
   searches for spread), downloads each 12 kbps stream into <work-dir>,
   decodes it with ffmpeg exactly as the browser would (mono, 11025 Hz),
   runs EncoreDSP.analyze, and prints:
     - a REF block to paste into js/encore/dsp.js
     - per-song results and analysis time
   It also writes <work-dir>/features.json for tools/compare_librosa.py. */
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var vm = require('vm');
var DSP = require('../js/encore/dsp.js');

var WORK = process.argv[2];
var WANT = +(process.argv[3] || 48);
if (!WORK) { console.error('usage: node tools/calibrate-dsp.js <work-dir> [songs]'); process.exit(1); }
fs.mkdirSync(WORK, { recursive: true });

var cfgCtx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/config.js'), 'utf8'), cfgCtx);
var CFG = cfgCtx.window.VINYL_CONFIG;
var API = CFG.apiBases[0];

function get(p) {
  return fetch(API + p).then(function (r) { return r.json(); }).then(function (j) {
    if (!j || j.success === false) throw new Error(j && j.message);
    return j.data;
  });
}
function low(s) {
  var d = (s.downloadUrl || []).filter(function (u) { return u.quality === '12kbps'; })[0];
  return d && d.url;
}

function collect() {
  var ids = CFG.explorePool.slice(0, 6);
  var queries = ['hindi sad songs', 'punjabi party', 'lofi hindi', 'english pop hits', 'tamil hits', 'sufi'];
  var jobs = ids.map(function (id) { return get('/playlists?id=' + id + '&limit=20').then(function (d) { return d.songs; }, function () { return []; }); })
    .concat(queries.map(function (q) { return get('/search/songs?query=' + encodeURIComponent(q) + '&limit=10').then(function (d) { return d.results; }, function () { return []; }); }));
  return Promise.all(jobs).then(function (groups) {
    // round-robin across sources so the sample is diverse
    var out = [], seen = {}, i = 0, more = true;
    while (out.length < WANT && more) {
      more = false;
      groups.forEach(function (g) {
        var s = g[i];
        if (!s) return;
        more = true;
        if (out.length < WANT && !seen[s.id] && low(s)) { seen[s.id] = true; out.push(s); }
      });
      i++;
    }
    return out;
  });
}

function decode(file) {
  var r = cp.spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(DSP.SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
}

collect().then(function (songs) {
  console.log('analysing ' + songs.length + ' songs');
  var rows = [], k = 0;
  function next() {
    if (k >= songs.length) return Promise.resolve();
    var s = songs[k++], file = path.join(WORK, s.id + '_12.mp4');
    var dl = fs.existsSync(file) ? Promise.resolve() : fetch(low(s)).then(function (r) { return r.arrayBuffer(); }).then(function (b) { fs.writeFileSync(file, Buffer.from(b)); });
    return dl.then(function () {
      var x = decode(file), t0 = Date.now(), raw = DSP.analyze(x, DSP.SR), ms = Date.now() - t0;
      rows.push({ id: s.id, file: file, title: s.name, artist: ((s.artists && s.artists.primary) || []).map(function (a) { return a.name; }).slice(0, 2).join(', '), lang: s.language, year: s.year, ms: ms, raw: raw });
      process.stdout.write('.');
    }).catch(function (e) { console.log('\n  skipped ' + s.name + ': ' + e.message); }).then(next);
  }
  return next().then(function () { return rows; });
}).then(function (rows) {
  console.log('\n');
  var keys = ['bpm', 'pulse', 'onsetRate', 'kickRate', 'perc', 'loud', 'dyn', 'centroid', 'flat', 'bright', 'harm'];
  var ref = { n: rows.length };
  keys.forEach(function (key) {
    var v = rows.map(function (r) { return r.raw[key]; }), m = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    var sd = Math.sqrt(v.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / v.length);
    ref[key] = { m: +m.toPrecision(3), s: +sd.toPrecision(2) };
  });
  console.log('REF block for js/encore/dsp.js:\n');
  console.log('  var REF = {\n    n: ' + ref.n + ',\n' + keys.map(function (key) {
    return '    ' + (key + ':').padEnd(11) + '{ m: ' + String(ref[key].m).padEnd(6) + ', s: ' + ref[key].s + ' }';
  }).join(',\n') + '\n  };\n');
  var times = rows.map(function (r) { return r.ms; }).sort(function (a, b) { return a - b; });
  console.log('analysis time per song (Node, one core): median ' + times[times.length >> 1] + ' ms, max ' + times[times.length - 1] + ' ms\n');
  rows.forEach(function (r) {
    var d = DSP.describe(r.raw);
    console.log([r.title.slice(0, 28).padEnd(28), (r.lang || '').slice(0, 8).padEnd(8), String(r.raw.bpm).padStart(6), d.key.padEnd(9), r.raw.camelot.padStart(3),
      'E' + d.energy.toFixed(2), 'A' + d.arousal.toFixed(2), 'V' + d.valence.toFixed(2), 'perc' + r.raw.perc.toFixed(2), 'intro' + r.raw.intro + 's', 'hook@' + r.raw.hook + 's'].join(' '));
  });
  fs.writeFileSync(path.join(WORK, 'features.json'), JSON.stringify(rows, null, 1));
  fs.writeFileSync(path.join(WORK, 'ref.json'), JSON.stringify(ref, null, 1));
}).catch(function (e) { console.error(e); process.exit(1); });
