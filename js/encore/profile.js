/* Encore profile: turns one play into a reward, and keeps a calibrated
   picture of one listener — when they listen, how they skip, what they reach
   for at each time of day, how they move between moods, and what they think
   of each song, artist, language and era.

   Pure (no DOM): the app, the tests and the simulator all use this file.

   Play record (built by signals.js):
     tid, title, artist, artists[], lang, album, year, dur, pc (play count)
     ctx      { t, hour, dow, weekend, block }      when it started
     how      'pick' | 'auto' | 'next' | 'prev' | 'encore'   why it started
     src      where the queue came from (search, home, playlist, encore, …)
     heard    seconds actually played (seeks excluded)
     maxPos   furthest position reached (s)
     end      'ended' | 'next' | 'prev' | 'pick' | 'idle' | 'close' | 'error'
     pauses, pauseSec, seekFwd, seekFwdEarly, seekBack, restarts, replay
     vol0, volMin, volMax, volEnd, liked (+1/−1/0), added (bool), bgSec
     sess, pos, prevSkip                              session bookkeeping */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EncoreProfile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var DAY = 864e5;
  var BLOCKS = ['night', 'morning', 'afternoon', 'evening', 'late evening'];
  var BLOCK_HOURS = ['midnight–5 AM', '5–11 AM', '11 AM–5 PM', '5–9 PM', '9 PM–midnight'];
  var SKIP_BINS = [5, 10, 20, 30, 60, 120, Infinity];
  var SONG_CAP = 1500, ARTIST_CAP = 600;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function round(v, d) { var k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; }
  function lc(s) { return String(s || '').toLowerCase().trim(); }

  function blockOf(hour) { return hour < 5 ? 0 : hour < 11 ? 1 : hour < 17 ? 2 : hour < 21 ? 3 : 4; }

  /* Context of a moment. Hour is local and fractional; the five blocks are
     Encore's own split, after the diurnal patterns in Heggli et al. (2021)
     and Park et al. (2019). */
  function context(ms) {
    var d = new Date(ms), hour = d.getHours() + d.getMinutes() / 60, dow = d.getDay();
    return { t: ms, hour: round(hour, 2), dow: dow, weekend: dow === 0 || dow === 6, block: blockOf(hour) };
  }

  /* "Ishq (Lofi)", "Ishq - Female", "Ishq Reprise" and "Ishq" are the same
     song for a listener: brackets, a " - …" tail and a trailing version word
     (after at least one other word) are dropped. */
  var VERSION_WORDS = /^(.+?)\s+(reprise|unplugged|lo-?fi|remix(ed)?|version|female|male|acoustic|slowed|reverb|sped up|mashup|cover|live|reloaded|flip|mix|edit|duet|instrumental|karaoke|extended|radio edit)\b.*$/;
  function titleKey(title) {
    var k = lc(title).replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/\s+-\s+.*$/, '').replace(/\s+/g, ' ').trim();
    var m = k.match(VERSION_WORDS);
    return m ? m[1].trim() : k;
  }

  /* ───────────── decayed statistics ─────────────
     Old behaviour fades with a half-life, so the profile follows a listener
     who changes (new phase, new season) without forgetting them overnight. */

  var HALF_LIFE = 45 * DAY;

  function decay(cell, now, hl) {
    if (!cell.t) { cell.t = now; return 1; }
    var f = Math.pow(0.5, Math.max(0, now - cell.t) / (hl || HALF_LIFE));
    cell.t = now;
    return f;
  }

  // a weighted mean that fades: { w, m, t }
  function meanAdd(cell, x, w, now, hl) {
    var f = decay(cell, now, hl);
    cell.w = (cell.w || 0) * f + w;
    cell.m = cell.w ? (cell.m || 0) + (x - (cell.m || 0)) * (w / cell.w) : x;
  }

  // a count and a reward sum that fade together: { n, r, t }
  function tally(cell, r, now, hl) {
    var f = decay(cell, now, hl);
    cell.n = (cell.n || 0) * f + 1;
    cell.r = (cell.r || 0) * f + r;
  }

  // shrunk mean reward: a song heard once can't outrank one loved for months
  function affinity(cell, prior) {
    if (!cell || !cell.n) return 0;
    var k = prior == null ? 2 : prior;
    return clamp(cell.r / (cell.n + k), -1.5, 2.5);
  }

  /* ───────────── reward ───────────── */

  // restarts and replays count as love only when the listener stays (≥ 20 s)
  function loopCount(rec) {
    return (rec.restarts || 0) + (rec.replay && (rec.heard || 0) >= 20 ? 1 : 0);
  }

  // how much a skip means from this listener: frequent skippers are browsing
  function harshness(prof) {
    var s = prof && prof.rates && prof.rates.skip && prof.rates.skip.w > 5 ? prof.rates.skip.m : 0.35;
    return clamp(0.35 / Math.max(s, 0.1), 0.6, 1.4);
  }

  /* Reward for one play: the plan's table, made continuous and calibrated.
       played through (≥ 90 % or ended)        +1.0
       skipped under 10 s                       −1.0
       skipped 10–30 s                          −1.0 → −0.5
       left after 30 s                          −0.2 → +0.7 by how much was heard
       restart / loop                           +1.5 each (max 2)
       liked while playing                      +2.0   (un-liked −1.0)
       added to a playlist                      +1.0
       went back to hear a part again           +0.3
       jumped past the intro, then stayed       +0.2
       turned it up                             +0.2   (turned it to near silence −0.3)
       stopped listening right after a skip     −1.0   (this song ended the session)
     Negative parts are scaled by harshness(): a skip means less from
     someone who skips most things. */
  function reward(rec, prof) {
    var parts = [], r = 0;
    function add(label, v) { if (v) { parts.push([label, round(v, 2)]); r += v; } }
    if (rec.end === 'error') return { r: 0, parts: [['could not play', 0]], skip: false, completed: false, neutral: true };

    var dur = rec.dur > 0 ? rec.dur : 240, heard = Math.max(0, rec.heard || 0);
    var frac = clamp(heard / dur, 0, 1), maxFrac = clamp((rec.maxPos || 0) / dur, 0, 1);
    // what was heard decides, not how it ended: scrubbing to the end is not listening to the end
    var completed = frac >= 0.9 || (maxFrac >= 0.97 && frac >= 0.5);
    var interrupted = rec.end === 'idle' || rec.end === 'close';
    var skip = !completed && !interrupted;
    var h = harshness(prof);

    if (completed) add('played to the end', 1);
    else if (interrupted) add(frac >= 0.5 ? 'listened most of it' : 'interrupted', frac >= 0.5 ? 0.5 : 0);
    else if (heard < 10) add('skipped in ' + Math.round(heard) + ' s', -1 * h);
    else if (heard < 30) add('skipped at ' + Math.round(heard) + ' s', (-1 + 0.5 * (heard - 10) / 20) * h);
    else {
      var f30 = Math.min(0.85, 30 / dur), v = -0.2 + 0.9 * clamp((frac - f30) / (0.9 - f30), 0, 1);
      add('left after ' + Math.round(frac * 100) + '%', v < 0 ? v * h : v);
    }

    var loops = Math.min(2, loopCount(rec));
    add(loops > 1 ? 'played it again (×' + loops + ')' : 'played it again', 1.5 * loops);
    if (rec.liked > 0) add('liked it', 2);
    if (rec.liked < 0) add('un-liked it', -1);
    if (rec.added) add('added to a playlist', 1);
    if (rec.seekBack > 0) add('went back to hear a part again', 0.3);
    if (rec.seekFwdEarly > 0 && heard >= 30) add('jumped past the intro, then stayed', 0.2);
    if (rec.volMax != null && rec.vol0 != null && rec.volEnd - rec.vol0 > 0.08) add('turned it up', 0.2);
    if (rec.volMin != null && rec.volMin < 0.04 && rec.vol0 > 0.1) add('turned it right down', -0.3 * h);
    if (interrupted && heard < 20 && rec.prevSkip) add('stopped listening here', -1 * h);

    return { r: round(clamp(r, -2.5, 4), 3), parts: parts, skip: skip, completed: completed, neutral: false, frac: frac };
  }

  /* ───────────── profile ───────────── */

  function create(now) {
    var blocks = [];
    for (var b = 0; b < 5; b++) {
      blocks.push({ plays: {}, skips: {}, heard: {}, vol: {}, energy: {}, valence: {}, arousal: {}, tempo: {} });
    }
    return {
      v: VERSION, n: 0, since: now || 0, last: 0,
      clock: new Array(24).fill(0).map(function () { return {}; }),   // decayed seconds per hour
      week: new Array(7).fill(0).map(function () { return {}; }),
      blocks: blocks,
      skipHist: SKIP_BINS.map(function () { return {}; }),
      rates: { skip: {}, complete: {}, loop: {}, like: {}, pause: {}, seekFwdEarly: {}, quick: {}, bg: {} },
      sessions: { n: 0, songs: {}, minutes: {}, cur: null },
      artists: {}, langs: {}, albums: {}, eras: {},
      songs: {},
      trans: { small: {}, mid: {}, big: {} },
      mood: { lowNext: {}, lowSkip: {} },          // after a low-valence song: valence change of the next song, accepted / skipped
      novelty: { fresh: {}, known: {} },
      repeat: {},
      year: {}, dur: {}, pop: {}
    };
  }

  function songArtists(rec) {
    var list = rec.artists && rec.artists.length ? rec.artists : String(rec.artist || '').split(/\s*,\s*/);
    return list.map(lc).filter(function (a) { return a && a !== 'unknown artist'; });
  }

  // keep only the most useful entries (most played, most recent) when a map grows
  function prune(map, cap, now) {
    var keys = Object.keys(map);
    if (keys.length <= cap) return;
    keys.sort(function (a, b) {
      var A = map[a], B = map[b];
      var sa = (A.n || 0) * Math.pow(0.5, (now - (A.last || A.t || 0)) / HALF_LIFE) + (A.liked ? 5 : 0);
      var sb = (B.n || 0) * Math.pow(0.5, (now - (B.last || B.t || 0)) / HALF_LIFE) + (B.liked ? 5 : 0);
      return sa - sb;
    });
    for (var i = 0; i < keys.length - cap; i++) delete map[keys[i]];
  }

  /* Fold one finished play into the profile.
       feat     describe() of the song (or null if not analysed yet)
       prevFeat describe() of the song before it in the session (or null)
       meta     a slim, playable copy of the track for the song memory */
  function update(prof, rec, rw, feat, prevFeat, meta) {
    if (rw.neutral) return prof;
    var now = rec.ctx.t + Math.max(0, rec.heard || 0) * 1000, b = rec.ctx.block, blk = prof.blocks[b];
    var heard = Math.max(0, rec.heard || 0), r = rw.r;
    prof.n++;
    prof.last = now;

    // when they listen
    var hc = prof.clock[Math.floor(rec.ctx.hour) % 24];
    var fc = decay(hc, now);
    hc.s = (hc.s || 0) * fc + heard;
    var wc = prof.week[rec.ctx.dow];
    var fw = decay(wc, now);
    wc.s = (wc.s || 0) * fw + heard;
    meanAdd(blk.plays, 1, 1, now);
    meanAdd(blk.skips, rw.skip ? 1 : 0, 1, now);
    meanAdd(blk.heard, heard, 1, now);
    if (rec.vol0 != null) meanAdd(blk.vol, rec.volEnd != null ? rec.volEnd : rec.vol0, 1, now);

    // how they listen
    meanAdd(prof.rates.skip, rw.skip ? 1 : 0, 1, now);
    meanAdd(prof.rates.complete, rw.completed ? 1 : 0, 1, now);
    meanAdd(prof.rates.loop, loopCount(rec) > 0 ? 1 : 0, 1, now);
    meanAdd(prof.rates.like, rec.liked > 0 ? 1 : 0, 1, now);
    meanAdd(prof.rates.pause, rec.pauses > 0 ? 1 : 0, 1, now);
    meanAdd(prof.rates.seekFwdEarly, rec.seekFwdEarly > 0 ? 1 : 0, 1, now);
    meanAdd(prof.rates.bg, heard ? clamp((rec.bgSec || 0) / heard, 0, 1) : 0, 1, now);
    if (rw.skip) {
      meanAdd(prof.rates.quick, heard < 10 ? 1 : 0, 1, now);
      for (var k = 0; k < SKIP_BINS.length; k++) if (heard < SKIP_BINS[k]) { tally(prof.skipHist[k], 0, now); break; }
    }

    // sessions
    var S = prof.sessions;
    if (!S.cur || S.cur.id !== rec.sess) {
      if (S.cur) { meanAdd(S.songs, S.cur.songs, 1, now); meanAdd(S.minutes, S.cur.sec / 60, 1, now); }
      S.cur = { id: rec.sess, songs: 0, sec: 0 };
      S.n++;
    }
    S.cur.songs++;
    S.cur.sec += heard;

    // what they like: artists, language, album, era
    var arts = songArtists(rec), known = false;
    arts.forEach(function (a, i) {
      var cell = prof.artists[a] || (prof.artists[a] = {});
      if (cell.n > 0.5) known = true;
      tally(cell, r * (i ? 0.5 : 1), now);
      cell.last = now;
      if (rec.artistIds && rec.artistIds[i]) cell.id = rec.artistIds[i];
    });
    prune(prof.artists, ARTIST_CAP, now);
    if (rec.lang) tally(prof.langs[lc(rec.lang)] || (prof.langs[lc(rec.lang)] = {}), r, now);
    if (rec.album) tally(prof.albums[lc(rec.album)] || (prof.albums[lc(rec.album)] = {}), r, now);
    prune(prof.albums, ARTIST_CAP, now);
    var yr = parseInt(rec.year, 10);
    if (yr > 1900) {
      var dec = String(Math.floor(yr / 10) * 10);
      tally(prof.eras[dec] || (prof.eras[dec] = {}), r, now);
      if (r > 0) meanAdd(prof.year, yr, r, now);
    }
    if (r > 0 && rec.dur) meanAdd(prof.dur, rec.dur, r, now);
    if (r > 0 && rec.pc) meanAdd(prof.pop, Math.log(rec.pc + 1) / Math.LN10, r, now);
    tally(known ? prof.novelty.known : prof.novelty.fresh, r, now);

    // the song itself
    var sm = prof.songs[rec.tid] || (prof.songs[rec.tid] = {});
    var playedRecently = sm.last && now - sm.last < DAY;
    if (playedRecently) tally(prof.repeat, r, now);
    tally(sm, r, now);
    sm.last = now;
    if (rw.skip && heard < 10) { sm.quick = (sm.quick || 0) * Math.pow(0.5, (now - (sm.qt || now)) / (7 * DAY)) + 1; sm.qt = now; }
    if (rw.completed) sm.done = (sm.done || 0) + 1;
    if (rec.liked) sm.liked = rec.liked > 0;
    if (meta) sm.m = meta;
    prune(prof.songs, SONG_CAP, now);

    // what they reach for at this time of day (weighted by how much they liked it)
    if (feat && r > 0) {
      meanAdd(blk.energy, feat.energy, r, now);
      meanAdd(blk.valence, feat.valence, r, now);
      meanAdd(blk.arousal, feat.arousal, r, now);
      if (feat.tempoConf > 0.5 && feat.bpm) meanAdd(blk.tempo, feat.bpm, r * feat.tempoConf, now);
    }

    // transitions: how much a big change of sound costs this listener
    if (feat && prevFeat) {
      var d = soundGap(prevFeat, feat), bucket = d < 0.25 ? 'small' : d < 0.5 ? 'mid' : 'big';
      meanAdd(prof.trans[bucket], rw.skip ? 1 : 0, 1, now);
      // mood regulation: after a sad, low-valence song, do they stay or climb?
      if (prevFeat.valence < 0.38) {
        var mood = prof.mood, cell = rw.skip ? (mood.lowSkip || (mood.lowSkip = {})) : mood.lowNext;
        meanAdd(cell, feat.valence - prevFeat.valence, 1, now);
      }
    }
    return prof;
  }

  // 0..1: how different two songs sound (energy, mood, tempo, timbre)
  function soundGap(a, b) {
    if (!a || !b) return 0.5;
    var dt = 0;
    if (a.timbre && b.timbre) {
      for (var i = 0; i < a.timbre.length; i++) dt += (a.timbre[i] - b.timbre[i]) * (a.timbre[i] - b.timbre[i]);
      dt = Math.sqrt(dt / a.timbre.length) / 2;
    }
    var tg = tempoGap(a, b);
    return clamp(0.3 * Math.abs(a.energy - b.energy) / 0.4 + 0.25 * Math.abs(a.valence - b.valence) / 0.4 + 0.25 * tg + 0.2 * clamp(dt, 0, 1), 0, 1);
  }

  function tempoGap(a, b) {
    if (!a.bpm || !b.bpm) return 0;
    var d = Math.abs(Math.log(a.bpm / b.bpm) / Math.LN2) % 1;
    return Math.min(d, 1 - d) * 2 * Math.min(a.tempoConf == null ? 1 : a.tempoConf, b.tempoConf == null ? 1 : b.tempoConf);
  }

  /* ───────────── reading the profile ───────────── */

  function cellMean(c, fallback) { return c && c.w > 0.5 ? c.m : fallback; }

  function artistAff(prof, names) {
    var best = 0, has = false;
    (names || []).forEach(function (a, i) {
      var c = prof.artists[lc(a)];
      if (c && c.n) { has = true; var v = affinity(c) * (i ? 0.6 : 1); if (Math.abs(v) > Math.abs(best)) best = v; }
    });
    return { aff: best, known: has };
  }

  function langAff(prof, lang) { return affinity(prof.langs[lc(lang)], 3); }
  function albumAff(prof, album) { return affinity(prof.albums[lc(album)], 3); }
  function song(prof, tid) { return prof.songs[tid] || null; }

  // what this listener reaches for in a time block; falls back to their overall taste
  function blockPref(prof, b) {
    var blk = prof.blocks[b], all = { energy: 0, valence: 0, arousal: 0, w: 0 };
    prof.blocks.forEach(function (x) {
      if (x.energy.w) { all.energy += x.energy.m * x.energy.w; all.valence += x.valence.m * x.valence.w; all.arousal += x.arousal.m * x.arousal.w; all.w += x.energy.w; }
    });
    var g = all.w ? { energy: all.energy / all.w, valence: all.valence / all.w, arousal: all.arousal / all.w } : null;
    var w = blk.energy.w || 0, conf = clamp(w / 6, 0, 1);
    if (!g && !w) return null;
    function mix(key) { var own = blk[key].w ? blk[key].m : (g ? g[key] : 0.5); return g ? own * conf + g[key] * (1 - conf) : own; }
    return {
      energy: mix('energy'), valence: mix('valence'), arousal: mix('arousal'),
      tempo: cellMean(blk.tempo, 0), conf: g ? Math.max(conf, clamp(all.w / 6, 0, 1) * 0.5) : conf
    };
  }

  // +1 = climbs out after a sad song (≈ +0.15 valence), 0 = stays with it (or unknown), < 0 = goes deeper
  /* Contrast, not a plain average: the mood change of songs they kept minus
     that of songs they skipped. A plain average of kept songs mostly reflects
     what was offered (selection bias); the contrast cancels it. */
  function liftTendency(prof) {
    var acc = prof.mood.lowNext, sk = prof.mood.lowSkip || {};
    if (!acc.w || acc.w < 3) return 0;
    var diff = sk.w >= 2 ? acc.m - sk.m : acc.m * 0.5;
    return clamp(diff / 0.15, -1, 1) * clamp(acc.w / 8, 0, 1);
  }

  // how much a big change of sound raises this listener's skip rate (0..1)
  function transitionSensitivity(prof) {
    var s = prof.trans.small, b = prof.trans.big;
    if (!s.w || !b.w || s.w < 3 || b.w < 3) return 0.3;
    return clamp((b.m - s.m) * 2, 0, 1);
  }

  // > 0: new artists go down well; < 0: they prefer what they know
  function noveltyAppetite(prof) {
    var f = prof.novelty.fresh, k = prof.novelty.known;
    if (!f.n || !k.n || f.n < 3 || k.n < 3) return 0;
    return clamp((f.r / f.n - k.r / k.n) / 1.5, -1, 1);
  }

  function introImpatience(prof) { return cellMean(prof.rates.seekFwdEarly, 0) * 2 + cellMean(prof.rates.quick, 0.3) * 0.5; }
  function yearFit(prof, year) {
    var y = parseInt(year, 10), c = prof.year;
    if (!(y > 1900) || !c.w || c.w < 2) return 0;
    return clamp(1 - Math.abs(y - c.m) / 12, -1, 1);
  }
  function durationFit(prof, dur) {
    if (!dur || !prof.dur.w || prof.dur.w < 3) return 0;
    return clamp(1 - Math.abs(dur - prof.dur.m) / 120, -1, 1);
  }

  /* ───────────── in plain words ───────────── */

  function hourLabel(h) {
    h = ((Math.round(h) % 24) + 24) % 24;
    return h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? h + ' AM' : (h - 12) + ' PM';
  }

  function topOf(map, n, minN) {
    return Object.keys(map).filter(function (k) { return (map[k].n || 0) >= (minN || 1); })
      .sort(function (a, b) { return affinity(map[b]) - affinity(map[a]); }).slice(0, n);
  }

  function titleCase(s) { return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // Sentences for the "What Encore has learned" panel, most telling first.
  function insights(prof, now) {
    var out = [];
    if (prof.n < 3) return [{ k: 'start', text: 'Play a few songs and Encore starts learning what you like next.' }];

    // listening clock (circular mean of hours, weighted by seconds heard)
    var sx = 0, sy = 0, tot = 0, peak = 0, peakV = -1;
    prof.clock.forEach(function (c, h) {
      var v = (c.s || 0) * Math.pow(0.5, (now - (c.t || now)) / HALF_LIFE);
      sx += v * Math.cos(2 * Math.PI * h / 24); sy += v * Math.sin(2 * Math.PI * h / 24); tot += v;
      if (v > peakV) { peakV = v; peak = h; }
    });
    if (tot > 0) {
      var mean = (Math.atan2(sy, sx) / (2 * Math.PI) * 24 + 24) % 24;
      var type = mean >= 21 || mean < 3 ? ' — a night owl' : mean >= 5 && mean < 11 ? ' — an early bird' : '';
      out.push({ k: 'clock', text: 'You listen most around ' + hourLabel(peak) + type + '.' });
    }

    // skipping style
    var skip = cellMean(prof.rates.skip, null), quick = cellMean(prof.rates.quick, null);
    if (skip != null && prof.rates.skip.w >= 5) {
      var sk = Math.round(skip * 100);
      var style = quick != null && quick > 0.6 ? 'and you decide fast: most skips come in the first 10 s' : quick != null && quick < 0.3 ? 'but you give songs a chance before skipping' : '';
      out.push({ k: 'skip', text: 'You skip ' + sk + '% of songs' + (style ? ', ' + style : '') + '.' });
    }

    // time-of-day taste
    var night = prof.blocks[0].energy.w > 1 ? prof.blocks[0] : prof.blocks[4].energy.w > 1 ? prof.blocks[4] : null;
    var day = prof.blocks[2].energy.w > 1 ? prof.blocks[2] : prof.blocks[1].energy.w > 1 ? prof.blocks[1] : null;
    if (night && day) {
      var ne = night.energy.m, de = day.energy.m;
      if (Math.abs(ne - de) > 0.06) {
        out.push({ k: 'block', text: (ne < de ? 'Late at night you go for calmer songs' : 'Late at night you want more energy, not less') +
          ' (energy ' + ne.toFixed(2) + ' vs ' + de.toFixed(2) + ' in the day).' });
      }
      var nv = night.valence.m, dv = day.valence.m;
      if (nv < dv - 0.06) out.push({ k: 'sadnight', text: 'Your night picks are sadder than your daytime ones (mood ' + nv.toFixed(2) + ' vs ' + dv.toFixed(2) + ').' });
    }

    // mood regulation
    var lt = liftTendency(prof);
    if (prof.mood.lowNext.w >= 3) {
      out.push({ k: 'mood', text: lt > 0.3 ? 'After a sad song you like to be lifted up gently.' : lt < 0.15 ? 'After a sad song you like to stay in the mood.' : 'After a sad song you go either way, so Encore keeps it close.' });
    }

    // transitions
    if (prof.trans.small.w >= 3 && prof.trans.big.w >= 3) {
      var ratio = (prof.trans.big.m + 0.05) / (prof.trans.small.m + 0.05);   // smoothed: 0 skips is common
      if (ratio > 1.3) out.push({ k: 'trans', text: 'Big jumps in sound make you skip ' + ratio.toFixed(1) + '× more, so Encore keeps changes smooth.' });
      else if (ratio < 0.9) out.push({ k: 'trans', text: 'You don\'t mind big changes between songs.' });
    }

    // loops and likes
    var loop = cellMean(prof.rates.loop, 0);
    if (loop > 0.05) out.push({ k: 'loop', text: 'You replay ' + Math.round(loop * 100) + '% of songs — replays count most when Encore learns.' });

    // artists, languages, eras
    var arts = topOf(prof.artists, 3, 1.5).filter(function (a) { return affinity(prof.artists[a]) > 0.2; });
    if (arts.length) out.push({ k: 'artists', text: 'Top artists right now: ' + arts.map(titleCase).join(', ') + '.' });
    var langs = Object.keys(prof.langs), lt2 = 0;
    langs.forEach(function (l) { lt2 += prof.langs[l].n || 0; });
    if (langs.length && lt2 > 3) {
      var parts = langs.sort(function (a, b) { return (prof.langs[b].n || 0) - (prof.langs[a].n || 0); }).slice(0, 3)
        .map(function (l) { return titleCase(l) + ' ' + Math.round(100 * (prof.langs[l].n || 0) / lt2) + '%'; });
      out.push({ k: 'langs', text: 'Languages: ' + parts.join(', ') + '.' });
    }
    if (prof.year.w > 3) out.push({ k: 'era', text: 'Your sweet spot is music from around ' + Math.round(prof.year.m) + '.' });
    var nov = noveltyAppetite(prof);
    if (Math.abs(nov) > 0.2) out.push({ k: 'novelty', text: nov > 0 ? 'New artists go down well with you, so Encore explores more.' : 'You prefer artists you know, so Encore explores carefully.' });

    var sess = prof.sessions;
    if (sess.songs.w > 2) out.push({ k: 'session', text: 'A typical session is ' + Math.round(sess.songs.m) + ' songs (' + Math.round(sess.minutes.m) + ' min).' });
    return out;
  }

  return {
    VERSION: VERSION, BLOCKS: BLOCKS, BLOCK_HOURS: BLOCK_HOURS, DAY: DAY,
    context: context, blockOf: blockOf, titleKey: titleKey,
    reward: reward, harshness: harshness,
    create: create, update: update, soundGap: soundGap, tempoGap: tempoGap,
    affinity: affinity, artistAff: artistAff, langAff: langAff, albumAff: albumAff, song: song,
    blockPref: blockPref, liftTendency: liftTendency, transitionSensitivity: transitionSensitivity,
    noveltyAppetite: noveltyAppetite, introImpatience: introImpatience, yearFit: yearFit, durationFit: durationFit,
    insights: insights, songArtists: songArtists, lc: lc
  };
});
