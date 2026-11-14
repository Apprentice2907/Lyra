/* Ask Encore for the next song after any song, from the terminal.

   node tools/next-song.js "Tum Hi Ho" [--hour 22] [--seed 1] [--analyse 12] [--pick 2]
   node tools/next-song.js --file song.mp3 --title "Aaoge Tum Kabhi" --artist "The Local Train"
                           [--lang hindi] [--genre "hindi indie"]

   By name, the song must be in JioSaavn's catalogue (where LYRA streams
   from); the best title match is used, and if nothing matches well the tool
   lists the closest results instead of guessing (--pick N chooses one).
   With --file, Encore hears your own copy of any song (mp3, m4a, wav, …);
   --genre adds a playlist search for that style to the candidates.

   Runs the app's own pipeline, outside the browser:
     1. finds the song with the app's API client (js/api.js)
     2. hears it: downloads the 12 kbps stream and runs Encore's DSP
        (tempo, key, energy, mood, drums vs harmony, intro, hook)
     3. gathers candidates the way the app does (this artist, similar
        artists, the album, a playlist that fits the moment, a popular pool)
     4. ranks them with Encore's model, analyses the shortlist's audio,
        re-ranks with the same draw, and explains the pick
   As in the app on day one, the listener has no history yet (cold start):
   the pick comes from how the songs sound, the moment and Encore's priors.
   Needs ffmpeg on the PATH. Song analyses are cached in data/cache/. */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var cp = require('child_process');
var DSP = require('../js/encore/dsp.js');
var P = require('../js/encore/profile.js');
var M = require('../js/encore/model.js');

var ROOT = path.join(__dirname, '..');
var CACHE_DIR = path.join(ROOT, 'data', 'cache');
var CACHE = path.join(CACHE_DIR, 'features.json');
var MARGIN = 0.1;

/* ── the app's API client, in Node ── */
function loadApi() {
  var entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'" };
  var sandbox = {
    fetch: fetch, AbortController: AbortController, setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
    document: {
      createElement: function () {
        return {
          set innerHTML(v) {
            this._v = String(v).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (m, e) {
              if (e[0] === '#') return String.fromCharCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
              return entities[e.toLowerCase()] != null ? entities[e.toLowerCase()] : m;
            });
          },
          get value() { return this._v; }
        };
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ['js/config.js', 'js/api.js'].forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }); });
  return { api: sandbox.MusicAPI, cfg: sandbox.VINYL_CONFIG };
}

/* ── hearing a song ── */
var cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { cache = {}; }
function saveCache() { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); }

// decode any audio with ffmpeg (mono, 11025 Hz, as the app decodes the 12 kbps stream) and analyse it
function analyseAudio(input) {
  var file = typeof input === 'string';
  // a local file is low-passed to the 12 kbps stream's ~3.8 kHz, so it is measured like catalogue songs
  var args = ['-v', 'error', '-i', file ? input : 'pipe:0'].concat(file ? ['-af', 'lowpass=f=3800'] : [])
    .concat(['-ac', '1', '-ar', String(DSP.SR), '-f', 'f32le', 'pipe:1']);
  var r = cp.spawnSync('ffmpeg', args, { input: file ? undefined : Buffer.from(input), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg: ' + String(r.stderr).slice(0, 200));
  return DSP.analyze(new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4), DSP.SR);
}

function hear(t) {
  if (cache[t.id]) return Promise.resolve(cache[t.id]);
  if (t.file) {
    try { cache[t.id] = analyseAudio(t.file); saveCache(); return Promise.resolve(cache[t.id]); } catch (e) { return Promise.reject(e); }
  }
  var url = String(t.src).replace(/_(\d+)\.mp4(\?.*)?$/, '_12.mp4$2');
  return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(function (buf) {
    cache[t.id] = analyseAudio(buf);
    saveCache();
    return cache[t.id];
  }).catch(function () { return null; });
}

/* ── finding the song you mean ── */
function words(s) {
  return P.titleKey(s).normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    .map(function (w) { return w.replace(/(.)\1+/g, '$1'); });                // "aaoge" ≈ "aoge"
}
/* Both ways: every word you typed is in the title or artist (recall), and
   most of the title's words are ones you typed (precision). "Aaoge Tum
   Kabhi" must not match "Laut Kar Kabhi Na Aaoge Tum" just because all
   three words appear in it. */
function matchScore(query, t) {
  var q = words(query), have = words(t.title + ' ' + t.artist), tw = words(t.title);
  if (!q.length || !tw.length) return { recall: 0, precision: 0, s: 0 };
  var recall = q.filter(function (w) { return have.indexOf(w) >= 0; }).length / q.length;
  var precision = tw.filter(function (w) { return q.indexOf(w) >= 0; }).length / tw.length;
  return { recall: recall, precision: precision, s: recall + precision };
}

function findSong(api, q, pick) {
  return api.searchSongs(q, 10).then(function (found) {
    var ranked = found.map(function (t) { var m = matchScore(q, t); return { t: t, s: m.s, m: m }; }).sort(function (a, b) { return b.s - a.s; });
    if (pick) {
      if (!ranked[pick - 1]) throw new Error('no result number ' + pick);
      return ranked[pick - 1].t;
    }
    if (ranked.length && ranked[0].m.recall >= 0.99 && ranked[0].m.precision >= 0.75) return ranked[0].t;
    var msg = '"' + q + '" is not in the catalogue LYRA streams from (JioSaavn), as far as the search can tell.';
    if (ranked.length) {
      msg += '\nClosest results:\n' + ranked.slice(0, 6).map(function (x, i) {
        return '  ' + (i + 1) + '. ' + x.t.title + ' — ' + x.t.artist + (x.t.year ? ' (' + x.t.year + ')' : '');
      }).join('\n') + '\nUse --pick N for one of these, or --file <audio> with --title / --artist for your own copy.';
    }
    throw new Error(msg);
  });
}

// an artist id for a name, so a local file still gets "this artist" candidates
function findArtist(cfg, name) {
  if (!name) return Promise.resolve(null);
  var base = (cfg.apiBases || [])[0];
  return fetch(base + '/search/artists?query=' + encodeURIComponent(name) + '&limit=5').then(function (r) { return r.json(); }).then(function (j) {
    var res = ((j && j.data && j.data.results) || []).filter(function (a) { return P.lc(a.name) === P.lc(name); })[0];
    return res ? String(res.id) : null;
  }).catch(function () { return null; });
}

function rngOf(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(a, r) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

/* ── candidates, as js/encore/encore.js gathers them ── */
function candidates(api, cfg, cur, curFeat, ctx, r, genre) {
  var jobs = [];
  function tag(src) { return function (list) { return (list || []).map(function (t) { return { t: t, src: src }; }); }; }
  function job(p) { jobs.push(p.catch(function () { return []; })); }
  var aid = cur.artistIds && cur.artistIds[0];
  if (aid) {
    job(api.artistSongs(aid).then(tag('artist')));
    job(api.artist(aid).then(function (info) {
      return Promise.all((info.similar || []).slice(0, 2).map(function (s) { return api.artistSongs(s.id).catch(function () { return []; }); }))
        .then(function (g) { return tag('taste')([].concat.apply([], g).slice(0, 12)); });
    }));
  }
  (cur.artistIds || []).slice(1, 2).forEach(function (id) { job(api.artistSongs(id).then(tag('taste'))); });
  if (cur.albumId) job(api.album(cur.albumId).then(tag('album')));
  // a playlist for the moment: language + time of day + the mood of this song
  var v = curFeat ? curFeat.valence : null, e = curFeat ? curFeat.energy : null, word;
  if (e != null && e > 0.68) word = ctx.block === 1 ? 'workout' : 'party';
  else if (ctx.block === 0 || ctx.block === 4) word = v != null && v < 0.38 ? 'sad' : 'late night';
  else if (ctx.block === 1) word = 'morning';
  else if (v != null && v < 0.38) word = 'sad';
  else if (ctx.block === 3) word = 'romantic';
  else word = 'chill';
  var query = (cur.language || 'hindi') + ' ' + word + ' songs';
  job(api.searchPlaylists(query, 3).then(function (pls) {
    var pl = (pls || []).filter(function (p) { return p.count >= 8; })[0];
    return pl ? api.playlist(pl.id, 40).then(function (l) { return tag('context')(shuffle(l.slice(), r).slice(0, 20)); }) : [];
  }));
  if (genre) {
    // the style you named: its best playlist joins the "context" source
    job(api.searchPlaylists(genre, 3).then(function (pls) {
      var pl = (pls || []).filter(function (p) { return p.count >= 8; })[0];
      return pl ? api.playlist(pl.id, 40).then(function (l) { return tag('context')(shuffle(l.slice(), r).slice(0, 20)); }) : [];
    }));
  }
  var pool = cfg.explorePool || [];
  if (pool.length) job(api.playlist(pool[Math.floor(r() * pool.length)], 40).then(function (l) { return tag('explore')(shuffle(l.slice(), r).slice(0, 12)); }));
  return Promise.all(jobs).then(function (groups) {
    var seen = {}, out = [], key = words(cur.title).join(' '), per = {};
    [].concat.apply([], groups).forEach(function (c) {
      var t = c.t;
      // not the same song again, in any version (covers, lofi, mashups that start with its title)
      if (!t || !t.src || seen[t.id] || t.id === cur.id || words(t.title).join(' ').indexOf(key) === 0) return;
      seen[t.id] = 1;
      if ((per[c.src] = (per[c.src] || 0) + 1) > 12) return;
      out.push(c);
    });
    return { list: out, query: query };
  });
}

function main() {
  var argv = process.argv.slice(2), o = {}, rest = [];
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].slice(0, 2) === '--') { o[argv[i].slice(2)] = argv[i + 1]; i++; } else rest.push(argv[i]);
  }
  var q = rest.join(' ');
  if (!q && !o.file) {
    console.error('usage: node tools/next-song.js "song name" [--hour 22] [--seed 1] [--analyse 12] [--pick N]\n' +
      '       node tools/next-song.js --file song.mp3 --title "..." --artist "..." [--lang hindi] [--genre "hindi indie"]');
    process.exit(1);
  }
  var now = new Date();
  if (o.hour != null) now.setHours(+o.hour, 0, 0, 0);
  var ctx = P.context(now.getTime()), r = rngOf(+(o.seed || 1)), nAnalyse = +(o.analyse || 12);
  var A = loadApi(), api = A.api;

  var seed = o.file
    ? findArtist(A.cfg, o.artist).then(function (aid) {
        if (!fs.existsSync(o.file)) throw new Error('no such file: ' + o.file);
        return { id: 'file:' + path.basename(o.file), file: o.file, title: o.title || path.basename(o.file).replace(/\.[^.]+$/, ''),
          artist: o.artist || 'Unknown artist', artistIds: aid ? [aid] : [], language: o.lang || 'hindi', album: '', year: '' };
      })
    : findSong(api, q, o.pick ? +o.pick : 0);

  seed.then(function (cur) {
    console.log('\nNow playing: ' + cur.title + ' — ' + cur.artist + (cur.album ? ' (' + cur.album + (cur.year ? ', ' + cur.year : '') + ')' : ''));
    console.log('Moment: ' + P.BLOCKS[ctx.block] + ', ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '. New listener: no history yet.\n');
    return hear(cur).then(function (raw) {
      var f = raw ? DSP.describe(raw) : null;
      if (f) {
        console.log('How it sounds:');
        console.log('  ' + (f.tempoConf > 0.3 ? Math.round(f.bpm) + ' BPM' : 'free tempo') + ', ' + f.key + ' (' + f.camelot + '), intro ' + f.intro + ' s, hook from ' + f.hook + ' s');
        console.log('  energy ' + pct(f.energy) + ', mood ' + pct(f.valence) + ', intensity ' + pct(f.arousal) + ', groove ' + pct(f.dance) + ', acoustic ' + pct(f.acoustic));
        console.log('  drums vs harmony: ' + pct(raw.perc) + ' of the sound is percussive, ' + raw.kickRate.toFixed(1) + ' kick hits/s, beat clarity ' + pct(raw.pulse));
      }
      return candidates(api, A.cfg, cur, f, ctx, r, o.genre).then(function (c) { return { cur: cur, f: f, cands: c.list, query: c.query }; });
    });
  }).then(function (d) {
    console.log('\nCandidates: ' + d.cands.length + ' (this artist, similar artists, the album, "' + d.query + '"' +
      (o.genre ? ', "' + o.genre + '"' : '') + ', a popular pool)');
    var prof = P.create(ctx.t), model = M.create();
    var state = { ctx: ctx, prof: prof, cur: d.cur, curFeat: d.f, session: { ids: [], artists: [], skips: [], valence: d.f ? d.f.valence : null },
      liked: function () { return false; }, inPlaylist: function () { return false; }, mode: 'auto' };
    // stage 1: rank on what we know, stage 2: hear the shortlist and re-rank with the same draw (as in the app)
    d.cands.forEach(function (c) { c.feat = cache[c.t.id] ? DSP.describe(cache[c.t.id]) : null; });
    var first = M.rank(model, state, d.cands, { rng: r, draws: 0, margin: MARGIN });
    var shortlist = first.list.slice(0, nAnalyse).map(function (it) { return it.cand.t; });
    process.stdout.write('Listening to the top ' + shortlist.length + ' candidates');
    var k = 0;
    function next() {
      if (k >= shortlist.length) return Promise.resolve();
      return hear(shortlist[k++]).then(function () { process.stdout.write('.'); return next(); });
    }
    return next().then(function () {
      console.log('\n');
      d.cands.forEach(function (c) { c.feat = cache[c.t.id] ? DSP.describe(cache[c.t.id]) : null; c.x = null; });
      var res = M.rank(model, state, d.cands, { rng: r, w: first.w, margin: MARGIN, draws: 64 });
      var top = res.list[0], byMean = res.list.slice().sort(function (a, b) { return b.mean - a.mean; });
      var exploring = byMean[0].mean - top.mean > 0.05;
      console.log('Up next: ' + top.cand.t.title + ' — ' + top.cand.t.artist + '   (found via ' + top.cand.src + ')');
      M.explain(top, res.mu, ctx, exploring).forEach(function (w) { console.log('  · ' + w); });
      if (top.cand.feat && d.f) {
        var g = top.cand.feat;
        console.log('  sound: ' + (g.tempoConf > 0.3 ? Math.round(g.bpm) + ' BPM' : 'free tempo') + ', ' + g.key + ' (' + g.camelot + '), energy ' + pct(g.energy) +
          ' (now ' + pct(d.f.energy) + '), mood ' + pct(g.valence) + ' (now ' + pct(d.f.valence) + ')');
      }
      console.log('  chance Encore picks it on a given draw: ' + pct(top.prop));
      console.log('\nThe rest of the shortlist (by expected score):');
      byMean.slice(0, 6).forEach(function (it, i) {
        var g = it.cand.feat;
        console.log('  ' + (i + 1) + '. ' + (it.cand.t.title + ' — ' + String(it.cand.t.artist).split(',')[0]).slice(0, 52).padEnd(52) +
          ' ' + it.mean.toFixed(2) + '  ' + it.cand.src.padEnd(8) + (g ? ' ' + (g.tempoConf > 0.3 ? Math.round(g.bpm) + ' BPM ' : '') + g.camelot + ', energy ' + pct(g.energy) + ', mood ' + pct(g.valence) : ' (not heard yet)'));
      });
      console.log('\nCold start: no listening history, so "definitely" is not a promise Encore can make yet.');
      console.log('Every play, skip and replay in the app moves these weights toward your own taste.\n');
    });
  }).catch(function (e) { console.error('\n' + e.message); process.exit(1); });
}

main();
