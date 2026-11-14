"""Turn real Yambda listening histories into Encore play records.

    python research/yambda_to_encore.py                       # 200 listeners, their last 60 days
    python research/yambda_to_encore.py --users 466 --days 300

Input:  data/public/yambda/events.parquet   (research/yambda_fetch.py)
Output: data/public/yambda/plays.jsonl      one Encore play record per line
        data/public/yambda/meta.json        how the conversion was done

Same format as the app's "Export data" plays (see js/encore/profile.js), so
the tools that read your own exports read these too. How each field is made:

  heard        played_ratio_pct (capped at 100) x track length
  end          'ended' if >= 90 % was played; else 'close' when it is the last
               song of a session (the listener stopped), else 'next' (a skip)
  seekBack     1 when played_ratio_pct > 100 (Yambda: rewound and replayed a part)
  replay       the same track was already played earlier in the session
  liked        +1 for a like, -1 for a dislike or an unlike, made between this
               listen and the next one (disliked: true marks dislikes)
  how / src    is_organic = 1 -> 'pick' (the listener chose it),
               is_organic = 0 -> 'encore' (a recommendation, like Encore's own picks)
  sess / pos   a new session after 30 min without music
  ctx.hour     ESTIMATED. Yambda timestamps are seconds from an unpublished
               origin. Listening has a deep night trough everywhere (Park et al.
               2019), so the clock is shifted to put this sample's quietest
               3 hours at 3-5 AM. With most Yandex listeners on Moscow time that
               is the same as reading the origin as UTC midnight (+3 h).
  ctx.dow      the weekday counted from the origin: consistent, but which real
               day is 0 is unknown, so `weekend` is not set
  artists      Yambda artist ids from artist_item_mapping.parquet (names are not
               published), as 'a<id>'
Fields Yambda does not record (pauses, volume, seek forward, background) are
left out or zero; the reward ignores what is missing.
"""
import argparse
import json
import os

import fsspec
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "data", "public", "yambda")
ARTIST_URL = "https://huggingface.co/datasets/yandex/yambda/resolve/main/artist_item_mapping.parquet"
GAP = 30 * 60          # seconds of silence that start a new session
BLOCK_EDGES = [5, 11, 17, 21]   # night, morning, afternoon, evening, late evening (as in profile.js)


def artists_for(items, cache):
    """Artist ids for the items in the sample (cached after the first run)."""
    if os.path.exists(cache):
        m = pd.read_parquet(cache)
    else:
        with fsspec.open(ARTIST_URL, "rb", block_size=1 << 20) as f:
            m = pq.read_table(f).to_pandas()
        m.to_parquet(cache)
    m = m[m.item_id.isin(items)]
    return m.groupby("item_id").artist_id.apply(lambda s: ["a%d" % a for a in s.tolist()[:2]]).to_dict()


def clock_offset(listen_ts):
    """Hours to add so this sample's quietest 3 hours sit at 3-5 AM."""
    counts = np.bincount(((listen_ts % 86400) // 3600).astype(int), minlength=24)
    window = [counts[h] + counts[(h + 1) % 24] + counts[(h + 2) % 24] for h in range(24)]
    quiet_mid = (int(np.argmin(window)) + 1) % 24
    return (4 - quiet_mid) % 24, counts.tolist()


def block_of(hour):
    return int(np.searchsorted(BLOCK_EDGES, hour, side="right"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--users", type=int, default=200, help="listeners to convert (random sample)")
    ap.add_argument("--days", type=float, default=60, help="the last N days of each listener's history")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--src", default=os.path.join(ROOT, "events.parquet"))
    ap.add_argument("--out", default=os.path.join(ROOT, "plays.jsonl"))
    args = ap.parse_args()

    ev = pd.read_parquet(args.src)
    offset, raw_hours = clock_offset(ev.loc[ev.event_type == "listen", "timestamp"].to_numpy())

    users = ev.uid.unique()
    rng = np.random.default_rng(args.seed)
    if args.users < len(users):
        users = rng.choice(users, args.users, replace=False)
    ev = ev[ev.uid.isin(users)].sort_values(["uid", "timestamp"], kind="stable")
    last = ev.groupby("uid").timestamp.transform("max")
    ev = ev[ev.timestamp >= last - args.days * 86400]

    listens = ev[ev.event_type == "listen"].copy()
    reacts = ev[ev.event_type != "listen"]
    art = artists_for(set(listens.item_id.unique()), os.path.join(ROOT, "artists.parquet"))

    listens["heard"] = np.minimum(listens.played_ratio_pct, 100) / 100.0 * listens.track_length_seconds
    listens["next_ts"] = listens.groupby("uid").timestamp.shift(-1)
    gap_after = listens.next_ts - (listens.timestamp + listens.heard)
    listens["last_in_session"] = gap_after.isna() | (gap_after > GAP)
    gap_before = listens.timestamp - (listens.groupby("uid").timestamp.shift(1) + listens.groupby("uid").heard.shift(1))
    listens["new_session"] = gap_before.isna() | (gap_before > GAP)
    listens["sess_no"] = listens.groupby("uid").new_session.cumsum()
    listens["pos"] = listens.groupby(["uid", "sess_no"]).cumcount()

    # reactions belong to the listen they follow (same track, before the next listen)
    react_map = {}
    for uid, g in reacts.groupby("uid"):
        react_map[uid] = g[["timestamp", "item_id", "event_type"]].to_numpy()

    out = open(args.out, "w", encoding="utf-8")
    n = 0
    for uid, g in listens.groupby("uid", sort=False):
        rx = react_map.get(uid)
        seen = {}
        prev_skip = False
        for row in g.itertuples(index=False):
            ts, item = int(row.timestamp), int(row.item_id)
            dur = int(row.track_length_seconds or 0)
            played = int(row.played_ratio_pct or 0)
            heard = round(float(row.heard), 1)
            if played >= 90:
                end = "ended"
            elif row.last_in_session:
                end = "close"
            else:
                end = "next"
            liked, disliked = 0, False
            if rx is not None:
                hi = row.next_ts if not np.isnan(row.next_ts) else ts + max(dur, 60) + 60
                m = rx[(rx[:, 0] >= ts) & (rx[:, 0] < hi) & (rx[:, 1] == item)]
                for _, _, kind in m:
                    if kind == "like":
                        liked = 1
                    elif kind in ("dislike", "unlike"):
                        liked = -1
                        disliked = disliked or kind == "dislike"
            sess = "y%d-%d" % (uid, row.sess_no)
            key = (sess, item)
            hour = ((ts + offset * 3600) % 86400) / 3600.0
            rec = {
                "uid": "y%d" % uid, "tid": "ym:%d" % item, "artists": art.get(item, []),
                "dur": dur, "heard": heard, "maxPos": heard, "end": end,
                "how": "pick" if row.is_organic else "encore",
                "src": "yambda-" + ("organic" if row.is_organic else "rec"),
                "ctx": {"t": ts * 1000, "hour": round(hour, 2), "dow": int((ts // 86400) % 7), "block": block_of(hour)},
                "sess": sess, "pos": int(row.pos), "prevSkip": prev_skip,
                "replay": key in seen, "restarts": 0, "seekBack": 1 if played > 100 else 0,
                "seekFwd": 0, "seekFwdEarly": 0, "pauses": 0, "liked": liked,
                "played": played,
            }
            if disliked:
                rec["disliked"] = True
            seen[key] = True
            prev_skip = end == "next"
            out.write(json.dumps(rec, separators=(",", ":")) + "\n")
            n += 1
    out.close()

    meta = {
        "source": "Yambda-50M (yandex/yambda, Apache 2.0), flat/50m/multi_event.parquet",
        "listeners": int(len(users)), "days": args.days, "plays": n,
        "clock_offset_hours": offset, "raw_hour_counts": raw_hours,
        "session_gap_s": GAP, "seed": args.seed,
    }
    with open(os.path.join(os.path.dirname(args.out), "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"{n:,} plays from {len(users)} listeners -> {os.path.relpath(args.out)} (clock offset +{offset} h)")


if __name__ == "__main__":
    main()
