#!/usr/bin/env python3
"""Real facade colours from Klimadatastyrelsen's 2025 oblique aerial photos.

Run from the repo root after build.mjs (which writes tools/raw/walls.json) and fetch_oblique.py:
    python3 tools/facades_dk.py && node tools/build.mjs
Writes tools/raw/facades.json, which build.mjs packs into data/facades.bin.gz.

For every wall segment a few points are placed just in front of the wall, between 2 m and 85 % of its height.
Each point is projected into every oblique photo whose camera the wall faces, and a ray is walked from the point
toward the camera through the laser surface model: if a roof or tree rises above the ray, that view is blocked.
The segment takes the per-channel median colour of the visible points in the photo that sees it best (most visible
points, most head-on, nearest the image centre). Windows are a minority of a facade, so the median lands on the
paint or brick. Finally, colours are evened out across orientations, because the photos were flown around midday
and north-facing walls sit in shade, and given back the contrast and saturation that aerial haze takes away.
"""
import os, json, math
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw'); DK = os.path.join(RAW, 'dk'); SK = os.path.join(DK, 'sk')
ORIGIN = (725300, 6176300)
OFFSET = 0.35      # sample this far in front of the wall
STEP = 0.6         # horizontal ray-march step, metres
STEPS = 80         # up to 48 m out from the wall
MIN_COS = 0.3      # wall must face the camera at least this squarely

def load_grids():
    m = json.load(open(os.path.join(DK, 'ndsm.json')))
    W, H = m['w'], m['h']
    dsm = np.fromfile(os.path.join(DK, 'dsm.i16'), np.int16).reshape(H, W)
    dtm = np.fromfile(os.path.join(DK, 'dtm.i16'), np.int16).reshape(H // 4, W // 4)
    return m, dsm, dtm

def segments(walls):
    """Flatten every wall segment: building, ring, index, endpoints (world x,z), tops, outward normal (world)."""
    rows = []
    for bi, rings in enumerate(walls):
        if not rings: continue
        polys = [np.array(r, np.float64)[:, :2] for r in rings]
        for ri, r in enumerate(rings):
            n = len(r)
            for k in range(n):
                a, b = r[k], r[(k + 1) % n]
                rows.append((bi, ri, k, a[0], a[1], b[0], b[1], a[2], b[2]))
    S = np.array(rows, np.float64)
    dx, dz = S[:, 5] - S[:, 3], S[:, 6] - S[:, 4]; L = np.hypot(dx, dz)
    nx, nz = dz / np.maximum(L, 1e-6), -dx / np.maximum(L, 1e-6)
    # outward: the side whose probe point is not inside the building (even-odd over all its rings)
    mx, mz = (S[:, 3] + S[:, 5]) / 2, (S[:, 4] + S[:, 6]) / 2
    inside = np.zeros(len(S), bool)
    by_b = {}
    for i, bi in enumerate(S[:, 0].astype(int)): by_b.setdefault(bi, []).append(i)
    for bi, idx in by_b.items():
        idx = np.array(idx); px, pz = mx[idx] + nx[idx] * 0.3, mz[idx] + nz[idx] * 0.3
        c = np.zeros(len(idx), bool)
        for r in walls[bi]:
            r = np.array(r)[:, :2]; ax, az = r[:, 0], r[:, 1]; bx, bz = np.roll(ax, -1), np.roll(az, -1)
            cross = ((az[None] > pz[:, None]) != (bz[None] > pz[:, None])) & (px[:, None] < (bx - ax)[None] * (pz[:, None] - az[None]) / np.where(bz - az == 0, 1e-9, bz - az)[None] + ax[None])
            c ^= (cross.sum(1) % 2).astype(bool)
        inside[idx] = c
    nx[inside], nz[inside] = -nx[inside], -nz[inside]
    return S, L, nx, nz

def main():
    walls = json.load(open(os.path.join(RAW, 'walls.json')))
    meta, dsm, dtm = load_grids()
    items = json.load(open(os.path.join(SK, 'items.json')))
    level = items['level']; items = [it for it in items['items'] if os.path.exists(os.path.join(SK, it['id'] + '.jpg'))]
    S, L, nx, nz = segments(walls)
    print(len(S), 'wall segments,', len(items), 'oblique photos', flush=True)

    # sample points: up to 4 along, 3 up, in front of each wall
    pts_seg, pts_xz, pts_h = [], [], []
    for u in (0.2, 0.4, 0.6, 0.8):
        for v in (0.15, 0.5, 0.85):
            ok = (L >= 1.5) & ((L >= 6) | (u in (0.4, 0.6)))
            top = np.minimum(S[:, 7], S[:, 8]) * 0.85
            ok &= top >= 2.5
            i = np.nonzero(ok)[0]
            x = S[i, 3] + (S[i, 5] - S[i, 3]) * u + nx[i] * OFFSET
            z = S[i, 4] + (S[i, 6] - S[i, 4]) * u + nz[i] * OFFSET
            h = 2.0 + (top[i] - 2.0) * v
            pts_seg.append(i); pts_xz.append(np.stack([x, z], 1)); pts_h.append(h)
    seg = np.concatenate(pts_seg); xz = np.concatenate(pts_xz); h = np.concatenate(pts_h)
    E = ORIGIN[0] + xz[:, 0]; N = ORIGIN[1] - xz[:, 1]
    res, e0, n1 = meta['res'], meta['e0'], meta['n1']
    dc = np.clip(((E - e0) / (res * 4)).astype(int), 0, dtm.shape[1] - 1); dr = np.clip(((n1 - N) / (res * 4)).astype(int), 0, dtm.shape[0] - 1)
    Z = dtm[dr, dc] / 100.0 + h
    P = np.stack([E, N, Z], 1)
    nE, nN = nx[seg], -nz[seg]                      # outward normal in UTM (world z points south)
    print(len(seg), 'sample points', flush=True)

    best = np.full(len(S), -1.0); col = np.zeros((len(S), 3), np.float32); bestdir = np.full(len(S), -1)
    dirs = {'north': 0, 'east': 1, 'south': 2, 'west': 3}
    for k, it in enumerate(items):
        C = np.array(it['center']); R = np.array(it['R']).reshape(3, 3); f = it['f']; ps = it['pixel']; SW, SH = it['sensor']
        img = cv2.imread(os.path.join(SK, it['id'] + '.jpg'))[..., ::-1].astype(np.float32)
        sc = img.shape[1] / SW
        v = C[None, :2] - P[:, :2]; dist = np.hypot(v[:, 0], v[:, 1]); cos = (v[:, 0] * nE + v[:, 1] * nN) / np.maximum(dist, 1e-6)
        # collinearity: image-plane x, y in mm, then pixels (row 0 at the top) scaled to the downloaded level.
        # The principal point's row is half the sensor's short side: for the portrait east and west photos that sits
        # 1792 px above the image centre (found by fitting projected roof outlines to the photos' edges).
        d = (P - C) @ R.T
        ix, iy = -f * d[:, 0] / d[:, 2], -f * d[:, 1] / d[:, 2]
        cx, cy = (SW / 2 + ix / ps) * sc, (min(SW, SH) / 2 - iy / ps) * sc
        m = (cos > MIN_COS) & (d[:, 2] < 0) & (cx > 2) & (cy > 2) & (cx < img.shape[1] - 3) & (cy < img.shape[0] - 3)
        idx = np.nonzero(m)[0]
        if not len(idx): continue
        # visibility: walk toward the camera through the surface model
        D = C[None] - P[idx]; Dh = np.hypot(D[:, 0], D[:, 1]); t = (np.arange(2, STEPS + 2) * STEP)[None, :] / Dh[:, None]
        rx = P[idx, 0:1] + D[:, 0:1] * t; ry = P[idx, 1:2] + D[:, 1:2] * t; rz = P[idx, 2:3] + D[:, 2:3] * t
        gc = np.clip(((rx - e0) / res).astype(int), 0, dsm.shape[1] - 1); gr = np.clip(((n1 - ry) / res).astype(int), 0, dsm.shape[0] - 1)
        blocked = (dsm[gr, gc] / 100.0 > rz + 0.3).any(1)
        idx = idx[~blocked]
        if not len(idx): continue
        # colour at each visible point (bilinear)
        x, y = cx[idx], cy[idx]; x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int); fx, fy = (x - x0)[:, None], (y - y0)[:, None]
        rgb = img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy
        sg = seg[idx]
        # per segment: visible count, mean facing, distance from image centre
        cnt = np.bincount(sg, minlength=len(S)); cs = np.bincount(sg, weights=cos[idx], minlength=len(S))
        rad = np.hypot(x / img.shape[1] - 0.5, y / img.shape[0] - 0.5)
        rs = np.bincount(sg, weights=rad, minlength=len(S))
        hit = np.nonzero(cnt)[0]
        total = np.bincount(seg, minlength=len(S))[hit]
        score = cnt[hit] / np.maximum(total, 1) * (cs[hit] / cnt[hit]) * (1 - 0.6 * rs[hit] / cnt[hit])
        score[cnt[hit] < np.minimum(2, total)] = -1
        win = hit[score > best[hit]]
        if len(win):
            best[win] = score[score > best[hit]]; bestdir[win] = dirs.get(it['direction'], -1)
            # per-channel median of this photo's visible points, for the segments it now wins
            sel = np.isin(sg, win); s2, c2 = sg[sel], rgb[sel]
            order = np.lexsort((c2[:, 0], s2)); s_sorted = s2[order]
            starts = np.r_[0, np.nonzero(np.diff(s_sorted))[0] + 1]; ends = np.r_[starts[1:], len(s_sorted)]
            for ch in range(3):
                o = np.lexsort((c2[:, ch], s2)); vals = c2[o, ch]
                col[s_sorted[starts], ch] = vals[(starts + ends) // 2]
        if k % 25 == 0: print(f'{k + 1}/{len(items)} coloured {int((best >= 0).sum())}', flush=True)

    ok = best >= 0
    np.save(os.path.join(RAW, 'facades_raw.npy'), np.c_[S[:, :3], col, ok])
    # even out orientation: match each 45-degree sector's median lightness and tint to the city-wide median
    lab = cv2.cvtColor(col[None].astype(np.uint8), cv2.COLOR_RGB2LAB)[0].astype(np.float32)
    az = (np.degrees(np.arctan2(nx, -nz)) + 360) % 360; sector = (az // 45).astype(int)
    gm = np.median(lab[ok], 0)
    for s_ in range(8):
        m = ok & (sector == s_)
        if m.sum() < 50: continue
        sm = np.median(lab[m], 0)
        lab[m, 0] = np.clip(lab[m, 0] * (gm[0] / max(sm[0], 1)) ** 0.85, 0, 255)
        lab[m, 1:] += (gm[1:] - sm[1:]) * 0.3   # mostly the blue cast of shade; each wall keeps its own hue
    out_rgb = cv2.cvtColor(np.clip(lab, 0, 255)[None].astype(np.uint8), cv2.COLOR_LAB2RGB)[0]
    # aerial haze leaves the photos pale: restore contrast and saturation, as the game does for the vertical photo
    lin = (out_rgb.astype(np.float32) / 255) ** (2.2 * 1.25)
    lum = (lin * [0.2126, 0.7152, 0.0722]).sum(1, keepdims=True)
    lin = np.clip(lum + (lin - lum) * 1.8, 0, 1)
    out_rgb = np.round(lin ** (1 / 2.2) * 255).astype(np.uint8)

    result = [None if not w else [[None] * len(r) for r in w] for w in walls]
    for i in np.nonzero(ok)[0]:
        bi, ri, kk = int(S[i, 0]), int(S[i, 1]), int(S[i, 2])
        result[bi][ri][kk] = [int(c) for c in out_rgb[i]]
    json.dump(result, open(os.path.join(RAW, 'facades.json'), 'w'))
    print(f'coloured {int(ok.sum())} of {len(S)} wall segments ({100 * ok.mean():.0f} %)')

if __name__ == '__main__':
    main()
