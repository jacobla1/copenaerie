// Real roof shapes from Danmarks Hoejdemodel. For one building footprint this samples the height grid
// (heights above terrain, 0.4 m cells) and returns a simplified roof surface: the footprint outline with a
// height at every point where the eave line bends, plus interior points added greedily wherever the surface
// misses the laser heights by more than opts.tol. The outline and interior are joined by a constrained Delaunay
// triangulation, so roof planes, ridges, dormers and chimneys come out as a few dozen triangles.
import fs from 'fs';
import path from 'path';
import cdt2d from 'cdt2d';

export const opts = { tol: 0.5, steep: 1.8 }; // metres of vertical error allowed on the roof surface
const INSET = 0.7;     // sample the eave this far inside the wall, clear of the street below
const STEP = 1.0;      // eave sampling step along each wall

// Load the nDSM grid written by mosaic_dk.py. origin: the world origin in UTM (world x = E - ox, z = oy - N).
export function loadNdsm(dir, origin){
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'ndsm.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'ndsm.i16'));
  const a = new Int16Array(buf.buffer, buf.byteOffset, meta.w * meta.h);
  const res = meta.res, x0 = meta.e0 - origin[0], z0 = origin[1] - meta.n1; // world coords of the grid's NW corner
  return { a, w: meta.w, h: meta.h, res, x0, z0 };
}

function pipRings(rings, x, z){
  let c = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++){
    const a = r[i], b = r[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function distToRings(rings, x, z){
  let d = Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i++){
    const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz;
    let t = l ? ((x - a[0]) * dx + (z - a[1]) * dz) / l : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a[0] + dx * t - x, ez = a[1] + dz * t - z; d = Math.min(d, ex * ex + ez * ez);
  }
  return Math.sqrt(d);
}
function median(v){ if (!v.length) return NaN; const s = Float32Array.from(v).sort(); return s[s.length >> 1]; }
// Douglas-Peucker on a polyline of [t, h] samples; returns the indices kept.
function dpIdx(s, tol){
  const keep = new Uint8Array(s.length); keep[0] = keep[s.length - 1] = 1;
  const st = [[0, s.length - 1]];
  while (st.length){
    const [i0, i1] = st.pop(); let md = 0, mi = -1;
    for (let i = i0 + 1; i < i1; i++){
      const f = (s[i][0] - s[i0][0]) / ((s[i1][0] - s[i0][0]) || 1), hl = s[i0][1] + (s[i1][1] - s[i0][1]) * f, d = Math.abs(s[i][1] - hl);
      if (d > md){ md = d; mi = i; }
    }
    if (md > tol && mi > 0){ keep[mi] = 1; st.push([i0, mi], [mi, i1]); }
  }
  return keep;
}

// rings: footprint rings in world metres ([[x,z],...], first = outer). skip(x,z): cells to ignore (landmark parts).
// Returns null when the laser data has no building here (new construction, or a footprint the scan missed).
export function roofFor(G, rings, skip){
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const r of rings) for (const p of r){ bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); bz0 = Math.min(bz0, p[1]); bz1 = Math.max(bz1, p[1]); }
  const c0 = Math.max(0, Math.floor((bx0 - G.x0) / G.res) - 2), c1 = Math.min(G.w - 1, Math.ceil((bx1 - G.x0) / G.res) + 2);
  const r0 = Math.max(0, Math.floor((bz0 - G.z0) / G.res) - 2), r1 = Math.min(G.h - 1, Math.ceil((bz1 - G.z0) / G.res) + 2);
  const W = c1 - c0 + 1, H = r1 - r0 + 1; if (W < 3 || H < 3) return null;
  // local copy: a 3x3 median drops single-cell spikes (aerials, birds, scan noise), then a light 3x3 blur (twice) flattens
  // the scan's ripple so roof planes come out as planes
  const raw = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) raw[r * W + c] = G.a[(r0 + r) * G.w + c0 + c] / 100;
  const hgt = new Float32Array(W * H), nb = new Float32Array(9);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++){
    let k = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++){ const rr = Math.min(H - 1, Math.max(0, r + dr)), cc = Math.min(W - 1, Math.max(0, c + dc)); nb[k++] = raw[rr * W + cc]; }
    nb.sort(); hgt[r * W + c] = nb[4];
  }
  for (let pass = 0; pass < 2; pass++){
    raw.set(hgt);
    for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++){
      let s = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s += raw[(r + dr) * W + c + dc] * (dr || dc ? (dr && dc ? 1 : 2) : 4);
      hgt[r * W + c] = s / 16;
    }
  }
  const cx = c => G.x0 + (c0 + c + 0.5) * G.res, cz = r => G.z0 + (r0 + r + 0.5) * G.res;
  // inner cells: inside the footprint, clear of the walls, not under a landmark part
  const inner = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++){
    const x = cx(c), z = cz(r);
    if (!pipRings(rings, x, z) || distToRings(rings, x, z) < 0.6 || (skip && skip(x, z))) continue;
    // skip steps (walls between parts of different height): a continuous surface can only ramp across them
    if (r > 0 && c > 0 && r < H - 1 && c < W - 1){
      const gx = (hgt[r * W + c + 1] - hgt[r * W + c - 1]) / (2 * G.res), gz = (hgt[(r + 1) * W + c] - hgt[(r - 1) * W + c]) / (2 * G.res);
      if (gx * gx + gz * gz > opts.steep * opts.steep) continue;
    }
    inner.push(r * W + c);
  }
  if (inner.length < 6) return null;
  const innerMask = new Uint8Array(W * H); for (const i of inner) innerMask[i] = 1;
  const med = median(inner.map(i => hgt[i]));
  if (!(med >= 2.0)) return null;
  const at = (x, z) => { // bilinear over the filtered grid
    const fc = (x - G.x0) / G.res - c0 - 0.5, fr = (z - G.z0) / G.res - r0 - 0.5;
    const ic = Math.max(0, Math.min(W - 2, Math.floor(fc))), ir = Math.max(0, Math.min(H - 2, Math.floor(fr))), u = Math.min(1, Math.max(0, fc - ic)), v = Math.min(1, Math.max(0, fr - ir));
    const i = ir * W + ic; return (hgt[i] * (1 - u) + hgt[i + 1] * u) * (1 - v) + (hgt[i + W] * (1 - u) + hgt[i + W + 1] * u) * v;
  };
  // eave line: sample just inside each wall, keep the points where the height profile bends
  const pts = [], edges = [], ringIdx = [];
  for (const r of rings){
    const n = r.length, start = pts.length, idx = [];
    for (let i = 0; i < n; i++){
      const a = r[i], b = r[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-3) continue;
      let nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (!pipRings(rings, mx + nx * 0.3, mz + nz * 0.3)){ nx = -nx; nz = -nz; }
      const steps = Math.max(1, Math.round(L / STEP)), s = [];
      for (let k = 0; k <= steps; k++){
        const f = k / steps, x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        const e = Math.min(INSET, L * 0.5);
        const fi = Math.min(Math.max(f, e / L), 1 - e / L); // stay off the corners
        s.push([f * L, at(a[0] + (b[0] - a[0]) * fi + nx * INSET, a[1] + (b[1] - a[1]) * fi + nz * INSET), x, z]);
      }
      const keep = dpIdx(s, opts.tol);
      // keep a point at least every 8 m, so a long facade can change colour from house to house
      for (let k = 1, last = 0; k < s.length; k++){ if (keep[k]) last = k; else if (s[k][0] - s[last][0] >= 8){ keep[k] = 1; last = k; } }
      for (let k = 0; k < s.length - 1; k++) if (keep[k]) idx.push([s[k][2], s[k][3], s[k][1]]);
    }
    if (idx.length < 3) continue;
    for (const p of idx) pts.push(p);
    for (let k = 0; k < idx.length; k++) edges.push([start + k, start + (k + 1) % idx.length]);
    ringIdx.push([start, pts.length]);
  }
  if (!ringIdx.length) return null;
  // greedy refinement of the interior
  const area = Math.abs(rings[0].reduce((s, p, i) => { const q = rings[0][(i + 1) % rings[0].length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const maxPts = pts.length + Math.min(400, 4 + Math.round(area / 5));
  let tris = [];
  for (let iter = 0; iter < 40; iter++){
    try { tris = cdt2d(pts.map(p => [p[0], p[1]]), edges, { exterior: false }); } catch (e){ return null; }
    if (pts.length >= maxPts) break;
    // worst cell per triangle
    const best = new Map();
    for (let t = 0; t < tris.length; t++){
      const [A, B, C] = tris[t].map(i => pts[i]);
      const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(d) < 1e-9) continue;
      const tc0 = Math.max(0, Math.floor((Math.min(A[0], B[0], C[0]) - G.x0) / G.res) - c0), tc1 = Math.min(W - 1, Math.ceil((Math.max(A[0], B[0], C[0]) - G.x0) / G.res) - c0);
      const tr0 = Math.max(0, Math.floor((Math.min(A[1], B[1], C[1]) - G.z0) / G.res) - r0), tr1 = Math.min(H - 1, Math.ceil((Math.max(A[1], B[1], C[1]) - G.z0) / G.res) - r0);
      let bi = -1, be = opts.tol;
      for (let r = tr0; r <= tr1; r++) for (let c = tc0; c <= tc1; c++){
        const x = cx(c), z = cz(r);
        const l1 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (z - C[1])) / d, l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (z - C[1])) / d, l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const i = r * W + c; if (!innerMask[i]) continue;
        const e = Math.abs(hgt[i] - (A[2] * l1 + B[2] * l2 + C[2] * l3));
        if (e > be){ be = e; bi = i; }
      }
      if (bi >= 0) best.set(bi, be);
    }
    if (!best.size) break;
    const add = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxPts - pts.length);
    for (const [i] of add){ const r = Math.floor(i / W), c = i % W; pts.push([cx(c), cz(r), hgt[i]]); }
  }
  return { pts, tris, rings: ringIdx, median: med };
}
