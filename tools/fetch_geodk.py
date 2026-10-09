#!/usr/bin/env python3
"""Kerb lines and masts from GeoDanmark, for the game's kerbs and street posts.

Run from the repo root after fetch_dk.py:  python3 tools/fetch_geodk.py
Needs the Dataforsyningen token in tools/.dataforsyningen-token, plus numpy, opencv and scikit-image.

Dataforsyningen serves GeoDanmark as a map (WMS), not as vectors, so each 400 m game tile is fetched as a 2000 px
image (0.2 m per pixel) of the VEJKANT layer (kerbs and road edges) and of the MAST layer (lamp posts, signal and
sign posts). Kerb lines are thinned to one pixel and traced back into polylines; each mast symbol becomes a point.
Writes tools/raw/dk/gd/{layer}_{ix}_{iz}.png and tools/raw/dk/kerbs.json, tools/raw/dk/masts.json in world metres.
"""
import os, json
from concurrent.futures import ThreadPoolExecutor
import numpy as np, cv2
from skimage.morphology import skeletonize
from fetch_dk import OUT, NX, NZ, TILE, ORIGIN, TOKEN, tile_utm, get

GD = os.path.join(OUT, 'gd')
PX = 2000
RES = TILE / PX
is_png = lambda d: d[:4] == b'\x89PNG'

def fetch(layer, ix, iz):
    p = os.path.join(GD, f'{layer}_{ix}_{iz}.png')
    if os.path.exists(p): return p
    b = tile_utm(ix, iz)
    url = ('https://api.dataforsyningen.dk/GeoDanmark_60_NOHIST_DAF?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
           f'&LAYERS={layer}&STYLES=&CRS=EPSG:25832&BBOX={b[0]},{b[1]},{b[2]},{b[3]}&WIDTH={PX}&HEIGHT={PX}'
           f'&FORMAT=image/png&TRANSPARENT=TRUE&token={TOKEN}')
    get(url, p, is_png)
    return p

N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

def trace(sk):
    """One-pixel skeleton to polylines of (row, col): walk from every end or junction pixel, then round the loops."""
    H, W = sk.shape
    pad = np.zeros((H + 2, W + 2), np.uint8); pad[1:-1, 1:-1] = sk
    deg = sum(np.roll(np.roll(pad, dr, 0), dc, 1) for dr, dc in N8) * pad
    on = set(zip(*np.nonzero(pad)))
    used = set(); lines = []
    def nbrs(p): return [(p[0] + dr, p[1] + dc) for dr, dc in N8 if (p[0] + dr, p[1] + dc) in on]
    def walk(a, b):
        line = [a, b]; used.add((a, b)); used.add((b, a)); prev, cur = a, b
        while deg[cur] == 2:
            nxt = [q for q in nbrs(cur) if q != prev and (cur, q) not in used]
            if not nxt: break
            q = nxt[0]; used.add((cur, q)); used.add((q, cur)); line.append(q); prev, cur = cur, q
        return line
    for p in [p for p in on if deg[p] != 2]:
        for q in nbrs(p):
            if (p, q) not in used: lines.append(walk(p, q))
    for p in on:
        for q in nbrs(p):
            if (p, q) not in used: lines.append(walk(p, q))
    return [[(r - 1, c - 1) for r, c in l] for l in lines]

def kerbs_of(ix, iz):
    a = cv2.imread(os.path.join(GD, f'VEJKANT_{ix}_{iz}.png'), cv2.IMREAD_UNCHANGED)
    if a is None or a.ndim < 3 or a.shape[2] < 4: return []
    sk = skeletonize(a[..., 3] > 60).astype(np.uint8)
    x0 = -1703 + ix * TILE; z0 = -1896 + iz * TILE  # world corner (BOUNDS in fetch_dk.py)
    out = []
    for l in trace(sk):
        if len(l) < 10: continue  # shorter than 2 m
        pts = np.array([[c, r] for r, c in l], np.float32).reshape(-1, 1, 2)
        s = cv2.approxPolyDP(pts, 0.8, False).reshape(-1, 2)
        out.append([[round(x0 + (c + 0.5) * RES, 2), round(z0 + (r + 0.5) * RES, 2)] for c, r in s])
    return out

def masts_of(ix, iz):
    a = cv2.imread(os.path.join(GD, f'MAST_{ix}_{iz}.png'), cv2.IMREAD_UNCHANGED)
    if a is None or a.ndim < 3 or a.shape[2] < 4: return []
    n, lab, st, cen = cv2.connectedComponentsWithStats((a[..., 3] > 60).astype(np.uint8), 8)
    x0 = -1703 + ix * TILE; z0 = -1896 + iz * TILE
    # the symbol stands on its point: take the middle of its foot
    return [[round(x0 + (st[k, 0] + st[k, 2] / 2) * RES, 2), round(z0 + (st[k, 1] + st[k, 3] - 0.5) * RES, 2)]
            for k in range(1, n) if 4 <= st[k, 4] <= 400]

if __name__ == '__main__':
    os.makedirs(GD, exist_ok=True)
    jobs = [(L, ix, iz) for L in ('VEJKANT', 'MAST') for iz in range(NZ) for ix in range(NX)]
    with ThreadPoolExecutor(4) as ex:
        for k, _ in enumerate(ex.map(lambda j: fetch(*j), jobs)):
            if k % 30 == 0: print(f'{k + 1}/{len(jobs)}', flush=True)
    kerbs, masts = [], []
    for iz in range(NZ):
        for ix in range(NX):
            kerbs += kerbs_of(ix, iz); masts += masts_of(ix, iz)
        print('row', iz, len(kerbs), 'kerb lines', len(masts), 'masts', flush=True)
    json.dump(kerbs, open(os.path.join(OUT, 'kerbs.json'), 'w'))
    json.dump(masts, open(os.path.join(OUT, 'masts.json'), 'w'))
    km = sum(np.hypot(*np.diff(np.array(l), axis=0).T).sum() for l in kerbs) / 1000
    print(f'{len(kerbs)} kerb lines, {km:.0f} km, {len(masts)} masts')
