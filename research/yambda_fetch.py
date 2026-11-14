"""Fetch real listening histories from Yambda (Yandex Music, Apache 2.0).

    python research/yambda_fetch.py                 # 8 chunks: ~530 listeners, ~2 M events, ~20 MB
    python research/yambda_fetch.py --chunks 40     # more listeners
    python research/yambda_fetch.py --all           # the whole 50M subset (~385 MB)

Yambda-50M (https://huggingface.co/datasets/yandex/yambda) is stored as
flat/50m/multi_event.parquet: 47.8 M events (listen, like, dislike, unlike,
undislike) in 183 row groups, sorted by user. Each row group holds about 66
users' complete histories, so reading a few row groups over HTTP gives whole
listeners without downloading the full file. The last user of the last chunk
read may be cut short, so that user is dropped.

Columns: uid, timestamp (5-second units, relative), item_id, is_organic
(1 = the listener chose it, 0 = a recommendation), played_ratio_pct (share of
the track played, >100 after rewinding), track_length_seconds, event_type.

Output: data/public/yambda/events.parquet
"""
import argparse
import os
import sys

import fsspec
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

URL = "https://huggingface.co/datasets/yandex/yambda/resolve/main/flat/50m/multi_event.parquet"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "public", "yambda")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chunks", type=int, default=8, help="row groups to read (about 66 listeners each)")
    ap.add_argument("--all", action="store_true", help="read every row group (~385 MB)")
    ap.add_argument("--out", default=os.path.join(ROOT, "events.parquet"))
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with fsspec.open(URL, "rb", block_size=1 << 20) as f:
        pf = pq.ParquetFile(f)
        n = pf.metadata.num_row_groups if args.all else min(args.chunks, pf.metadata.num_row_groups)
        tables = []
        for i in range(n):
            tables.append(pf.read_row_group(i))
            sys.stdout.write(f"\rrow group {i + 1}/{n}")
            sys.stdout.flush()
    print()
    t = pa.concat_tables(tables)
    if not args.all:
        # the last user may continue in the next row group: drop that partial history
        last = t.column("uid")[-1].as_py()
        t = t.filter(pc.not_equal(t.column("uid"), last))
    t = t.set_column(t.schema.get_field_index("event_type"), "event_type",
                     pc.cast(t.column("event_type"), pa.string()))
    pq.write_table(t, args.out, compression="zstd")
    users = len(pc.unique(t.column("uid")))
    print(f"{t.num_rows:,} events from {users} listeners -> {os.path.relpath(args.out)}")


if __name__ == "__main__":
    main()
