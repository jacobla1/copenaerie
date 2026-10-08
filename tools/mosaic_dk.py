#!/usr/bin/env python3
"""Stitches the height-model tiles from fetch_dk.py into one grid of heights above the terrain (nDSM).

Run from the repo root:  python3 tools/mosaic_dk.py
Writes tools/raw/dk/ndsm.i16 (int16 centimetres, row 0 = north edge, 0.4 m cells) and ndsm.json (its georeference).
Building heights are measured above the local terrain, because the game's streets are flat.
Also writes dsm.i16 (absolute surface heights, same grid) and dtm.i16 (absolute terrain, 1.6 m cells), which
facades_dk.py uses to place walls in the oblique photos and to test whether anything blocks the view.
"""
import os, json, glob
import numpy as np, tifffile, cv2
from fetch_dk import OUT, NX, NZ, TILE, tile_utm

RES = 0.4
P = int(TILE / RES)

def main():
    W, H = NX * P, NZ * P
    nd = np.zeros((H, W), np.int16); ds = np.zeros((H, W), np.int16); dt = np.zeros((H // 4, W // 4), np.int16); missing = []
    for iz in range(NZ):
        for ix in range(NX):
            tag = f'{ix}_{iz}'
            try:
                dsm = tifffile.imread(os.path.join(OUT, f'dsm_{tag}.tif')).astype(np.float32)
                dtm = tifffile.imread(os.path.join(OUT, f'dtm_{tag}.tif')).astype(np.float32)
            except FileNotFoundError:
                missing.append(tag); continue
            dt[iz * P // 4:(iz + 1) * P // 4, ix * P // 4:(ix + 1) * P // 4] = np.round(dtm * 100).astype(np.int16)
            ds[iz * P:(iz + 1) * P, ix * P:(ix + 1) * P] = np.round(np.clip(dsm, -5, 300) * 100).astype(np.int16)
            dtm = cv2.resize(dtm, (P, P), interpolation=cv2.INTER_LINEAR)
            h = np.clip(dsm - dtm, -5, 300)
            nd[iz * P:(iz + 1) * P, ix * P:(ix + 1) * P] = np.round(h * 100).astype(np.int16)
    E0, _, _, N1 = tile_utm(0, 0)
    nd.tofile(os.path.join(OUT, 'ndsm.i16')); ds.tofile(os.path.join(OUT, 'dsm.i16')); dt.tofile(os.path.join(OUT, 'dtm.i16'))
    json.dump({'e0': E0, 'n1': N1, 'res': RES, 'w': W, 'h': H, 'unit': 'cm', 'missing': missing}, open(os.path.join(OUT, 'ndsm.json'), 'w'))
    print('ndsm', W, 'x', H, 'missing tiles:', missing or 'none')

if __name__ == '__main__':
    main()
