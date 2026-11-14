"""Can a classifier tell real sessions from synthetic ones?

    python research/two_sample_test.py data/public/yambda/plays.jsonl data/synthetic/plays.jsonl

A classifier two-sample test (Lopez-Paz & Oquab, 2017): describe every
session with the same features, label real = 1 and synthetic = 0, train a
gradient-boosted classifier with 5-fold cross-validation and report the
ROC AUC.
  AUC ~ 0.5   the classifier can't tell them apart on these features
  AUC ~ 1.0   trivially different
The feature importances say what still gives the synthetic data away, so this
is a to-do list as much as a score. Only behaviour is compared: song ids,
artists and audio never enter, because the two catalogues differ by design.
"""
import argparse
import json
from collections import defaultdict

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score

FEATURES = ["songs", "log_songs", "through", "skip", "fast_skip", "first_through", "longest_skip_run",
            "through_after_skip", "replay", "repeat", "same_artist", "own_choice", "mean_heard", "start_block"]


def sessions(path, limit_users=None):
    """Session feature rows from a plays JSONL file."""
    by_user = defaultdict(list)
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                by_user[r.get("uid", "me")].append(r)
    rows = []
    for uid, plays in list(by_user.items())[:limit_users]:
        heard_before = set()
        cur, cur_id = [], None
        for r in plays + [None]:
            if r is None or r["sess"] != cur_id:
                if cur:
                    rows.append(describe(cur))
                cur, cur_id = [], (r["sess"] if r else None)
            if r is None:
                break
            r["_repeat"] = r["tid"] in heard_before
            heard_before.add(r["tid"])
            cur.append(r)
    return np.array(rows, dtype=float)


def frac(r):
    return min(1.0, (r.get("heard") or 0) / r["dur"]) if r.get("dur") else 0.0


def describe(s):
    th = [frac(r) >= 0.9 for r in s]
    sk = [(not t) and r.get("end") in ("next", "prev", "pick") for r, t in zip(s, th)]
    fast = [k and (r.get("heard") or 0) < 10 for r, k in zip(s, sk)]
    run = best = 0
    for k in sk:
        run = run + 1 if k else 0
        best = max(best, run)
    after = [th[i] for i in range(1, len(s)) if sk[i - 1]]
    same = [bool(s[i].get("artists")) and bool(s[i - 1].get("artists")) and s[i]["artists"][0] == s[i - 1]["artists"][0]
            for i in range(1, len(s))]
    n = len(s)
    return [n, np.log(n), np.mean(th), np.mean(sk), np.mean(fast), float(th[0]), best,
            np.mean(after) if after else -1, np.mean([bool(r.get("replay")) for r in s]),
            np.mean([r["_repeat"] for r in s]), np.mean(same) if same else -1,
            np.mean([r.get("how") == "pick" for r in s]), np.mean([frac(r) for r in s]),
            (s[0].get("ctx") or {}).get("block", -1)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("real")
    ap.add_argument("synthetic")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    real, syn = sessions(args.real), sessions(args.synthetic)
    rng = np.random.default_rng(args.seed)
    n = min(len(real), len(syn))
    real = real[rng.choice(len(real), n, replace=False)]
    syn = syn[rng.choice(len(syn), n, replace=False)]
    X = np.vstack([real, syn])
    y = np.r_[np.ones(n), np.zeros(n)]
    clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08, random_state=args.seed)
    cv = StratifiedKFold(5, shuffle=True, random_state=args.seed)
    p = cross_val_predict(clf, X, y, cv=cv, method="predict_proba")[:, 1]
    auc = roc_auc_score(y, p)
    clf.fit(X, y)
    imp = permutation_importance(clf, X, y, scoring="roc_auc", n_repeats=5, random_state=args.seed)
    order = np.argsort(-imp.importances_mean)
    print(f"{n:,} real vs {n:,} synthetic sessions")
    print(f"classifier ROC AUC (5-fold): {auc:.3f}   (0.5 = indistinguishable, 1.0 = trivially different)")
    print("what gives the synthetic sessions away (permutation importance, AUC points):")
    for i in order[:6]:
        print(f"  {FEATURES[i]:20s} {imp.importances_mean[i]:.3f}   real {np.median(real[:, i]):.2f} vs synthetic {np.median(syn[:, i]):.2f} (medians)")


if __name__ == "__main__":
    main()
