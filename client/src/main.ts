import * as THREE from 'three';
import './style.css';
import { CHARACTERS, DT, Dir, MAX_PLAYERS, TICK_RATE } from '../../shared/constants.ts';
import { MAP_IDS, MAP_NAMES, MAP_ROWS, type MapId } from '../../shared/maps.ts';
import type { MetaPlayer, ServerMsg } from '../../shared/protocol.ts';
import { spawnOrder, movePlayer, tileFromChar, updatePassers, type GameState, type PlayerState } from '../../shared/sim.ts';
import { Arena } from './arena.ts';
import { createCharacter, type CharacterModel } from './characters.ts';
import { Input } from './input.ts';
import { Net } from './net.ts';

type Snap = Extract<ServerMsg, { t: 's' }>;
type Meta = Extract<ServerMsg, { t: 'meta' }>;

const INTERP_MS = 100; // 다른 플레이어는 100ms 전 상태를 보간해서 그림
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

// ---------- 상태 ----------
let myId = '';
let joined = false;
let meta: Meta | null = null;
const snaps: { at: number; s: Snap }[] = [];
let pred: { state: GameState; me: PlayerState } | null = null;
let prevPos = { x: 0, y: 0 };
let curPos = { x: 0, y: 0 };
let pending: { s: number; d: Dir }[] = [];
let seq = 0;
let shake = 0;
let lastFlames = 0;

interface Avatar { model: CharacterModel; char: number; name: string; last: { x: number; y: number }; dead: boolean; label: THREE.Sprite }
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

function avatarFor(id: string, char: number, name: string): Avatar {
  let a = avatars.get(id);
  if (a && (a.char !== char || a.name !== name)) { removeAvatar(id); a = undefined; }
  if (!a) {
    const model = createCharacter(char);
    const label = nameSprite(name, CHARACTERS[char].color);
    model.root.add(label);
    scene.add(model.root);
    a = { model, char, name, last: { x: 0, y: 0 }, dead: false, label };
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
  else if (m.t === 'error') { toast(m.msg); }
};
net.connect();

function onMeta(m: Meta) {
  const prev = meta?.phase;
  meta = m;
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
    arena.setTiles(MAP_ROWS[meta.mapId].join('').split('').map((ch) => tileFromChar(ch, () => 1)).join(''));
  }
  const lobbyIds = new Set<string>();
  const spawns = spawnOrder(arena.w, arena.h);
  meta.players.slice(0, MAX_PLAYERS).forEach((p, i) => {
    lobbyIds.add(p.id);
    const a = avatarFor(p.id, p.char, p.name);
    const [x, y] = spawns[i];
    a.model.root.position.set(x, 0, y);
    a.model.root.rotation.y = 0;
    a.last = { x, y };
  });
  for (const id of [...avatars.keys()]) if (!lobbyIds.has(id)) removeAvatar(id);
}

function onSnap(s: Snap) {
  if (!meta) return;
  if (arena.mapId !== meta.mapId) arena.build(meta.mapId);
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
    if (!pred) prevPos = { x: mine.x, y: mine.y };
    pred = { state: st, me: mine };
    curPos = { x: mine.x, y: mine.y };
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
    prevPos = { ...curPos };
    movePlayer(pred.state, pred.me, d, DT);
    updatePassers(pred.state);
    curPos = { x: pred.me.x, y: pred.me.y };
    pending.push({ s: seq, d });
  }
}

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
      const av = avatarFor(p.id, mp?.char ?? p.slot % CHARACTERS.length, mp?.name ?? '???');
      let x: number, y: number;
      if (p.id === myId && pred) {
        x = lerp(prevPos.x, curPos.x, alpha);
        y = lerp(prevPos.y, curPos.y, alpha);
      } else {
        const pa = a.s.players.find((q) => q.id === p.id) ?? p;
        const pb = b.s.players.find((q) => q.id === p.id) ?? p;
        x = lerp(pa.x, pb.x, k);
        y = lerp(pa.y, pb.y, k);
      }
      const dx = x - av.last.x, dy = y - av.last.y;
      const moving = Math.hypot(dx, dy) > 0.002;
      if (moving) {
        const target = Math.atan2(dx, dy);
        let diff = target - av.model.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        av.model.root.rotation.y += diff * Math.min(1, dt * 18);
      }
      av.model.root.position.set(x, 0, y);
      av.last = { x, y };
      if (!p.alive && !av.dead) { av.dead = true; av.model.die(); av.label.visible = false; }
      av.model.animate(t, dt, moving && p.alive);
      if (p.id === myId && p.alive) focus = { x, y };
    }
    for (const id of [...avatars.keys()]) if (!ids.has(id)) removeAvatar(id);
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
  const pos = focus ? look.clone().add(new THREE.Vector3(0, 11.5, 8.5)) : look.clone().add(new THREE.Vector3(0, 21, 15).multiplyScalar(mw / 23)); // 전체 보기: 맵 크기에 맞춰 거리 조절
  const kk = 1 - Math.exp(-dt * 6);
  camPos.lerp(pos, kk);
  camLook.lerp(look, kk);
  camera.position.copy(camPos);
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    shake *= Math.exp(-dt * 9);
  }
  camera.lookAt(camLook);

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

function charButtons(el: HTMLElement, selected: number, taken: Set<number>, onPick: (i: number) => void) {
  el.innerHTML = '';
  CHARACTERS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = i === selected ? 'on' : '';
    b.disabled = taken.has(i);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = hex(c.color);
    b.append(dot, c.name);
    b.title = taken.has(i) ? '다른 플레이어가 사용 중' : c.name;
    b.onclick = () => onPick(i);
    el.append(b);
  });
}

function doJoin() {
  const name = nameInput.value.trim().slice(0, 12) || `플레이어${Math.floor(Math.random() * 90 + 10)}`;
  store.set('popop.name', name);
  store.set('popop.char', String(myChar));
  net.send({ t: 'join', room: ROOM, name, char: myChar });
}
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

function renderUI() {
  $('join').classList.toggle('hidden', joined);
  if (!joined) {
    charButtons($('join-chars'), myChar, new Set(), (i) => { myChar = i; renderUI(); });
    return;
  }
  const m = meta;
  if (!m) return;
  const isHost = m.host === myId;
  const me = metaPlayer(myId);
  if (me) { myChar = me.char; store.set('popop.char', String(me.char)); }

  $('lobby').classList.toggle('hidden', m.phase !== 'lobby');
  $('hud').classList.toggle('hidden', m.phase === 'lobby');

  // 플레이어 목록
  const ul = $('players');
  ul.innerHTML = '';
  m.players.forEach((p, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = hex(CHARACTERS[p.char].color);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (p.id === m.host ? '👑 ' : '') + p.name + (p.id === myId ? ' (나)' : '') + (i >= MAX_PLAYERS ? ' · 관전' : '');
    const wins = document.createElement('span');
    wins.className = 'wins';
    wins.textContent = p.wins ? `${p.wins}승` : '';
    li.append(dot, name, wins);
    ul.append(li);
  });
  $('count').textContent = `${Math.min(m.players.length, MAX_PLAYERS)}/${MAX_PLAYERS}`;

  const taken = new Set(m.players.filter((p) => p.id !== myId).map((p) => p.char));
  charButtons($('lobby-chars'), myChar, taken, (i) => net.send({ t: 'char', char: i }));

  const maps = $('maps');
  maps.innerHTML = '';
  for (const id of MAP_IDS) {
    const b = document.createElement('button');
    b.textContent = MAP_NAMES[id];
    b.className = id === m.mapId ? 'on' : '';
    b.disabled = !isHost;
    b.onclick = () => net.send({ t: 'map', mapId: id as MapId });
    maps.append(b);
  }
  $('map-hint').textContent = isHost ? '' : '(방장이 선택)';
  $('start-btn').classList.toggle('hidden', !isHost);
  $('wait-msg').textContent = isHost
    ? (m.players.length === 1 ? '혼자서도 연습할 수 있어요. 초대 링크로 팀원을 불러 보세요!' : '')
    : '방장이 게임을 시작하기를 기다리는 중…';

  const banner = $('banner');
  if (m.phase === 'ended' && m.result) {
    const w = m.result.winner ? metaPlayer(m.result.winner) : undefined;
    banner.textContent = w ? `🎉 ${w.name} 승리!` : (m.players.filter((p) => p.playing).length <= 1 ? '💥 게임 오버' : '🤝 무승부!');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function updateHud(s: Snap) {
  const sec = Math.max(0, Math.ceil(s.timeLeft / TICK_RATE));
  const timer = $('timer');
  timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  timer.classList.toggle('warn', sec <= 30);

  const ul = $('alive');
  const sig = s.players.map((p) => p.id + p.alive).join();
  if (ul.dataset.sig !== sig) {
    ul.dataset.sig = sig;
    ul.innerHTML = '';
    for (const p of s.players) {
      const mp = metaPlayer(p.id);
      const li = document.createElement('li');
      li.className = p.alive ? '' : 'dead';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = hex(CHARACTERS[mp?.char ?? 0].color);
      li.append(dot, (mp?.name ?? '???') + (p.id === myId ? ' (나)' : ''));
      ul.append(li);
    }
  }
  const me = s.players.find((p) => p.id === myId);
  const stats = $('mystats');
  stats.classList.toggle('hidden', !me);
  if (me) stats.textContent = me.alive ? `💣 ${me.bombMax}   🔥 ${me.range}   👟 ${me.speedLv + 1}` : '👻 관전 중';
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
  arena.setTiles(MAP_ROWS.glacier.join('').split('').map((ch) => tileFromChar(ch, () => 1)).join(''));
}
renderUI();
