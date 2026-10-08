// Turns the raw downloads in tools/raw/ into data/city.json, the compact city the game loads.
// Run from the repo root: node tools/build.mjs [--preview]
// World frame: metres, x = east, z = south, y = up; origin at ORIGIN in UTM 32N (EPSG:25832).
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, 'raw');
const OUT = path.join(HERE, '..', 'data', 'city.json');
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
lms.sort((a,b)=>a.top-b.top);
for (const l of lms) fillPoly([l.r], i=>{ const v=l.shape?l.eave+(l.top-l.eave)*0.5:l.top; if (v>HR[i]) HR[i]=v; });
console.log('landmark parts', lms.length);

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
const roads=polys(load('vejflade').features, null, 0.5, 4);
const grass=polys(load('dp_graes').features, null, 0.5, 6);
const parks=polys(load('park_groent_omr_oversigtskort').features, null, 0.8, 20);
const bridges=polys(load('bro').features, null, 0.2, 4);
console.log('water', water.length, 'roads', roads.length, 'grass', grass.length, 'parks', parks.length, 'bridges', bridges.length);

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
const TR=[]; for (const t of trees) TR.push(dm(t[0]), dm(t[1]), dm(t[2]), dm(t[3]));
const city = { v:1, origin:ORIGIN, bounds:BOUNDS, B, L, water:encList(water), roads:encList(roads), grass:encList(grass), parks:encList(parks), bridges:encList(bridges), trees:TR };
const json = JSON.stringify(city);
fs.writeFileSync(OUT, json);
console.log('wrote', OUT, (json.length/1e6).toFixed(2)+' MB', 'gzip', (zlib.gzipSync(json).length/1e6).toFixed(2)+' MB', 'bounds', BOUNDS);

/* ------------------------------------------------------------ optional preview + course check */
export { HR, RW, RH, RX0, RZ0, llW, BOUNDS, water, bridges, previewImage, writePNG };
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
  for (const b of bridges) fillPoly(b, i=>put(i,[230,120,40]));
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
