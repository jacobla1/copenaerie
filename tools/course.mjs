// Checks the race course against the building height raster and draws it on the preview.
// Run after build.mjs: node tools/course.mjs
import fs from 'fs';
import { HR, RW, RH, RX0, RZ0, llW } from './build.mjs';
import { COURSE } from './course-points.mjs';
const pts = COURSE.map(([x,z,y,name]) => ({x,y,z,name}));
// centripetal Catmull-Rom, closed
function cr(p0,p1,p2,p3,t){
  const d=(a,b)=>Math.pow(Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z),0.5)||1e-3;
  const t0=0,t1=t0+d(p0,p1),t2=t1+d(p1,p2),t3=t2+d(p2,p3); const u=t1+(t2-t1)*t;
  const L=(a,b,ta,tb)=>{ const k=(u-ta)/(tb-ta); return {x:a.x+(b.x-a.x)*k,y:a.y+(b.y-a.y)*k,z:a.z+(b.z-a.z)*k}; };
  const A1=L(p0,p1,t0,t1),A2=L(p1,p2,t1,t2),A3=L(p2,p3,t2,t3),B1=L(A1,A2,t0,t2),B2=L(A2,A3,t1,t3); return L(B1,B2,t1,t2);
}
const n=pts.length, samp=[];
for (let i=0;i<n;i++) for (let k=0;k<200;k++) samp.push({...cr(pts[(i+n-1)%n],pts[i],pts[(i+1)%n],pts[(i+2)%n],k/200), seg:i});
let len=0; for (let i=1;i<samp.length;i++) len+=Math.hypot(samp[i].x-samp[i-1].x,samp[i].z-samp[i-1].z);
const hAt=(x,z)=>{ const ix=Math.floor(x-RX0), iz=Math.floor(z-RZ0); return (ix<0||iz<0||ix>=RW||iz>=RH)?0:HR[iz*RW+ix]; };
const GROUND=2;
let worst={};
for (const s of samp){
  let h=0; for (let a=0;a<8;a++) for (const r of [0,2,4]) h=Math.max(h,hAt(s.x+Math.cos(a*0.785)*r, s.z+Math.sin(a*0.785)*r));
  const clr = s.y - (h>0 ? h+GROUND : 0);
  if (!worst[s.seg] || clr<worst[s.seg].clr) worst[s.seg]={clr, x:s.x|0, z:s.z|0};
}
// minimal horizontal turn radius per segment
const rad={};
for (let i=2;i<samp.length-2;i++){ const a=samp[i-2],b=samp[i],c=samp[i+2];
  const ab=Math.hypot(b.x-a.x,b.z-a.z), bc=Math.hypot(c.x-b.x,c.z-b.z), ca=Math.hypot(a.x-c.x,a.z-c.z);
  const cross=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x)); const R=cross>1e-6? ab*bc*ca/(2*cross):1e9;
  if (!rad[b.seg]||R<rad[b.seg]) rad[b.seg]=R; }
console.log('lap length', len.toFixed(0), 'm');
pts.forEach((p,i)=>console.log(String(i+1).padStart(2), p.name.padEnd(22), 'y', String(p.y).padStart(3), 'clear->next', worst[i].clr.toFixed(1).padStart(6), 'minR', rad[i]?.toFixed(0), '@', worst[i].x, worst[i].z));
console.log(JSON.stringify(pts.map(p=>[Math.round(p.x*10)/10, p.y, Math.round(p.z*10)/10])));

// draw: whole map at 2 m/px plus a 1 m/px crop of the harbour core
import { previewImage, writePNG } from './build.mjs';
function draw(file, S, crop){
  const { W, H, img } = previewImage(S, crop);
  const dot=(x,z,r,c)=>{ const px=(x-RX0-crop[0])/S, pz=(z-RZ0-crop[1])/S; for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++){ const X=Math.round(px+dx), Y=Math.round(pz+dy); if (X<0||Y<0||X>=W||Y>=H||dx*dx+dy*dy>r*r) continue; const o=(Y*W+X)*3; img[o]=c[0]; img[o+1]=c[1]; img[o+2]=c[2]; } };
  for (const s of samp){ let h=0; for (let a=0;a<8;a++) for (const r of [0,2,4]) h=Math.max(h,hAt(s.x+Math.cos(a*0.785)*r, s.z+Math.sin(a*0.785)*r)); dot(s.x,s.z,1, s.y-(h>0?h+GROUND:0) < 3 ? [255,0,255] : [255,210,0]); }
  for (let Y=0;Y<H;Y++) for (let X=0;X<W;X++){ const wx=RX0+crop[0]+X*S, wz=RZ0+crop[1]+Y*S; const gx=((wx%100)+100)%100, gz=((wz%100)+100)%100;
    if (gx<S || gz<S){ const o=(Y*W+X)*3; const big=(((wx%500)+500)%500<S)||(((wz%500)+500)%500<S); const k=big?0.35:0.75; img[o]*=k; img[o+1]*=k; img[o+2]*=k; } }
  pts.forEach((p,i)=>{ dot(p.x,p.z,5,[0,0,0]); for (let b=0;b<5;b++) if ((i+1)>>b&1) dot(p.x+8+b*5,p.z-8,2,[255,255,255]); });
  writePNG(file, W, H, img);
}
draw('tools/raw/course.png', 2, [0,0,RW,RH]);
const core=(x0,z0,x1,z1,f,S)=>draw(f,S||1,[x0-RX0,z0-RZ0,x1-x0,z1-z0]);
core(-1000,-800,1000,1000,'tools/raw/core-w.png',1.4);
core(-300,-800,1300,900,'tools/raw/core-e.png',1.2);
core(300,100,1100,900,'tools/raw/core-c.png',1);
core(-200,500,800,1300,'tools/raw/core-s.png',1);
