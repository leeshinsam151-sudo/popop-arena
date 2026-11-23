// 펑펑 아레나 서버: 빌드된 클라이언트(dist/)와 WebSocket(/ws)을 한 포트에서 제공한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_MS } from '../shared/constants.ts';
import { NAME_MAX, ROOM_CODE_RE, type ClientMsg } from '../shared/protocol.ts';
import { Room } from './room.ts';

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 200;
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

const rooms = new Map<string, Room>();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let file = path.join(DIST, path.normalize(url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('클라이언트가 아직 빌드되지 않았습니다. 개발 중에는 npm run dev 후 http://localhost:5173 으로 접속하세요.');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws: WebSocket & { alive?: boolean }) => {
  let room: Room | null = null;
  let id = '';
  let budget = 120; // 초당 메시지 한도 (정상 클라이언트는 약 20개)
  const refill = setInterval(() => { budget = 120; }, 1000);
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    if (--budget < 0) return;
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') {
      if (Number.isFinite(msg.c)) ws.send(JSON.stringify({ t: 'pong', c: msg.c }));
      return;
    }

    if (!room) {
      if (msg.t !== 'join') return;
      const code = String(msg.room ?? '').toLowerCase();
      if (!ROOM_CODE_RE.test(code)) { ws.send(JSON.stringify({ t: 'error', msg: '방 코드가 올바르지 않아요.' })); return; }
      let r = rooms.get(code);
      if (!r) {
        if (rooms.size >= MAX_ROOMS) { ws.send(JSON.stringify({ t: 'error', msg: '서버에 방이 너무 많아요. 잠시 후 다시 시도해 주세요.' })); return; }
        r = new Room(code, () => rooms.delete(code));
        rooms.set(code, r);
      }
      const name = String(msg.name ?? '').trim().slice(0, NAME_MAX) || '플레이어';
      const c = r.add(ws, name, Number(msg.char));
      if (!c) { ws.send(JSON.stringify({ t: 'error', msg: '방이 가득 찼어요.' })); return; }
      room = r;
      id = c.id;
      return;
    }
    room.onMessage(id, msg);
  });

  ws.on('close', () => {
    clearInterval(refill);
    room?.remove(id);
  });
});

// 끊긴 연결 정리 (호스팅 프록시의 유휴 타임아웃도 방지)
setInterval(() => {
  for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 15000);

// 고정 틱 루프 (setTimeout 오차를 누적 보정)
let next = performance.now();
function loop() {
  const now = performance.now();
  if (now - next > 1000) next = now; // 서버가 오래 멈췄다면 따라잡지 않고 건너뜀
  while (next <= now) {
    for (const r of rooms.values()) r.tick();
    next += TICK_MS;
  }
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

server.listen(PORT, () => console.log(`펑펑 아레나 서버 실행 중: http://localhost:${PORT}`));
