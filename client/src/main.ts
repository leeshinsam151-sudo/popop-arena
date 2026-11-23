import * as THREE from 'three';
import './style.css';
import { BUBBLE_TICKS, CHARACTERS, DT, Dir, MAX_PLAYERS, SANDSTORM_PERIOD, SANDSTORM_TICKS, SUDDEN_TICKS, TEAM_COLORS, TEAM_NAMES, TICK_RATE } from '../../shared/constants.ts';
import { MAP_IDS, MAP_NAMES, type MapId } from '../../shared/maps.ts';
import type { MetaPlayer, ServerMsg } from '../../shared/protocol.ts';
import { featureAt, spawnOrder, teamSpawns, movePlayer, updatePassers, type GameState, type PlayerState } from '../../shared/sim.ts';
import { Arena } from './arena.ts';
import { createCharacter, type CharacterModel } from './characters.ts';
import { Input } from './input.ts';
import { Net } from './net.ts';
import { Studio, lobbyTiles } from './studio.ts';
import { GameAudio, type Sfx } from './audio.ts';

type Snap = Extract<ServerMsg, { t: 's' }>;
type Meta = Extract<ServerMsg, { t: 'meta' }>;

const INTERP_MS = 80; // 다른 플레이어는 80ms 전 상태를 보간해서 그림 (스냅샷 간격 50ms + 흔들림 여유)
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

// ---------- 방 코드 (URL #코드) ----------
function roomFromUrl(): string {
  let c = location.hash.slice(1).toLowerCase();
  if (!/^[a-z0-9]{4,12}$/.test(c)) {
    c = Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
    history.replaceState(null, '', '#' + c);
  }
  return c;
}
const ROOM = roomFromUrl();
addEventListener('hashchange', () => location.reload());

// ---------- three.js ----------
const canvas = $<HTMLCanvasElement>('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(17, 26, 19);
sun.target.position.set(9, 0, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, far: 80 });
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const arena = new Arena(scene);
const input = new Input();
const net = new Net();
const audio = new GameAudio();
audio.setMusic('lobby');
// 브라우저는 사용자가 한 번 누르기 전까지 소리를 막으므로, 첫 입력 때 켬
addEventListener('pointerdown', () => audio.unlock());
addEventListener('keydown', () => audio.unlock());

// ---------- 상태 ----------
let myId = '';
let joined = false;
let meta: Meta | null = null;
const snaps: { at: number; s: Snap }[] = [];
let pred: { state: GameState; me: PlayerState } | null = null;
/** 서버 보정으로 위치가 바뀔 때 순간이동처럼 보이지 않도록 서서히 줄여 나가는 화면 오프셋 */
const corr = { x: 0, y: 0 };
let rtt = 0; // 서버 왕복 시간(ms), 0이면 아직 측정 전
let pending: { s: number; d: Dir }[] = [];
let seq = 0;
let shake = 0;
let lastFlames = 0;
let hadKick = false;
let hadGlove = false;

interface Avatar { model: CharacterModel; char: number; name: string; team: number; last: { x: number; y: number }; dead: boolean; label: THREE.Sprite; trapped: number; deadAt: number; deathPos: { x: number; y: number } | null; ghost: boolean }
const avatars = new Map<string, Avatar>();

function nameSprite(text: string, color: number) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '34px Jua, sans-serif';
  const w = Math.min(240, g.measureText(text).width + 40);
  g.fillStyle = 'rgba(20,22,30,0.75)';
  g.beginPath(); g.roundRect((256 - w) / 2, 8, w, 48, 24); g.fill();
  g.fillStyle = hex(color);
  g.beginPath(); g.arc((256 - w) / 2 + 20, 32, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128 + 8, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = 1.85;
  s.renderOrder = 10;
  return s;
}

function avatarFor(id: string, char: number, name: string, team = -1): Avatar {
  let a = avatars.get(id);
  if (a && (a.char !== char || a.name !== name || a.team !== team)) { removeAvatar(id); a = undefined; }
  if (!a) {
    const model = createCharacter(char);
    // 팀전이면 발밑 링과 이름표 점을 팀 색으로
    const color = team >= 0 ? TEAM_COLORS[team] : CHARACTERS[char].color;
    const label = nameSprite(name, color);
    model.setRingColor(color);
    model.root.add(label);
    scene.add(model.root);
    a = { model, char, name, team, last: { x: 0, y: 0 }, dead: false, label, trapped: 0, deadAt: 0, deathPos: null, ghost: false };
    avatars.set(id, a);
  }
  return a;
}
function removeAvatar(id: string) {
  const a = avatars.get(id);
  if (!a) return;
  scene.remove(a.model.root);
  a.model.dispose();
  avatars.delete(id);
}
const clearAvatars = () => [...avatars.keys()].forEach(removeAvatar);
const metaPlayer = (id: string): MetaPlayer | undefined => meta?.players.find((p) => p.id === id);

// ---------- 네트워크 ----------
net.onOpen = () => {
  const btn = $<HTMLButtonElement>('join-btn');
  btn.disabled = false;
  btn.textContent = '입장하기';
  $('status').classList.add('hidden');
};
net.onClose = () => {
  const st = $('status');
  st.innerHTML = '';
  st.append('서버와 연결이 끊겼어요.');
  const b = document.createElement('button');
  b.textContent = '다시 연결';
  b.onclick = () => location.reload();
  st.append(b);
  st.classList.remove('hidden');
};
net.onMessage = (m) => {
  if (m.t === 'welcome') { myId = m.id; joined = true; renderUI(); }
  else if (m.t === 'meta') onMeta(m);
  else if (m.t === 's') onSnap(m);
  else if (m.t === 'pong') {
    const sample = performance.now() - m.c;
    rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
    const el = $('ping');
    if (!joined) return; // 입장 화면에서는 버튼을 가리지 않도록 숨김
    el.textContent = `📶 ${Math.round(rtt)}ms`;
    el.className = rtt < 90 ? 'good' : rtt < 160 ? 'ok' : 'bad';
  }
  else if (m.t === 'error') { toast(m.msg); }
};
net.connect();

function onMeta(m: Meta) {
  const prev = meta?.phase;
  meta = m;
  if (m.phase === 'playing' && prev !== 'playing') {
    audio.play('start');
    audio.setMusic(m.mapId);
    lastSec = -1;
  }
  if (m.phase === 'ended' && prev === 'playing' && m.result) {
    const myTeam = metaPlayer(myId)?.team ?? -1;
    const won = m.result.team !== undefined ? m.result.team === myTeam : m.result.winner === myId;
    audio.play(m.result.final && m.target > 1 && (m.result.winner || m.result.team !== undefined) ? 'champion' : won ? 'win' : 'lose');
  }
  if (m.phase === 'lobby') audio.setMusic('lobby');
  if (m.phase === 'playing' && prev !== 'playing') {
    snaps.length = 0; pred = null; pending = []; lastFlames = 0;
    clearAvatars();
    arena.build(m.mapId);
  }
  if (m.phase === 'lobby') {
    if (prev && prev !== 'lobby') { snaps.length = 0; pred = null; clearAvatars(); arena.mapId = null; }
    showLobbyScene();
  }
  renderUI();
}

/** 로비: 선택된 맵을 블록 없이 보여 주고 참가자를 스폰 위치에 세움 */
function showLobbyScene() {
  if (!meta) return;
  if (arena.mapId !== meta.mapId) {
    arena.build(meta.mapId);
    arena.setTiles(lobbyTiles(meta.mapId));
  }
  const lobbyIds = new Set<string>();
  const spawns = spawnOrder(arena.w, arena.h);
  const tSpawns = teamSpawns(arena.w, arena.h);
  const teamCount = [0, 0];
  // 이번 판 참가자: 사람 앞 6명 + 봇 (서버와 같은 순서)
  const humans = meta.players.filter((p) => !p.bot).slice(0, MAX_PLAYERS);
  [...humans, ...meta.players.filter((p) => p.bot)].slice(0, MAX_PLAYERS).forEach((p, i) => {
    lobbyIds.add(p.id);
    const a = avatarFor(p.id, p.char, p.name, p.team);
    const [x, y] = p.team >= 0 ? tSpawns[p.team][teamCount[p.team]++] ?? spawns[i] : spawns[i];
    a.model.root.position.set(x, 0, y);
    a.model.root.rotation.y = 0;
    a.last = { x, y };
  });
  for (const id of [...avatars.keys()]) if (!lobbyIds.has(id)) removeAvatar(id);
}

function onSnap(s: Snap) {
  if (!meta) return;
  if (arena.mapId !== meta.mapId) arena.build(meta.mapId);
  const prevSnap = snaps.at(-1)?.s;
  if (prevSnap) snapEvents(prevSnap, s);
  snaps.push({ at: performance.now(), s });
  while (snaps.length > 40) snaps.shift();
  arena.setTiles(s.tiles);
  arena.syncBombs(s.bombs);
  arena.syncFlames(s.flames);
  arena.syncItems(s.items);
  if (s.flames.length > lastFlames) shake = Math.min(0.35, shake + 0.12 + (s.flames.length - lastFlames) * 0.01);
  lastFlames = s.flames.length;

  // 내 캐릭터: 서버 상태에서 아직 처리 안 된 입력을 다시 적용 (예측 보정)
  const me = s.players.find((p) => p.id === myId);
  if (me) {
    pending = pending.filter((p) => p.s > s.ack);
    const st: GameState = {
      mapId: meta.mapId, w: arena.w, h: arena.h, tiles: [...s.tiles].map(Number),
      players: [{ ...me }], bombs: s.bombs.map((b) => ({ ...b, passers: [...b.passers] })),
      flames: [], items: [], tick: s.tick, nextBombId: 0,
    };
    const mine = st.players[0];
    for (const p of pending) { movePlayer(st, mine, p.d, DT); updatePassers(st); }
    if (pred) {
      const ex = pred.me.x - mine.x, ey = pred.me.y - mine.y;
      if (Math.abs(ex) < 1 && Math.abs(ey) < 1) { corr.x += ex; corr.y += ey; } // 작은 보정은 부드럽게
    }
    pred = { state: st, me: mine };
  } else {
    pred = null;
  }
  updateHud(s);
}

// ---------- 고정 틱 입력 ----------
function fixedStep() {
  if (!joined) return;
  seq++;
  const d = input.dir;
  net.send({ t: 'in', s: seq, d, b: input.bombCount });
  if (meta?.phase === 'playing' && pred && pred.me.alive) {
    movePlayer(pred.state, pred.me, d, DT);
    updatePassers(pred.state);
    pending.push({ s: seq, d });
  }
}

/** 내 캐릭터 화면 위치: 다음 입력 틱까지 기다리지 않고, 지금 누른 키로 남은 시간만큼 미리 움직여 본다 */
function previewMe(alpha: number): { x: number; y: number; h: number } {
  const st = pred!.state, me = pred!.me;
  if (alpha <= 0 || !me.alive) return { x: me.x, y: me.y, h: jumpHeight(me.jump) };
  // 키를 안 눌러도 얼음 미끄러짐·점프는 계속 진행되므로 항상 미리 계산
  const ghost = { ...me, jump: me.jump ? { ...me.jump } : null };
  const tmp: GameState = { ...st, players: [ghost], bombs: st.bombs.map((b) => ({ ...b })) };
  movePlayer(tmp, ghost, input.dir, DT * alpha);
  return { x: ghost.x, y: ghost.y, h: jumpHeight(ghost.jump) };
}

/** 🍄 점프 포물선 높이 */
const jumpHeight = (j: { t: number; total: number } | null) => {
  if (!j) return 0;
  const k = j.t / j.total;
  return 4 * 1.3 * k * (1 - k);
};

// 폭탄 키: 서버 응답을 기다리지 않고 폭탄을 먼저 그림 (서버 폭탄이 도착하면 교체)
input.onBomb = () => {
  if (meta?.phase !== 'playing' || !pred || !pred.me.alive) return;
  const me = pred.me, st = pred.state;
  const cx = Math.round(me.x), cy = Math.round(me.y);
  const onBomb = st.bombs.some((b) => b.fly === 0 && b.x === cx && b.y === cy);
  if (onBomb) return; // 이미 폭탄 위 (글러브라면 던지기)
  if (st.bombs.filter((b) => b.owner === myId).length >= me.bombMax) return;
  arena.ghostBomb(cx, cy);
  audio.play('place');
};

// ---------- 효과음: 스냅샷 변화로 사건 감지 ----------
const listener = { x: 9, y: 7 }; // 소리를 듣는 위치 (카메라가 보는 곳)
let lastSec = -1;
function sfxAt(name: Sfx, x: number, y: number, base = 1) {
  const d = Math.hypot(x - listener.x, y - listener.y);
  const vol = base * Math.max(0.12, 1 - d / 13);
  const pan = Math.max(-0.8, Math.min(0.8, (x - listener.x) / 7));
  audio.play(name, vol, pan);
}

function snapEvents(prev: Snap, cur: Snap) {
  // 폭탄: 새로 놓임(다른 사람), 차임, 던져짐, 착지, 폭발
  const prevBombs = new Map(prev.bombs.map((b) => [b.id, b]));
  const curIds = new Set(cur.bombs.map((b) => b.id));
  for (const b of cur.bombs) {
    const pb = prevBombs.get(b.id);
    if (!pb) { if (b.fly > 0) sfxAt('throw', b.sx, b.sy); else if (b.owner !== myId) sfxAt('place', b.x, b.y, 0.8); continue; }
    if (!pb.slide && b.slide) sfxAt('kick', b.fx, b.fy);
    if (pb.fly === 0 && b.fly > 0) sfxAt('throw', b.sx, b.sy);
    if (pb.fly > 0 && b.fly === 0) sfxAt('land', b.x, b.y);
  }
  let booms = 0;
  for (const pb of prev.bombs) {
    if (curIds.has(pb.id) || booms >= 3) continue;
    sfxAt('explode', pb.x, pb.y, booms ? 0.6 : 1);
    booms++;
  }
  // 🧊 언 상자에 금이 감
  for (let i = 0; i < cur.tiles.length; i++) {
    if (prev.tiles[i] === '4' && cur.tiles[i] === '5') { sfxAt('crack', i % arena.w, Math.floor(i / arena.w)); break; }
  }
  // 🌋 근처 용암 분출 시작
  const prevLava = new Set(prev.flames.filter((f) => f.lava).map((f) => `${f.x},${f.y}`));
  const nearLava = cur.flames.find((f) => f.lava && !prevLava.has(`${f.x},${f.y}`) && Math.hypot(f.x - listener.x, f.y - listener.y) < 4.5);
  if (nearLava) sfxAt('lava', nearLava.x, nearLava.y, 0.55); // 가까운 균열만, 작게 (너무 자주 울리지 않도록)
  // 플레이어: 사망, 🍄 점프, 🌀 워프, 아이템 획득
  for (const p of cur.players) {
    const pp = prev.players.find((q) => q.id === p.id);
    if (!pp) continue;
    if (pp.alive && !p.alive) sfxAt('death', p.x, p.y, p.id === myId ? 1.2 : 0.9);
    if (!pp.trapped && p.trapped) sfxAt('trap', p.x, p.y, p.id === myId ? 1.2 : 0.9); // 🫧 갇힘
    if (pp.trapped && !p.trapped && p.alive) sfxAt('rescue', p.x, p.y); // 구출
    if (!pp.jump && p.jump) {
      arena.bounceMushroom(Math.round(p.jump.sx), Math.round(p.jump.sy));
      sfxAt('boing', p.jump.sx, p.jump.sy);
    }
    if (p.alive && Math.hypot(p.x - pp.x, p.y - pp.y) > 1.5 && !p.jump && !pp.jump) sfxAt('warp', p.x, p.y);
    if (p.id === myId) {
      if ((p.kick && !pp.kick) || (p.glove && !pp.glove)) audio.play('power');
      else if (p.bombMax > pp.bombMax || p.range > pp.range || p.speedLv > pp.speedLv) audio.play('pickup');
    }
  }
  // ⚠️ 서든데스 시작: 경보, 배경음 빨라짐
  if (prev.timeLeft > SUDDEN_TICKS && cur.timeLeft <= SUDDEN_TICKS) {
    audio.play('siren');
    audio.setTempo(1.25);
    toast('⚠️ 서든데스! 바깥부터 벽이 떨어져요. 가운데로!');
  }
  // 근처에 벽이 쿵
  for (let i = 0; i < cur.tiles.length; i++) {
    if (cur.tiles[i] !== '6' || prev.tiles[i] === '6') continue;
    const x = i % arena.w, y = Math.floor(i / arena.w);
    const d = Math.hypot(x - listener.x, y - listener.y);
    if (d < 9) { sfxAt('thud', x, y, 0.7); shake = Math.max(shake, 0.12 * (1 - d / 9)); }
    break;
  }
  // 남은 10초 카운트다운
  const sec = Math.ceil(cur.timeLeft / TICK_RATE);
  if (meta?.phase === 'playing' && sec !== lastSec && sec <= 10 && sec > 0) audio.play('tick');
  lastSec = sec;
}

// 핑: 1초마다 서버 왕복 시간 측정
setInterval(() => { if (net.open) net.send({ t: 'ping', c: performance.now() }); }, 1000);

// ---------- 렌더 루프 ----------
const camPos = new THREE.Vector3(9, 18, 21);
const camLook = new THREE.Vector3(9, 0, 7);
camera.position.copy(camPos);
let acc = 0;
let last = performance.now();

function frame(now: number) {
  const elapsed = (now - last) / 1000;
  last = now;
  // 입력은 실제 시간 기준으로 생성 (프레임이 낮아도 이동 속도 유지, 최대 0.5초까지 보충)
  acc = Math.min(acc + elapsed, 0.5);
  const dt = Math.min(0.1, elapsed);
  while (acc >= DT) { acc -= DT; fixedStep(); }
  render(now, dt, acc / DT);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let debugCam: { pos: [number, number, number]; look: [number, number, number] } | null = null;

/** 🌪️ 사막: 45초마다 8초 동안 모래폭풍으로 시야가 좁아짐 (연출만, 판정 영향 없음) */
let storm = 0;
let stormOn = false;
function updateSandstorm(tick: number, dt: number) {
  const active = tick >= 0 && meta?.mapId === 'desert' && meta.phase === 'playing'
    && tick % SANDSTORM_PERIOD >= SANDSTORM_PERIOD - SANDSTORM_TICKS;
  if (active && !stormOn) toast('🌪️ 모래폭풍! 잠시 시야가 좁아져요');
  stormOn = active;
  const target = active ? 1 : 0;
  if (Math.abs(storm - target) < 0.001 && storm === target) return;
  storm += (target - storm) * Math.min(1, dt * 1.5);
  if (Math.abs(storm - target) < 0.01) storm = target;
  if (meta?.mapId === 'desert') arena.setSandstorm(storm);
}

function render(now: number, dt: number, alpha: number) {
  const t = now / 1000;
  const latest = snaps.at(-1)?.s;
  let focus: { x: number; y: number } | null = null;

  if (meta && meta.phase !== 'lobby' && latest) {
    const rt = now - INTERP_MS;
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].at <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
    }
    const k = b.at === a.at ? 1 : Math.min(1, Math.max(0, (rt - a.at) / (b.at - a.at)));
    const ids = new Set<string>();
    for (const p of latest.players) {
      ids.add(p.id);
      const mp = metaPlayer(p.id);
      const av = avatarFor(p.id, mp?.char ?? p.slot % CHARACTERS.length, mp?.name ?? '???', p.team);
      let x: number, y: number, h = 0;
      if (p.id === myId && pred && p.alive) {
        const pv = previewMe(alpha);
        const decay = Math.exp(-dt * 12);
        corr.x *= decay; corr.y *= decay;
        x = pv.x + corr.x;
        y = pv.y + corr.y;
        h = pv.h;
      } else {
        const pa = a.s.players.find((q) => q.id === p.id) ?? p;
        const pb = b.s.players.find((q) => q.id === p.id) ?? p;
        if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 1.5) {
          x = pb.x; y = pb.y; // 🌀 워프: 맵을 가로질러 미끄러지지 않게 바로 이동
        } else {
          x = lerp(pa.x, pb.x, k);
          y = lerp(pa.y, pb.y, k);
        }
        const ja = pa.jump, jb = pb.jump;
        if (ja || jb) {
          const jt = ja && jb ? lerp(ja.t, jb.t, k) : (jb ? jb.t * k : (ja!.total));
          h = jumpHeight({ t: jt, total: (jb ?? ja)!.total });
        }
      }
      const dx = x - av.last.x, dy = y - av.last.y;
      const moving = Math.hypot(dx, dy) > 0.002;
      if (moving) {
        const target = Math.atan2(dx, dy);
        let diff = target - av.model.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        av.model.root.rotation.y += diff * Math.min(1, dt * 18);
      }
      // 👻 탈락: 쓰러진 자리에서 1.3초 쓰러지는 연출 → 경기장 밖(서버가 정한 유령 위치)에서 유령으로
      if (!p.alive && !av.dead) {
        av.dead = true; av.deadAt = now; av.deathPos = { ...av.last };
        av.model.die(); av.label.visible = false;
      }
      if (av.dead && !av.ghost && now - av.deadAt < 1300) { x = av.deathPos!.x; y = av.deathPos!.y; }
      else if (av.dead && !av.ghost) {
        av.ghost = true;
        av.model.becomeGhost();
        av.model.root.remove(av.label);
        av.label = nameSprite(`👻 ${mp?.name ?? '???'}`, 0xffffff);
        av.label.position.y = 2.2;
        av.model.root.add(av.label);
      }
      av.model.root.position.set(x, h, y);
      av.last = { x, y };
      // 🌲 덤불 속: 다른 사람에게는 거의 안 보이고 이름표도 숨김, 나는 반투명
      const inBush = p.alive && meta.mapId === 'forest' && featureAt(meta.mapId, Math.round(x), Math.round(y)) === 'G' && h === 0;
      if (p.alive) av.model.setOpacity(inBush ? (p.id === myId ? 0.5 : 0.12) : 1);
      if (p.alive) av.label.visible = !inBush || p.id === myId;
      av.model.animate(t, dt, moving && p.alive && !p.trapped);
      // 🫧 물방울: 서버가 알려 준 남은 시간 기준
      av.model.setBubble(p.alive && p.trapped ? p.trapped / BUBBLE_TICKS : 0, t);
      if (p.id === myId && p.alive) focus = { x, y };
    }
    for (const id of [...avatars.keys()]) if (!ids.has(id)) removeAvatar(id);

    // 폭탄: 다른 플레이어와 같은 시점으로 보간 (차여서 미끄러짐, 던져져서 포물선 비행)
    for (const bl of latest.bombs) {
      const bb = b.s.bombs.find((q) => q.id === bl.id) ?? bl;
      const ba = a.s.bombs.find((q) => q.id === bl.id) ?? bb;
      if (bb.fly > 0 || ba.fly > 0) {
        const fly = ba.fly > 0 && bb.fly > 0 ? lerp(ba.fly, bb.fly, k) : (bb.fly > 0 ? bb.fly : 0);
        const f = bb.fly > 0 ? bb : ba;
        const prog = f.flyTotal ? 1 - fly / f.flyTotal : 1;
        arena.poseBomb(bl.id, lerp(f.sx, f.x, prog), lerp(f.sy, f.y, prog), 4 * 1.6 * prog * (1 - prog), prog * Math.PI * 2);
      } else {
        const x = lerp(ba.fx, bb.fx, k), y = lerp(ba.fy, bb.fy, k);
        const rolled = (x - bl.x) + (y - bl.y);
        arena.poseBomb(bl.id, x, y, 0, bb.slide ? rolled * 3 : 0);
      }
    }
  } else {
    for (const av of avatars.values()) av.model.animate(t, dt, false);
  }

  // 카메라: 살아 있으면 내 캐릭터 추적, 아니면 맵 전체
  const mw = arena.w || 19, mh = arena.h || 15;
  const cx = (mw - 1) / 2, cy = (mh - 1) / 2;
  // 추적 카메라는 맵 가장자리에서 바깥 빈 공간을 비추지 않도록 범위를 제한
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const look = focus
    ? new THREE.Vector3(clamp(focus.x, 6, mw - 7), 0, clamp(focus.y, 4, mh - 6) + 0.5)
    : new THREE.Vector3(cx, 0, cy + 1);
  // 전체 보기: 맵 크기에 맞춰 거리 조절. 내가 유령이면 경기장 밖까지 보이게 조금 더 멀리
  const meGhost = meta?.phase !== 'lobby' && latest?.players.find((p) => p.id === myId)?.alive === false;
  const pos = focus ? look.clone().add(new THREE.Vector3(0, 11.5, 8.5)) : look.clone().add(new THREE.Vector3(0, 21, 15).multiplyScalar((mw / 23) * (meGhost ? 1.3 : 1)));
  const kk = 1 - Math.exp(-dt * 6);
  camPos.lerp(pos, kk);
  camLook.lerp(look, kk);
  if (debugCam) { camPos.set(...debugCam.pos); camLook.set(...debugCam.look); } // 개발용 (?debug)
  camera.position.copy(camPos);
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    shake *= Math.exp(-dt * 9);
  }
  camera.lookAt(camLook);
  listener.x = camLook.x; listener.y = camLook.z - 0.5;

  // 서버 틱을 부드럽게 추정 (용암 균열 경고·분출, 모래폭풍 타이밍)
  const lastSnap = snaps.at(-1);
  if (lastSnap && meta?.phase !== 'lobby') {
    const tickF = lastSnap.s.tick + (now - lastSnap.at) / (1000 / TICK_RATE);
    arena.setTick(tickF);
    updateSandstorm(tickF, dt);
  } else {
    updateSandstorm(-1, dt);
  }

  arena.update(t, dt);
  renderer.render(scene, camera);
}

// ---------- UI ----------
let myChar = Number(store.get('popop.char') ?? Math.floor(Math.random() * CHARACTERS.length));
if (!(myChar >= 0 && myChar < CHARACTERS.length)) myChar = 0;
const nameInput = $<HTMLInputElement>('name');
nameInput.value = store.get('popop.name') ?? '';
nameInput.placeholder = '닉네임 (최대 12자)';
$('join-room').textContent = ROOM;
$('room-code').textContent = ROOM;

const MAP_DESC: Record<MapId, string> = {
  glacier: '🧊 가운데 탁 트인 얼음 호수. 숨을 곳이 적은 정면 승부',
  volcano: '🌋 용암 강은 다리 3개로만 건널 수 있어요. 다리 앞 눈치싸움',
  forest: '🌲 나무 3그루와 덤불 사이로 돌아가는 길이 많은 맵',
  desert: '🏜️ 가운데 오아시스를 둘러싼 넓은 모래밭',
  park: '🎢 대관람차를 도는 컨베이어 벨트! 폭탄도 실려 가요. 귀퉁이엔 트램펄린',
};

// 썸네일·미리보기 (첫 화면이 뜬 뒤 만들어서 로딩을 막지 않음)
const studio = new Studio();
let charThumbs: string[] = [];
let mapThumbs: Partial<Record<MapId, string>> = {};
setTimeout(() => {
  try {
    charThumbs = studio.characterThumbs();
    mapThumbs = studio.mapThumbs();
  } catch (err) { console.warn('썸네일 생성 실패', err); }
  if (!joined) studio.startPreview($('preview-stage'), myChar);
  renderUI();
}, 30);

function charCards(el: HTMLElement, selected: number, taken: Set<number>, onPick: (i: number) => void) {
  el.innerHTML = '';
  CHARACTERS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = i === selected ? 'on' : '';
    b.disabled = taken.has(i);
    b.title = `${c.name} · ${c.desc}`;
    if (charThumbs[i]) {
      const img = document.createElement('img');
      img.src = charThumbs[i];
      img.alt = c.name;
      b.append(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'thumb-fallback';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = hex(c.color);
      ph.append(dot);
      b.append(ph);
    }
    b.append(c.name);
    if (taken.has(i)) {
      const tag = document.createElement('span');
      tag.className = 'taken';
      tag.textContent = '사용 중';
      b.append(tag);
    }
    b.onclick = () => onPick(i);
    el.append(b);
  });
}

function showPreviewInfo() {
  const c = CHARACTERS[myChar];
  const nameEl = $('preview-name');
  nameEl.textContent = c.name;
  nameEl.style.color = hex(c.color);
  $('preview-desc').textContent = c.desc;
  studio.setPreviewChar(myChar);
}

function doJoin() {
  const name = nameInput.value.trim().slice(0, 12) || `플레이어${Math.floor(Math.random() * 90 + 10)}`;
  store.set('popop.name', name);
  store.set('popop.char', String(myChar));
  requestedChar = myChar;
  net.send({ t: 'join', room: ROOM, name, char: myChar });
}
let requestedChar = -1; // 입장할 때 고른 캐릭터 (이미 누가 쓰고 있으면 서버가 바꿔 줌)
$('join-btn').onclick = doJoin;
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

$('copy-btn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('초대 링크를 복사했어요! 팀원에게 보내 주세요');
  } catch {
    prompt('이 링크를 복사해서 팀원에게 보내 주세요', location.href);
  }
};
$('start-btn').onclick = () => net.send({ t: 'start' });
$('bot-minus').onclick = () => meta && net.send({ t: 'bots', n: meta.bots - 1 });
$('bot-plus').onclick = () => meta && net.send({ t: 'bots', n: meta.bots + 1 });
$('mode-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.onclick = () => net.send({ t: 'mode', mode: b.dataset.mode as 'solo' | 'team' });
});
$('sets-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.onclick = () => net.send({ t: 'sets', n: Number(b.dataset.sets) });
});
$('team-pick').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.onclick = () => net.send({ t: 'team', team: Number(b.dataset.team) });
});

// 🔊 효과음 / 🎵 배경음 켜고 끄기 (브라우저에 기억)
const sfxBtn = $<HTMLButtonElement>('sfx-btn'), musicBtn = $<HTMLButtonElement>('music-btn');
const paintSound = () => {
  sfxBtn.textContent = audio.sfxOn ? '🔊' : '🔇';
  sfxBtn.title = audio.sfxOn ? '효과음 끄기' : '효과음 켜기';
  musicBtn.textContent = '🎵';
  musicBtn.classList.toggle('off', !audio.musicOn);
  musicBtn.title = audio.musicOn ? '배경음 끄기' : '배경음 켜기';
};
sfxBtn.onclick = () => { audio.unlock(); audio.toggleSfx(); paintSound(); sfxBtn.blur(); };
musicBtn.onclick = () => { audio.unlock(); audio.toggleMusic(); paintSound(); musicBtn.blur(); };
paintSound();

function renderUI() {
  $('join').classList.toggle('hidden', joined);
  if (!joined) {
    charCards($('join-chars'), myChar, new Set(), (i) => { myChar = i; store.set('popop.char', String(i)); renderUI(); });
    showPreviewInfo();
    return;
  }
  studio.stopPreview();
  const m = meta;
  if (!m) return;
  const isHost = m.host === myId;
  const me = metaPlayer(myId);
  if (me) {
    if (requestedChar >= 0 && me.char !== requestedChar) {
      toast(`${CHARACTERS[requestedChar].name}은(는) 이미 다른 사람이 골라서 ${CHARACTERS[me.char].name}(으)로 바꿨어요. 대기실에서 다시 고를 수 있어요`);
    }
    requestedChar = -1;
    myChar = me.char;
    store.set('popop.char', String(me.char));
  }

  $('lobby').classList.toggle('hidden', m.phase !== 'lobby');
  $('hud').classList.toggle('hidden', m.phase === 'lobby');

  // 플레이어 목록 (사람 → 봇 순, 팀전이면 팀 표시)
  const ul = $('players');
  ul.innerHTML = '';
  const humans = m.players.filter((p) => !p.bot);
  const bots = m.players.filter((p) => p.bot);
  [...humans, ...bots].forEach((p) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = hex(CHARACTERS[p.char].color);
    const name = document.createElement('span');
    name.className = 'name';
    const spectator = !p.bot && humans.indexOf(p) >= MAX_PLAYERS;
    name.textContent = (p.id === m.host ? '👑 ' : '') + (p.bot ? '🤖 ' : '') + p.name + (p.id === myId ? ' (나)' : '') + (spectator ? ' · 관전' : '');
    li.append(dot, name);
    if (p.team >= 0) {
      const badge = document.createElement('span');
      badge.className = `badge t${p.team}`;
      badge.textContent = TEAM_NAMES[p.team];
      li.append(badge);
    }
    const wins = document.createElement('span');
    wins.className = 'wins';
    wins.textContent = p.wins ? `${p.wins}승` : '';
    li.append(wins);
    ul.append(li);
  });
  const total = Math.min(humans.length, MAX_PLAYERS) + bots.length;
  $('count').textContent = `${total}/${MAX_PLAYERS}`;

  // 🤖 봇 수 (방장만 조절)
  $('bot-count').textContent = String(m.bots);
  const botMax = MAX_PLAYERS - Math.min(humans.length, MAX_PLAYERS);
  $<HTMLButtonElement>('bot-minus').disabled = !isHost || m.bots <= 0;
  $<HTMLButtonElement>('bot-plus').disabled = !isHost || m.bots >= botMax;
  // 개인전 / 팀전 (팀전은 총 4명 또는 6명일 때)
  const teamOk = total >= 4 && total % 2 === 0;
  $('mode-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === m.mode);
    b.disabled = !isHost || (b.dataset.mode === 'team' && !teamOk);
  });
  $('mode-hint').textContent = m.mode === 'team'
    ? '🫧 맞으면 물방울에 갇혀요. 같은 팀이 닿으면 구출, 상대가 닿거나 5초가 지나면 탈락!'
    : teamOk ? '' : '팀전은 사람과 봇을 합쳐 4명 또는 6명일 때 고를 수 있어요';
  $('sets-seg').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.sets) === m.target);
    b.disabled = !isHost;
  });
  const teamPick = $('team-pick');
  teamPick.classList.toggle('hidden', m.mode !== 'team');
  teamPick.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.className = `team-${b.dataset.team}` + (Number(b.dataset.team) === me?.team ? ' on' : '');
  });

  const taken = new Set(m.players.filter((p) => p.id !== myId && !p.bot).map((p) => p.char));
  charCards($('lobby-chars'), myChar, taken, (i) => net.send({ t: 'char', char: i }));

  const maps = $('maps');
  maps.innerHTML = '';
  for (const id of MAP_IDS) {
    const b = document.createElement('button');
    b.className = id === m.pick ? 'on' : '';
    b.disabled = !isHost;
    if (mapThumbs[id]) {
      const img = document.createElement('img');
      img.src = mapThumbs[id]!;
      img.alt = MAP_NAMES[id];
      b.append(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'map-ph';
      b.append(ph);
    }
    b.append(MAP_NAMES[id]);
    b.title = MAP_DESC[id];
    b.onclick = () => net.send({ t: 'map', mapId: id });
    maps.append(b);
  }
  const rnd = document.createElement('button');
  rnd.className = 'random' + (m.pick === 'random' ? ' on' : '');
  rnd.disabled = !isHost;
  rnd.textContent = '🎲 랜덤 (판마다 무작위)';
  rnd.onclick = () => net.send({ t: 'map', mapId: 'random' });
  maps.append(rnd);
  $('map-desc').textContent = m.pick === 'random' ? '🎲 게임을 시작할 때 4개 맵 중 하나가 무작위로 골라져요' : MAP_DESC[m.pick];
  $('map-hint').textContent = isHost ? '· 눌러서 선택' : '· 방장이 선택해요';
  $('start-btn').classList.toggle('hidden', !isHost);
  const teamSize = [0, 1].map((t) => m.players.filter((p) => p.team === t && (p.bot || humans.indexOf(p) < MAX_PLAYERS)).length);
  $('wait-msg').textContent = !isHost ? '방장이 게임을 시작하기를 기다리는 중…'
    : m.mode === 'team' && teamSize[0] !== teamSize[1] ? `⚠️ 팀 인원을 맞춰 주세요 (A팀 ${teamSize[0]} : B팀 ${teamSize[1]})`
    : total === 1 ? '혼자서도 연습할 수 있어요. 🤖 봇을 넣거나 초대 링크로 팀원을 불러 보세요!' : '';

  renderSetBar(m);
  const banner = $('banner');
  if (m.phase === 'ended' && m.result) {
    const w = m.result.winner ? metaPlayer(m.result.winner) : undefined;
    const team = m.result.team;
    const who = team !== undefined ? TEAM_NAMES[team] : w?.name;
    const finalSet = m.result.final && m.target > 1 && who;
    banner.textContent = finalSet ? `🏆 ${who} 최종 우승!`
      : who ? `🎉 ${who} 승리!` : (m.players.filter((p) => p.playing).length <= 1 ? '💥 게임 오버' : '🤝 무승부!');
    if (m.target > 1 && !m.result.final) {
      const small = document.createElement('small');
      small.textContent = `${m.round}라운드 끝 · 곧 다음 판이 시작돼요`;
      banner.append(small);
    }
    banner.style.color = team !== undefined ? hex(TEAM_COLORS[team]) : '';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

/** 🏆 세트 점수 바: "2승 먼저 · 3라운드 | A팀 ★ : ★★ B팀" */
function renderSetBar(m: Meta) {
  const bar = $('setbar');
  const show = m.target > 1 && m.phase !== 'lobby';
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  bar.innerHTML = '';
  const head = document.createElement('span');
  head.textContent = `🏆 ${m.target}승 먼저 · ${m.round}라운드`;
  bar.append(head);
  const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(Math.max(0, m.target - n));
  const entries = m.mode === 'team'
    ? [0, 1].map((t) => ({ name: TEAM_NAMES[t], color: TEAM_COLORS[t], n: m.score[`team${t}`] ?? 0 }))
    : m.players.filter((p) => p.playing).map((p) => ({ name: p.name, color: CHARACTERS[p.char].color, n: m.score[p.id] ?? 0 }));
  for (const e of entries) {
    const span = document.createElement('span');
    span.className = 'who';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = hex(e.color);
    const st = document.createElement('span');
    st.className = 'stars';
    st.textContent = stars(e.n);
    span.append(dot, e.name, st);
    bar.append(span);
  }
}

function updateHud(s: Snap) {
  const sec = Math.max(0, Math.ceil(s.timeLeft / TICK_RATE));
  const timer = $('timer');
  const sudden = s.timeLeft <= SUDDEN_TICKS;
  timer.textContent = `${sudden ? '⚠️ 서든데스 ' : ''}${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  timer.classList.toggle('sudden', sudden);

  const ul = $('alive');
  const sig = s.players.map((p) => p.id + p.alive + !!p.trapped).join();
  if (ul.dataset.sig !== sig) {
    ul.dataset.sig = sig;
    ul.innerHTML = '';
    // 팀전이면 팀별로 묶어서
    const list = [...s.players].sort((a, b) => a.team - b.team);
    for (const p of list) {
      const mp = metaPlayer(p.id);
      const li = document.createElement('li');
      li.className = !p.alive ? 'dead' : p.trapped ? 'trapped' : '';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = hex(CHARACTERS[mp?.char ?? 0].color);
      li.append(dot);
      if (p.team >= 0) {
        const badge = document.createElement('span');
        badge.className = `badge t${p.team}`;
        badge.textContent = TEAM_NAMES[p.team][0];
        li.append(badge);
      }
      li.append((mp?.bot ? '🤖 ' : '') + (mp?.name ?? '???') + (p.id === myId ? ' (나)' : '') + (p.alive && p.trapped ? ' 🫧' : ''));
      ul.append(li);
    }
  }
  const me = s.players.find((p) => p.id === myId);
  const stats = $('mystats');
  stats.classList.toggle('hidden', !me);
  if (me) {
    stats.textContent = !me.alive ? '👻 유령이 됐어요 · 방향키로 경기장 밖을 돌아다니며 구경해요'
      : me.trapped ? `🫧 갇혔어요! 같은 팀이 구해 줄 때까지 ${Math.ceil(me.trapped / TICK_RATE)}초`
      : `💣 ${me.bombMax}   🔥 ${me.range}   👟 ${me.speedLv + 1}${me.kick ? '   ⚽' : ''}${me.glove ? '   🧤' : ''}`;
    // 특수 아이템을 처음 얻으면 사용법 안내
    if (me.kick && !hadKick) toast('⚽ 축구화! 폭탄 쪽으로 걸어가면 뻥 차요');
    if (me.glove && !hadGlove) toast('🧤 글러브! 폭탄 위에서 Space를 한 번 더 누르면 던져요');
  }
  hadKick = !!me?.kick;
  hadGlove = !!me?.glove;
}

let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 2500);
}

// 입장 전 배경: 맵 미리보기
if (!meta) {
  arena.build('glacier');
  arena.setTiles(lobbyTiles('glacier'));
}
renderUI();

// 개발용: 주소에 ?debug를 붙이면 브라우저 콘솔에서 내부 상태 확인 가능
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { __popop: { arena, input, audio, setCam: (c: typeof debugCam) => { debugCam = c; }, get pred() { return pred; }, get rtt() { return rtt; }, get myPos() { return avatars.get(myId)?.model.root.position.clone(); } } });
}
