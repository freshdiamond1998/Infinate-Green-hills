import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, 'site');
const PORT = Number(process.env.PORT || 8080);
const MAX_PLAYERS = Math.max(2, Math.min(32, Number(process.env.MAX_PLAYERS || 16)));
const rooms = new Map();

const mime = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'
};

function serve(req,res){
  if(req.url === '/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.clients.size,0)}));return;}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);}catch{pathname='/';}
  if(pathname==='/') pathname='/index.html';
  const file=path.resolve(SITE, '.' + pathname);
  const relative=path.relative(SITE,file);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){res.writeHead(403);res.end('Forbidden');return;}
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()){res.writeHead(404,{'content-type':'text/plain'});res.end('Not found');return;}
    const headers={'content-type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','cache-control':path.basename(file)==='index.html'?'no-cache':'public, max-age=3600'};
    res.writeHead(200,headers);fs.createReadStream(file).pipe(res);
  });
}

const server=http.createServer(serve);

function makeCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';for(let tries=0;tries<100;tries++){let s='';for(let i=0;i<6;i++)s+=chars[crypto.randomInt(chars.length)];if(!rooms.has(s))return s;}return crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();}
function makeId(){return crypto.randomBytes(6).toString('base64url');}
function roomSnapshot(room){
  return {
    removed:[...room.removed],
    placed:[...room.placed.values()],
    doors:[...room.doors.entries()],
    players:[...room.clients.values()].map(c=>({id:c.id,x:c.state.x||0,z:c.state.z||0,dir:c.state.dir||0,hp:c.state.hp??100,name:c.state.name||'Player'})),
    world:room.world,
  };
}
function jsonSend(client,obj){if(client.closed)return;sendFrame(client.socket,JSON.stringify(obj));}
function broadcast(room,obj,except=null){for(const c of room.clients.values())if(c!==except)jsonSend(c,obj);}
function leaveRoom(client){
  const room=client.room;if(!room)return;room.clients.delete(client.id);broadcast(room,{type:'player_leave',id:client.id});
  if(room.clients.size===0){rooms.delete(room.code);}else if(room.hostId===client.id){room.hostId=room.clients.keys().next().value;broadcast(room,{type:'host',id:room.hostId});}
  client.room=null;
}
function handleMessage(client,msg){
  let m;try{m=JSON.parse(msg);}catch{return;}
  if(!m||typeof m!=='object')return;
  if(m.type==='create'){
    leaveRoom(client);const code=makeCode();const mode=m.mode==='creative'?'creative':'survival';
    const room={code,mode,seed:crypto.randomInt(1,0x7fffffff),clients:new Map(),hostId:client.id,removed:new Set(),placed:new Map(),doors:new Map(),world:{time:480,day:1,weather:'clear'}};
    rooms.set(code,room);room.clients.set(client.id,client);client.room=room;client.state={x:0,z:0,dir:0,hp:100,name:'Host'};
    jsonSend(client,{type:'created',id:client.id,room:code,seed:room.seed,mode,host:true,snapshot:roomSnapshot(room)});return;
  }
  if(m.type==='join'){
    leaveRoom(client);const code=String(m.code||'').toUpperCase();const room=rooms.get(code);if(!room){jsonSend(client,{type:'error',message:'Room not found'});return;}if(room.clients.size>=MAX_PLAYERS){jsonSend(client,{type:'error',message:'Room is full'});return;}
    room.clients.set(client.id,client);client.room=room;client.state={x:0,z:0,dir:0,hp:100,name:'Player'};
    jsonSend(client,{type:'joined',id:client.id,room:room.code,seed:room.seed,mode:room.mode,host:room.hostId===client.id,snapshot:roomSnapshot(room)});
    broadcast(room,{type:'player_join',id:client.id,x:0,z:0,name:'Player'},client);return;
  }
  const room=client.room;if(!room)return;
  if(m.type==='state'){
    client.state={x:Number(m.x)||0,z:Number(m.z)||0,dir:Number(m.dir)||0,hp:Number.isFinite(m.hp)?m.hp:100,name:String(m.name||'Player').slice(0,24)};
    broadcast(room,{type:'state',id:client.id,...client.state},client);return;
  }
  if(m.type==='world'){
    if(room.hostId!==client.id)return;room.world={time:Number(m.time)||0,day:Math.max(1,Number(m.day)||1),weather:m.weather==='rain'?'rain':'clear'};broadcast(room,{type:'world',...room.world},client);return;
  }
  if(m.type==='event'&&m.event&&typeof m.event==='object'){
    const ev=m.event;
    if(ev.kind==='remove'&&typeof ev.id==='string')room.removed.add(ev.id.slice(0,160));
    else if(ev.kind==='place'&&ev.object&&typeof ev.object.id==='string'){const o={id:String(ev.object.id).slice(0,160),type:['wall','door','floor','stairs','campfire'].includes(ev.object.type)?ev.object.type:'floor',x:Number(ev.object.x)||0,z:Number(ev.object.z)||0,rot:Number(ev.object.rot)||0};room.placed.set(o.id,o);ev.object=o;}
    else if(ev.kind==='delete'&&typeof ev.id==='string')room.placed.delete(ev.id);
    else if(ev.kind==='door'&&typeof ev.id==='string')room.doors.set(ev.id.slice(0,160),!!ev.value);
    else return;
    broadcast(room,{type:'event',event:ev},client);return;
  }
}

// Minimal RFC 6455 WebSocket server. Text messages, ping/pong and close frames are supported.
function acceptWebSocket(req,socket,head){
  if(req.url!=='/ws'){socket.destroy();return;}
  const key=req.headers['sec-websocket-key'];if(!key){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const client={id:makeId(),socket,buffer:Buffer.alloc(0),room:null,state:{},closed:false};
  socket.on('data',chunk=>parseFrames(client,chunk));socket.on('error',()=>closeClient(client));socket.on('close',()=>closeClient(client));socket.on('end',()=>closeClient(client));if(head?.length)parseFrames(client,head);
}
function closeClient(client){if(client.closed)return;client.closed=true;leaveRoom(client);try{client.socket.destroy();}catch{}}
function sendFrame(socket,text,opcode=1){
  const payload=Buffer.from(text);let header;if(payload.length<126){header=Buffer.alloc(2);header[0]=0x80|opcode;header[1]=payload.length;}else if(payload.length<65536){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(payload.length,2);}else{header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);}socket.write(Buffer.concat([header,payload]));
}
function sendPong(socket,payload){let h;if(payload.length<126){h=Buffer.from([0x8A,payload.length]);}else{h=Buffer.alloc(4);h[0]=0x8A;h[1]=126;h.writeUInt16BE(payload.length,2);}socket.write(Buffer.concat([h,payload]));}
function parseFrames(client,chunk){
  client.buffer=Buffer.concat([client.buffer,chunk]);
  while(client.buffer.length>=2){
    const b=client.buffer,opcode=b[0]&0x0f,masked=(b[1]&0x80)!==0;let len=b[1]&0x7f,off=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>BigInt(8*1024*1024)){closeClient(client);return;}len=Number(big);off=10;}
    const maskLen=masked?4:0;if(b.length<off+maskLen+len)return;let mask=null;if(masked){mask=b.subarray(off,off+4);off+=4;}const payload=Buffer.from(b.subarray(off,off+len));client.buffer=b.subarray(off+len);if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
    if(opcode===0x8){closeClient(client);return;}if(opcode===0x9){sendPong(client.socket,payload);continue;}if(opcode!==0x1)continue;handleMessage(client,payload.toString('utf8'));
  }
}
server.on('upgrade',acceptWebSocket);
server.listen(PORT,'0.0.0.0',()=>console.log(`Infinite Green Hills website + multiplayer server listening on http://0.0.0.0:${PORT}`));
