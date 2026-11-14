/* Encore model: scores "how much will this listener want song c next, right
   now?" and learns from every play.

   - featurize(state, cand) → x: 43 interpretable features about the
     candidate, the song before it, the moment, the session and the listener.
   - Bayesian linear regression on the reward with Thompson sampling
     (Agrawal & Goyal 2013; Chapelle & Li 2011): one draw of the weights per
     decision, so uncertain features get tried and certain ones exploited.
   - Forgetting (discount γ per update, pulled back toward the prior) keeps
     up with a listener whose taste moves (non-stationary bandits).
   - The prior mean μ0 encodes what the research says before any data:
     familiar and liked songs win, abrupt jumps in tempo/energy/key lose,
     calm music fits late night. A new listener gets sensible picks on day
     one; the data then overrules the prior wherever they differ.
   - Every pick logs its propensity (how likely this policy was to choose
     it), so the logs support off-policy evaluation later (IPS / DR).

   Pure (no DOM): used by the app, the tests and the simulator. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.EncoreProfile || require('./profile.js'));
  else root.EncoreModel = factory(root.EncoreProfile);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  var VERSION = 1;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function round(v, d) { var k = Math.pow(10, d == null ? 4 : d); return Math.round(v * k) / k; }

  /* Feature table: name, prior weight, and how to say it to a listener when
     it is the reason for a pick ({a} = artist, {l} = language). */
  var FEATURES = [
    ['bias',             0,     null],
    ['liked',            0.6,   'You liked it'],
    ['inPlaylist',       0.3,   'It\'s in your playlists'],
    ['songAff',          0.6,   'You usually play it through'],
    ['heardBefore',      0.05,  null],
    ['recent24h',       -0.4,   null],
    ['quickSkipped',    -1.0,   null],
    ['artistAff',        0.5,   'You keep coming back to {a}'],
    ['sameArtist',       0.15,  'More from {a}'],
    ['artistRun',       -0.7,   null],
    ['sameAlbum',        0.15,  'From the same album'],
    ['langAff',          0.5,   'Your kind of {l} music'],
    ['langMatch',        0.4,   'Stays in {l}'],
    ['eraFit',           0.2,   'From your favourite era'],
    ['popularity',       0.15,  'A big favourite with listeners'],
    ['newArtist',       -0.05,  'Someone new for you'],
    ['hasAudio',         0,     null],
    ['tempoGap',        -0.35,  null],
    ['energyGap',       -0.35,  null],
    ['keyGap',          -0.15,  null],
    ['valenceGap',      -0.3,   null],
    ['timbreGap',       -0.2,   null],
    ['energyStep',       0,     null],
    ['valenceStep',      0,     null],
    ['smoothFlow',       0.3,   'Flows smoothly from this song'],
    ['blockEnergyFit',   0.3,   'Right energy for the {b}'],
    ['blockMoodFit',     0.25,  'Fits your {b} mood'],
    ['blockTempoFit',    0.15,  null],
    ['nightCalm',        0.25,  'Calm, for late at night'],
    ['morningLift',      0.1,   'Bright, for the morning'],
    ['sessionMoodFit',   0.25,  'Keeps the mood of this session'],
    ['liftMove',         0.3,   'Lifts the mood a little'],
    ['introCost',       -0.15,  null],
    ['durationFit',      0.1,   null],
    ['explicit',         0,     null],
    ['skipStreakNew',   -0.3,   null],
    ['skipStreakKnown',  0.3,   'A safe favourite after a few skips'],
    ['userChosen',       0,     null],
    ['srcArtist',        0,     null],
    ['srcAlbum',         0,     null],
    ['srcTaste',         0,     null],
    ['srcFamiliar',      0,     null],
    ['srcContext',       0,     null]
  ];
  var D = FEATURES.length;
  var IDX = {};
  FEATURES.forEach(function (f, i) { IDX[f[0]] = i; });
  // typical values between two random catalogue songs (see featurize)
  var TYP = { tempo: 0.49, energy: 0.49, key: 0.58, valence: 0.49, timbre: 0.62, sound: 0.49, dE: 0.2, dV: 0.2, intro: 15 };
  var SOURCES = { artist: 'srcArtist', album: 'srcAlbum', taste: 'srcTaste', familiar: 'srcFamiliar', context: 'srcContext' };

  /* ───────────── features ─────────────
     state: { ctx, prof, cur, curFeat, session, liked(id), inPlaylist(id), mode }
       cur      the song playing now (track) or null (e.g. Explore)
       session  { ids[], artists[] (lower-case, newest last), valence, energy,
                  skips[] (1/0, newest last) }
       mode     'auto' | 'match' | 'lift'
     cand: { t (track), feat (describe() or null), src } */
  function featurize(state, cand) {
    var x = new Float64Array(D), t = cand.t, f = cand.feat, prof = state.prof, ses = state.session || {};
    var cur = state.cur, cf = state.curFeat, ctx = state.ctx;
    x[0] = 1;

    var sm = P.song(prof, t.id);
    x[IDX.liked] = state.liked && state.liked(t.id) ? 1 : 0;
    x[IDX.inPlaylist] = state.inPlaylist && state.inPlaylist(t.id) ? 1 : 0;
    x[IDX.songAff] = sm ? P.affinity(sm) / 2 : 0;
    x[IDX.heardBefore] = sm && sm.n > 0.3 ? 1 : 0;
    x[IDX.recent24h] = sm && sm.last && ctx.t - sm.last < P.DAY ? 1 : 0;
    x[IDX.quickSkipped] = sm && sm.quick ? clamp(sm.quick * Math.pow(0.5, (ctx.t - (sm.qt || ctx.t)) / (7 * P.DAY)), 0, 2) / 2 : 0;

    var arts = P.songArtists(t), aa = P.artistAff(prof, arts);
    var curArts = cur ? P.songArtists(cur) : [];
    x[IDX.artistAff] = aa.aff / 2;
    x[IDX.sameArtist] = arts.some(function (a) { return curArts.indexOf(a) >= 0; }) ? 1 : 0;
    var recentA = (ses.artists || []).slice(-2);
    x[IDX.artistRun] = recentA.length === 2 && arts.length && recentA.every(function (a) { return a === arts[0]; }) ? 1 : 0;
    x[IDX.sameAlbum] = cur && t.album && cur.album && P.lc(t.album) === P.lc(cur.album) ? 1 : 0;
    x[IDX.langAff] = t.language ? P.langAff(prof, t.language) / 2 : 0;
    x[IDX.langMatch] = cur && t.language && cur.language ? (P.lc(t.language) === P.lc(cur.language) ? 1 : -1) : 0;
    x[IDX.eraFit] = P.yearFit(prof, t.year);
    x[IDX.popularity] = t.playCount ? clamp((Math.log(t.playCount + 1) / Math.LN10 - 6) / 2, -1, 1) : 0;
    x[IDX.newArtist] = aa.known ? 0 : 1;

    /* Audio features are centred on their typical value between two random
       catalogue songs (measured on 46 songs: tempo 0.49, energy 0.49, key
       0.58, mood 0.49, timbre 0.62, sound 0.49, intro 15 s). A song not yet
       analysed then reads as 'typical' (0), not as 'perfectly smooth' — without
       this, unanalysed songs would beat analysed ones by default. */
    var hasAudio = !!(f && cf);
    x[IDX.hasAudio] = hasAudio ? 1 : 0;
    if (hasAudio) {
      x[IDX.tempoGap] = P.tempoGap(cf, f) - TYP.tempo;
      x[IDX.energyGap] = clamp(Math.abs(f.energy - cf.energy) / 0.4, 0, 1.5) - TYP.energy;
      x[IDX.keyGap] = f.camelot && cf.camelot ? keyDistance(cf.camelot, f.camelot) / 6 - TYP.key : 0;
      x[IDX.valenceGap] = clamp(Math.abs(f.valence - cf.valence) / 0.4, 0, 1.5) - TYP.valence;
      x[IDX.timbreGap] = timbreGap(cf, f) - TYP.timbre;
      x[IDX.energyStep] = clamp((f.energy - cf.energy) / 0.4, -1.5, 1.5);
      x[IDX.valenceStep] = clamp((f.valence - cf.valence) / 0.4, -1.5, 1.5);
      // a listener who is sensitive to jumps gets a stronger pull toward smooth flow
      x[IDX.smoothFlow] = (TYP.sound - P.soundGap(cf, f)) * 2 * (0.5 + P.transitionSensitivity(prof));
    }

    if (f) {
      var bp = P.blockPref(prof, ctx.block);
      if (bp) {
        x[IDX.blockEnergyFit] = (TYP.dE - Math.abs(f.energy - bp.energy)) / 0.25 * bp.conf;
        x[IDX.blockMoodFit] = (TYP.dV - Math.abs(f.valence - bp.valence)) / 0.25 * bp.conf;
        if (bp.tempo && f.bpm && f.tempoConf > 0.5) x[IDX.blockTempoFit] = (TYP.tempo - P.tempoGap({ bpm: bp.tempo }, f)) / 0.5 * bp.conf;
      }
      // the 3 AM effect (Park et al. 2019): calmer music late at night
      var nightness = ctx.hour >= 23 || ctx.hour < 4 ? 1 : ctx.hour >= 21 || ctx.hour < 6 ? 0.5 : 0;
      x[IDX.nightCalm] = nightness * (0.5 - f.arousal) * 2;
      x[IDX.morningLift] = ctx.block === 1 ? (f.arousal - 0.5) * 2 : 0;
      if (ses.valence != null) x[IDX.sessionMoodFit] = (TYP.dV - Math.abs(f.valence - ses.valence)) / 0.2;
      if (cf) {
        // 'match' gently resists climbing; 'lift' pulls up; 'auto' uses what this listener does
        var lift = state.mode === 'lift' ? 1 : state.mode === 'match' ? -0.4 : P.liftTendency(prof);
        var low = cf.valence < 0.4 ? 1 : 0.4;            // the choice matters most after a sad song
        x[IDX.liftMove] = clamp((f.valence - cf.valence) / 0.2, -1.5, 1.5) * lift * low;
      }
      x[IDX.introCost] = clamp(((f.intro || 0) - TYP.intro) / 30, -0.5, 2) * (0.5 + P.introImpatience(prof));
    }
    x[IDX.durationFit] = P.durationFit(prof, t.duration);
    x[IDX.explicit] = t.explicit ? 1 : 0;

    var sk = (ses.skips || []).slice(-4), skipRate = 0;
    sk.forEach(function (s) { skipRate += s; });
    skipRate = sk.length ? skipRate / sk.length : 0;
    x[IDX.skipStreakNew] = skipRate * x[IDX.newArtist];
    x[IDX.skipStreakKnown] = skipRate * (x[IDX.songAff] > 0.1 || x[IDX.liked] ? 1 : 0);
    x[IDX.userChosen] = cand.chosen || 0;
    var s = SOURCES[cand.src];
    if (s) x[IDX[s]] = 1;
    return x;
  }

  function keyDistance(ca, cb) {
    var na = parseInt(ca, 10), nb = parseInt(cb, 10), d = Math.abs(na - nb) % 12;
    d = Math.min(d, 12 - d);
    return d + (ca.slice(-1) === cb.slice(-1) ? 0 : 1);
  }

  function timbreGap(a, b) {
    if (!a.timbre || !b.timbre) return 0;
    var s = 0;
    for (var i = 0; i < a.timbre.length; i++) s += (a.timbre[i] - b.timbre[i]) * (a.timbre[i] - b.timbre[i]);
    return clamp(Math.sqrt(s / a.timbre.length) / 1.5, 0, 1.5);
  }

  /* ───────────── Bayesian linear regression ─────────────
     Posterior over weights w with precision A and A·μ = b:
        A ← γA + (1−γ)λ0·I + w·x·xᵀ        b ← γb + (1−γ)λ0·μ0 + w·r·x
     γ < 1 forgets old evidence and pulls toward the prior, so A ≥ λ0·I
     always (well-conditioned forever). */

  function prior() { return FEATURES.map(function (f) { return f[1]; }); }

  function create(opts) {
    opts = opts || {};
    // λ = 8, explore = 0.25: tuned on the simulator (tools/simulate.js) for a good
    // first week (mostly sensible picks, light exploration) without hurting week 4
    var lam = opts.lambda || 8, mu0 = prior(), A = new Array(D * D).fill(0), b = new Array(D).fill(0);
    for (var i = 0; i < D; i++) { A[i * D + i] = lam; b[i] = lam * mu0[i]; }
    return {
      v: VERSION, d: D, names: FEATURES.map(function (f) { return f[0]; }),
      lambda: lam, gamma: opts.gamma || 0.997, explore: opts.explore == null ? 0.25 : opts.explore, noise: opts.noise || 1,
      A: A, b: b, n: 0
    };
  }

  // a stored model whose feature list no longer matches starts again from the prior
  function valid(m) {
    return !!(m && m.v === VERSION && m.d === D && m.A && m.A.length === D * D && m.names && m.names.join() === FEATURES.map(function (f) { return f[0]; }).join());
  }

  function update(m, x, r, w) {
    w = (w == null ? 1 : w) / (m.noise * m.noise);
    var g = m.gamma, lam = m.lambda, mu0 = prior(), A = m.A, b = m.b, i, j;
    for (i = 0; i < D; i++) {
      var xi = x[i], row = i * D;
      for (j = 0; j < D; j++) A[row + j] = g * A[row + j] + w * xi * x[j];
      A[row + i] += (1 - g) * lam;
      b[i] = g * b[i] + (1 - g) * lam * mu0[i] + w * r * xi;
    }
    m.n++;
    m._chol = null;
  }

  // Cholesky A = L·Lᵀ (lower triangular, row-major)
  function cholesky(m) {
    if (m._chol) return m._chol;
    var A = m.A, L = new Float64Array(D * D), i, j, k;
    for (i = 0; i < D; i++) {
      for (j = 0; j <= i; j++) {
        var s = A[i * D + j];
        for (k = 0; k < j; k++) s -= L[i * D + k] * L[j * D + k];
        if (i === j) L[i * D + i] = Math.sqrt(Math.max(s, 1e-9));
        else L[i * D + j] = s / L[j * D + j];
      }
    }
    return (m._chol = L);
  }

  function mean(m) {
    var L = cholesky(m), y = new Float64Array(D), mu = new Float64Array(D), i, k, s;
    for (i = 0; i < D; i++) { s = m.b[i]; for (k = 0; k < i; k++) s -= L[i * D + k] * y[k]; y[i] = s / L[i * D + i]; }
    for (i = D - 1; i >= 0; i--) { s = y[i]; for (k = i + 1; k < D; k++) s -= L[k * D + i] * mu[k]; mu[i] = s / L[i * D + i]; }
    return mu;
  }

  function gauss(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // one draw from N(μ, v²·A⁻¹): solve Lᵀ·e = z, w = μ + v·e
  function sample(m, rng, mu) {
    var L = cholesky(m), z = new Float64Array(D), e = new Float64Array(D), w = new Float64Array(D), i, k;
    mu = mu || mean(m);
    for (i = 0; i < D; i++) z[i] = gauss(rng);
    for (i = D - 1; i >= 0; i--) { var s = z[i]; for (k = i + 1; k < D; k++) s -= L[k * D + i] * e[k]; e[i] = s / L[i * D + i]; }
    for (i = 0; i < D; i++) w[i] = mu[i] + m.explore * e[i];
    return w;
  }

  function dot(w, x) { var s = 0; for (var i = 0; i < D; i++) s += w[i] * x[i]; return s; }

  /* ───────────── artist pacing ─────────────
     The model scores one song at a time, and the next song by the same
     artist is often a safe bet (a similar sound, an artist they love). Left
     alone, Encore followed a song with the same artist a third of the time
     in simulation. Real listeners do it 17% of the time when they choose for
     themselves, and Yandex Music's recommender under 1% (Yambda logs,
     docs/DATA.md). In those logs a same-artist follow-up is played through
     about as often as any other, so repeating doesn't cost the next song;
     what it costs is variety over weeks, which a per-song score can't see.

     So how often to stay with an artist is a budget for the long run, not
     part of the score:
     - the target is how often this listener stays with an artist when they
       choose for themselves (17% until they have, kept between 5% and 35%);
     - a penalty λ on same-artist candidates rises while Encore's own picks
       run above the target and relaxes below it (a Lagrange multiplier
       updated online, as in constrained bandits; Agrawal & Devanur 2016).
     Nothing is banned: a same-artist song that is clearly better still wins. */
  var PACE = { target: 0.17, k: 20, min: 0.05, max: 0.35, eta: 0.05, lamMax: 2, keep: 0.995 };

  function pacing(m) { return m.pace || (m.pace = { lam: 0, ownN: 0, ownS: 0, recN: 0, recS: 0 }); }

  // how often this listener stays with an artist when choosing for themselves
  function paceTarget(m) {
    var p = pacing(m);
    return clamp((p.ownS + PACE.target * PACE.k) / (p.ownN + PACE.k), PACE.min, PACE.max);
  }

  // after a play that follows a different song in the same session
  function pace(m, same, own) {
    var p = pacing(m), s = same ? 1 : 0;
    if (own) { p.ownN = p.ownN * PACE.keep + 1; p.ownS = p.ownS * PACE.keep + s; return; }
    p.recN = p.recN * PACE.keep + 1; p.recS = p.recS * PACE.keep + s;
    p.lam = clamp(p.lam + PACE.eta * (s - paceTarget(m)), 0, PACE.lamMax);
  }

  /* ───────────── ranking ─────────────
     rank(model, state, cands, opts) → { list, w, mu, lam }
       list: [{ cand, x, score (sampled), mean (expected reward), pen, prop }]
       pen is the artist-pacing penalty on this song (λ if it's by the
       artist playing now, else 0); it counts in score, safety and prop.
     opts.rng      random source (Math.random by default)
     opts.w        reuse a weight draw (re-ranking the same decision when
                   audio features arrive must not re-roll the dice)
     opts.draws    extra draws to estimate propensities (default 32)
     opts.margin   safe exploration: only songs whose expected reward is
                   within this margin of the best may be picked, so a
                   random draw can never choose a clearly worse song
                   (in the spirit of conservative bandits, Wu et al. 2016)
     opts.pace     false: no artist pacing (for comparisons) */
  function rank(m, state, cands, opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random, mu = mean(m), w = opts.w || sample(m, rng, mu);
    var lam = opts.pace === false ? 0 : pacing(m).lam;
    var list = cands.map(function (c) {
      var x = c.x || featurize(state, c), pen = lam * x[IDX.sameArtist];
      return { cand: c, x: x, score: dot(w, x) - pen, mean: dot(mu, x), pen: pen, prop: 0, safe: true };
    });
    if (opts.margin != null && list.length) {
      var bestMean = Math.max.apply(null, list.map(function (it) { return it.mean - it.pen; }));
      list.forEach(function (it) { it.safe = it.mean - it.pen >= bestMean - opts.margin; });
    }
    list.sort(function (a, b) { return (b.safe - a.safe) || (b.score - a.score); });
    var draws = opts.draws == null ? 32 : opts.draws;
    if (draws && list.length) {
      var wins = new Array(list.length).fill(0);
      for (var d = 0; d < draws; d++) {
        var wd = sample(m, rng, mu), best = 0, bs = -Infinity;
        for (var i = 0; i < list.length; i++) { if (!list[i].safe) continue; var s = dot(wd, list[i].x) - list[i].pen; if (s > bs) { bs = s; best = i; } }
        wins[best]++;
      }
      // smoothed so no logged propensity is ever exactly 0
      list.forEach(function (it, i) { it.prop = round((wins[i] + 0.5) / (draws + 0.5 * list.length), 4); });
    }
    return { list: list, w: w, mu: mu, lam: lam };
  }

  /* Why a song was picked, in plain words: the features that pushed its
     expected reward up the most. If it won only on the random draw, say so —
     honest about exploration. */
  function explain(item, mu, ctx, exploring) {
    var x = item.x, contrib = [];
    for (var i = 1; i < D; i++) {
      var tpl = FEATURES[i][2], c = mu[i] * x[i];
      if (tpl && c > 0.04) contrib.push({ i: i, c: c, tpl: tpl });
    }
    contrib.sort(function (a, b) { return b.c - a.c; });
    var t = item.cand.t, artist = String(t.artist || '').split(/\s*,\s*/)[0];
    var lang = t.language ? t.language.charAt(0).toUpperCase() + t.language.slice(1) : '';
    var blockName = P.BLOCKS[ctx ? ctx.block : 2];
    var reasons = contrib.slice(0, 3).map(function (k) {
      return k.tpl.replace('{a}', artist).replace('{l}', lang).replace('{b}', blockName);
    });
    if (exploring) reasons.unshift('Trying something new for you');
    return reasons;
  }

  // the learned weights, strongest first (for the insights panel and research)
  function weights(m) {
    var mu = mean(m), mu0 = prior();
    return FEATURES.map(function (f, i) { return { name: f[0], w: round(mu[i], 3), prior: mu0[i], moved: round(mu[i] - mu0[i], 3) }; })
      .sort(function (a, b) { return Math.abs(b.moved) - Math.abs(a.moved); });
  }

  // compact for storage: 4 decimals is plenty
  function serialize(m) {
    var out = { v: m.v, d: m.d, names: m.names, lambda: m.lambda, gamma: m.gamma, explore: m.explore, noise: m.noise, n: m.n,
      A: m.A.map(function (v) { return round(v, 5); }), b: m.b.map(function (v) { return round(v, 5); }) };
    if (m.pace) out.pace = { lam: round(m.pace.lam), ownN: round(m.pace.ownN, 2), ownS: round(m.pace.ownS, 2), recN: round(m.pace.recN, 2), recS: round(m.pace.recS, 2) };
    return out;
  }

  return {
    pace: pace, paceTarget: paceTarget, pacing: pacing, PACE: PACE,
    VERSION: VERSION, D: D, FEATURES: FEATURES, IDX: IDX,
    featurize: featurize, create: create, valid: valid, update: update, mean: mean, sample: sample,
    rank: rank, explain: explain, weights: weights, serialize: serialize, prior: prior, dot: dot
  };
});
