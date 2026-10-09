// Turns the raw downloads in tools/raw/ into data/city.json, the compact city the game loads.
// Run from the repo root: node tools/build.mjs [--preview]
// World frame: metres, x = east, z = south, y = up; origin at ORIGIN in UTM 32N (EPSG:25832).
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadNdsm, roofFor, opts as roofOpts } from './roofs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, 'raw');
const OUT = path.join(HERE, '..', 'data', 'city.json');
const ROOFS_OUT = path.join(HERE, '..', 'data', 'roofs.bin.gz');
const FACADES_OUT = path.join(HERE, '..', 'data', 'facades.bin.gz');
const load = n => JSON.parse(fs.readFileSync(path.join(RAW, n + '.json'), 'utf8'));

/* ------------------------------------------------------------ projection */
function utm32(lon, lat){
  const a=6378137, f=1/298.257222101, k0=0.9996, rad=Math.PI/180, e2=f*(2-f), ep2=e2/(1-e2);
  const p=lat*rad, s=Math.sin(p), c=Math.cos(p), t=Math.tan(p);
  const N=a/Math.sqrt(1-e2*s*s), T=t*t, C=ep2*c*c, A=c*(lon-9)*rad;
  const e4=e2*e2, e6=e4*e2;
  const M=a*((1-e2/4-3*e4/64-5*e6/256)*p - (3*e2/8+3*e4/32+45*e6/1024)*Math.sin(2*p) + (15*e4/256+45*e6/1024)*Math.sin(4*p) - (35*e6/3072)*Math.sin(6*p));
  const x=k0*N*(A+(1-T+C)*A**3/6+(5-18*T+T*T+72*C-58*ep2)*A**5/120)+500000;
  const y=k0*(M+N*t*(A*A/2+(5-T+9*C+4*C*C)*A**4/24+(61-58*T+T*T+600*C-330*ep2)*A**6/720));
  return [x,y];
}
const ORIGIN = [725300, 6176300];
const toW = (E,N) => [E-ORIGIN[0], ORIGIN[1]-N];
const llW = (lon,lat) => { const [E,N]=utm32(lon,lat); return toW(E,N); };
{ // sanity check against a kbhkort point that carries both coordinate systems
  const [E,N]=utm32(12.574047,55.695767); const err=Math.hypot(E-724600.242591, N-6178009.862019);
  if (err>0.5) throw new Error('UTM projection off by '+err.toFixed(2)+' m');
}
const c0=llW(12.555,55.662), c1=llW(12.615,55.698), c2=llW(12.555,55.698), c3=llW(12.615,55.662);
const BOUNDS = [Math.ceil(Math.max(c0[0],c2[0])), Math.ceil(Math.max(c1[1],c2[1])), Math.floor(Math.min(c1[0],c3[0])), Math.floor(Math.min(c0[1],c3[1]))];
const inB = (x,z,m=0) => x>=BOUNDS[0]-m && x<=BOUNDS[2]+m && z>=BOUNDS[1]-m && z<=BOUNDS[3]+m;

/* ------------------------------------------------------------ geometry helpers */
function area(r){ let s=0; for (let i=0,n=r.length;i<n;i++){ const a=r[i], b=r[(i+1)%n]; s+=a[0]*b[1]-b[0]*a[1]; } return s/2; }
function perim(r){ let s=0; for (let i=0,n=r.length;i<n;i++){ const a=r[i], b=r[(i+1)%n]; s+=Math.hypot(b[0]-a[0],b[1]-a[1]); } return s; }
function centroid(r){ let x=0,z=0; for (const p of r){ x+=p[0]; z+=p[1]; } return [x/r.length, z/r.length]; }
function segDist(p,a,b){ const dx=b[0]-a[0], dz=b[1]-a[1], l=dx*dx+dz*dz; let t=l?((p[0]-a[0])*dx+(p[1]-a[1])*dz)/l:0; t=Math.max(0,Math.min(1,t)); return Math.hypot(a[0]+dx*t-p[0], a[1]+dz*t-p[1]); }
function dp(pts, tol){
  if (pts.length<3) return pts.slice();
  let md=0, mi=0; const a=pts[0], b=pts[pts.length-1];
  for (let i=1;i<pts.length-1;i++){ const d=segDist(pts[i],a,b); if (d>md){ md=d; mi=i; } }
  if (md<=tol) return [a,b];
  const l=dp(pts.slice(0,mi+1),tol), r=dp(pts.slice(mi),tol); return l.slice(0,-1).concat(r);
}
// Clean a closed ring: drop the closing point and duplicates, simplify, and drop near-collinear points.
function cleanRing(raw, tol){
  let r=[]; for (const p of raw){ const q=[p[0],p[1]]; const l=r[r.length-1]; if (!l || Math.hypot(q[0]-l[0],q[1]-l[1])>0.05) r.push(q); }
  if (r.length>1 && Math.hypot(r[0][0]-r[r.length-1][0], r[0][1]-r[r.length-1][1])<0.05) r.pop();
  if (r.length<3) return null;
  // split the closed ring at its farthest pair so Douglas-Peucker has two anchors
  let far=0, fi=0; for (let i=1;i<r.length;i++){ const d=Math.hypot(r[i][0]-r[0][0], r[i][1]-r[0][1]); if (d>far){ far=d; fi=i; } }
  const A=dp(r.slice(0,fi+1),tol), B=dp(r.slice(fi).concat([r[0]]),tol);
  r=A.slice(0,-1).concat(B.slice(0,-1));
  return r.length>=3 && Math.abs(area(r))>0.5 ? r : null;
}
function segX(a,b,c,d){
  const d1=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]), d2=(b[0]-a[0])*(d[1]-a[1])-(b[1]-a[1])*(d[0]-a[0]);
  const d3=(d[0]-c[0])*(a[1]-c[1])-(d[1]-c[1])*(a[0]-c[0]), d4=(d[0]-c[0])*(b[1]-c[1])-(d[1]-c[1])*(b[0]-c[0]);
  return ((d1>0)!==(d2>0)) && ((d3>0)!==(d4>0));
}
function simple(r){
  const n=r.length;
  for (let i=0;i<n;i++) for (let j=i+2;j<n;j++){ if (i===0 && j===n-1) continue; if (segX(r[i],r[(i+1)%n],r[j],r[(j+1)%n])) return false; }
  return true;
}
// Shared with index.html: offset a positive-area ring inward by d (mitred, miter capped at 2.5d).
function insetRing(r, d){
  const n=r.length, out=[];
  for (let i=0;i<n;i++){
    const p=r[(i+n-1)%n], c=r[i], q=r[(i+1)%n];
    let ax=c[0]-p[0], az=c[1]-p[1], al=Math.hypot(ax,az)||1; ax/=al; az/=al;
    let bx=q[0]-c[0], bz=q[1]-c[1], bl=Math.hypot(bx,bz)||1; bx/=bl; bz/=bl;
    const n1x=-az, n1z=ax, n2x=-bz, n2z=bx;
    let mx=n1x+n2x, mz=n1z+n2z; const ml=Math.hypot(mx,mz);
    if (ml<1e-6){ mx=n1x; mz=n1z; } else { mx/=ml; mz/=ml; }
    const cosh=mx*n1x+mz*n1z, k=Math.min(d/Math.max(cosh,1e-3), d*2.5);
    out.push([c[0]+mx*k, c[1]+mz*k]);
  }
  return out;
}
function insetOk(r, q){
  if (area(q) < area(r)*0.06) return false;
  for (let i=0,n=r.length;i<n;i++){
    const j=(i+1)%n, ox=r[j][0]-r[i][0], oz=r[j][1]-r[i][1], nx=q[j][0]-q[i][0], nz=q[j][1]-q[i][1];
    if (ox*nx+oz*nz <= 0) return false;
  }
  return simple(q);
}

/* ------------------------------------------------------------ height raster (1 m) for checks */
const RX0=BOUNDS[0], RZ0=BOUNDS[1], RW=BOUNDS[2]-BOUNDS[0], RH=BOUNDS[3]-BOUNDS[1];
const HR = new Float32Array(RW*RH);
function fillPoly(rings, fn){
  let z0=Infinity, z1=-Infinity; for (const r of rings) for (const p of r){ z0=Math.min(z0,p[1]); z1=Math.max(z1,p[1]); }
  const iz0=Math.max(0,Math.floor(z0-RZ0)), iz1=Math.min(RH-1,Math.ceil(z1-RZ0));
  const xs=[];
  for (let iz=iz0; iz<=iz1; iz++){
    const zc=RZ0+iz+0.5; xs.length=0;
    for (const r of rings) for (let i=0,n=r.length;i<n;i++){ const a=r[i], b=r[(i+1)%n];
      if ((a[1]<=zc)!==(b[1]<=zc)) xs.push(a[0]+(zc-a[1])/(b[1]-a[1])*(b[0]-a[0])); }
    xs.sort((a,b)=>a-b);
    for (let k=0;k+1<xs.length;k+=2){ const ix0=Math.max(0,Math.round(xs[k]-RX0)), ix1=Math.min(RW-1,Math.round(xs[k+1]-RX0)-1); for (let ix=ix0; ix<=ix1; ix++) fn(iz*RW+ix); }
  }
}
const hrAt = (x,z) => { const ix=Math.floor(x-RX0), iz=Math.floor(z-RZ0); return (ix<0||iz<0||ix>=RW||iz>=RH)?0:HR[iz*RW+ix]; };

/* ------------------------------------------------------------ colours */
const NAMED = { black:0x2a2a2c, white:0xeeeae2, gray:0x8a8a8a, grey:0x8a8a8a, darkgray:0x5a5a5c, darkgrey:0x5a5a5c, slategray:0x5c6674, slategrey:0x5c6674,
  sienna:0xa0522d, maroon:0x7a2a24, red:0xa8402e, yellow:0xe8c66a, brown:0x7a4e30, green:0x5f8a6a, gold:0xd8b04a, sandybrown:0xe0a060, firebrick:0xa8402e,
  beige:0xe6dcc0, orange:0xd8803a, lightgrey:0xc8c8c8, lightgray:0xc8c8c8, silver:0xb8bcc2, tan:0xc8aa80, cream:0xf0e6c8, darkred:0x7a2a24, darkgreen:0x3c5a40 };
function parseColour(s){
  if (!s) return -1; s=s.trim().toLowerCase();
  if (NAMED[s]!==undefined) return NAMED[s];
  const m=/^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s); if (!m) return -1;
  let h=m[1]; if (h.length===3) h=h.split('').map(c=>c+c).join(''); return parseInt(h,16);
}

/* ------------------------------------------------------------ buildings */
const ROOF = { 'Tagpap med lille hældning':0, 'Tegl':1, 'Tagpap med stor hældning':2, 'Fibercement herunder asbest':3, 'Fibercement uden asbest':3,
  'Metal':4, 'Levende tage':5, 'Glas':6, 'Betontagsten':7, 'Stråtag':8, 'Plastmaterialer':3 };
const PITCH = { 1:1.0, 2:0.85, 3:0.6, 4:0.9, 7:0.9, 8:1.1 }; // rise per metre of inset
const WALL = { 'Mursten':1, 'Træ':2, 'Betonelementer':3, 'Metal':4, 'Bindingsværk':5, 'Glas':6, 'Letbetonsten':7, 'Fibercement uden asbest':8, 'Fibercement herunder asbest':8, 'Plastmaterialer':8 };
const ROOF_COPPER = 9, ROOF_UNKNOWN = 10;

const bygning = load('bygning').features;
const blds = [];
for (const f of bygning){
  const P=f.properties;
  for (const poly of f.geometry.coordinates){
    const rings=[];
    for (let k=0;k<poly.length;k++){
      const r=cleanRing(poly[k].map(c=>toW(c[0],c[1])), 0.3); if (!r) { if (k===0) break; else continue; }
      const a=area(r); if ((k===0 && a<0) || (k>0 && a>0)) r.reverse();
      rings.push(r);
    }
    if (!rings.length) continue;
    const outer=rings[0], A=area(outer), [cx,cz]=centroid(outer);
    if (!inB(cx,cz) || A<10) continue;
    const boat = P.bygningstype==='Husbåd';
    let h = P.tagrendehoejde_estimat;
    if (h==null) h = P.antaletager ? P.antaletager*3.1+1.4 : 6;
    h = Math.max(boat?2.2:2.4, Math.min(h, 90)); if (boat) h=Math.min(h,3.6);
    let roof = ROOF[P.tagdaekningsmateriale]; if (roof===undefined) roof=ROOF_UNKNOWN;
    const year = P.opfoerelselsaar || 0;
    let pitched = PITCH[roof]!==undefined;
    if (roof===ROOF_UNKNOWN) pitched = (year ? year<1950 : true) && A<1600 && h<26 && h>3.5;
    let rise=0, d=0;
    if (pitched && rings.length===1 && !boat){
      const width=2*A/perim(outer);
      d=Math.min(5.5, 0.45*width);
      for (let tries=0; tries<4 && d>=1.0; tries++){ if (insetOk(outer, insetRing(outer,d))) break; d*=0.7; if (tries===3) d=0; }
      if (d<1.0) d=0;
      rise = d*(PITCH[roof] ?? 0.9);
    }
    blds.push({ rings, A, cx, cz, h, rise, d, roof, wall: WALL[P.ydervaeggensmateriale]||0, floors: P.antaletager||0, year, boat, colW:-1, colR:-1 });
  }
}
// OSM colour tags, joined by the tagged way's centre point
{
  const grid=new Map(), G=50, key=(x,z)=>Math.floor(x/G)+','+Math.floor(z/G);
  blds.forEach((b,i)=>{ let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity; for (const p of b.rings[0]){ x0=Math.min(x0,p[0]); x1=Math.max(x1,p[0]); z0=Math.min(z0,p[1]); z1=Math.max(z1,p[1]); }
    for (let gx=Math.floor(x0/G); gx<=Math.floor(x1/G); gx++) for (let gz=Math.floor(z0/G); gz<=Math.floor(z1/G); gz++){ const k=gx+','+gz; if (!grid.has(k)) grid.set(k,[]); grid.get(k).push(i); } });
  const inside=(r,x,z)=>{ let c=false; for (let i=0,j=r.length-1;i<r.length;j=i++){ const a=r[i], b=r[j]; if ((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) c=!c; } return c; };
  let n=0;
  for (const e of load('osm_colours').elements){
    if (!e.center) continue; const [x,z]=llW(e.center.lon, e.center.lat);
    for (const i of grid.get(key(x,z))||[]){ const b=blds[i]; if (!inside(b.rings[0],x,z)) continue;
      const t=e.tags; b.colW=parseColour(t['building:colour']); b.colR=parseColour(t['roof:colour']);
      if (t['roof:material']==='copper' && b.colR<0) b.roof=ROOF_COPPER;
      n++; break; }
  }
  console.log('osm colour joins', n);
}
blds.sort((a,b)=>(a.h+a.rise)-(b.h+b.rise));
for (const b of blds){ const top=b.h+b.rise*0.6; fillPoly(b.rings, i=>{ if (top>HR[i]) HR[i]=top; }); }
console.log('buildings', blds.length, 'pitched', blds.filter(b=>b.rise>0).length);

/* ------------------------------------------------------------ landmark parts from OSM */
const lms=[];
for (const e of load('osm_parts').elements){
  if (e.type!=='way' || !e.geometry || e.geometry.length<4) continue;
  const t=e.tags;
  let top=parseFloat(t.height); if (!isFinite(top) && t['building:levels']) top=parseFloat(t['building:levels'])*3.2+2;
  if (!isFinite(top) || top<8) continue;
  const raw=e.geometry.map(g=>llW(g.lon,g.lat)); const r=cleanRing(raw, 0.08); if (!r) continue;
  if (area(r)<0) r.reverse();
  const [cx,cz]=centroid(r); if (!inB(cx,cz)) continue;
  let under=hrAt(cx,cz); for (const p of r) under=Math.max(under, hrAt(p[0]+(cx-p[0])*0.15, p[1]+(cz-p[1])*0.15));
  if (top < under+2.5) continue;
  const minH=parseFloat(t.min_height)||0;
  const shp=t['roof:shape']||'flat';
  let shape = /pyramidal|conical|spire|tented/.test(shp) ? 1 : shp==='dome' ? 2 : shp==='onion' ? 3 : 0;
  let rh=parseFloat(t['roof:height']);
  const rad=Math.sqrt(Math.abs(area(r))/Math.PI);
  if (!isFinite(rh)) rh = shape===1 ? Math.min((top-minH)*0.6, rad*4) : shape>=2 ? rad : 0;
  if (shape===0) rh=0;
  const base=Math.max(minH, under-1), eave=Math.max(base, top-rh);
  let wc=parseColour(t['building:colour']), rc=parseColour(t['roof:colour']);
  if (rc<0 && t['roof:material']==='copper') rc=0x7fae9c;
  lms.push({ r, base, eave, top, shape, wc, rc });
}
// Vor Frelsers Kirke's spire is modelled by hand in index.html (its gold outside staircase); drop the OSM boxes
// stacked up its axis (one is a dark slab 0.4 m over the tower top, which flickered), keeping the tower they stand on
// and its gallery. The axis is the laser scan's highest point there. The church body's OSM parts are flat boxes at
// ridge height with the hipped roof buried inside them, so they go too and the laser-scanned roof takes over.
const HAND_SPIRES = [{ x:688.8, z:781.4, r:9, above:46.2, body:40, colour:0x8a4a38 }];
for (let i=lms.length-1; i>=0; i--){
  const l=lms[i], [cx,cz]=centroid(l.r);
  for (const h of HAND_SPIRES){
    const d=Math.hypot(cx-h.x, cz-h.z);
    if ((d<h.r && Math.max(l.top, l.eave)>h.above) || (d>=h.r && d<h.body)){ lms.splice(i,1); break; }
    if (d<h.r && l.top-l.base>20){ l.wc=h.colour; l.base=0; }  // the tower: red brick, from the street up
  }
}
// the church body is red brick too; the oblique photos see mostly its sandstone trim, so its photo colours are skipped
for (const b of blds) if (HAND_SPIRES.some(h=>Math.hypot(b.cx-h.x, b.cz-h.z)<30 && Math.abs(b.A)>800)){ b.colW=HAND_SPIRES[0].colour; b.noFacade=true; }
// Landmarks modelled by hand in index.html (buildLandmarks), centred on the laser scan's highest point. Their OSM parts
// within `drop` metres go, the laser roofs leave a circle of `skip` metres for them, and the building records under
// them are restyled (wall 97: plain stone, no windows) or hidden (wall 96). The square towers take their turn from the
// largest OSM part they replace.
const HAND = [
  { id:'marble',   x:336.1,  z:-560.6, drop:24,  skip:27.5, body:{ r:34, minA:40, wall:96, colour:0xd2c8b6 } },
  { id:'chborg',   x:-189.0, z:442.8,  drop:12,  skip:9.5 },
  { id:'cityhall', x:-810.6, z:547.5,  drop:6.5, skip:6.5 },
  { id:'rund',     x:-507.7, z:-114.0, drop:9,   skip:8.6, hide:8 },
  { id:'slotskirke', x:-256.6, z:351.6, drop:14, skip:11.5 },
  { id:'holmens',  x:11.6,   z:387.3,  drop:6,   skip:3.2 },
  { id:'kgldome',  x:162.7,  z:81.9,   drop:0,   skip:25 },
];
const hand = {};
for (const h of HAND){
  let ang=0, big=0;
  for (let i=lms.length-1; i>=0; i--){
    const l=lms[i], [cx,cz]=centroid(l.r); if (Math.hypot(cx-h.x, cz-h.z)>=h.drop) continue;
    const A=Math.abs(area(l.r)); if (A>big && l.r.length<=6){ big=A; let bl=0; for (let k=0;k<l.r.length;k++){ const a=l.r[k], b=l.r[(k+1)%l.r.length], L=Math.hypot(b[0]-a[0], b[1]-a[1]); if (L>bl){ bl=L; ang=Math.atan2(b[1]-a[1], b[0]-a[0]); } } }
    lms.splice(i,1);
  }
  hand[h.id]=[h.x, h.z, +ang.toFixed(4)];
  for (const b of blds){
    const d=Math.hypot(b.cx-h.x, b.cz-h.z);
    if (h.hide && d<h.hide){ b.wall=96; b.noFacade=true; }
    else if (h.body && d<h.body.r && Math.abs(b.A)>h.body.minA){ b.wall=h.body.wall; b.colW=h.body.colour; b.noFacade=true; }
  }
}
// Christiansborg's palace is dark grey granite and stone, and the oblique photos are pixelated over parts of it and of
// Slotskirken, so both take a set colour instead of the photo colours. The palace gets its five rows of windows.
{
  const p=blds.find(b=>Math.hypot(b.cx+210.6, b.cz-459.1)<30 && Math.abs(b.A)>8000);
  if (p){
    p.colW=0x403c39; p.noFacade=true; p.floors=5;
    // OSM's parts over the palace are flat blocks up to 39 m standing over the roof: they go, so the laser scan gives
    // the roofs. The window rows keep the gutter height from kbhkort.
    const r=p.rings[0], pip=(x,z)=>{ let c=false; for (let i=0,j=r.length-1;i<r.length;j=i++){ const a=r[i], b=r[j]; if ((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) c=!c; } return c; };
    const onPalace=l=>l.r.filter(q=>pip(q[0],q[1])).length>=l.r.length/2;   // most of its corners on the palace (the
    for (let i=lms.length-1; i>=0; i--){ const [cx,cz]=centroid(lms[i].r); if (onPalace(lms[i]) && Math.hypot(cx+189, cz-442.8)>12) lms.splice(i,1); }   // big one wraps the courtyard)
    p.keepH=true;
    // its steep roofs are drawn in one dark colour: the aerial photo, seen from straight above, smears down their sides
    (hand.roofCol=hand.roofCol||[]).push([+p.cx.toFixed(1), +p.cz.toFixed(1), 0x77757a]);
  }
  for (const b of blds) if (Math.hypot(b.cx+256.2, b.cz-353.2)<6 || Math.hypot(b.cx+222.9, b.cz-371.5)<6){ b.colW=0xdcd3c4; b.noFacade=true; }
}
// Det Kongelige Teater (Gamle Scene, 1874) is pale sandstone; Skuespilhuset (2008) is near-black brick over a glazed
// ground floor, with its stage tower in the same brick; its laser roof and tower are drawn in one grey, as the aerial
// photo smears down the tower's sides.
{
  const kt=blds.find(b=>Math.hypot(b.cx-160.4, b.cz-70.6)<12 && Math.abs(Math.abs(b.A)-3139)<200);
  if (kt){ kt.colW=0xc9b896; kt.noFacade=true; hand.teater=[147.35, 40.9, Math.atan2(-9.8, 25.5)]; }
  const sh=blds.find(b=>b.year===2007 && Math.abs(Math.abs(b.A)-6744)<300 && Math.hypot(b.cx-685, b.cz+33)<40);
  if (sh){ sh.colW=0x3b3330; sh.noFacade=true; (hand.roofCol=hand.roofCol||[]).push([+sh.cx.toFixed(1), +sh.cz.toFixed(1), 0x6a6866]); hand.glass=[sh.rings[0].flat().map(v=>+v.toFixed(1))]; }
}
// Colours from the oblique photos where OSM's parts carry none (they would get a random palette) or the wrong one:
// Rosenborg is red brick under green copper, Amalienborg's palaces pale stone, Holmens Kirke red brick.
{
  const RECOL = [
    { x:-429, z:-600, r:45, wc:0x6e3e30, rc:0x76a07c, map:{ [0xc1d5ca]:0x76a07c, [0xc48a58]:0x6e3e30 } },
    { x:566,  z:-467, r:125, wc:0xd6cdbd },
  ];
  for (const o of RECOL) for (const l of lms){ const [cx,cz]=centroid(l.r); if (Math.hypot(cx-o.x, cz-o.z)>=o.r) continue;
    l.wc = o.map && o.map[l.wc]!==undefined ? o.map[l.wc] : l.wc<0 ? o.wc : l.wc;
    if (o.rc!==undefined) l.rc = o.map && o.map[l.rc]!==undefined ? o.map[l.rc] : l.rc<0 ? o.rc : l.rc; }
  const ros=blds.find(b=>Math.hypot(b.cx+429.1, b.cz+600.5)<6 && b.year===1606);
  if (ros){ ros.colW=0x6e3e30; ros.colR=0x76a07c; ros.noFacade=true; (hand.roofCol=hand.roofCol||[]).push([+ros.cx.toFixed(1), +ros.cz.toFixed(1), 0x82a684]); }
  for (const b of blds) if (b.year>=1750 && b.year<=1760 && b.colW===0xdecbb7 && Math.hypot(b.cx-566, b.cz+467)<125){ b.colW=0xd6cdbd; b.noFacade=true; }
  const hol=blds.find(b=>Math.hypot(b.cx-11.6, b.cz-388.4)<6 && b.year===1619);
  if (hol){ hol.colW=0x985440; hol.noFacade=true; }
}
// Nationalbanken (Arne Jacobsen, 1971): one record covers both the 20 m block and the low walled garden beside it, so
// its walls stopped at the garden wall and the photo was smeared down the glass. It is built by hand from the laser
// scan instead: the block with its two courtyards, and the garden at 3.4 m.
{
  const nb=blds.find(b=>b.year===1971 && Math.abs(Math.abs(b.A)-11409)<300 && Math.hypot(b.cx-145.8, b.cz-363.7)<40);
  if (nb){ nb.wall=96; nb.noFacade=true;
    hand.natbank={ block:[[169.8,284.3],[209.6,426.0],[166.5,438.0],[126.8,296.4]], h:20.3,
      courts:[[[145.1,308.0],[160.7,303.6],[173.4,348.7],[157.8,353.1],7.8], [[164.9,377.4],[180.0,373.3],[187.5,401.6],[172.4,405.6],4.6]],
      low:nb.rings[0].map(p=>[+p[0].toFixed(1), +p[1].toFixed(1)]), lowH:3.4 }; }
}
// Børsen, the 1620s exchange, burnt in April 2024 and stands under a white restoration tent in the 2025 laser scan and
// photos. It is modelled by hand as it stood before the fire, on its footprint from kbhkort: centre, length, width,
// direction of the long side and the gutter height. Its footprint record is hidden.
{
  const b=blds.find(b=>Math.hypot(b.cx-30.5, b.cz-506.1)<6 && Math.abs(Math.abs(b.A)-2720)<150);
  if (b){
    b.wall=96; b.noFacade=true;
    const ang=19.48*Math.PI/180;
    hand.borsen=[43.42, 510.07, +ang.toFixed(4), 130.19, 21.16, +b.h.toFixed(2)];
    // the restoration's site buildings (first registered 2026) go too; the ground under them is drawn plain
    hand.plain=[];
    const cA=Math.cos(ang), sA=Math.sin(ang), onIt=(x,z)=>Math.abs((x-43.42)*cA+(z-510.07)*sA)<68 && Math.abs(-(x-43.42)*sA+(z-510.07)*cA)<13;
    for (const s of blds) if (s!==b && onIt(s.cx, s.cz)){ s.wall=96; s.noFacade=true; }   // small records at its ends
    for (const s of blds) if (s.year===2026 && Math.hypot(s.cx-43.42, s.cz-510.07)<120){ s.wall=96; s.noFacade=true; hand.plain.push(s.rings[0].flat().map(v=>+v.toFixed(1))); }
    const ca=Math.cos(ang), sa=Math.sin(ang);
    for (let i=lms.length-1; i>=0; i--){ const [x,z]=centroid(lms[i].r), u=(x-43.42)*ca+(z-510.07)*sa, v=-(x-43.42)*sa+(z-510.07)*ca;
      if (Math.abs(u)<70 && Math.abs(v)<15) lms.splice(i,1); }
  }
}
lms.sort((a,b)=>a.top-b.top);
for (const l of lms) fillPoly([l.r], i=>{ const v=l.shape?l.eave+(l.top-l.eave)*0.5:l.top; if (v>HR[i]) HR[i]=v; });
console.log('landmark parts', lms.length);

/* ------------------------------------------------------------ real roofs from Danmarks Hoejdemodel */
// Optional: needs tools/raw/dk/ndsm.* from fetch_dk.py + mosaic_dk.py. Without it every roof stays procedural.
const DK = path.join(RAW, 'dk');
let roofs = null;
function triRaster(A, B, C, fn){ // 1 m cells whose centre lies in triangle ABC ([x,z,h]); fn(index, height)
  const d=(B[1]-C[1])*(A[0]-C[0])+(C[0]-B[0])*(A[1]-C[1]); if (Math.abs(d)<1e-9) return;
  const x0=Math.max(0,Math.floor(Math.min(A[0],B[0],C[0])-RX0)), x1=Math.min(RW-1,Math.ceil(Math.max(A[0],B[0],C[0])-RX0));
  const z0=Math.max(0,Math.floor(Math.min(A[1],B[1],C[1])-RZ0)), z1=Math.min(RH-1,Math.ceil(Math.max(A[1],B[1],C[1])-RZ0));
  for (let iz=z0; iz<=z1; iz++) for (let ix=x0; ix<=x1; ix++){
    const x=RX0+ix+0.5, z=RZ0+iz+0.5;
    const l1=((B[1]-C[1])*(x-C[0])+(C[0]-B[0])*(z-C[1]))/d, l2=((C[1]-A[1])*(x-C[0])+(A[0]-C[0])*(z-C[1]))/d, l3=1-l1-l2;
    if (l1>=0 && l2>=0 && l3>=0) fn(iz*RW+ix, A[2]*l1+B[2]*l2+C[2]*l3);
  }
}
if (fs.existsSync(path.join(DK, 'ndsm.json'))){
  roofOpts.tol = 0.8;
  const G = loadNdsm(DK, ORIGIN);
  const LM = new Uint8Array(RW*RH); for (const l of lms) fillPoly([l.r], i=>{ LM[i]=1; });
  for (const h of HAND){ const n=48, c=[]; for (let k=0;k<n;k++){ const a=k/n*Math.PI*2; c.push([h.x+Math.cos(a)*h.skip, h.z+Math.sin(a)*h.skip]); } fillPoly([c], i=>{ LM[i]=1; }); }
  // The Opera's roof is one flat slab that runs some 30 m out over the quay: fit a rectangle to the laser cells at roof
  // height around it, and the fly tower to the cells above that. Its buildings become dark glass under the slab.
  {
    const fit=(lo, hi, cx, cz, R)=>{
      const P=[], H=[];
      for (let z=cz-R; z<cz+R; z+=0.8) for (let x=cx-R; x<cx+R; x+=0.8){
        const c=Math.floor((x-G.x0)/G.res), r=Math.floor((z-G.z0)/G.res); if (c<0||r<0||c>=G.w||r>=G.h) continue;
        const v=G.a[r*G.w+c]/100; if (v>lo && v<hi && Math.hypot(x-cx, z-cz)<R){ P.push([x,z]); H.push(v); }
      }
      const mx=P.reduce((s,p)=>s+p[0],0)/P.length, mz=P.reduce((s,p)=>s+p[1],0)/P.length;
      let sxx=0, sxz=0, szz=0; for (const p of P){ const dx=p[0]-mx, dz=p[1]-mz; sxx+=dx*dx; sxz+=dx*dz; szz+=dz*dz; }
      const ang=0.5*Math.atan2(2*sxz, sxx-szz), ca=Math.cos(ang), sa=Math.sin(ang);
      const us=P.map(p=>(p[0]-mx)*ca+(p[1]-mz)*sa).sort((a,b)=>a-b), vs=P.map(p=>-(p[0]-mx)*sa+(p[1]-mz)*ca).sort((a,b)=>a-b);
      const q=(a,f)=>a[Math.floor(a.length*f)], hs=H.slice().sort((a,b)=>a-b);
      return [+mx.toFixed(2), +mz.toFixed(2), +ang.toFixed(4), +q(us,0.01).toFixed(2), +q(us,0.99).toFixed(2), +q(vs,0.01).toFixed(2), +q(vs,0.99).toFixed(2), +q(hs,0.5).toFixed(2)];
    };
    const roof=fit(20, 45, 1065, -258, 110), fly=fit(36, 45, 1065, -258, 110);
    hand.opera=[roof, fly];
    const ca=Math.cos(roof[2]), sa=Math.sin(roof[2]), inRoof=(x,z)=>{ const u=(x-roof[0])*ca+(z-roof[1])*sa, v=-(x-roof[0])*sa+(z-roof[1])*ca; return u>roof[3] && u<roof[4] && v>roof[5] && v<roof[6]; };
    // Two of the footprints under the slab are the canopy's outline and the plaza under it: hide them, so the roof runs
    // out over open ground. The main building's curved glass front (the part nearer the harbour) is drawn as glass.
    const U=(x,z)=>(x-roof[0])*ca+(z-roof[1])*sa, Vv=(x,z)=>-(x-roof[0])*sa+(z-roof[1])*ca;
    let front=null;
    for (const b of blds) if (inRoof(b.cx, b.cz)){
      b.noFacade=true;
      if (U(b.cx,b.cz)<-20 && Math.abs(b.A)<4000){ b.wall=96; continue; }
      b.wall=98;
      if (Math.abs(b.A)>8000){
        // the front: the run of the outer ring nearer the harbour than u=-15, in order
        const r=b.rings[0], n=r.length, inF=k=>U(r[k][0],r[k][1])<-15 && Math.abs(Vv(r[k][0],r[k][1]))<30;
        let k0=0; while (k0<n && inF(k0)) k0++;
        const pts=[]; for (let j=1;j<=n;j++){ const k=(k0+j)%n; if (inF(k)) pts.push(r[k]); else if (pts.length) break; }
        front=pts.map(p=>[+p[0].toFixed(2), +p[1].toFixed(2)]);
      }
    }
    if (front) hand.opera.push(front.flat());
    for (let i=lms.length-1; i>=0; i--){ const [cx,cz]=centroid(lms[i].r); if (inRoof(cx,cz)) lms.splice(i,1); }
    console.log('opera roof', roof.join(' '), 'fly tower', fly.join(' '));
  }
  const skip = (x,z) => { const ix=Math.floor(x-RX0), iz=Math.floor(z-RZ0); return ix>=0 && iz>=0 && ix<RW && iz<RH && LM[iz*RW+ix]===1; };
  let nt=0, np=0, t0=Date.now();
  roofs = blds.map(b => {
    if (b.boat) return null;
    const r = roofFor(G, b.rings, skip); if (!r) return null;
    if (b.keepH) for (const q of r.pts) q[2]=Math.max(q[2], b.h);   // nothing on the palace sits below its gutters
    // the collision/course raster follows the real roof surface
    let lo=Infinity; for (const [s,e] of r.rings) for (let k=s;k<e;k++) lo=Math.min(lo, r.pts[k][2]);
    fillPoly(b.rings, i=>{ HR[i]=lo; });
    for (const t of r.tris) triRaster(r.pts[t[0]], r.pts[t[1]], r.pts[t[2]], (i,h)=>{ if (h>HR[i]) HR[i]=h; });
    if (!b.keepH) b.h = Math.max(2, lo);
    nt+=r.tris.length; np+=r.pts.length; return r;
  });
  for (const l of lms) fillPoly([l.r], i=>{ const v=l.shape?l.eave+(l.top-l.eave)*0.5:l.top; if (v>HR[i]) HR[i]=v; });
  console.log('laser roofs', roofs.filter(Boolean).length, 'of', blds.length, 'points', np, 'triangles', nt, ((Date.now()-t0)/1000).toFixed(0)+' s');
} else console.log('no height model in tools/raw/dk: roofs stay procedural (see tools/fetch_dk.py)');

/* ------------------------------------------------------------ ground layers */
function polys(features, filter, tol, minA){
  const out=[];
  for (const f of features){
    if (filter && !filter(f.properties)) continue;
    const g=f.geometry; if (!g) continue;
    const list = g.type==='Polygon' ? [g.coordinates] : g.type==='MultiPolygon' ? g.coordinates : [];
    for (const poly of list){
      const rings=[];
      for (let k=0;k<poly.length;k++){ const r=cleanRing(poly[k].map(c=>toW(c[0],c[1])), tol); if (!r){ if (k===0) break; continue; } rings.push(r); }
      if (!rings.length || Math.abs(area(rings[0]))<(minA||0)) continue;
      let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity; for (const p of rings[0]){ x0=Math.min(x0,p[0]); x1=Math.max(x1,p[0]); z0=Math.min(z0,p[1]); z1=Math.max(z1,p[1]); }
      if (x1<BOUNDS[0]-200 || x0>BOUNDS[2]+200 || z1<BOUNDS[1]-200 || z0>BOUNDS[3]+200) continue;
      out.push(rings);
    }
  }
  return out;
}
const vand=load('vand_oversigtskort').features;
const water=polys(vand, null, 0.4, 4);
console.log('water', water.length);

/* ------------------------------------------------------------ bridges you can fly under */
// Outlines from OpenStreetMap (man_made=bridge). The municipal water layer stops at each bridge face, so the water
// under a deck is rebuilt as the convex hull of the water vertices that fall inside the outline, and added to `water`.
// Clearances: about 5.4 m for the harbour bridges; Christianshavn's canal bridges really give about 2.2-2.5 m, which a
// glider cannot thread with quays 2 m above the water, so short spans get a generous 3.4 m.
const SKIP_BRIDGE = new Set(['Dronning Louises Bro', 'Cykelslangen']);
function hull(pts){
  pts=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]); if (pts.length<3) return pts;
  const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]), lo=[], up=[];
  for (const p of pts){ while (lo.length>=2 && cr(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop(); lo.push(p); }
  for (let i=pts.length-1;i>=0;i--){ const p=pts[i]; while (up.length>=2 && cr(up[up.length-2],up[up.length-1],p)<=0) up.pop(); up.push(p); }
  return lo.slice(0,-1).concat(up.slice(0,-1));
}
function pip(r,x,z){ let c=false; for (let i=0,j=r.length-1;i<r.length;j=i++){ const a=r[i], b=r[j]; if ((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) c=!c; } return c; }
function edgeDist(r,x,z){ let d=Infinity; for (let i=0;i<r.length;i++) d=Math.min(d, segDist([x,z], r[i], r[(i+1)%r.length])); return d; }
const WAT=new Uint8Array(RW*RH); for (const w of water) fillPoly(w, i=>{ WAT[i]=1; });
const watAt=(x,z)=>{ const ix=Math.floor(x-RX0), iz=Math.floor(z-RZ0); return ix>=0&&iz>=0&&ix<RW&&iz<RH && WAT[iz*RW+ix]===1; };
// join a multipolygon relation's outer member ways into closed rings
function joinOuter(members){
  const segs=members.filter(m=>m.type==='way' && m.role!=='inner' && m.geometry).map(m=>m.geometry.map(g=>[g.lon,g.lat]));
  const key=p=>p[0].toFixed(7)+','+p[1].toFixed(7), rings=[];
  while (segs.length){
    let cur=segs.shift();
    while (key(cur[0])!==key(cur[cur.length-1])){
      const i=segs.findIndex(sg=>key(sg[0])===key(cur[cur.length-1]) || key(sg[sg.length-1])===key(cur[cur.length-1]));
      if (i<0) break;
      let sg=segs.splice(i,1)[0]; if (key(sg[0])!==key(cur[cur.length-1])) sg=sg.slice().reverse();
      cur=cur.concat(sg.slice(1));
    }
    rings.push(cur.map(([lon,lat])=>({lon,lat})));
  }
  return rings;
}
const osmB = [];
for (const e of load('osm_bridges').elements){
  if (e.type==='way' && e.geometry) osmB.push(e);
  else if (e.type==='relation' && e.members) for (const g of joinOuter(e.members)) osmB.push({ tags:e.tags, geometry:g });
}
const bWays = osmB.filter(e=>e.tags && e.tags.man_made!=='bridge' && (e.tags.highway||e.tags.railway)).map(e=>e.geometry.map(g=>llW(g.lon,g.lat)));
const spans=[];
for (const e of osmB){
  const t=e.tags||{}; if (t.man_made!=='bridge' || SKIP_BRIDGE.has(t.name)) continue;
  const r=cleanRing(e.geometry.map(g=>llW(g.lon,g.lat)), 0.3); if (!r) continue;
  const [cx,cz]=centroid(r); if (!inB(cx,cz,-60)) continue;
  // axis: summed direction of the roads and paths that run across the outline, else the outline's long side
  let ax=0, az=0;
  for (const w of bWays) for (let i=0;i+1<w.length;i++){ const a=w[i], b=w[i+1]; if (!pip(r,(a[0]+b[0])/2,(a[1]+b[1])/2)) continue;
    let dx=b[0]-a[0], dz=b[1]-a[1]; if (dx*ax+dz*az<0){ dx=-dx; dz=-dz; } ax+=dx; az+=dz; }
  if (Math.hypot(ax,az)<3){ let best=0; for (let i=0;i<r.length;i++){ const a=r[i], b=r[(i+1)%r.length], L=Math.hypot(b[0]-a[0],b[1]-a[1]); if (L>best){ best=L; ax=b[0]-a[0]; az=b[1]-a[1]; } } }
  const al=Math.hypot(ax,az); ax/=al; az/=al;
  // water under the deck: hull of water vertices inside (or within 3 m of) the outline
  const pts=[];
  for (const w of water) for (const ring of w) for (const p of ring) if (pip(r,p[0],p[1]) || edgeDist(r,p[0],p[1])<3) pts.push(p);
  const h=pts.length>=3 ? hull(pts) : [];
  const hA=h.length>=3 ? Math.abs(area(h)) : 0;
  // water span along the axis, sampled down the middle of the outline
  const S=p=>(p[0]-cx)*ax+(p[1]-cz)*az, T=p=>-(p[0]-cx)*az+(p[1]-cz)*ax;
  let pa=Infinity, pb=-Infinity, t0=Infinity, t1=-Infinity; for (const p of r){ pa=Math.min(pa,S(p)); pb=Math.max(pb,S(p)); t0=Math.min(t0,T(p)); t1=Math.max(t1,T(p)); }
  const tm=(t0+t1)/2; let wa=Infinity, wb=-Infinity;
  for (let s=pa; s<=pb; s+=0.5){ const x=cx+ax*s-az*tm, z=cz+az*s+ax*tm; if (watAt(x,z) || (hA>0 && pip(h,x,z))){ wa=Math.min(wa,s); wb=Math.max(wb,s); } }
  if (!(wb-wa>=5)) continue;
  if (hA>=20) water.push([h]);
  const span=wb-wa, big=span>55;
  const clear=big?5.4:3.4, thick=big?1.4:0.8, piers=[];
  if (big){ const n=Math.ceil(span/40); for (let k=1;k<n;k++) piers.push(wa+span*k/n); }
  spans.push({ name:t.name||'', c:[cx,cz], u:[ax,az], pa, pb, wa, wb, clear, thick, piers, r });
}
console.log('bridges', spans.length, spans.filter(s=>s.name).map(s=>s.name+' '+(s.wb-s.wa).toFixed(0)+'m').join(', '));
for (const b of spans) fillPoly([b.r], i=>{ const v=b.clear+b.thick; if (v>HR[i]) HR[i]=v; });

/* ------------------------------------------------------------ street lamps hung on wires */
// Copenhagen's streets are lit by lamps slung on wires between facing buildings. Along each OSM street, every 32 m,
// look left and right through the height raster for the building walls; where both stand within reach, hang a lamp
// over the middle at about 7 m with its wire to each wall.
const lamps=[];
if (fs.existsSync(path.join(RAW, 'osm_streets.json'))){
  const wallAt=(x,z,dx,dz)=>{ for (let d=1.5; d<=15; d+=0.5){ const h=hrAt(x+dx*d, z+dz*d); if (h>5) return [d, h]; } return null; };
  for (const e of load('osm_streets').elements){
    const t=e.tags||{}; if (t.bridge || t.tunnel || !e.geometry) continue;
    const pts=e.geometry.map(g=>llW(g.lon,g.lat));
    let carry=12;
    for (let i=0;i+1<pts.length;i++){
      const a=pts[i], b=pts[i+1], L=Math.hypot(b[0]-a[0], b[1]-a[1]); if (L<0.5) continue;
      const ux=(b[0]-a[0])/L, uz=(b[1]-a[1])/L, px=-uz, pz=ux;
      for (let d=carry; d<L; d+=32){
        const x=a[0]+ux*d, z=a[1]+uz*d; if (!inB(x,z,-50) || hrAt(x,z)>1) continue;
        const l=wallAt(x,z,px,pz), r=wallAt(x,z,-px,-pz); if (!l || !r || l[0]+r[0]<6 || l[0]+r[0]>26) continue;
        const ax=x+px*(l[0]-0.3), az=z+pz*(l[0]-0.3), bx=x-px*(r[0]-0.3), bz=z-pz*(r[0]-0.3);
        const cx=(ax+bx)/2, cz=(az+bz)/2, y=Math.max(5.5, Math.min(7.5, 0.7*Math.min(l[1], r[1])));
        if (lamps.some(q=>Math.hypot(q[0]-cx, q[1]-cz)<14)) continue;
        lamps.push([cx, cz, y, ax, az, bx, bz]);
      }
      carry = ((carry - L) % 32 + 32) % 32;
    }
  }
}
console.log('street lamps', lamps.length);

/* ------------------------------------------------------------ street detail */
// Kerbs and masts from GeoDanmark (tools/fetch_geodk.py), squares, parking and bicycle parking from OpenStreetMap.
// Street centrelines, binned on a 20 m grid, tell each kerb which side the road is on and what kind of street it lines.
const hash=n=>{ n=Math.sin(n*127.1+311.7)*43758.5453; return n-Math.floor(n); };
const SG=new Map(), SGC=20, sgKey=(x,z)=>Math.floor(x/SGC)+','+Math.floor(z/SGC);
if (fs.existsSync(path.join(RAW, 'osm_streets.json'))) load('osm_streets').elements.forEach((e, id) => {
  if (!e.geometry) return; const hw=(e.tags||{}).highway, pts=e.geometry.map(g=>llW(g.lon,g.lat));
  for (let i=0;i+1<pts.length;i++){ const a=pts[i], b=pts[i+1], s={ a, b, hw, id };
    const x0=Math.min(a[0],b[0])-SGC, x1=Math.max(a[0],b[0])+SGC, z0=Math.min(a[1],b[1])-SGC, z1=Math.max(a[1],b[1])+SGC;
    for (let gx=Math.floor(x0/SGC); gx<=Math.floor(x1/SGC); gx++) for (let gz=Math.floor(z0/SGC); gz<=Math.floor(z1/SGC); gz++){ const k=gx+','+gz; if (!SG.has(k)) SG.set(k,[]); SG.get(k).push(s); } }
});
// nearest centreline to (x,z): { d, s, px, pz } or null
function nearStreet(x, z, maxD, skipId){
  let best=null;
  for (const s of SG.get(sgKey(x,z))||[]){
    if (s.id===skipId) continue;
    const dx=s.b[0]-s.a[0], dz=s.b[1]-s.a[1], l=dx*dx+dz*dz; let t=l?((x-s.a[0])*dx+(z-s.a[1])*dz)/l:0; t=Math.max(0,Math.min(1,t));
    const px=s.a[0]+dx*t, pz=s.a[1]+dz*t, d=Math.hypot(px-x, pz-z);
    if (d<maxD && (!best || d<best.d)) best={ d, s, px, pz };
  }
  return best;
}
const kerbs=[], masts=[], cars=[], bikes=[], paved=[];
const freeAt=(x,z)=>hrAt(x,z)<1 && !watAt(x,z);
const carGrid=new Set(), carKey=(x,z)=>Math.round(x/3)+','+Math.round(z/3);
function addCar(x, z, a){
  const k=carKey(x,z); if (carGrid.has(k) || !freeAt(x,z) || !inB(x,z,-20)) return;
  // keep the whole car on the street
  const ca=Math.cos(a), sa=Math.sin(a); if (!freeAt(x+ca*2.1, z+sa*2.1) || !freeAt(x-ca*2.1, z-sa*2.1)) return;
  for (let dx=-1;dx<=1;dx++) for (let dz=-1;dz<=1;dz++) carGrid.add((Math.round(x/3)+dx)+','+(Math.round(z/3)+dz));
  cars.push([x, z, a]);
}
const PARK_ON = new Set(['residential','tertiary','unclassified','secondary']);
if (fs.existsSync(path.join(DK, 'kerbs.json'))){
  for (const raw of JSON.parse(fs.readFileSync(path.join(DK, 'kerbs.json'), 'utf8'))){
    // split where the line runs into a building or the water
    let run=[];
    const flush=()=>{ if (run.length>1) kerbs.push(run); run=[]; };
    for (let i=0;i<raw.length;i++){
      const p=raw[i]; if (!inB(p[0],p[1],-5)){ flush(); continue; }
      if (run.length){ const q=run[run.length-1], mx=(p[0]+q[0])/2, mz=(p[1]+q[1])/2; if (!freeAt(mx,mz)){ flush(); } }
      run.push(p);
    }
    flush();
  }
  // road on the right of the direction of travel: the normal (dz, -dx) points into the street
  for (const l of kerbs){
    let side=0;
    for (let i=0;i+1<l.length;i++){
      const a=l[i], b=l[i+1], L=Math.hypot(b[0]-a[0], b[1]-a[1]); if (L<0.1) continue;
      const mx=(a[0]+b[0])/2, mz=(a[1]+b[1])/2, ns=nearStreet(mx, mz, 25); if (!ns) continue;
      side += Math.sign(((b[1]-a[1])*(ns.px-mx) - (b[0]-a[0])*(ns.pz-mz))) * L;
    }
    if (side<0) l.reverse();
  }
  // parallel parking along kerbs of ordinary streets wide enough for it, clear of junctions
  for (const l of kerbs){
    let carry=2+hash(l[0][0]*0.37+l[0][1]*0.11)*4;
    for (let i=0;i+1<l.length;i++){
      const a=l[i], b=l[i+1], L=Math.hypot(b[0]-a[0], b[1]-a[1]); if (L<0.5){ continue; }
      const ux=(b[0]-a[0])/L, uz=(b[1]-a[1])/L, nx=uz, nz=-ux;
      let d=carry;
      for (; d<L; d+=5.7){
        const x=a[0]+ux*d+nx*1.15, z=a[1]+uz*d+nz*1.15;
        if (hash(x*1.7+z*0.3)<0.3) continue;
        const ns=nearStreet(x, z, 14); if (!ns || !PARK_ON.has(ns.s.hw) || ns.d<3.0) continue;
        if (nearStreet(x, z, 9, ns.s.id)) continue;  // a junction
        addCar(x, z, Math.atan2(uz, ux));
      }
      carry=d-L;
    }
  }
  for (const m of JSON.parse(fs.readFileSync(path.join(DK, 'masts.json'), 'utf8'))){
    if (!inB(m[0],m[1],-5) || !freeAt(m[0],m[1])) continue;
    if (masts.some(q=>Math.abs(q[0]-m[0])<1.2 && Math.abs(q[1]-m[1])<1.2)) continue;
    masts.push(m);
  }
}
// bicycles: the nearest kerb (or the parking way itself) sets the row's direction; each bike stands across the row
function kerbDir(x, z){
  let best=6, ang=null;
  for (const l of kerbsNear(x, z)) for (let i=0;i+1<l.length;i++){ const d=segDist([x,z], l[i], l[i+1]); if (d<best){ best=d; ang=Math.atan2(l[i+1][1]-l[i][1], l[i+1][0]-l[i][0]); } }
  return ang;
}
const KG=new Map(); for (const l of kerbs){ const seen=new Set(); for (const p of l){ const k=sgKey(p[0],p[1]); if (seen.has(k)) continue; seen.add(k); if (!KG.has(k)) KG.set(k,[]); KG.get(k).push(l); } }
const kerbsNear=(x,z)=>{ const out=new Set(); for (let dx=-1;dx<=1;dx++) for (let dz=-1;dz<=1;dz++) for (const l of KG.get((Math.floor(x/SGC)+dx)+','+(Math.floor(z/SGC)+dz))||[]) out.add(l); return out; };
if (fs.existsSync(path.join(RAW, 'osm_areas.json'))){
  const ringsOf=e=>e.type==='way' && e.geometry ? [e.geometry] : e.type==='relation' && e.members ? joinOuter(e.members) : [];
  for (const e of load('osm_areas').elements){
    const t=e.tags||{};
    if (t.place==='square' || (t.highway==='pedestrian' && (t.area==='yes' || e.type==='relation')) || t['area:highway']==='pedestrian' || t['area:highway']==='footway'){
      for (const g of ringsOf(e)){ const r=cleanRing(g.map(q=>llW(q.lon,q.lat)), 0.3); if (r && Math.abs(area(r))>30) paved.push([r]); }
    } else if (t.amenity==='parking' && !/underground|multi-storey|rooftop/.test(t.parking||'')){
      for (const g of ringsOf(e)){
        const r=g.map(q=>llW(q.lon,q.lat)); if (r.length<4) continue;
        // the polygon's own frame: its longest edge
        let ang=0, bl=0; for (let i=0;i+1<r.length;i++){ const L=Math.hypot(r[i+1][0]-r[i][0], r[i+1][1]-r[i][1]); if (L>bl){ bl=L; ang=Math.atan2(r[i+1][1]-r[i][1], r[i+1][0]-r[i][0]); } }
        const ca=Math.cos(ang), sa=Math.sin(ang); let u0=Infinity,u1=-Infinity,v0=Infinity,v1=-Infinity;
        for (const p of r){ const u=p[0]*ca+p[1]*sa, v=-p[0]*sa+p[1]*ca; u0=Math.min(u0,u); u1=Math.max(u1,u); v0=Math.min(v0,v); v1=Math.max(v1,v); }
        const W=v1-v0, inside=(x,z)=>{ let c=false; for (let i=0,j=r.length-1;i<r.length;j=i++){ const a=r[i], b=r[j]; if ((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) c=!c; } return c; };
        const at=(u,v)=>[u*ca-v*sa, u*sa+v*ca];
        if (W<4.2){ for (let u=u0+3; u<u1-2.5; u+=5.7){ const [x,z]=at(u,(v0+v1)/2); if (inside(x,z) && hash(x*0.9+z*1.3)>0.2) addCar(x,z,ang); } }
        else for (let v=v0+2.6; v<v1-2.4; v+=5.2) for (let u=u0+1.4; u<u1-1.2; u+=2.6){ const [x,z]=at(u,v); if (inside(x,z) && hash(x*0.9+z*1.3)>0.25) addCar(x,z,ang+Math.PI/2); }
      }
    } else if (t.amenity==='bicycle_parking'){
      const cap=Math.min(24, Math.max(4, parseInt(t.capacity)||8)), n=Math.ceil(cap*0.6);
      let line=null;
      if (e.type==='node') line=[[e.lon, e.lat]].map(([lon,lat])=>llW(lon,lat));
      else { const g=ringsOf(e)[0]; if (g) line=g.map(q=>llW(q.lon,q.lat)); }
      if (!line) continue;
      if (line.length===1){
        const [x,z]=line[0]; const a=kerbDir(x,z) ?? hash(x+z)*Math.PI;
        for (let k=0;k<n;k++){ const o=(k-(n-1)/2)*0.65, bx=x+Math.cos(a)*o, bz=z+Math.sin(a)*o; if (freeAt(bx,bz)) bikes.push([bx, bz, a+Math.PI/2+(hash(k+x)-0.5)*0.25]); }
      } else {
        // along the mapped stand or around the area's longest side
        let best=0, A=null, Bp=null; for (let i=0;i+1<line.length;i++){ const L=Math.hypot(line[i+1][0]-line[i][0], line[i+1][1]-line[i][1]); if (L>best){ best=L; A=line[i]; Bp=line[i+1]; } }
        if (!A) continue; const a=Math.atan2(Bp[1]-A[1], Bp[0]-A[0]), m=Math.min(n, Math.floor(best/0.65));
        for (let k=0;k<m;k++){ const f=(k+0.5)/m, bx=A[0]+(Bp[0]-A[0])*f, bz=A[1]+(Bp[1]-A[1])*f; if (freeAt(bx,bz)) bikes.push([bx, bz, a+Math.PI/2+(hash(k+bx)-0.5)*0.25]); }
      }
    }
  }
}
// Nyhavn's café tables: in front of the old houses on the sunny north quay (and a few on the south quay), umbrellas
// over tables in the band between the facades and the walkway along the canal. The canal axis is the one
// index.html's boats use; the quay edges and facades are found in the rasters.
const cafes=[];
{
  const A=[226,-87], ux=0.9117, uz=0.411, nx=-uz, nz=ux;
  for (let t=70; t<392; t+=4.6){
    for (const side of [-1, 1]){
      if (side>0 && (t<120 || t>260)) continue;   // the south side has only a few
      const edge = side<0 ? -3-(t-60)*0.0347 : 24.5-(t-60)*0.0361;
      let o=edge, fac=null; for (let k=0;k<30;k+=0.5){ o=edge+side*k; const x=A[0]+ux*t+nx*o, z=A[1]+uz*t+nz*o; if (hrAt(x,z)>3){ fac=k; break; } }
      if (fac===null || fac<7 || fac>22) continue;
      if (hash(t*0.37+side)<0.18) continue;          // a gap between restaurants
      const d=edge+side*(fac-3.4), x=A[0]+ux*t+nx*d, z=A[1]+uz*t+nz*d;
      if (!freeAt(x,z)) continue;
      cafes.push([x, z, Math.atan2(uz, ux), Math.floor(hash(Math.floor(t/14)*3.1+side)*4)]);
    }
  }
}
// The harbour bus route: rough points down the inner harbour, each pulled to the middle of the channel near it
// (the point within 70 m farthest from any quay), so the boats keep clear of the edges.
const ferry=[];
{
  const shore=(x,z)=>{ let d=90; for (let k=0;k<24;k++){ const a=k/24*Math.PI*2, dx=Math.cos(a), dz=Math.sin(a); for (let r=2;r<d;r+=2) if (!watAt(x+dx*r, z+dz*r)){ d=r; break; } } return d; };
  for (const [x0,z0] of [[-100,980],[60,780],[200,600],[380,420],[540,240],[690,60],[740,-200],[780,-580]]){
    let best=[x0,z0], bd=-1;
    for (let dz=-70; dz<=70; dz+=5) for (let dx=-70; dx<=70; dx+=5){ const x=x0+dx, z=z0+dz; if (!watAt(x,z) || Math.hypot(dx,dz)>70) continue; const d=shore(x,z)-Math.hypot(dx,dz)*0.15; if (d>bd){ bd=d; best=[x,z]; } }
    ferry.push(best);
  }
  console.log('harbour bus route', ferry.map(p=>p.join(',')).join('  '));
}
console.log('cafes', cafes.length, 'kerb lines', kerbs.length, 'masts', masts.length, 'parked cars', cars.length, 'bikes', bikes.length, 'paved areas', paved.length);

const trees=[];
for (const f of load('automatisk_detekterede_traeer_kk_beta').features){
  const [x,z]=toW(f.geometry.coordinates[0], f.geometry.coordinates[1]); const P=f.properties;
  if (!inB(x,z) || !(P.traehoejde>=3.5)) continue;
  const r=Math.sqrt(Math.max(P.kroneareal||8, 4)/Math.PI);
  trees.push([x,z,Math.min(P.traehoejde,32),Math.min(r,11)]);
}
console.log('trees', trees.length);

/* ------------------------------------------------------------ encode */
const dm = v => Math.round(v*10);
function encRings(out, rings){ out.push(rings.length); for (const r of rings){ out.push(r.length); let px=0, pz=0; r.forEach((p,i)=>{ const x=dm(p[0]), z=dm(p[1]); out.push(i?x-px:x, i?z-pz:z); px=x; pz=z; }); } }
const B=[]; for (const b of blds){ B.push(dm(b.h), dm(b.rise), dm(b.d), b.wall, b.roof, b.floors, b.year, b.colW, b.colR, b.boat?1:0); encRings(B, b.rings); }
const L=[]; for (const l of lms){ L.push(dm(l.base), dm(l.eave), dm(l.top), l.shape, l.wc, l.rc); encRings(L, [l.r]); }
const encList = list => { const o=[list.length]; for (const rings of list) encRings(o, rings); return o; };
const SP=[spans.length]; for (const b of spans){ SP.push(dm(b.c[0]), dm(b.c[1]), Math.round(b.u[0]*1e4), Math.round(b.u[1]*1e4), dm(b.pa), dm(b.pb), dm(b.wa), dm(b.wb), dm(b.clear), dm(b.thick), b.piers.length, ...b.piers.map(dm)); encRings(SP, [b.r]); }
const LP=[lamps.length]; for (const l of lamps) LP.push(...l.map(dm));
const TR=[]; for (const t of trees) TR.push(dm(t[0]), dm(t[1]), dm(t[2]), dm(t[3]));
// chimneys found in the laser scan (tools/roofs.mjs): x, z, base, top, width, depth in decimetres, angle in milliradians
const CH=[]; if (roofs) roofs.forEach((r,i) => { if (r && blds[i].wall!==96) for (const c of r.chims) if (!HAND.some(h=>Math.hypot(c[0]-h.x, c[1]-h.z)<h.skip)) CH.push(dm(c[0]), dm(c[1]), dm(c[2]), dm(c[3]), dm(c[4]), dm(c[5]), Math.round(c[6]*1000)); });
console.log('chimneys', CH.length/7);
const city = { v:1, origin:ORIGIN, bounds:BOUNDS, B, L, water:encList(water), spans:SP, lamps:LP, trees:TR, chim:CH, hand,
  kerb:encList(kerbs.map(l=>[l])), mast:masts.flat().map(dm), paved:encList(paved),
  cars:cars.flatMap(c=>[dm(c[0]), dm(c[1]), Math.round(c[2]*1000)]), bikes:bikes.flatMap(c=>[dm(c[0]), dm(c[1]), Math.round(c[2]*1000)]),
  ferry:ferry.flat().map(dm),
  cafes:cafes.flatMap(c=>[dm(c[0]), dm(c[1]), Math.round(c[2]*1000), c[3]]) };
const json = JSON.stringify(city);
fs.writeFileSync(OUT, json);

// Walls for tools/facades_dk.py: per building, each ring as [x, z, top] points in the order the game draws them
// (laser outline points, or the footprint at gutter height). Segment k runs from point k to point k+1.
const wallRings = blds.map((b, i) => {
  if (b.boat) return null;
  const r = roofs && roofs[i];
  if (r) return r.rings.map(([s0, e]) => r.pts.slice(s0, e).map(p => [+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)]));
  return b.rings.map(ring => ring.map(p => [+p[0].toFixed(2), +p[1].toFixed(2), +b.h.toFixed(2)]));
});
fs.writeFileSync(path.join(RAW, 'walls.json'), JSON.stringify(wallRings));
// Real facade colours from the oblique photos, when facades_dk.py has run: data/facades.bin.gz is one uint16
// stream in city.B order. Per building: the segment count (0 = none), then one RGB565 colour per segment,
// 0 where no photo saw that wall.
const FC = path.join(RAW, 'facades.json');
if (fs.existsSync(FC)){
  const cols = JSON.parse(fs.readFileSync(FC, 'utf8'));
  if (cols.length !== wallRings.length) console.log('facades.json is stale (', cols.length, 'vs', wallRings.length, 'buildings): rerun tools/facades_dk.py');
  else {
    const F = [wallRings.length & 0xffff, wallRings.length >> 16]; let n = 0, seen = 0;
    wallRings.forEach((w, i) => {
      const c = cols[i];
      // a building whose outline changed since facades_dk.py ran keeps its procedural colour
      if (!w || !c || blds[i].noFacade || c.length !== w.length || c.some((r, k) => r.length !== w[k].length)){ F.push(0); return; }
      const segs = c.flat(); F.push(segs.length);
      for (const rgb of segs){ n++; if (!rgb){ F.push(0); continue; } seen++; F.push(Math.max(1, ((rgb[0] >> 3) << 11) | ((rgb[1] >> 2) << 5) | (rgb[2] >> 3))); }
    });
    const buf = zlib.gzipSync(Buffer.from(Uint16Array.from(F).buffer), { level: 9 });
    fs.writeFileSync(FACADES_OUT, buf);
    console.log('wrote', FACADES_OUT, seen, 'of', n, 'wall segments coloured,', (buf.length/1e3).toFixed(0)+' KB');
  }
}
if (roofs){
  // data/roofs.bin.gz: one int16 stream, buildings in city.B order.
  // per building: npts (0 = procedural roof); then nrings, the boundary point count of each ring, ntris,
  // points as x, z, height in decimetres (x and z as deltas from the previous point; outline points first, ring by
  // ring), and triangle indices.
  const R=[blds.length & 0x7fff, blds.length >> 15];
  for (const r of roofs){
    if (!r){ R.push(0); continue; }
    R.push(r.pts.length, r.rings.length, ...r.rings.map(([s,e])=>e-s), r.tris.length);
    let px=0, pz=0; for (const p of r.pts){ const x=dm(p[0]), z=dm(p[1]); R.push(x-px, z-pz, dm(p[2])); px=x; pz=z; }
    for (const t of r.tris) R.push(t[0], t[1], t[2]);
  }
  const buf = zlib.gzipSync(Buffer.from(Int16Array.from(R).buffer), { level: 9 });
  fs.writeFileSync(ROOFS_OUT, buf);
  console.log('wrote', ROOFS_OUT, (R.length*2/1e6).toFixed(1)+' MB raw', (buf.length/1e6).toFixed(2)+' MB gzip');
}
console.log('wrote', OUT, (json.length/1e6).toFixed(2)+' MB', 'gzip', (zlib.gzipSync(json).length/1e6).toFixed(2)+' MB', 'bounds', BOUNDS);

/* ------------------------------------------------------------ optional preview + course check */
export { HR, RW, RH, RX0, RZ0, llW, BOUNDS, ORIGIN, water, spans, blds, lms, previewImage, writePNG };
if (process.argv.includes('--preview')){ const { W, H, img } = previewImage(2); writePNG(path.join(HERE,'raw','preview.png'), W, H, img); console.log('preview', W, H); }
function previewImage(S, crop){
  crop = crop || [0,0,RW,RH];
  const W=Math.floor(crop[2]/S), H=Math.floor(crop[3]/S), img=new Uint8Array(W*H*3);
  const wat=new Uint8Array(RW*RH); for (const w of water) fillPoly(w, i=>{ wat[i]=1; });
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    const i=Math.floor(crop[1]+y*S)*RW+Math.floor(crop[0]+x*S), h=HR[i], o=(y*W+x)*3;
    let c = wat[i] ? [40,80,120] : [210,205,195];
    if (h>0){ const v=Math.max(40, 200-h*4); c=[v,v*0.92,v*0.85]; }
    img[o]=c[0]; img[o+1]=c[1]; img[o+2]=c[2];
  }
  for (const t of trees){ const x=Math.floor((t[0]-RX0-crop[0])/S), y=Math.floor((t[1]-RZ0-crop[1])/S); if (x>=0&&y>=0&&x<W&&y<H){ const o=(y*W+x)*3; img[o]=60; img[o+1]=140; img[o+2]=60; } }
  const put=(i,c)=>{ const x=Math.floor((i%RW-crop[0])/S), y=Math.floor((Math.floor(i/RW)-crop[1])/S); if (x<0||y<0||x>=W||y>=H) return; const o=(y*W+x)*3; img[o]=c[0]; img[o+1]=c[1]; img[o+2]=c[2]; };
  if (!process.env.NOSPAN) for (const b of spans) fillPoly([b.r], i=>put(i,[230,120,40]));
  for (const l of lms) fillPoly([l.r], i=>put(i,[220,30,30]));
  return { W, H, img };
}
function writePNG(file, w, h, rgb){
  const crcT=new Int32Array(256).map((_,n)=>{ let c=n; for (let k=0;k<8;k++) c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; return c; });
  const crc=b=>{ let c=-1; for (const x of b) c=crcT[(c^x)&255]^(c>>>8); return (c^-1)>>>0; };
  const chunk=(t,d)=>{ const l=Buffer.alloc(4); l.writeUInt32BE(d.length); const td=Buffer.concat([Buffer.from(t),d]); const c=Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l,td,c]); };
  const raw=Buffer.alloc((w*3+1)*h); for (let y=0;y<h;y++){ raw[y*(w*3+1)]=0; Buffer.from(rgb.buffer, y*w*3, w*3).copy(raw, y*(w*3+1)+1); }
  const ih=Buffer.alloc(13); ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ih), chunk('IDAT',zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]));
}
