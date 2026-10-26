const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];
const canvas = $('#game');
const ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = true;

const UI = {
  loading: $('#loading'), loadingText: $('#loadingText'), loadingBar: $('#loadingBar'),
  menu: $('#menu'), mp: $('#multiplayerMenu'), controls: $('#controlsMenu'),
  hud: $('#hud'), clock: $('#clock'), roomBadge: $('#roomBadge'), resourceHud: $('#resourceHud'),
  survivalHud: $('#survivalHud'), message: $('#message'), hotbar: $('#hotbar'), zoom: $('#zoomSlider'),
  inventory: $('#inventoryPanel'), inventoryGrid: $('#inventoryGrid'), craft: $('#craftPanel'), craftList: $('#craftList'),
  pause: $('#pausePanel'), mobile: $('#mobileControls'), roomInput: $('#roomInput'), networkStatus: $('#networkStatus'),
  bars: { hp: $('#hpBar'), food: $('#foodBar'), water: $('#waterBar'), stamina: $('#staminaBar') },
  counts: { rock: $('#rockCount'), stick: $('#stickCount'), flint: $('#flintCount'), cloth: $('#clothCount'), stone: $('#stoneCount') },
};

const DPR = Math.min(devicePixelRatio || 1, 2);
let W = innerWidth, H = innerHeight;
function resize() {
  W = innerWidth; H = innerHeight;
  canvas.width = Math.max(1, Math.floor(W * DPR));
  canvas.height = Math.max(1, Math.floor(H * DPR));
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener('resize', resize, { passive: true });
resize();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a,b,t) => a + (b-a)*t;
const dist2 = (ax,az,bx,bz) => (ax-bx)**2 + (az-bz)**2;
const TAU = Math.PI * 2;
const MODE_SURVIVAL = 'survival';
const MODE_CREATIVE = 'creative';

function mix32(v) {
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return (v ^ (v >>> 16)) >>> 0;
}
function hash2(x,z,s=0) {
  let n = (Math.imul(x|0, 374761393) + Math.imul(z|0, 668265263) + Math.imul((state.seed+s)|0, 1442695041)) | 0;
  return mix32(n) / 4294967295;
}
function smooth(t){ return t*t*(3-2*t); }
function valueNoise(x,z,s=0) {
  const x0=Math.floor(x), z0=Math.floor(z), fx=x-x0, fz=z-z0;
  const a=hash2(x0,z0,s), b=hash2(x0+1,z0,s), c=hash2(x0,z0+1,s), d=hash2(x0+1,z0+1,s);
  const u=smooth(fx), v=smooth(fz);
  return lerp(lerp(a,b,u), lerp(c,d,u), v);
}
function seededColor(id) {
  let h=2166136261; for (let i=0;i<id.length;i++) h=Math.imul(h^id.charCodeAt(i),16777619);
  const hue=((h>>>0)%360); return `hsl(${hue} 46% 58%)`;
}

const state = {
  running:false, paused:false, mode:MODE_SURVIVAL, seed:Math.floor(Math.random()*1e9),
  time:8*60, day:1, zoom:1.08, camera:{x:0,z:0},
  player:{x:0,z:0,dir:0,hp:100,hunger:100,water:100,stamina:100, speed:2.65, name:'You'},
  players:new Map(), removed:new Set(), placed:new Map(), doors:new Map(),
  inventory:{ rock:0, stick:0, flint:0, cloth:0, stone:0, steel:0, pickaxe:0, axe:0, torch:0, campfire:0, backpack:0 },
  selectedItem:null, selectedHotbar:0, hotbar:[],
  messageUntil:0, actionCooldown:0, network:null, room:'', clientId:'', isHost:false, multiplayer:false,
  netTick:0, worldTick:0, buildCounter:0, lastPortal:null,
  weather:'clear', rainPhase:0, pendingSnapshot:null,
};

const input = { up:false,down:false,left:false,right:false,run:false,use:false, joyX:0,joyY:0, pointerX:0,pointerY:0 };

function setScreen(el) { $$('.screen').forEach(x=>x.classList.remove('show')); if(el) el.classList.add('show'); }
function showMessage(text, seconds=2.4) { UI.message.textContent=text; UI.message.classList.add('show'); state.messageUntil=performance.now()+seconds*1000; }
function setLoading(text,pct){ UI.loadingText.textContent=text; UI.loadingBar.style.width=`${clamp(pct,0,100)}%`; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function getBiome(tx,tz) {
  const broad=valueNoise(tx/28,tz/28,11), moist=valueNoise(tx/22+50,tz/22-40,27), city=valueNoise(tx/36-90,tz/36+70,73);
  if(city>0.70 && broad>0.27 && broad<0.82) return 'city';
  if(broad<0.20) return 'snow';
  if(broad>0.79) return 'desert';
  if(moist>0.57) return 'forest';
  return 'meadow';
}
function terrainHeight(x,z){
  const n1=valueNoise(x/15,z/15,111)-0.5, n2=valueNoise(x/5,z/5,112)-0.5;
  const b=getBiome(Math.floor(x),Math.floor(z));
  let h=(n1*1.2+n2*.28);
  if(b==='city') h*=.25; if(b==='snow') h*=1.25; if(b==='desert') h*=.72;
  return h;
}
function roadAt(tx,tz){
  if(getBiome(tx,tz)!=='city') return false;
  const mx=((tx%8)+8)%8, mz=((tz%8)+8)%8;
  return mx===0 || mx===1 || mz===0 || mz===1;
}
function tileColor(tx,tz){
  const biome=getBiome(tx,tz), variation=(hash2(tx,tz,301)-.5)*12;
  const base={ meadow:[74,126,58], forest:[47,96,48], snow:[215,225,226], desert:[183,145,83], city:[102,111,105] }[biome];
  if(roadAt(tx,tz)) return `rgb(${45+variation},${48+variation},${50+variation})`;
  return `rgb(${clamp(base[0]+variation,0,255)},${clamp(base[1]+variation,0,255)},${clamp(base[2]+variation,0,255)})`;
}

function iso(x,z,y=0){
  const zoom=state.zoom;
  const dx=x-state.camera.x, dz=z-state.camera.z;
  return { x:W/2+(dx-dz)*34*zoom, y:H/2+(dx+dz)*17*zoom-y*20*zoom };
}
function screenToWorld(sx,sy){
  const zoom=state.zoom, rx=(sx-W/2)/(34*zoom), ry=(sy-H/2)/(17*zoom);
  return { x:state.camera.x+(ry+rx)/2, z:state.camera.z+(ry-rx)/2 };
}
function diamond(tx,tz,color,stroke=null){
  const h00=terrainHeight(tx,tz), h10=terrainHeight(tx+1,tz), h11=terrainHeight(tx+1,tz+1), h01=terrainHeight(tx,tz+1);
  const p0=iso(tx,tz,h00), p1=iso(tx+1,tz,h10), p2=iso(tx+1,tz+1,h11), p3=iso(tx,tz+1,h01);
  ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.lineTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.lineTo(p3.x,p3.y); ctx.closePath();
  ctx.fillStyle=color; ctx.fill(); if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}
}
function polygon(points, fill, stroke=null, alpha=1){
  ctx.save(); ctx.globalAlpha=alpha; ctx.beginPath(); ctx.moveTo(points[0].x,points[0].y); for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.stroke();}ctx.restore();
}
function line(a,b,color,width=1,alpha=1){ctx.save();ctx.globalAlpha=alpha;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();ctx.restore();}

function getBuilding(cx,cz){
  const x=cx*8+4, z=cz*8+4;
  if(getBiome(Math.floor(x),Math.floor(z))!=='city') return null;
  if(hash2(cx,cz,701)<.28) return null;
  const w=3+Math.floor(hash2(cx,cz,702)*2.6), d=3+Math.floor(hash2(cx,cz,703)*2.6), floors=1+Math.floor(hash2(cx,cz,704)*3.5);
  const ox=(hash2(cx,cz,705)-.5)*1.0, oz=(hash2(cx,cz,706)-.5)*1.0;
  return {id:`b:${cx}:${cz}`,cx,cz,x:x+ox,z:z+oz,w,d,h:floors*1.6, floors, door:`bd:${cx}:${cz}`};
}
function buildingDoorPos(b){ return {x:b.x+b.w/2, z:b.z+b.d*.28}; }
function insideBuilding(x,z,b,pad=0){return x>b.x-b.w/2+pad&&x<b.x+b.w/2-pad&&z>b.z-b.d/2+pad&&z<b.z+b.d/2-pad;}
function visibleBuildings(radius=18){
  const minCx=Math.floor((state.camera.x-radius)/8)-1,maxCx=Math.floor((state.camera.x+radius)/8)+1;
  const minCz=Math.floor((state.camera.z-radius)/8)-1,maxCz=Math.floor((state.camera.z+radius)/8)+1;
  const out=[];for(let cz=minCz;cz<=maxCz;cz++)for(let cx=minCx;cx<=maxCx;cx++){const b=getBuilding(cx,cz);if(b)out.push(b);}return out;
}
function nearBuildingAt(x,z){for(const b of visibleBuildings(10)) if(insideBuilding(x,z,b,-.15)) return b; return null;}

function resourceForTile(tx,tz){
  const biome=getBiome(tx,tz); if(roadAt(tx,tz)) return null;
  const r=hash2(tx,tz,401), jx=.15+hash2(tx,tz,402)*.7, jz=.15+hash2(tx,tz,403)*.7;
  let type=null;
  if(biome==='forest' && r<.32) type='tree';
  else if(biome==='snow' && r<.15) type='boulder';
  else if(biome==='desert' && r<.12) type='cactus';
  else if(r<.075) type='rock';
  else if(r<.14) type='stick';
  else if((biome==='meadow'||biome==='forest') && r<.17) type='flower';
  if(!type)return null;
  const id=`r:${tx}:${tz}:${type}`; if(state.removed.has(id)) return null;
  return {id,type,x:tx+jx,z:tz+jz,tx,tz};
}
function portalForCell(cx,cz){
  if(hash2(cx,cz,901)<.965) return null;
  const x=cx*14+2+hash2(cx,cz,902)*10,z=cz*14+2+hash2(cx,cz,903)*10;
  if(getBiome(Math.floor(x),Math.floor(z))==='city') return null;
  return {id:`p:${cx}:${cz}`,x,z,color:['#d32d52','#7554d9','#21a9d8','#d6a71e'][Math.floor(hash2(cx,cz,904)*4)%4]};
}
function visiblePortals(radius=24){const out=[];const a=Math.floor((state.camera.x-radius)/14)-1,b=Math.floor((state.camera.x+radius)/14)+1,c=Math.floor((state.camera.z-radius)/14)-1,d=Math.floor((state.camera.z+radius)/14)+1;for(let cz=c;cz<=d;cz++)for(let cx=a;cx<=b;cx++){const p=portalForCell(cx,cz);if(p)out.push(p);}return out;}

function drawIsoBox(x,z,w,d,h,colors,alpha=1){
  const y=terrainHeight(x,z), topY=y+h;
  const p0=iso(x-w/2,z-d/2,topY),p1=iso(x+w/2,z-d/2,topY),p2=iso(x+w/2,z+d/2,topY),p3=iso(x-w/2,z+d/2,topY);
  const b1=iso(x+w/2,z-d/2,y),b2=iso(x+w/2,z+d/2,y),b3=iso(x-w/2,z+d/2,y);
  polygon([p0,p1,p2,p3],colors[0],null,alpha); polygon([p1,p2,b2,b1],colors[1],null,alpha); polygon([p2,p3,b3,b2],colors[2],null,alpha);
}
function drawTree(r){
  const y=terrainHeight(r.x,r.z), base=iso(r.x,r.z,y), top=iso(r.x,r.z,y+2.7); const s=state.zoom;
  ctx.fillStyle='#5b422b';ctx.fillRect(base.x-3*s,top.y+26*s,6*s,35*s);
  const snow=getBiome(r.tx,r.tz)==='snow';
  const cols=snow?['#d9e5e4','#9eb7ad','#426b58']:['#1f5b39','#2f7444','#19492f'];
  for(let i=0;i<3;i++){const cy=top.y+i*18*s,ww=(38+i*13)*s;polygon([{x:top.x,y:cy-10*s},{x:top.x-ww/2,y:cy+30*s},{x:top.x+ww/2,y:cy+30*s}],cols[i],null,.98)}
}
function drawRock(r,big=false){const y=terrainHeight(r.x,r.z);drawIsoBox(r.x,r.z,big?.75:.42,big?.7:.4,big?.55:.28,['#9b9d99','#727976','#626a66']);}
function drawStick(r){const y=terrainHeight(r.x,r.z),a=iso(r.x-.25,r.z,y+.03),b=iso(r.x+.25,r.z+.08,y+.03);line(a,b,'#664b31',4*state.zoom);}
function drawCactus(r){const y=terrainHeight(r.x,r.z),p=iso(r.x,r.z,y),t=iso(r.x,r.z,y+1.35);line(p,t,'#2b7a47',9*state.zoom);line(iso(r.x,r.z,y+.7),iso(r.x+.28,r.z,y+.9),'#2b7a47',7*state.zoom);}
function drawFlower(r){const y=terrainHeight(r.x,r.z),p=iso(r.x,r.z,y+.08);ctx.fillStyle='#e6e7e2';ctx.beginPath();ctx.arc(p.x,p.y,2.2*state.zoom,0,TAU);ctx.fill();}
function drawResource(r){if(r.type==='tree')drawTree(r);else if(r.type==='boulder')drawRock(r,true);else if(r.type==='rock')drawRock(r,false);else if(r.type==='stick')drawStick(r);else if(r.type==='cactus')drawCactus(r);else drawFlower(r);}

function drawBuilding(b){
  const inside=insideBuilding(state.player.x,state.player.z,b,0);
  const y=terrainHeight(b.x,b.z), wallH=b.h, roofAlpha=inside?0:1;
  // Floor panel always remains visible, avoiding terrain/floor clipping.
  const f0=iso(b.x-b.w/2,b.z-b.d/2,y+.08),f1=iso(b.x+b.w/2,b.z-b.d/2,y+.08),f2=iso(b.x+b.w/2,b.z+b.d/2,y+.08),f3=iso(b.x-b.w/2,b.z+b.d/2,y+.08);
  polygon([f0,f1,f2,f3],inside?'#887f70':'#6e6d66');
  const top=[iso(b.x-b.w/2,b.z-b.d/2,y+wallH),iso(b.x+b.w/2,b.z-b.d/2,y+wallH),iso(b.x+b.w/2,b.z+b.d/2,y+wallH),iso(b.x-b.w/2,b.z+b.d/2,y+wallH)];
  const bot=[iso(b.x-b.w/2,b.z-b.d/2,y+.08),iso(b.x+b.w/2,b.z-b.d/2,y+.08),iso(b.x+b.w/2,b.z+b.d/2,y+.08),iso(b.x-b.w/2,b.z+b.d/2,y+.08)];
  const c1=hash2(b.cx,b.cz,708)>.5?'#a29684':'#747b7e', c2=hash2(b.cx,b.cz,708)>.5?'#817868':'#596266';
  // Back walls remain; front/right walls cut down when the player is inside.
  polygon([top[0],top[1],bot[1],bot[0]],c1,null,inside?.35:1);
  polygon([top[0],top[3],bot[3],bot[0]],c2,null,inside?.35:1);
  if(!inside){ polygon([top[1],top[2],bot[2],bot[1]],c2); polygon([top[3],top[2],bot[2],bot[3]],c1); }
  if(roofAlpha) polygon(top,'#555956',null,.96);
  // Windows and door cue.
  if(!inside){
    const dp=buildingDoorPos(b), dbase=iso(dp.x,dp.z,terrainHeight(dp.x,dp.z)), dtop=iso(dp.x,dp.z,terrainHeight(dp.x,dp.z)+1.1);
    line(dbase,dtop,state.doors.get(b.door)?'#98d2a7':'#40362e',8*state.zoom);
  } else {
    // Simple furniture with collision-like visual mass.
    const fx=b.x-.65+(hash2(b.cx,b.cz,710)-.5)*.4,fz=b.z-.2;
    drawIsoBox(fx,fz,.7,.45,.45,['#8a6c4c','#6d5239','#5f4933'],.95);
  }
}

function drawPortal(p){
  const y=terrainHeight(p.x,p.z), b=iso(p.x,p.z,y),t=iso(p.x,p.z,y+1.75),s=state.zoom;
  ctx.save();ctx.shadowBlur=18*s;ctx.shadowColor=p.color;line({x:b.x-17*s,y:b.y},{x:t.x-17*s,y:t.y},'#222',7*s);line({x:b.x+17*s,y:b.y},{x:t.x+17*s,y:t.y},'#222',7*s);line({x:t.x-20*s,y:t.y},{x:t.x+20*s,y:t.y},'#222',7*s);polygon([{x:t.x-14*s,y:t.y+5*s},{x:t.x+14*s,y:t.y+5*s},{x:b.x+14*s,y:b.y-2*s},{x:b.x-14*s,y:b.y-2*s}],p.color);ctx.restore();
}
function drawPlaced(o){
  const y=terrainHeight(o.x,o.z), rot=o.rot||0;
  if(o.type==='floor'){
    const p0=iso(o.x-.5,o.z-.5,y+.07),p1=iso(o.x+.5,o.z-.5,y+.07),p2=iso(o.x+.5,o.z+.5,y+.07),p3=iso(o.x-.5,o.z+.5,y+.07);polygon([p0,p1,p2,p3],'#8c7961','#554a3c');
  } else if(o.type==='wall'){
    if(rot%2===0) drawIsoBox(o.x,o.z,1,.13,1.35,['#9d866b','#715e4b','#655542']); else drawIsoBox(o.x,o.z,.13,1,1.35,['#9d866b','#715e4b','#655542']);
  } else if(o.type==='door'){
    const open=!!state.doors.get(o.id), col=open?'#80b88c':'#7a5c40'; if(rot%2===0) drawIsoBox(o.x,o.z,1,.12,1.35,[col,'#513f31','#47382c']); else drawIsoBox(o.x,o.z,.12,1,1.35,[col,'#513f31','#47382c']);
  } else if(o.type==='stairs'){
    for(let i=0;i<4;i++) drawIsoBox(o.x+(rot%2===0?(i-1.5)*.16:0),o.z+(rot%2? (i-1.5)*.16:0),rot%2===0?.34:.82,rot%2===0?.82:.34,.15+i*.12,['#a38c70','#715e4c','#635340']);
  } else if(o.type==='campfire'){
    drawIsoBox(o.x,o.z,.55,.55,.12,['#5d5650','#48413d','#3f3935']); const p=iso(o.x,o.z,y+.45);ctx.fillStyle='#ffb13b';ctx.beginPath();ctx.arc(p.x,p.y,7*state.zoom,0,TAU);ctx.fill();
  }
}
function drawPlayer(p,local=false){
  const y=terrainHeight(p.x,p.z), base=iso(p.x,p.z,y), head=iso(p.x,p.z,y+1.25), s=state.zoom;
  ctx.save();ctx.fillStyle=local?'#e8ebdc':(p.color||'#69a9d8');ctx.beginPath();ctx.arc(head.x,head.y,6*s,0,TAU);ctx.fill();
  ctx.strokeStyle=local?'#283a49':'#26343f';ctx.lineWidth=8*s;ctx.beginPath();ctx.moveTo(head.x,head.y+7*s);ctx.lineTo(base.x,base.y-3*s);ctx.stroke();ctx.lineWidth=3*s;ctx.strokeStyle='#1d2520';ctx.beginPath();ctx.moveTo(base.x,base.y-2*s);ctx.lineTo(base.x-7*s,base.y+10*s);ctx.moveTo(base.x,base.y-2*s);ctx.lineTo(base.x+7*s,base.y+10*s);ctx.stroke();
  if(!local&&p.name){ctx.font=`${Math.max(9,11*s)}px system-ui`;ctx.textAlign='center';ctx.fillStyle='rgba(255,255,255,.9)';ctx.fillText(p.name,head.x,head.y-12*s)}ctx.restore();
}

function render(){
  ctx.setTransform(DPR,0,0,DPR,0,0);ctx.fillStyle='#16241b';ctx.fillRect(0,0,W,H);
  if(!state.running){requestAnimationFrame(render);return;}
  const radius=Math.ceil(12/state.zoom)+5, cx=Math.floor(state.camera.x),cz=Math.floor(state.camera.z);
  const tiles=[];for(let z=cz-radius;z<=cz+radius;z++)for(let x=cx-radius;x<=cx+radius;x++)tiles.push({x,z,d:x+z});tiles.sort((a,b)=>a.d-b.d||a.x-b.x);
  for(const t of tiles){diamond(t.x,t.z,tileColor(t.x,t.z)); if(roadAt(t.x,t.z)){const mx=((t.x%8)+8)%8,mz=((t.z%8)+8)%8;if(mx===0||mz===0){const c=iso(t.x+.5,t.z+.5,terrainHeight(t.x+.5,t.z+.5)+.02);ctx.fillStyle='rgba(227,193,75,.65)';ctx.fillRect(c.x-2*state.zoom,c.y-1*state.zoom,4*state.zoom,2*state.zoom);}}}
  const draw=[];
  for(const t of tiles){const r=resourceForTile(t.x,t.z);if(r)draw.push({d:r.x+r.z,kind:'r',v:r});}
  for(const b of visibleBuildings(radius+4))draw.push({d:b.x+b.z+b.d*.3,kind:'b',v:b});
  for(const p of visiblePortals(radius+6))draw.push({d:p.x+p.z,kind:'p',v:p});
  for(const o of state.placed.values())if(Math.abs(o.x-state.camera.x)<radius+4&&Math.abs(o.z-state.camera.z)<radius+4)draw.push({d:o.x+o.z+.05,kind:'o',v:o});
  for(const p of state.players.values())draw.push({d:p.x+p.z+.3,kind:'op',v:p});
  draw.push({d:state.player.x+state.player.z+.31,kind:'lp',v:state.player});
  draw.sort((a,b)=>a.d-b.d);
  for(const d of draw){if(d.kind==='r')drawResource(d.v);else if(d.kind==='b')drawBuilding(d.v);else if(d.kind==='p')drawPortal(d.v);else if(d.kind==='o')drawPlaced(d.v);else if(d.kind==='op')drawPlayer(d.v,false);else drawPlayer(d.v,true);}
  drawWeatherAndNight();
  requestAnimationFrame(render);
}
function drawWeatherAndNight(){
  const hour=(state.time/60)%24; let darkness=0;if(hour<5)darkness=.48;else if(hour<7)darkness=lerp(.48,0,(hour-5)/2);else if(hour>19)darkness=lerp(0,.48,(hour-19)/3);
  if(darkness>0){ctx.fillStyle=`rgba(18,31,55,${darkness})`;ctx.fillRect(0,0,W,H);}
  if(state.weather==='rain'){
    ctx.strokeStyle='rgba(190,210,222,.35)';ctx.lineWidth=1;const off=(state.rainPhase*220)%28;for(let x=-40;x<W+40;x+=28){for(let y=-20;y<H+30;y+=54){ctx.beginPath();ctx.moveTo(x+off,y);ctx.lineTo(x+off-7,y+18);ctx.stroke();}}
  }
}
requestAnimationFrame(render);

function setModeDefaults(mode){
  state.mode=mode;state.player.hp=100;state.player.hunger=100;state.player.water=100;state.player.stamina=100;state.removed.clear();state.placed.clear();state.doors.clear();state.players.clear();state.time=8*60;state.day=1;state.camera.x=0;state.camera.z=0;state.player.x=0;state.player.z=0;
  state.inventory={ rock:0,stick:0,flint:0,cloth:0,stone:0,steel:0,pickaxe:0,axe:0,torch:0,campfire:0,backpack:0 };
  if(mode===MODE_CREATIVE){state.inventory.rock=999;state.inventory.stick=999;state.inventory.flint=999;state.inventory.cloth=999;state.inventory.stone=999;state.hotbar=[{type:'wall',icon:'▥',label:'Wall'},{type:'door',icon:'▯',label:'Door'},{type:'stairs',icon:'▱',label:'Stairs'},{type:'floor',icon:'◇',label:'Floor'}];}
  else {state.hotbar=[{type:'hand',icon:'✋',label:'Use'},{type:'pickaxe',icon:'⛏',label:'Pickaxe'},{type:'axe',icon:'🪓',label:'Axe'},{type:'torch',icon:'🔥',label:'Torch'}];}
  state.selectedHotbar=0;state.selectedItem=null;refreshHotbar();refreshInventory();refreshCrafting();updateHud();
}
function applyNetworkSnapshot(snap){
  if(!snap)return;
  state.removed=new Set(snap.removed||[]);
  state.placed=new Map((snap.placed||[]).map(o=>[o.id,o]));
  state.doors=new Map(snap.doors||[]);
  state.players.clear();
  for(const p of (snap.players||[])){if(p.id!==state.clientId)state.players.set(p.id,{...p,color:seededColor(p.id)});}
  if(snap.world){state.time=snap.world.time??state.time;state.day=snap.world.day??state.day;state.weather=snap.world.weather??state.weather;}
}
async function startGame(mode, multiplayer=false){
  setScreen(UI.loading);UI.loading.classList.add('show');setLoading('Preparing browser world…',18);await sleep(120);
  setModeDefaults(mode);state.multiplayer=multiplayer;if(multiplayer&&state.pendingSnapshot){applyNetworkSnapshot(state.pendingSnapshot);state.pendingSnapshot=null;}setLoading('Generating terrain and buildings…',52);await sleep(100);setLoading('Preparing inventory and controls…',78);await sleep(90);
  state.running=true;state.paused=false;UI.hud.classList.remove('hidden');UI.mobile.classList.toggle('hidden',!isTouchDevice());UI.survivalHud.classList.toggle('hidden',mode===MODE_CREATIVE);UI.resourceHud.classList.remove('hidden');
  setLoading('Entering Infinite Green Hills…',100);await sleep(180);setScreen(null);UI.loading.classList.remove('show');
  showMessage(multiplayer?`Connected to room ${state.room}`:(mode===MODE_CREATIVE?'Creative mode':'Survival mode'));
}
function returnToMenu(){
  state.running=false;state.paused=false;state.multiplayer=false;state.room='';state.clientId='';state.isHost=false;state.players.clear();if(state.network){state.network.close();state.network=null;}UI.hud.classList.add('hidden');UI.mobile.classList.add('hidden');closePanels();setScreen(UI.menu);
}

function isTouchDevice(){return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints>0;}
function selectedHot(){return state.hotbar[state.selectedHotbar]||state.hotbar[0];}
function refreshHotbar(){
  UI.hotbar.innerHTML='';state.hotbar.forEach((h,i)=>{const d=document.createElement('div');d.className='hotSlot'+(i===state.selectedHotbar?' selected':'');let count='';if(state.mode===MODE_SURVIVAL&&state.inventory[h.type]!=null&&h.type!=='hand')count=state.inventory[h.type]?`x${state.inventory[h.type]}`:'none';d.innerHTML=`<div class="ico">${h.icon}</div><div>${h.label}</div><div class="count">${count}</div>`;d.addEventListener('pointerdown',e=>{e.preventDefault();state.selectedHotbar=i;refreshHotbar();});UI.hotbar.appendChild(d);});
}
function updateHud(){
  const inv=state.inventory;for(const k of Object.keys(UI.counts))UI.counts[k].textContent=inv[k]||0;
  UI.bars.hp.style.width=clamp(state.player.hp,0,100)+'%';UI.bars.food.style.width=clamp(state.player.hunger,0,100)+'%';UI.bars.water.style.width=clamp(state.player.water,0,100)+'%';UI.bars.stamina.style.width=clamp(state.player.stamina,0,100)+'%';
  const mins=Math.floor(state.time%1440),hh=String(Math.floor(mins/60)).padStart(2,'0'),mm=String(mins%60).padStart(2,'0');UI.clock.textContent=`Day ${state.day} • ${hh}:${mm}`;
  if(state.room){UI.roomBadge.textContent=`ROOM ${state.room}${state.isHost?' • HOST':''}`;UI.roomBadge.classList.remove('hidden');}else UI.roomBadge.classList.add('hidden');
}
function refreshInventory(){
  UI.inventoryGrid.innerHTML='';for(const [k,v] of Object.entries(state.inventory)){if(v<=0&&state.mode!==MODE_CREATIVE)continue;const d=document.createElement('div');d.className='invItem'+(state.selectedItem===k?' selected':'');d.innerHTML=`<b>${pretty(k)}</b><small>${state.mode===MODE_CREATIVE&&v>=999?'Unlimited':`x${v}`}</small>`;d.addEventListener('click',()=>{state.selectedItem=k;refreshInventory();});UI.inventoryGrid.appendChild(d);}
}
function pretty(k){return k.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
const recipes=[
  {name:'Pickaxe',out:'pickaxe',cost:{rock:3,stick:1}}, {name:'Axe',out:'axe',cost:{rock:2,stick:1}}, {name:'Flint and Steel',out:'steel',cost:{flint:1,stone:1}}, {name:'Torch',out:'torch',cost:{stick:1,flint:1}}, {name:'Campfire',out:'campfire',cost:{rock:6,stick:10}},
];
function canCraft(r){return Object.entries(r.cost).every(([k,v])=>(state.inventory[k]||0)>=v);}
function refreshCrafting(){
  UI.craftList.innerHTML='';for(const r of recipes){const d=document.createElement('div');d.className='recipe';const req=Object.entries(r.cost).map(([k,v])=>`${pretty(k)} ${state.inventory[k]||0}/${v}`).join(' • ');d.innerHTML=`<div><b>${r.name}</b><small>${req}</small></div>`;const b=document.createElement('button');b.textContent='Craft';b.disabled=state.mode!==MODE_CREATIVE&&!canCraft(r);b.onclick=()=>craft(r);d.appendChild(b);UI.craftList.appendChild(d);}
}
function craft(r){if(state.mode!==MODE_CREATIVE&&!canCraft(r)){showMessage('Missing materials');return;}if(state.mode!==MODE_CREATIVE)for(const [k,v] of Object.entries(r.cost))state.inventory[k]-=v;state.inventory[r.out]=(state.inventory[r.out]||0)+1;showMessage(`Crafted ${r.name}`);refreshInventory();refreshCrafting();refreshHotbar();updateHud();}
function dropSelected(){
  const k=state.selectedItem;if(!k){showMessage('Select an item first');return;}if((state.inventory[k]||0)<=0)return;
  if(state.mode===MODE_CREATIVE){state.inventory[k]=Math.max(0,state.inventory[k]-1);showMessage(`${pretty(k)} deleted`);}else{state.inventory[k]--;showMessage(`${pretty(k)} dropped`);}
  refreshInventory();refreshHotbar();updateHud();
}
function closePanels(){UI.inventory.classList.add('hidden');UI.craft.classList.add('hidden');UI.pause.classList.add('hidden');}
function toggleInventory(){const opening=UI.inventory.classList.contains('hidden');closePanels();if(opening){refreshInventory();UI.inventory.classList.remove('hidden');}}
function toggleCraft(){const opening=UI.craft.classList.contains('hidden');closePanels();if(opening){refreshCrafting();UI.craft.classList.remove('hidden');}}
function togglePause(){const opening=UI.pause.classList.contains('hidden');closePanels();if(opening){state.paused=true;UI.pause.classList.remove('hidden');}else state.paused=false;}

function worldCollision(nx,nz,ox,oz){
  // Building shell collision with a usable doorway gap.
  for(const b of visibleBuildings(10)){
    const wasIn=insideBuilding(ox,oz,b,0), nowIn=insideBuilding(nx,nz,b,0);if(wasIn===nowIn)continue;
    const dp=buildingDoorPos(b), nearDoor=dist2(nx,nz,dp.x,dp.z)<.55*.55 || dist2(ox,oz,dp.x,dp.z)<.55*.55;
    if(!(nearDoor&&state.doors.get(b.door)))return {x:ox,z:oz};
  }
  // Placed walls/closed doors.
  for(const o of state.placed.values()){
    if(o.type!=='wall'&&o.type!=='door')continue;if(o.type==='door'&&state.doors.get(o.id))continue;
    if(dist2(nx,nz,o.x,o.z)<.34*.34)return {x:ox,z:oz};
  }
  return {x:nx,z:nz};
}
function nearestInteraction(){
  let best=null,bd=1.45*1.45;
  for(let z=Math.floor(state.player.z)-2;z<=Math.floor(state.player.z)+2;z++)for(let x=Math.floor(state.player.x)-2;x<=Math.floor(state.player.x)+2;x++){const r=resourceForTile(x,z);if(r){const d=dist2(state.player.x,state.player.z,r.x,r.z);if(d<bd){bd=d;best={kind:'resource',v:r};}}}
  for(const b of visibleBuildings(8)){const dp=buildingDoorPos(b),d=dist2(state.player.x,state.player.z,dp.x,dp.z);if(d<bd){bd=d;best={kind:'door',v:{id:b.door,x:dp.x,z:dp.z}};}}
  for(const p of visiblePortals(8)){const d=dist2(state.player.x,state.player.z,p.x,p.z);if(d<bd){bd=d;best={kind:'portal',v:p};}}
  for(const o of state.placed.values())if(o.type==='door'){const d=dist2(state.player.x,state.player.z,o.x,o.z);if(d<bd){bd=d;best={kind:'door',v:{id:o.id,x:o.x,z:o.z}};}}
  return best;
}
function useAction(){
  if(state.actionCooldown>0)return;state.actionCooldown=.18;
  const h=selectedHot();
  if(state.mode===MODE_CREATIVE&&['wall','door','floor','stairs'].includes(h.type)){placeCreative(h.type);return;}
  if(h.type==='campfire'&&(state.inventory.campfire||0)>0){placeCampfire();return;}
  const it=nearestInteraction();if(!it){showMessage('Nothing nearby');return;}
  if(it.kind==='door'){const val=!state.doors.get(it.v.id);state.doors.set(it.v.id,val);sendEvent({kind:'door',id:it.v.id,value:val});showMessage(val?'Door opened':'Door closed');return;}
  if(it.kind==='portal'){teleportPortal(it.v);return;}
  if(it.kind==='resource')gather(it.v);
}
function gather(r){
  if(r.type==='flower'){showMessage('Wild flowers');return;}
  if(r.type==='tree'&&!(state.inventory.axe>0)){showMessage('You need an axe');return;}
  if(r.type==='boulder'&&!(state.inventory.pickaxe>0)){showMessage('You need a pickaxe');return;}
  state.removed.add(r.id);sendEvent({kind:'remove',id:r.id});
  if(r.type==='tree'){const n=1+Math.floor(hash2(r.tx,r.tz,501)*6);state.inventory.stick+=n;showMessage(`Collected ${n} sticks`);}
  else if(r.type==='boulder'){const n=1+Math.floor(hash2(r.tx,r.tz,502)*6);state.inventory.rock+=n;if(hash2(r.tx,r.tz,503)<.14)state.inventory.flint++;showMessage(`Mined ${n} rocks`);}
  else if(r.type==='rock'){state.inventory.rock++;if(hash2(r.tx,r.tz,504)<.05)state.inventory.flint++;showMessage('Collected rock');}
  else if(r.type==='stick'){state.inventory.stick++;showMessage('Collected stick');}
  else if(r.type==='cactus'){state.inventory.stick+=2;showMessage('Collected 2 sticks');}
  refreshInventory();refreshCrafting();updateHud();
}
function teleportPortal(p){
  const parts=p.id.split(':');const cx=+parts[1],cz=+parts[2];let tcx=cx,tcz=cz;for(let i=0;i<80;i++){const a=Math.floor(hash2(cx+i,cz-i,950)*25)-12,b=Math.floor(hash2(cx-i,cz+i,951)*25)-12;const q=portalForCell(cx+a,cz+b);if(q&&q.id!==p.id){tcx=cx+a;tcz=cz+b;state.player.x=q.x+.8;state.player.z=q.z+.8;state.camera.x=state.player.x;state.camera.z=state.player.z;state.lastPortal=q.id;showMessage('The doorway carries you somewhere else…');return;}}
  state.player.x+=35;state.player.z+=21;showMessage('The doorway shifts the world…');
}
function placeCreative(type){
  const dir=state.player.dir, x=Math.round((state.player.x+Math.cos(dir)*1.5)*2)/2,z=Math.round((state.player.z+Math.sin(dir)*1.5)*2)/2;
  if([...state.placed.values()].some(o=>dist2(x,z,o.x,o.z)<.3)){showMessage('Space is occupied');return;}
  const id=`${state.clientId||'local'}:${Date.now().toString(36)}:${state.buildCounter++}`;const o={id,type,x,z,rot:Math.abs(Math.cos(dir))>Math.abs(Math.sin(dir))?0:1};state.placed.set(id,o);sendEvent({kind:'place',object:o});showMessage(`${pretty(type)} placed`);
}
function placeCampfire(){const dir=state.player.dir,x=state.player.x+Math.cos(dir)*1.2,z=state.player.z+Math.sin(dir)*1.2;const id=`fire:${state.clientId||'local'}:${Date.now().toString(36)}`;const o={id,type:'campfire',x,z,rot:0};state.placed.set(id,o);if(state.mode!==MODE_CREATIVE)state.inventory.campfire--;sendEvent({kind:'place',object:o});refreshHotbar();refreshInventory();showMessage('Campfire placed');}

function update(dt){
  if(!state.running||state.paused)return;
  if(state.messageUntil&&performance.now()>state.messageUntil){UI.message.classList.remove('show');state.messageUntil=0;}
  state.actionCooldown=Math.max(0,state.actionCooldown-dt);
  let mx=(input.right?1:0)-(input.left?1:0)+input.joyX,my=(input.down?1:0)-(input.up?1:0)+input.joyY;const len=Math.hypot(mx,my);if(len>1){mx/=len;my/=len;}
  const moving=Math.hypot(mx,my)>.05, running=(input.run&&state.player.stamina>0&&moving&&state.mode===MODE_SURVIVAL);let speed=state.player.speed*(running?1.7:1);
  if(moving){const dx=(mx+my)*.7071,dz=(my-mx)*.7071;state.player.dir=Math.atan2(dz,dx);let nx=state.player.x+dx*speed*dt,nz=state.player.z+dz*speed*dt;const c=worldCollision(nx,nz,state.player.x,state.player.z);state.player.x=c.x;state.player.z=c.z;}
  if(state.mode===MODE_SURVIVAL){
    state.player.hunger=Math.max(0,state.player.hunger-dt*.055);state.player.water=Math.max(0,state.player.water-dt*.075);
    if(running)state.player.stamina=Math.max(0,state.player.stamina-dt*16);else state.player.stamina=Math.min(100,state.player.stamina+dt*10);
    if(state.player.hunger<=0||state.player.water<=0)state.player.hp=Math.max(0,state.player.hp-dt*2.3);
    if(state.player.hp<=0){state.player.hp=100;state.player.hunger=70;state.player.water=70;state.player.x=0;state.player.z=0;showMessage('You collapsed and woke near the starting hills',3);}
  }
  if(input.use){input.use=false;useAction();}
  state.camera.x=lerp(state.camera.x,state.player.x,1-Math.pow(.001,dt));state.camera.z=lerp(state.camera.z,state.player.z,1-Math.pow(.001,dt));
  if(state.isHost||!state.multiplayer){state.time+=dt*2.0;if(state.time>=1440){state.time-=1440;state.day++;state.weather=hash2(state.day,0,1201)>.76?'rain':'clear';}}
  state.rainPhase+=dt;
  if(state.multiplayer&&state.network){state.netTick-=dt;if(state.netTick<=0){state.netTick=.10;state.network.send({type:'state',x:state.player.x,z:state.player.z,dir:state.player.dir,hp:state.player.hp,name:state.player.name});}if(state.isHost){state.worldTick-=dt;if(state.worldTick<=0){state.worldTick=3;state.network.send({type:'world',time:state.time,day:state.day,weather:state.weather});}}}
  updateHud();
}
let last=performance.now();function loop(now){const dt=Math.min(.05,(now-last)/1000);last=now;update(dt);requestAnimationFrame(loop);}requestAnimationFrame(loop);

function sendEvent(ev){if(state.multiplayer&&state.network)state.network.send({type:'event',event:ev});}
function applyEvent(ev){if(!ev)return;if(ev.kind==='remove')state.removed.add(ev.id);else if(ev.kind==='place'&&ev.object)state.placed.set(ev.object.id,ev.object);else if(ev.kind==='delete')state.placed.delete(ev.id);else if(ev.kind==='door')state.doors.set(ev.id,!!ev.value);}

class NetClient{
  constructor(){this.ws=null;this.pendingAction=null;}
  url(){if(location.protocol==='file:')return null;return `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`;}
  connect(action){return new Promise((resolve,reject)=>{const url=this.url();if(!url){reject(new Error('Open the website through its server, not as a file.'));return;}const ws=new WebSocket(url);this.ws=ws;let settled=false;const fail=(m)=>{if(!settled){settled=true;reject(new Error(m));}};ws.onopen=()=>{if(action.type==='create')this.send({type:'create',mode:action.mode});else this.send({type:'join',code:action.code});};ws.onerror=()=>fail('Could not reach multiplayer server');ws.onclose=()=>{if(state.running&&state.multiplayer)showMessage('Disconnected from multiplayer server',4);};ws.onmessage=(e)=>{let m;try{m=JSON.parse(e.data)}catch{return;}if(m.type==='error'){fail(m.message||'Multiplayer error');UI.networkStatus.textContent=m.message||'Error';return;}if(m.type==='created'||m.type==='joined'){state.clientId=m.id;state.room=m.room;state.seed=m.seed;state.isHost=!!m.host;state.mode=m.mode||action.mode||MODE_SURVIVAL;state.pendingSnapshot=m.snapshot||null;if(!settled){settled=true;resolve(m);}return;}this.handle(m);};});}
  handle(m){if(m.type==='player_join'){if(m.id!==state.clientId)state.players.set(m.id,{id:m.id,x:m.x||0,z:m.z||0,dir:0,name:m.name||'Player',color:seededColor(m.id)});showMessage('A player joined the world');}else if(m.type==='player_leave'){state.players.delete(m.id);showMessage('A player left the world');}else if(m.type==='state'&&m.id!==state.clientId){const p=state.players.get(m.id)||{id:m.id,color:seededColor(m.id)};Object.assign(p,m);state.players.set(m.id,p);}else if(m.type==='event'){applyEvent(m.event);}else if(m.type==='world'&&!state.isHost){state.time=m.time??state.time;state.day=m.day??state.day;state.weather=m.weather??state.weather;}else if(m.type==='host'){state.isHost=m.id===state.clientId;showMessage(state.isHost?'You are now the host':'Host changed');}}
  send(obj){if(this.ws&&this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(obj));}
  close(){try{this.ws?.close()}catch{}this.ws=null;}
}

async function hostMultiplayer(mode){UI.networkStatus.textContent='Creating room…';try{const n=new NetClient();state.network=n;const m=await n.connect({type:'create',mode});UI.networkStatus.textContent=`Room ${m.room} created`;await startGame(mode,true);}catch(e){UI.networkStatus.textContent=e.message;state.network?.close();state.network=null;}}
async function joinMultiplayer(){const code=UI.roomInput.value.trim().toUpperCase();if(code.length<4){UI.networkStatus.textContent='Enter the room code';return;}UI.networkStatus.textContent='Joining…';try{const n=new NetClient();state.network=n;const m=await n.connect({type:'join',code});UI.networkStatus.textContent=`Joined ${m.room}`;await startGame(m.mode||MODE_SURVIVAL,true);}catch(e){UI.networkStatus.textContent=e.message;state.network?.close();state.network=null;}}

// Menus
$$('[data-action]').forEach(b=>b.addEventListener('click',async()=>{const a=b.dataset.action;if(a==='solo'){state.seed=Math.floor(Math.random()*1e9);state.room='';await startGame(MODE_SURVIVAL,false);}else if(a==='creative'){state.seed=Math.floor(Math.random()*1e9);state.room='';await startGame(MODE_CREATIVE,false);}else if(a==='multiplayer'){setScreen(UI.mp);}else if(a==='controls'){setScreen(UI.controls);}else if(a==='back'){setScreen(UI.menu);}else if(a==='host-survival')hostMultiplayer(MODE_SURVIVAL);else if(a==='host-creative')hostMultiplayer(MODE_CREATIVE);else if(a==='join')joinMultiplayer();}));
$$('[data-close-panel]').forEach(b=>b.addEventListener('click',()=>{closePanels();state.paused=false;}));
$('#dropButton').onclick=dropSelected;$('#pauseButton').onclick=togglePause;$('#resumeButton').onclick=()=>{closePanels();state.paused=false;};$('#leaveButton').onclick=returnToMenu;$('#invBtn').onclick=toggleInventory;$('#craftBtn').onclick=toggleCraft;$('#useBtn').onpointerdown=()=>input.use=true;$('#runBtn').onpointerdown=()=>input.run=true;$('#runBtn').onpointerup=$('#runBtn').onpointercancel=()=>input.run=false;
UI.zoom.addEventListener('input',()=>{state.zoom=+UI.zoom.value;});
UI.roomInput.addEventListener('input',()=>UI.roomInput.value=UI.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g,''));

addEventListener('keydown',e=>{if(!state.running)return;const k=e.key.toLowerCase();if(k==='w'||e.key==='ArrowUp')input.up=true;if(k==='s'||e.key==='ArrowDown')input.down=true;if(k==='a'||e.key==='ArrowLeft')input.left=true;if(k==='d'||e.key==='ArrowRight')input.right=true;if(k==='shift')input.run=true;if(k==='e')input.use=true;if(k==='i'||k==='tab'){e.preventDefault();toggleInventory();}if(k==='c')toggleCraft();if(k==='q')dropSelected();if(k==='escape'){if(!UI.inventory.classList.contains('hidden')||!UI.craft.classList.contains('hidden')){closePanels();state.paused=false;}else togglePause();}if(['1','2','3','4'].includes(k)){state.selectedHotbar=+k-1;refreshHotbar();}});
addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(k==='w'||e.key==='ArrowUp')input.up=false;if(k==='s'||e.key==='ArrowDown')input.down=false;if(k==='a'||e.key==='ArrowLeft')input.left=false;if(k==='d'||e.key==='ArrowRight')input.right=false;if(k==='shift')input.run=false;});
canvas.addEventListener('wheel',e=>{if(!state.running)return;e.preventDefault();state.zoom=clamp(state.zoom+(e.deltaY>0?-.08:.08),.7,1.65);UI.zoom.value=state.zoom;},{passive:false});
canvas.addEventListener('pointermove',e=>{input.pointerX=e.clientX;input.pointerY=e.clientY;});
canvas.addEventListener('pointerdown',e=>{if(!state.running||state.paused)return;if(state.mode===MODE_CREATIVE&&!isTouchDevice()&&e.button===0){const h=selectedHot();if(['wall','door','floor','stairs'].includes(h.type)){const w=screenToWorld(e.clientX,e.clientY);const id=`${state.clientId||'local'}:${Date.now().toString(36)}:${state.buildCounter++}`;const o={id,type:h.type,x:Math.round(w.x*2)/2,z:Math.round(w.z*2)/2,rot:0};state.placed.set(id,o);sendEvent({kind:'place',object:o});showMessage(`${pretty(h.type)} placed`);}}});

// Mobile joystick
const joy=$('#joystick'),stick=$('#stick');let joyId=null;
function joyUpdate(e){const r=joy.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,dx=e.clientX-cx,dy=e.clientY-cy,m=Math.min(55,Math.hypot(dx,dy)),a=Math.atan2(dy,dx);input.joyX=Math.cos(a)*(m/55);input.joyY=Math.sin(a)*(m/55);stick.style.transform=`translate(${input.joyX*46}px,${input.joyY*46}px)`;}
joy.addEventListener('pointerdown',e=>{joyId=e.pointerId;joy.setPointerCapture(e.pointerId);joyUpdate(e);});joy.addEventListener('pointermove',e=>{if(e.pointerId===joyId)joyUpdate(e);});function joyEnd(e){if(e.pointerId!==joyId)return;joyId=null;input.joyX=input.joyY=0;stick.style.transform='';}joy.addEventListener('pointerup',joyEnd);joy.addEventListener('pointercancel',joyEnd);

async function boot(){setLoading('Loading website game…',22);await sleep(160);setLoading('Preparing procedural world…',58);await sleep(130);setLoading('Ready',100);await sleep(240);UI.loading.classList.remove('show');setScreen(UI.menu);}
boot();
