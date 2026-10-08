#!/usr/bin/env python3
"""Turns the downloaded orthophotos into the game's textures.

Run from the repo root after fetch_dk.py:  python3 tools/ortho_dk.py
Writes data/ortho/{ix}_{iz}.webp (one per 400 m tile, 2048 px, about 0.2 m per pixel) and data/ortho/overview.webp
(the whole map at 1.25 m per pixel), which the game shows until a tile's full-resolution image has streamed in.

The photos were flown near midday in spring, so streets carry hard noon shadows that would fight the game's own
low evening sun. Dark, blue-tinted (sky-lit) areas are lifted toward the brightness of their sunlit surroundings.
"""
import os
import numpy as np, cv2
from fetch_dk import OUT, NX, NZ

HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(HERE, '..', 'data', 'ortho')
SIZE = 2048
OV = 320  # overview pixels per tile

def lift_shadows(img):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[..., 0] / 255; b = lab[..., 2] - 128
    dark = np.clip((0.42 - L) / 0.2, 0, 1) * np.clip(0.6 - b / 25, 0, 1)
    m = np.clip(cv2.GaussianBlur(dark, (0, 0), 6) * 1.3, 0, 1)
    w = cv2.GaussianBlur(1 - m, (0, 0), 40)
    lit = cv2.GaussianBlur(L * (1 - m), (0, 0), 40) / np.maximum(w, 1e-3)
    gain = np.clip(lit / np.maximum(L, 0.03), 1, 3.0)
    lab[..., 0] = np.clip(L * (1 + (gain - 1) * m * 0.7) * 255, 0, 255)
    lab[..., 2] += m * 4
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)

def main():
    os.makedirs(DST, exist_ok=True)
    ov = np.zeros((NZ * OV, NX * OV, 3), np.uint8); total = 0
    for iz in range(NZ):
        for ix in range(NX):
            src = cv2.imread(os.path.join(OUT, f'ortho_{ix}_{iz}.jpg'))
            img = lift_shadows(src)
            t = cv2.resize(img, (SIZE, SIZE), interpolation=cv2.INTER_AREA)
            p = os.path.join(DST, f'{ix}_{iz}.webp')
            cv2.imwrite(p, t, [cv2.IMWRITE_WEBP_QUALITY, 72]); total += os.path.getsize(p)
            ov[iz * OV:(iz + 1) * OV, ix * OV:(ix + 1) * OV] = cv2.resize(img, (OV, OV), interpolation=cv2.INTER_AREA)
        print('row', iz, flush=True)
    p = os.path.join(DST, 'overview.webp'); cv2.imwrite(p, ov, [cv2.IMWRITE_WEBP_QUALITY, 80])
    print(f'tiles {total / 1e6:.1f} MB, overview {os.path.getsize(p) / 1e6:.2f} MB')

if __name__ == '__main__':
    main()
