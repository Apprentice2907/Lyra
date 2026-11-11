# LYRA

[![tests](https://github.com/Apprentice2907/Lyra/actions/workflows/test.yml/badge.svg)](https://github.com/Apprentice2907/Lyra/actions/workflows/test.yml)

A vinyl-style music player for the web, with **Encore**: a next-song recommender that runs entirely in your browser and learns from every song you play.

## What's inside

**The player**
- A turntable Now Playing view, with an arc seek bar and a volume knob.
- A rotary Explore wheel, plus Home, Search, Liked songs and playlists.
- Streams through the community [JioSaavn API](https://github.com/sumitkolhe/jiosaavn-api).
- An offline demo collection, synthesised live with the Web Audio API.

**Encore, the next-song recommender** ([full design and verification](docs/ENCORE.md))
- **Hears every song.** Its own signal processing runs on each song's 12 kbps stream in a Web Worker. It measures tempo, pulse, kick-drum rate, percussive share, key and mode, energy, loudness, brightness, intro length and the first chorus.
- **Watches how you listen.** Seconds actually heard, skip timing, pauses, seeks, restarts, replays, volume, likes during the song, background listening, time of day and sessions.
- **Calibrates to you.** It builds a listening clock and learns your skip style, your taste for each time of day, whether you stay sad or lift out after a sad song, how much big jumps in sound bother you, and your artists, languages and eras.
- **Picks and learns.** A Bayesian linear model with Thompson sampling weighs 43 interpretable features, starting from research priors. It forgets slowly, explores safely, and logs a propensity with every pick for off-policy evaluation later.
- **Explains itself.** "Up next" shows why each song was picked. The Encore panel shows what it has learned and exactly how the last song was scored.
- **Private by design.** Everything stays in the browser. *Export data* gives you the full log as JSON.

On synthetic listeners with hidden tastes (5 seeds × 3 personas, 4 weeks), Encore's listen-through rate reaches **78.7%** by week 4. That compares with 74.6% when its weights are frozen, 50.3% for random picks and 38.2% for the most popular song. Fast skips drop from 22–29% to 8.7%. The simulator shares the model's assumptions; [docs/ENCORE.md](docs/ENCORE.md) explains what that does and doesn't show.

## Run it

Any static file server works. With Python:

```bash
python -m http.server 5173 --bind 127.0.0.1
```

Then open http://127.0.0.1:5173.

## Test it

Needs Node 18 or newer:

```bash
node --test tests/
```

There are 42 tests:
- **Audio analysis:** tempo and key on signals with known answers.
- **Reward, profile and model.**
- **The listening logger,** against a fake player.
- **End to end,** on simulated listeners.

```bash
node tools/simulate.js 28 1
```

## Layout

```
index.html, css/, img/     the app shell
js/                        player, pages, playlists, API client, library
js/encore/                 the recommender
  dsp.js, dsp-worker.js    audio analysis
  features.js              fetch, decode, analyse, cache
  signals.js               the listening logger
  profile.js               reward and the calibrated listener profile
  model.js                 features and the Bayesian Thompson-sampling ranker
  encore.js, ui.js         candidates, decisions, Up next and the Encore panel
tests/                     node --test
tools/                     simulator, DSP calibration, librosa cross-check
docs/ENCORE.md             design, verification, limits, next steps
```

## Note

This is a personal, educational project. Songs and artwork are streamed from JioSaavn through a community API and belong to their owners.
