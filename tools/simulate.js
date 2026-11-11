/* ListenSim-lite: synthetic listeners with hidden tastes, to check that
   Encore's learning loop (reward → profile → features → model → rank)
   actually learns, and to compare it with simple policies.

   node tools/simulate.js [days=28] [seed=1]

   Honest scope: the simulator is built on the same assumptions the model
   encodes (time-of-day taste, mood regulation, smooth transitions,
   familiarity), so good numbers here show the machinery can learn those
   patterns from implicit feedback — not that real people behave this way.
   Calibrating a simulator to real logs is the research step that comes next
   (see 02-music-next-song-plan.md, ListenSim). */
'use strict';
var P = require('../js/encore/profile.js');
var M = require('../js/encore/model.js');

function rngOf(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { var u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sig(x) { return 1 / (1 + Math.exp(-x)); }
function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

/* ───────────── catalogue ───────────── */

function catalogue(seed) {
  var r = rngOf(seed), langs = ['hindi', 'hindi', 'hindi', 'hindi', 'hindi', 'punjabi', 'punjabi', 'english', 'english', 'tamil'];
  var artists = [], songs = [];
  for (var a = 0; a < 70; a++) {
    var art = {
      name: 'Artist ' + a, lang: pick(r, langs),
      e: 0.15 + r() * 0.75, v: 0.15 + r() * 0.7, bpm: clamp(110 + gauss(r) * 22, 65, 175),
      timbre: [0, 0, 0, 0, 0, 0, 0, 0, 0].map(function () { return gauss(r); }),
      pop: Math.pow(10, 5.5 + r() * 2.5), year: 1992 + Math.floor(r() * 33)
    };
    artists.push(art);
    var n = 8 + Math.floor(r() * 6);
    for (var k = 0; k < n; k++) {
      var e = clamp(art.e + gauss(r) * 0.09, 0.03, 0.98), v = clamp(art.v + gauss(r) * 0.09, 0.03, 0.98);
      var bpm = clamp(art.bpm + gauss(r) * 9, 60, 185);
      var feat = {
        energy: e, valence: v, arousal: clamp(0.6 * e + 0.4 * (bpm - 60) / 120 + gauss(r) * 0.05, 0, 1),
        bpm: bpm, tempoConf: 0.8, camelot: (1 + Math.floor(r() * 12)) + (r() < 0.55 ? 'A' : 'B'),
        timbre: art.timbre.map(function (t) { return t + gauss(r) * 0.3; }), intro: Math.floor(-Math.log(1 - r() * 0.95) * 12)
      };
      songs.push({
        t: { id: 's' + songs.length, title: 'Song ' + songs.length, artist: art.name, artistIds: ['a' + a], language: art.lang,
             album: art.name + ' LP' + (k % 2), year: String(art.year), duration: Math.round(clamp(230 + gauss(r) * 40, 120, 420)),
             playCount: Math.round(art.pop * Math.pow(10, gauss(r) * 0.4)) },
        feat: feat, artist: a
      });
    }
  }
  return { artists: artists, songs: songs };
}

/* ───────────── listeners (hidden truth) ───────────── */

var PERSONAS = [
  { name: 'night owl, stays sad at night', hours: [22.5, 0.7, 2.6], langs: { hindi: 1, punjabi: 0.1 },
    energy: [0.2, 0.5, 0.55, 0.45, 0.3], valence: [0.25, 0.5, 0.55, 0.45, 0.3], regulation: 'match', trans: 0.6, novelty: -0.2, skipMean: 7, loop: 0.25, like: 0.2 },
  { name: 'morning runner, lifts out of sad songs', hours: [6.8, 8.2, 18.5], langs: { punjabi: 1, english: 0.8, hindi: 0.3 },
    energy: [0.4, 0.85, 0.7, 0.6, 0.5], valence: [0.5, 0.75, 0.65, 0.6, 0.5], regulation: 'lift', trans: 0.3, novelty: 0.15, skipMean: 20, loop: 0.1, like: 0.1 },
  { name: 'evening explorer, hates jarring jumps', hours: [17.5, 20.2, 22.4], langs: { hindi: 0.8, english: 0.8, tamil: 0.6 },
    energy: [0.35, 0.5, 0.55, 0.5, 0.4], valence: [0.4, 0.55, 0.55, 0.5, 0.45], regulation: 'match', trans: 1.0, novelty: 0.35, skipMean: 30, loop: 0.05, like: 0.08 }
];

function listener(persona, cat, seed) {
  var r = rngOf(seed), favs = {};
  // favourite artists: in their languages, close to their daytime taste
  var ranked = cat.artists.map(function (a, i) {
    var lw = persona.langs[a.lang] || 0;
    return { i: i, s: lw * 1.5 - Math.abs(a.e - persona.energy[2]) - Math.abs(a.v - persona.valence[2]) + r() * 0.6 };
  }).sort(function (a, b) { return b.s - a.s; });
  ranked.slice(0, 6).forEach(function (x) { favs[x.i] = 1; });
  return { p: persona, favs: favs, heard: {} };
}

// how much this listener wants song s now (hidden from the policy)
function utility(L, s, prev, block, history, now, r, cat) {
  var p = L.p, f = s.feat, a = cat.artists[s.artist], u = 0;
  u += L.favs[s.artist] ? 1.0 : (p.langs[a.lang] || 0) * 0.4 - 0.35;
  u += 0.9 * (0.25 - Math.abs(f.energy - p.energy[block])) / 0.25;
  u += 0.6 * (0.25 - Math.abs(f.valence - p.valence[block])) / 0.25;
  if (prev) {
    u -= p.trans * 1.4 * P.soundGap(prev.feat, f);
    if (prev.feat.valence < 0.4) {
      var dv = f.valence - prev.feat.valence;
      u += p.regulation === 'lift' ? 0.8 * clamp(dv / 0.2, -1, 1.5) : -0.6 * Math.abs(dv) / 0.2;
    }
  }
  if (!L.heard[s.artist]) u += p.novelty;
  var last = L.heard['song' + s.t.id];
  if (last && now - last < P.DAY) u -= 0.8;
  var run = history.slice(-2);
  if (run.length === 2 && run[0].artist === s.artist && run[1].artist === s.artist) u -= 1.0;
  u += 0.15 * (Math.log(s.t.playCount) / Math.LN10 - 6.5);
  return u + gauss(r) * 0.45;
}

/* ───────────── one simulated play → a play record ───────────── */

function respond(L, s, u, ctx, ses, r, how) {
  var p = L.p, dur = s.t.duration, through = r() < sig(1.7 * u - 0.1);
  var heard, end;
  if (through) { heard = dur; end = 'ended'; }
  else {
    heard = clamp(-Math.log(1 - r() * 0.98) * p.skipMean * (u > 0 ? 1.8 : 1), 1, dur * 0.85);
    end = r() < 0.04 ? 'idle' : 'next';
  }
  var loops = through && u > 1.1 && r() < p.loop ? 1 : 0;
  var liked = through && r() < p.like * sig(2 * (u - 1)) ? 1 : 0;
  return {
    tid: s.t.id, title: s.t.title, artist: s.t.artist, artists: [s.t.artist], artistIds: s.t.artistIds, lang: s.t.language,
    album: s.t.album, year: s.t.year, dur: dur, pc: s.t.playCount, ctx: ctx, how: how, src: how,
    heard: heard, maxPos: heard, end: end, pauses: 0, seekFwd: 0, seekFwdEarly: 0, seekBack: 0, restarts: loops, replay: false,
    vol0: 0.5, volMin: 0.5, volMax: 0.5, volEnd: 0.5, liked: liked, added: false, bgSec: 0,
    sess: ses.id, pos: ses.pos, prevSkip: ses.prevSkip
  };
}

/* ───────────── candidate pool (the same for every policy) ───────────── */

function pool(cat, cur, prof, ses, r) {
  var out = [], seen = {};
  function add(s, src) { if (!seen[s.t.id] && ses.ids.indexOf(s.t.id) < 0) { seen[s.t.id] = 1; out.push({ t: s.t, feat: s.feat, src: src, s: s }); } }
  cat.songs.forEach(function (s) { if (s.artist === cur.artist) add(s, 'artist'); });
  var top = Object.keys(prof.artists).sort(function (a, b) { return P.affinity(prof.artists[b]) - P.affinity(prof.artists[a]); }).slice(0, 2);
  cat.songs.forEach(function (s) { if (top.indexOf(P.lc(s.t.artist)) >= 0) add(s, 'taste'); });
  Object.keys(prof.songs).filter(function (id) { return P.affinity(prof.songs[id]) > 0.4; }).slice(0, 15)
    .forEach(function (id) { add(cat.songs[+id.slice(1)], 'familiar'); });
  var lang = cur.t.language;
  for (var i = 0; i < 15; i++) { var c = pick(r, cat.songs); if (c.t.language === lang) add(c, 'context'); }
  for (i = 0; i < 15; i++) add(pick(r, cat.songs), 'explore');
  return out;
}

/* ───────────── policies ───────────── */

var POLICIES = {
  random: function (env, cands) { return cands[Math.floor(env.r() * cands.length)]; },
  popular: function (env, cands) { return cands.slice().sort(function (a, b) { return b.t.playCount - a.t.playCount; })[0]; },
  'same artist': function (env, cands, cur) {
    var same = cands.filter(function (c) { return c.s.artist === cur.artist; });
    return same.length ? same[Math.floor(env.r() * same.length)] : cands[Math.floor(env.r() * cands.length)];
  },
  'encore, frozen weights': function (env, cands) { return M.rank(env.model, env.state, cands, { rng: env.r, draws: 0, margin: env.margin }).list[0].cand; },
  encore: function (env, cands) { return M.rank(env.model, env.state, cands, { rng: env.r, draws: 0, margin: env.margin }).list[0].cand; }
};

function run(opts) {
  opts = opts || {};
  var days = opts.days || 28, seed = opts.seed || 1;
  if (!('margin' in opts)) opts.margin = 0.1;           // same safe exploration as the app
  var personas = opts.personas || PERSONAS, policies = opts.policies || Object.keys(POLICIES);
  var cat = catalogue(seed), start = new Date(2026, 10, 2, 0, 0).getTime(), results = {};
  personas.forEach(function (persona, pi) {
    results[persona.name] = {};
    policies.forEach(function (pol) {
      var r = rngOf(seed * 1000 + pi * 17 + 3), L = listener(persona, cat, seed + pi), prof = P.create(start), model = M.create(opts.model);
      var learn = pol === 'encore', weeks = [];
      for (var d = 0; d < days; d++) {
        var wk = weeks[Math.floor(d / 7)] || (weeks[Math.floor(d / 7)] = { plays: 0, through: 0, quick: 0, reward: 0, sessions: 0, songs: 0 });
        persona.hours.forEach(function (h, si) {
          if (r() < 0.15) return;                             // some sessions don't happen
          var t = start + d * P.DAY + (h + gauss(r) * 0.4) * 3600e3;
          var ses = { id: 'd' + d + 's' + si, ids: [], artists: [], skips: [], pos: 0, prevSkip: false, valence: null };
          var favList = cat.songs.filter(function (s) { return L.favs[s.artist]; });
          var cur = pick(r, favList), prevFeat = null, history = [], how = 'pick';
          wk.sessions++;
          for (var k = 0; k < 30; k++) {
            var ctx = P.context(t), state = { ctx: ctx, prof: prof, cur: history.length ? history[history.length - 1].t : null,
              curFeat: prevFeat, session: ses, liked: function () { return false; }, inPlaylist: function () { return false; }, mode: 'auto' };
            var prevSong = history[history.length - 1] || null;
            var u = utility(L, cur, prevSong, ctx.block, history, t, r, cat);
            var rec = respond(L, cur, u, ctx, ses, r, how);
            var rw = P.reward(rec, prof);
            if (learn && how !== 'pick') M.update(model, M.featurize(state, { t: cur.t, feat: cur.feat, src: cur._src }), rw.r, 1);
            if (learn && how === 'pick') M.update(model, M.featurize(state, { t: cur.t, feat: cur.feat, chosen: 1 }), rw.r, 0.5);
            P.update(prof, rec, rw, cur.feat, prevFeat, cur.t);
            L.heard[cur.artist] = 1;
            L.heard['song' + cur.t.id] = t;
            if (how !== 'pick') {
              wk.plays++;
              wk.through += rw.completed ? 1 : 0;
              wk.quick += rw.skip && rec.heard < 10 ? 1 : 0;
              wk.reward += rw.r;
            }
            wk.songs++;
            ses.ids.push(cur.t.id); ses.artists.push(P.lc(cur.t.artist)); ses.skips.push(rw.skip ? 1 : 0);
            ses.valence = ses.valence == null ? cur.feat.valence : ses.valence * 0.6 + cur.feat.valence * 0.4;
            ses.prevSkip = rw.skip; ses.pos++;
            history.push(cur);
            prevFeat = cur.feat;
            t += rec.heard * 1000 + 2000;
            var quits = 0.05 + (rw.skip ? 0.1 : 0) + (ses.skips.slice(-2).join() === '1,1' ? 0.2 : 0);
            if (r() < quits || rec.end === 'idle') break;
            var cands = pool(cat, cur, prof, ses, r);
            if (!cands.length) break;
            var env = { r: r, margin: opts.margin, model: model, state: { ctx: P.context(t), prof: prof, cur: cur.t, curFeat: cur.feat, session: ses,
              liked: function () { return false; }, inPlaylist: function () { return false; }, mode: 'auto' } };
            var choice = POLICIES[pol](env, cands, cur);
            cur = choice.s;
            cur._src = choice.src;
            how = 'encore';
          }
        });
      }
      results[persona.name][pol] = weeks.map(function (w) {
        return { through: w.plays ? w.through / w.plays : 0, quick: w.plays ? w.quick / w.plays : 0, reward: w.plays ? w.reward / w.plays : 0, songs: w.sessions ? w.songs / w.sessions : 0 };
      });
      results[persona.name][pol].profile = prof;
      results[persona.name][pol].model = model;
    });
  });
  return results;
}

module.exports = { run: run, PERSONAS: PERSONAS, POLICIES: POLICIES, catalogue: catalogue };

if (require.main === module) {
  var days = +(process.argv[2] || 28), seed = +(process.argv[3] || 1), t0 = Date.now();
  var res = run({ days: days, seed: seed });
  Object.keys(res).forEach(function (name) {
    console.log('\n' + name + '\n' + 'policy'.padEnd(20) + Array.from({ length: Math.ceil(days / 7) }, function (_, i) { return ('week ' + (i + 1)).padStart(10); }).join('') + '   last week: quick skips, songs/session');
    Object.keys(res[name]).forEach(function (pol) {
      var w = res[name][pol], last = w[w.length - 1];
      console.log(pol.padEnd(20) + w.map(function (x) { return (Math.round(x.through * 100) + '%').padStart(10); }).join('') +
        '   ' + (Math.round(last.quick * 100) + '%').padStart(5) + '   ' + last.songs.toFixed(1));
    });
    var enc = res[name].encore;
    console.log('  learned: ' + P.insights(enc.profile, Date.now() + 365 * P.DAY).slice(0, 4).map(function (i) { return i.text; }).join(' / '));
    console.log('  moved most: ' + M.weights(enc.model).slice(0, 5).map(function (w) { return w.name + ' ' + (w.moved > 0 ? '+' : '') + w.moved; }).join(', '));
  });
  console.log('\n(listen-through rate per week; ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}
