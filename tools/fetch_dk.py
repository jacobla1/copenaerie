#!/usr/bin/env python3
"""Downloads Klimadatastyrelsen's aerial photos and height models for the game area into tools/raw/dk/.

Run from the repo root:  python3 tools/fetch_dk.py
Needs a free Dataforsyningen token in tools/.dataforsyningen-token (git-ignored), plus numpy, tifffile and opencv.

Per 400 m game tile (the same grid as index.html's TILE):
  ortho_{ix}_{iz}.jpg   GeoDanmark spring orthophoto 2025, 10 cm, fetched as four 200 m quadrants and stitched (4000 px)
  dsm_{ix}_{iz}.tif     Danmarks Hoejdemodel surface model (buildings, trees), 0.4 m
  dtm_{ix}_{iz}.tif     Danmarks Hoejdemodel terrain model, 1.6 m
Existing files are skipped, so the script can be re-run after an interruption.
"""
import os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'raw', 'dk')
TOKEN = open(os.path.join(HERE, '.dataforsyningen-token')).read().strip()
ORIGIN = (725300, 6176300)          # world (0,0) in UTM 32N, as in build.mjs
BOUNDS = (-1703, -1896, 1859, 1911) # world x0, z0, x1, z1 (z = south)
TILE = 400
NX = -(-(BOUNDS[2] - BOUNDS[0]) // TILE)
NZ = -(-(BOUNDS[3] - BOUNDS[1]) // TILE)
ORTHO_LAYER = 'geodanmark_2025_10cm'

def tile_utm(ix, iz):
    x0 = BOUNDS[0] + ix * TILE; z0 = BOUNDS[1] + iz * TILE
    return ORIGIN[0] + x0, ORIGIN[1] - z0 - TILE, ORIGIN[0] + x0 + TILE, ORIGIN[1] - z0  # E0, N0, E1, N1

def get(url, path, check):
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=180) as r: data = r.read()
            if not check(data): raise ValueError('unexpected response: ' + data[:120].decode('latin1'))
            tmp = path + '.part'; open(tmp, 'wb').write(data); os.replace(tmp, path); return
        except (urllib.error.URLError, ValueError, TimeoutError) as e:
            if attempt == 4: raise
            time.sleep(2 + attempt * 3)

is_jpeg = lambda d: d[:2] == b'\xff\xd8'
is_tiff = lambda d: d[:4] in (b'II*\x00', b'MM\x00*')

def wcs(cov, b, px, path):
    url = ('https://api.dataforsyningen.dk/dhm_wcs_DAF?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage'
           f'&COVERAGE={cov}&CRS=EPSG:25832&BBOX={b[0]},{b[1]},{b[2]},{b[3]}&WIDTH={px}&HEIGHT={px}&FORMAT=GTiff&token={TOKEN}')
    get(url, path, is_tiff)

def wms(b, px, path):
    url = ('https://api.dataforsyningen.dk/orto_foraar_DAF?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
           f'&LAYERS={ORTHO_LAYER}&STYLES=&CRS=EPSG:25832&BBOX={b[0]},{b[1]},{b[2]},{b[3]}&WIDTH={px}&HEIGHT={px}&FORMAT=image/jpeg&token={TOKEN}')
    get(url, path, is_jpeg)

def job(ix, iz):
    b = tile_utm(ix, iz); tag = f'{ix}_{iz}'
    p = os.path.join(OUT, f'dsm_{tag}.tif')
    if not os.path.exists(p): wcs('dhm_overflade', b, TILE * 10 // 4, p)
    p = os.path.join(OUT, f'dtm_{tag}.tif')
    if not os.path.exists(p): wcs('dhm_terraen', b, TILE * 10 // 16, p)
    p = os.path.join(OUT, f'ortho_{tag}.jpg')
    if not os.path.exists(p):
        half = TILE // 2; quads = []
        for qz in (0, 1):          # top row first (north)
            row = []
            for qx in (0, 1):
                qb = (b[0] + qx * half, b[3] - (qz + 1) * half, b[0] + (qx + 1) * half, b[3] - qz * half)
                qp = os.path.join(OUT, f'q_{tag}_{qx}{qz}.jpg'); wms(qb, half * 10, qp)
                row.append(cv2.imread(qp)); os.remove(qp)
            quads.append(np.hstack(row))
        cv2.imwrite(p, np.vstack(quads), [cv2.IMWRITE_JPEG_QUALITY, 92])
    return tag

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    jobs = [(ix, iz) for iz in range(NZ) for ix in range(NX)]
    print(f'{len(jobs)} tiles ({NX} x {NZ}) into {OUT}', flush=True)
    with ThreadPoolExecutor(4) as ex:
        for k, tag in enumerate(ex.map(lambda a: job(*a), jobs)):
            print(f'{k + 1}/{len(jobs)} {tag}', flush=True)
    print('done')
