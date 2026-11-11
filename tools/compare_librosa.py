"""Cross-check Encore's in-browser DSP against librosa on the same audio.

    python tools/compare_librosa.py <work-dir>     (after tools/calibrate-dsp.js)

Tempo: MIREX-style Acc1 (within 4 %) and Acc2 (within 4 % of x1/2, x2, x1/3, x3).
Key:   librosa chroma_cqt + the same Krumhansl-Kessler profiles, scored with
       the MIREX weights (same 1.0, fifth 0.5, relative 0.3, parallel 0.2).
librosa is a reference implementation here, not ground truth: agreement
shows the JavaScript port behaves like the standard tools.
"""
import json
import subprocess
import sys

import numpy as np
import librosa

KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def decode(path, sr=22050):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def ks_key(chroma):
    best = None
    for k in range(12):
        for mode, prof in ((1, KK_MAJOR), (0, KK_MINOR)):
            r = np.corrcoef(np.roll(chroma, -k), prof)[0, 1]
            if best is None or r > best[0]:
                best = (r, k, mode)
    return best[1], best[2]


def key_score(a, b):
    (ka, ma), (kb, mb) = a, b
    if ka == kb and ma == mb:
        return 1.0
    if ma == mb and (kb - ka) % 12 in (5, 7):
        return 0.5
    rel = (ka + 9) % 12 if ma == 1 else (ka + 3) % 12   # relative minor / major
    if ma != mb and kb == rel:
        return 0.3
    if ka == kb and ma != mb:
        return 0.2
    return 0.0


def main(work):
    rows = json.load(open(f'{work}/features.json', encoding='utf-8'))
    seen, acc1, acc2, kscore, kexact, n = set(), 0, 0, 0.0, 0, 0
    print(f"{'song':28} {'encore':>7} {'librosa':>7}  {'encore key':10} {'librosa key':10}")
    for r in rows:
        if r['title'] in seen:
            continue
        seen.add(r['title'])
        y = decode(r['file'])
        tempo = float(np.atleast_1d(librosa.beat.beat_track(y=y, sr=22050)[0])[0])
        chroma = librosa.feature.chroma_cqt(y=y, sr=22050).mean(axis=1)
        lk = ks_key(chroma)
        ours, ek = r['raw']['bpm'], (r['raw']['key'], r['raw']['mode'])
        ratio = ours / tempo if tempo else 0
        a1 = abs(ratio - 1) < 0.04
        a2 = any(abs(ratio / m - 1) < 0.04 for m in (0.5, 1, 2, 1 / 3, 3))
        s = key_score(lk, ek)
        acc1 += a1
        acc2 += a2
        kscore += s
        kexact += s == 1.0
        n += 1
        fmt = lambda k: NOTES[k[0]] + (' maj' if k[1] else ' min')
        print(f"{r['title'][:28]:28} {ours:7.1f} {tempo:7.1f}{'' if a1 else (' ~' if a2 else ' x')}  {fmt(ek):10} {fmt(lk):10} {s:.1f}")
    print(f"\n{n} songs   tempo Acc1 {acc1 / n:.0%}   Acc2 {acc2 / n:.0%}   key exact {kexact / n:.0%}   MIREX key score {kscore / n:.2f}")


if __name__ == '__main__':
    main(sys.argv[1])
