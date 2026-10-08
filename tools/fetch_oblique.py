#!/usr/bin/env python3
"""Downloads Klimadatastyrelsen's 2025 oblique aerial photos (skraafoto) over the game area, for facade colours.

Run from the repo root:  python3 tools/fetch_oblique.py
Needs the Dataforsyningen token in tools/.dataforsyningen-token, plus tifffile, imagecodecs and opencv.

The photos are cloud-optimised GeoTIFFs of 14144 x 10560 px. Only one reduced level (1/8, 1768 x 1320, roughly 0.8 m
per pixel) is read, by HTTP range requests, which is plenty for a facade's colour. Writes tools/raw/dk/sk/{id}.jpg
and tools/raw/dk/sk/items.json with each photo's camera (position, rotation matrix, focal length, sensor).
"""
import os, io, json, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import tifffile, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'raw', 'dk', 'sk')
TOKEN = open(os.path.join(HERE, '.dataforsyningen-token')).read().strip()
BBOX = '12.555,55.662,12.615,55.698'
LEVEL = 3

class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, in 64 KB blocks."""
    B = 1 << 16
    def __init__(self, url): self.url, self.pos, self.cache, self.size = url, 0, {}, None
    def _get(self, a):
        req = urllib.request.Request(self.url, headers={'Range': f'bytes={a}-{a + self.B - 1}'})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = r.read(); cr = r.headers.get('Content-Range')
                    if cr and self.size is None: self.size = int(cr.split('/')[-1])
                    return d
            except Exception:
                if attempt == 4: raise
                time.sleep(2 + 3 * attempt)
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, o, w=0):
        if w == 0: self.pos = o
        elif w == 1: self.pos += o
        else:
            if self.size is None: self._get(0)
            self.pos = self.size + o
        return self.pos
    def readinto(self, b):
        n, a0 = len(b), (self.pos // self.B) * self.B; out = bytearray(); a = a0
        while a < self.pos + n:
            if a not in self.cache: self.cache[a] = self._get(a)
            out += self.cache[a]
            if len(self.cache[a]) < self.B: break
            a += self.B
        chunk = out[self.pos - a0:self.pos - a0 + n]; b[:len(chunk)] = chunk; self.pos += len(chunk); return len(chunk)

def list_items():
    url = f'https://api.dataforsyningen.dk/rest/skraafoto_api/v1.0/collections/skraafotos2025/items?bbox={BBOX}&limit=200&token={TOKEN}'
    items = []
    while url:
        d = json.load(urllib.request.urlopen(url, timeout=60)); items += d['features']
        url = next((l['href'] for l in d.get('links', []) if l.get('rel') == 'next'), None)
        if url and 'token=' not in url: url += ('&' if '?' in url else '?') + 'token=' + TOKEN
    keep = []
    for it in items:
        p = it['properties']
        if p.get('direction') == 'nadir': continue
        io_ = p['pers:interior_orientation']
        keep.append({'id': it['id'], 'direction': p['direction'], 'datetime': p['datetime'],
                     'center': p['pers:perspective_center'], 'R': p['pers:rotation_matrix'],
                     'f': io_['focal_length'], 'pixel': io_['pixel_spacing'][0], 'sensor': io_['sensor_array_dimensions'],
                     'url': it['assets']['data']['href']})
    return keep

def fetch(it):
    p = os.path.join(OUT, it['id'] + '.jpg')
    if os.path.exists(p): return it['id']
    url = it['url'] if 'token=' in it['url'] else it['url'] + ('&' if '?' in it['url'] else '?') + 'token=' + TOKEN
    with tifffile.TiffFile(io.BufferedReader(RangeFile(url), 1 << 16)) as tf:
        a = tf.series[0].levels[LEVEL].asarray()
    cv2.imwrite(p + '.part.jpg', a[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 92]); os.replace(p + '.part.jpg', p)
    return it['id']

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    items = list_items()
    for it in items: it['url'] = it['url'].split('?')[0]  # keep the token out of items.json
    json.dump({'level': LEVEL, 'items': items}, open(os.path.join(OUT, 'items.json'), 'w'))
    print(len(items), 'oblique photos', flush=True)
    with ThreadPoolExecutor(6) as ex:
        for k, i in enumerate(ex.map(fetch, items)):
            if k % 20 == 0: print(f'{k + 1}/{len(items)} {i}', flush=True)
    print('done')
