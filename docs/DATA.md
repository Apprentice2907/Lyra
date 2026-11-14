# Data for Encore research without real users

You don't need users to start the research. There are two sources, and both come out in the **same format as the app's own *Export data***, so every tool works on all three:

1. **Real public listening logs:** Yambda, from Yandex Music (Apache 2.0). These are real people's skips, replays, likes, and own choices vs recommendations.
2. **Synthetic listeners**, calibrated to those real logs and driven by Encore's real model. Unlike real data, they log the **true** chance that each song would be played through.

When your own users arrive, their exports drop into the same pipeline.

```
research/yambda_fetch.py      real histories from Yambda (reads only the parts it needs over HTTP)
research/yambda_to_encore.py  → Encore play records (data/public/yambda/plays.jsonl)
tools/logstats.js             the same behaviour statistics for any log
tools/synth-logs.js           synthetic listeners: calibrate to real stats, then generate
research/two_sample_test.py   can a classifier tell real sessions from synthetic ones?
```

Everything is written under `data/`, which git ignores.

## Quick start

```bash
python -m pip install -r research/requirements.txt
```

```bash
python research/yambda_fetch.py
```

```bash
python research/yambda_to_encore.py
```

```bash
node tools/logstats.js data/public/yambda/plays.jsonl --json data/public/yambda/stats.json
```

The defaults in `tools/synth-logs.js` are already calibrated to this Yambda sample, so you can generate right away:

```bash
node tools/synth-logs.js
```

That writes 500 listeners × 21 days (about 340,000 plays) with Encore's real model, to `data/synthetic/plays.jsonl`. Add `--exports data/synthetic/exports` for one *Export data* file per listener (about 300 MB for 500 listeners), or `--policy proxy` for the reference recommender. Generation takes about 3 minutes with Encore, 10 seconds with the proxy.

To re-calibrate on other data (about 25 minutes for 4 rounds of 200 listeners):

```bash
node tools/synth-logs.js --calibrate data/public/yambda/stats.json --rounds 4
```

```bash
node tools/synth-logs.js --params data/synthetic/params.json
```

```bash
python research/two_sample_test.py data/public/yambda/plays.jsonl data/synthetic/plays.jsonl
```

## 1. Yambda: real listening logs

[Yambda](https://huggingface.co/datasets/yandex/yambda) is Yandex Music's public dataset: 4.79 billion events from 1 million listeners, under Apache 2.0, published for research ([paper](https://arxiv.org/abs/2505.22238)). Encore uses the 50M subset: `flat/50m/multi_event.parquet`, 47.8 M events, 385 MB.

- **Sorted by listener, so no full download is needed.** Each of the file's 183 chunks holds about 66 listeners' complete histories. `yambda_fetch.py` reads 8 chunks by default: 466 listeners, 2.09 M events, about 15 MB on disk.
- **What it has that Encore needs:**
  - `played_ratio_pct`: how much of the song was heard; above 100 means the listener rewound.
  - `is_organic`: the listener's own choice vs a recommendation. This is exactly Encore's "pick vs Encore".
  - Likes, dislikes and un-likes, with timestamps.
  - Track length.
  - An artist for every track (`artist_item_mapping.parquet`, 38 MB).
- **What it doesn't have:**
  - Pauses, volume, seeking forward, or background listening.
  - Song titles, artist names, or audio features. Only ids, plus 13.8 GB of audio embeddings, which aren't used here.

**Two things the dataset card gets wrong or leaves out, found while converting:**

- **Timestamps are seconds, not 5-second units** (they are rounded to 5 s). Read as 5-second units, the 50M sample spans 4 years and the daily rhythm disappears. Read as seconds, it spans 301 days with a clear day–night cycle.
- **Time of day is estimated.** The clock's origin isn't published. Listening everywhere bottoms out at night (Park et al. 2019), so the converter shifts the clock to put the quietest three hours at 3–5 AM. That comes to +3 h, the same as reading the origin as UTC midnight with listeners on Moscow time. The weekday is consistent, but which day is "0" is unknown.

How each Encore field is made is documented at the top of `research/yambda_to_encore.py`.

### What real listeners do

From 229,743 plays by 200 listeners over their last 60 days, via `tools/logstats.js`:

| | |
|---|---|
| Played through (≥ 90%) | **59.3%** |
| Skipped | 38.4%. 58% of skips come in the first 10 s, 72% in the first 30 s |
| How much was heard | Bimodal: 22.6% of plays under 5% of the song, 59.3% at 90%+, little in between |
| Songs per session | mean 19, median 10, 90th percentile 44 |
| Own choice vs recommended | 50 / 50. Played through 55% vs 63%: the recommendations did *better* |
| Sessions are one or the other | 41% all own choices, 34% all recommended, 2.4% switches per song |
| Streaks | After a skip, 25% played through. After a full listen, 84% |
| First song of a session | 48% played through, against about 62% later in the session |
| Repeats | 56% of plays are songs heard before; played through 61% vs 57% for new songs |
| Same artist as the song before | 12% |
| Replays (same song again in the session) | 10% of plays |
| Likes | 0.2% of plays. Dislikes 0.1% |
| Listeners differ | played through: 19% (bottom tenth), 64% (median), 88% (top tenth) |
| Time of day | 54% played through at night, 63% in the morning, 58% in the evening |

These are the targets the synthetic listeners are calibrated to.

## 2. Synthetic listeners

`tools/synth-logs.js` simulates listeners with hidden traits playing a synthetic catalogue, day after day, in sessions. Every play becomes an Encore play record.

- **Calibrated to the real statistics above** (coordinate search, `--calibrate`):
  - how easily each listener is pleased, and how different listeners are;
  - a *browsing vs engaged* state, which reproduces the streaks;
  - session length and when sessions stop;
  - how fast skips happen;
  - sessions driven by the listener vs a recommendation stream;
  - repeat favourites, album runs and replays;
  - likes and dislikes;
  - time-of-day effects;
  - session start times, taken from the real daily curve.
- **Assumed from the literature** (public logs have no audio features): calmer music late at night, mood "matchers" vs "lifters", and sensitivity to big jumps in sound. These are what Encore's audio features act on, so their effect in synthetic results is an assumption, not a finding.
- **Recommendations:**
  - `--policy encore` (default) runs Encore's real model, one per listener, learning online exactly like the app. Propensities and feature vectors are logged.
  - `--policy proxy` uses a softmax over each listener's true taste. It's fast, and used for calibration.
- **Ground truth:** every record has `truth.p`, the listener's true chance of playing it through. Real logs never have this. It's what lets you check whether an off-policy estimate (IPS, doubly robust) recovers the right answer before you trust it on real data.
- **`--exports <dir>`** also writes one file per listener in the exact *Export data* shape: plays, profile, and learned weights.

### How close is it?

These are 500 synthetic listeners the calibration never saw (seed 3), with a 30-day warm-up and then 21 logged days, against the 229,743 real Yambda plays (`data/synthetic/compare.txt` has every row):

| | Real (Yambda) | Synthetic, proxy recommender | Synthetic, Encore |
|---|---|---|---|
| Played through | 59.3% | 62.7% | 55.8% |
| Skips in the first 10 s / 30 s | 57.9% / 71.9% | 62.0% / 69.6% | 64.9% / 72.0% |
| Through after a skip / after a full listen | 25.1% / 83.7% | 23.2% / 87.4% | 20.2% / 85.3% |
| Songs per session: mean / median / p90 | 19 / 10 / 44 | 19 / 12 / 45 | 20 / 12 / 46 |
| Own choices | 50.2% | 52.6% | 52.3% |
| Through: own choice / recommended | 55.2% / 63.4% | 56.5% / 69.5% | 52.3% / 59.7% |
| Repeat listens | 56.5% | 58.5% | 54.3% |
| Same artist as the song before | 11.9% | 10.6% | **25.9%** |
| Listeners played through (10th / 50th / 90th percentile) | 19 / 64 / 88% | 21 / 65 / 92% | 15 / 54 / 88% |
| Sessions all own picks / all recommended | 40.9% / 33.8% | 45.6% / 32.8% | 45.4% / 34.6% |

**Spread.** Four fresh populations of 500 (same catalogue, different listeners) land at 59.6–62.8% played through, against 59.3% real. That's the honest error bar on these numbers.

**The classifier test still tells sessions apart** (`research/two_sample_test.py`): ROC AUC **0.92** for the proxy world and **0.96** for the Encore world (0.5 would be indistinguishable). Each point of the AUC comes from what the test lists as giveaways, in order:
- Own-choice mixing inside sessions.
- Repeat share per session.
- How much of each song is heard.
- Replay patterns.
- Fast-skip concentration.

So the synthetic data matches the averages and most distributions, but **real sessions are still more varied in their mix than simulated ones**. That's the next modelling step, not a solved problem.

**Lessons from calibrating** (all in `tools/synth-logs.js`):

1. **Modelling choices the data forced.**
   - Real sessions are either the listener's own picks or a recommendation stream, rarely a mix, so sessions got a mode.
   - Real skipping is streaky (25% played through after a skip, 84% after a full listen), so listeners got a browsing state.
   - Clustering of fast skips and same-artist runs needed per-session effects and album sessions.
   - Real listeners arrive with years of history, so the generator lives through a warm-up before logging.
2. **Calibration overfits the simulated listeners it tunes on.**
   - Fitted on 50 listeners, the parameters matched them; a fresh 500 then played ~9 points less through.
   - Fitted on 200, the gap was ~4 points. Overall satisfaction was then re-centred on a fresh population (seed 2), and the datasets above use a third, untouched one (seed 3).
   - The catalogue is now the same for every seed, so "fresh listeners" isn't confused with "a different catalogue".

### A first research finding (in the synthetic world)

Encore v1's recommendations are played through **59.7%** of the time. The reference recommender, which knows each listener's true taste, scores **69.5%**. Encore also follows a song with the **same artist 26%** of the time, more than twice what real listeners do (12%). Same-artist runs are also the classifier's top clue that Encore's sessions aren't real.

Two concrete targets for the next research step:
- **Diversify artists.** The `sameArtist` prior is +0.15, and the `artist` and `taste` sources feed many same-artist candidates.
- **Close the gap to the reference recommender.** Measure progress with off-policy estimates checked against `truth.p`.

## 3. Spotify's Music Streaming Sessions Dataset (get it yourself)

[MSSD](https://arxiv.org/abs/1901.09851) has about 160 M Spotify listening sessions. It's the closest public match to Encore's signals:
- skip timing (`skip_1/2/3`, `not_skipped`);
- pauses before play, seeks, session position, hour of day, shuffle and context type;
- per-track audio features: energy, valence, tempo, key, mode, danceability, acousticness.

Some sessions were played in uniformly random shuffle, which is valuable for unbiased evaluation. It needs an account and accepting the terms on [AIcrowd](https://www.aicrowd.com/challenges/spotify-sequential-skip-prediction-challenge), so download it yourself (start with the "mini" version). A converter to Encore records is the natural next step: map `skip_1/2/3` to seconds heard, and the audio features to Encore's energy and mood.

## Honest limits

- Yambda's time of day is an estimate (±1 h), and its fields are coarser than Encore's.
- Synthetic data can only be as right as its assumptions. Calibration matches the *behaviour statistics listed*; the two-sample test shows what still differs. Results on synthetic data are for building and checking methods. They are not evidence about real people.
- Yambda listeners are Yandex Music users (mostly Russian-speaking). LYRA's listeners will differ in language and catalogue. Treat the numbers as "how people use a streaming app", not "how LYRA's users behave".
