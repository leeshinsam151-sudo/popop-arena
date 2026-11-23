// 게임 시뮬레이션. 서버는 이 코드로 게임을 진행하고,
// 클라이언트는 같은 movePlayer로 내 캐릭터 이동을 미리 예측한다.
// 맵 기믹(얼음·유사·버섯·워프·용암 균열·언 상자)도 모두 여기서 판정한다.
import {
  BASE_SPEED, CORNER_ASSIST, DIR_VEC, Dir, FLAME_TICKS, FUSE_TICKS, ICE_DECEL, ITEM_CHANCE, ITEM_WEIGHTS,
  BUBBLE_SPEED_MUL, BUBBLE_TICKS, RESCUE_SHIELD_TICKS, TOUCH_DIST,
  ItemType, JUMP_DIST, JUMP_TIME, KICK_SPEED, LAVA_CYCLE, LAVA_ERUPT, LAVA_WARN, MAX_BOMBS, MAX_RANGE,
  MAX_SPEED_LV, QUICKSAND_MUL, SOFT_DENSITY, SPEED_STEP, THROW_BOUNCE_TICKS, THROW_DIST, THROW_TICKS, Tile, DT,
} from './constants.ts';
import { MAP_ROWS, type MapId } from './maps.ts';

export interface PlayerState {
  id: string;
  slot: number;
  x: number; // 칸 단위 실수 좌표 (칸 중심 = 정수)
  y: number;
  alive: boolean;
  bombMax: number;
  range: number;
  speedLv: number;
  kick: boolean; // ⚽ 축구화: 폭탄 쪽으로 걸으면 참
  glove: boolean; // 🧤 글러브: 폭탄 위에서 폭탄 키를 다시 누르면 던짐
  facing: Dir;
  mom: number; // 🧊 얼음 위 관성 속도 (손을 떼도 이 속도로 미끄러짐)
  jump: Jump | null; // 🍄 버섯 점프 중이면 경로
  warpLock: boolean; // 🌀 워프 직후: 워프 칸을 벗어나야 다시 탈 수 있음
  team: number; // 팀전: 0(A) / 1(B), 개인전: -1
  trapped: number; // 🫧 팀전: 물방울에 갇혀 남은 틱 (0이면 자유)
  shield: number; // 구출 직후 무적 남은 틱
}
export interface Jump { t: number; total: number; sx: number; sy: number; tx: number; ty: number }
export interface Bomb {
  id: number;
  x: number; // 논리 칸 (막힘·폭발 판정 기준). 날아가는 중이면 착지할 칸
  y: number;
  fx: number; // 실제 위치 (차여서 미끄러지는 중에는 소수)
  fy: number;
  owner: string;
  fuse: number;
  range: number;
  passers: string[]; // 설치 순간 겹쳐 있던 플레이어: 빠져나갈 때까지 통과 가능
  slide: Dir; // 차여서 미끄러지는 방향 (None이면 정지)
  fly: number; // 날아가는 중 남은 틱 (0이면 바닥에 있음)
  flyTotal: number;
  sx: number; // 던진 위치 (날아가는 연출용)
  sy: number;
}
export interface Flame { x: number; y: number; ttl: number; lava?: boolean }
export interface Item { x: number; y: number; type: ItemType }

export interface GameState {
  mapId: MapId;
  w: number;
  h: number;
  tiles: number[];
  players: PlayerState[];
  bombs: Bomb[];
  flames: Flame[];
  items: Item[];
  tick: number;
  nextBombId: number;
}

/** 스폰 순서: 2명은 대각선, 4명은 네 모서리, 5~6명째는 위아래 가운데 */
export function spawnOrder(w: number, h: number): [number, number][] {
  const cx = Math.floor(w / 2);
  return [[1, 1], [w - 2, h - 2], [w - 2, 1], [1, h - 2], [cx, 1], [cx, h - 2]];
}

export function tileFromChar(ch: string, rand: () => number): Tile {
  switch (ch) {
    case '#': case 'T': case 'O': return Tile.Wall;
    case '~': return Tile.Pit;
    case 'F': return Tile.Frozen;
    case '.': return rand() < SOFT_DENSITY ? Tile.Soft : Tile.Floor;
    default: return Tile.Floor;
  }
}

/**
 * 순간이동해서 도착하는 칸(🌀 워프 석판, 🍄 버섯 착지 칸) 주변에는 랜덤 블록을 두지 않는다.
 * 안 그러면 사방이 막힌 한 칸에 갇혀서, 빠져나가지도 못하고 폭탄을 놓으면 피할 곳도 없다.
 */
function clearArrivalZones(rows: string[], tiles: number[], w: number, h: number) {
  const clearAround = (x: number, y: number) => {
    for (const [dx, dy] of DIR_VEC.slice(1)) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (rows[ny][nx] === '.' && tiles[ny * w + nx] === Tile.Soft) tiles[ny * w + nx] = Tile.Floor;
    }
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = rows[y][x];
    if (ch === 'A' || ch === 'B' || ch === 'C') clearAround(x, y);
    if (ch === 'M') {
      for (const [dx, dy] of DIR_VEC.slice(1)) {
        const tx = x + dx * JUMP_DIST, ty = y + dy * JUMP_DIST;
        if (tx > 0 && ty > 0 && tx < w - 1 && ty < h - 1) clearAround(tx, ty);
      }
    }
  }
}

/** 팀전 스폰: A팀은 왼쪽, B팀은 오른쪽 */
export function teamSpawns(w: number, h: number): [number, number][][] {
  const cx = Math.floor(w / 2);
  return [
    [[1, 1], [1, h - 2], [cx, 1]],
    [[w - 2, h - 2], [w - 2, 1], [cx, h - 2]],
  ];
}

/** teams를 주면 팀전 (각 플레이어의 팀 0/1), 없으면 개인전 */
export function createGame(mapId: MapId, playerIds: string[], rand: () => number, teams?: number[]): GameState {
  const rows = MAP_ROWS[mapId];
  const h = rows.length, w = rows[0].length;
  const tiles: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push(tileFromChar(rows[y][x], rand));
  clearArrivalZones(rows, tiles, w, h);
  const spawns = spawnOrder(w, h);
  const tSpawns = teamSpawns(w, h);
  const teamCount = [0, 0];
  const players = playerIds.map((id, slot): PlayerState => {
    const team = teams ? teams[slot] : -1;
    const [x, y] = team >= 0 ? tSpawns[team][teamCount[team]++] : spawns[slot];
    return {
      id, slot, x, y,
      alive: true, bombMax: 1, range: 2, speedLv: 0, kick: false, glove: false, facing: Dir.Down,
      mom: 0, jump: null, warpLock: false, team, trapped: 0, shield: 0,
    };
  });
  return { mapId, w, h, tiles, players, bombs: [], flames: [], items: [], tick: 0, nextBombId: 1 };
}

export const playerSpeed = (p: PlayerState) => BASE_SPEED + p.speedLv * SPEED_STEP;

/** 맵 원본 문자 (기믹 판정용: I 얼음, Q 유사, M 버섯, A/B/C 워프, L 용암 균열, G 덤불) */
export const featureAt = (mapId: MapId, x: number, y: number): string => MAP_ROWS[mapId][y]?.[x] ?? '#';

const warpCache = new Map<string, [number, number]>();
/** 🌀 같은 글자 워프 석판의 짝 */
export function warpPartner(mapId: MapId, x: number, y: number): [number, number] | null {
  const key = `${mapId}:${x},${y}`;
  if (warpCache.has(key)) return warpCache.get(key)!;
  const ch = featureAt(mapId, x, y);
  const rows = MAP_ROWS[mapId];
  for (let yy = 0; yy < rows.length; yy++) for (let xx = 0; xx < rows[yy].length; xx++) {
    if (rows[yy][xx] === ch && (xx !== x || yy !== y)) { warpCache.set(key, [xx, yy]); return [xx, yy]; }
  }
  return null;
}

const lavaCache = new Map<MapId, [number, number, number][]>();
/** 🌋 용암 균열 칸과 각자의 분출 시점 오프셋 */
export function lavaCracks(mapId: MapId): [number, number, number][] {
  let list = lavaCache.get(mapId);
  if (!list) {
    list = [];
    MAP_ROWS[mapId].forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === 'L') list!.push([x, y, (x * 11 + y * 7) % LAVA_CYCLE]);
    }));
    lavaCache.set(mapId, list);
  }
  return list;
}
/** 0~1: 경고 진행도(분출 전), 2: 분출 중, -1: 잠잠 */
export function lavaState(tick: number, offset: number): number {
  const ph = (tick + offset) % LAVA_CYCLE;
  if (ph < LAVA_WARN) return ph / LAVA_WARN;
  if (ph < LAVA_WARN + LAVA_ERUPT) return 2;
  return -1;
}

const groundBombAt = (s: GameState, x: number, y: number) =>
  s.bombs.find((b) => b.fly === 0 && b.x === x && b.y === y);

export function isBlocked(s: GameState, cx: number, cy: number, pid: string): boolean {
  if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return true;
  if (s.tiles[cy * s.w + cx] !== Tile.Floor) return true;
  for (const b of s.bombs) {
    if (b.fly === 0 && b.x === cx && b.y === cy && !b.passers.includes(pid)) return true;
  }
  return false;
}

const overlaps = (p: PlayerState, x: number, y: number) =>
  p.alive && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1;

/** 폭탄이 들어갈 수 없는 칸인가 (미끄러짐·착지 판정) */
function bombCellBlocked(s: GameState, x: number, y: number, self: Bomb | null, checkPlayers: boolean): boolean {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return true;
  if (s.tiles[y * s.w + x] !== Tile.Floor) return true;
  if (s.bombs.some((b) => b !== self && b.x === x && b.y === y)) return true; // 날아오는 중인 폭탄의 착지 칸 포함
  if (checkPlayers && s.players.some((p) => overlaps(p, x, y))) return true;
  return false;
}

/** 진행 방향으로 dist만큼 이동. 길 중앙 정렬, 모서리 보정, 축구화 차기 포함. 실제로 움직인 거리 반환 */
function moveCore(s: GameState, p: PlayerState, dir: Dir, dist: number): number {
  const [dx, dy] = DIR_VEC[dir];
  const horiz = dx !== 0;
  const d = horiz ? dx : dy;
  const x0 = p.x, y0 = p.y;
  let m = horiz ? p.x : p.y; // 진행 축
  let q = horiz ? p.y : p.x; // 수직 축
  const free = (mm: number, qq: number) =>
    horiz ? !isBlocked(s, mm, qq, p.id) : !isBlocked(s, qq, mm, p.id);

  const cur = Math.round(m);
  const lane = Math.round(q);
  const off = q - lane;

  // 1) 목표 길 결정 (모서리 보정)
  let target = lane;
  if (!free(cur + d, lane) && off !== 0) {
    const alt = lane + Math.sign(off);
    if (1 - Math.abs(off) <= CORNER_ASSIST && free(cur, alt) && free(cur + d, alt)) target = alt;
  }

  // 2) 수직 축 정렬 (이동 거리 소모)
  const need = target - q;
  const step = Math.min(Math.abs(need), dist);
  q += Math.sign(need) * step;
  dist -= step;
  if (Math.abs(target - q) < 1e-9) q = target;

  // 3) 정렬이 끝났으면 진행 축 이동
  if (q === target && dist > 0) {
    const base = Math.round(m);
    let next = m + d * dist;
    if (!free(base + d, target)) {
      // 막힌 칸 쪽으로는 현재 칸 중심까지만 (이미 넘어선 경우 뒤로 밀지 않음)
      next = d > 0 ? Math.min(next, Math.max(m, base)) : Math.max(next, Math.min(m, base));
      if (p.kick && next === base) {
        const bx = horiz ? base + d : target, by = horiz ? target : base + d;
        const b = groundBombAt(s, bx, by);
        if (b && b.slide === Dir.None && !bombCellBlocked(s, bx + dx, by + dy, b, true)) b.slide = dir;
      }
    }
    m = next;
  }

  if (horiz) { p.x = m; p.y = q; } else { p.y = m; p.x = q; }
  return Math.abs(p.x - x0) + Math.abs(p.y - y0);
}

/**
 * 한 틱 이동 (서버 판정과 클라이언트 예측이 같은 코드 사용).
 * 기믹: 🧊 얼음 관성, 🏜️ 유사 감속, 🍄 버섯 점프, 🌀 워프
 */
export function movePlayer(s: GameState, p: PlayerState, dir: Dir, dt: number): void {
  if (!p.alive) return;

  // 🍄 점프 중: 입력 무시, 정해진 포물선 경로를 따라감
  if (p.jump) {
    const j = p.jump;
    j.t = Math.min(j.total, j.t + dt);
    const k = j.t / j.total;
    p.x = j.sx + (j.tx - j.sx) * k;
    p.y = j.sy + (j.ty - j.sy) * k;
    if (j.t >= j.total) { p.x = j.tx; p.y = j.ty; p.jump = null; }
    return;
  }

  const cx = Math.round(p.x), cy = Math.round(p.y);
  const here = featureAt(s.mapId, cx, cy);
  const onIce = here === 'I';

  if (dir === Dir.None) {
    // 🧊 얼음 위에서 손을 떼면 바라보던 방향으로 미끄러지며 감속
    if (onIce && p.mom > 0) {
      const moved = moveCore(s, p, p.facing, p.mom * dt);
      p.mom = moved < 1e-6 ? 0 : Math.max(0, p.mom - ICE_DECEL * dt);
    } else {
      p.mom = 0;
    }
  } else {
    p.facing = dir;
    const speed = playerSpeed(p) * (here === 'Q' ? QUICKSAND_MUL : 1) * (p.trapped ? BUBBLE_SPEED_MUL : 1);
    const moved = moveCore(s, p, dir, speed * dt);
    p.mom = onIce && moved > 1e-6 ? speed : 0;
  }

  triggerFeatures(s, p, dir);
}

/** 이동 후 발밑 기믹 발동: 🍄 버섯 점프, 🌀 워프 */
function triggerFeatures(s: GameState, p: PlayerState, dir: Dir) {
  if (p.trapped) return; // 물방울 안에서는 버섯·워프 안 탐
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const here = featureAt(s.mapId, cx, cy);
  const nearCenter = Math.abs(p.x - cx) < 0.3 && Math.abs(p.y - cy) < 0.3;

  // 🍄 버섯: 누르고 있는 방향으로 2칸 점프 (사이에 있는 벽·블록·폭탄은 넘어감). 착지 칸이 막혀 있으면 안 뜀
  if (here === 'M' && dir !== Dir.None && nearCenter) {
    const [dx, dy] = DIR_VEC[dir];
    const tx = cx + dx * JUMP_DIST, ty = cy + dy * JUMP_DIST;
    if (!isBlocked(s, tx, ty, p.id) && !groundBombAt(s, tx, ty)) {
      p.jump = { t: 0, total: JUMP_TIME, sx: p.x, sy: p.y, tx, ty };
      p.mom = 0;
      return;
    }
  }

  // 🌀 워프: 석판 한가운데에 서면 같은 글자 석판으로 순간이동. 석판을 벗어나야 다시 탈 수 있음
  const isWarp = here === 'A' || here === 'B' || here === 'C';
  if (!isWarp) { p.warpLock = false; return; }
  if (!p.warpLock && nearCenter) {
    const to = warpPartner(s.mapId, cx, cy);
    if (to && !isBlocked(s, to[0], to[1], p.id)) {
      p.x = to[0]; p.y = to[1];
      p.mom = 0;
      p.warpLock = true;
    }
  }
}

/** 폭탄에서 완전히 빠져나간 플레이어는 더 이상 그 폭탄을 통과할 수 없다. */
export function updatePassers(s: GameState): void {
  for (const b of s.bombs) {
    if (b.passers.length === 0) continue;
    b.passers = b.passers.filter((id) => {
      const p = s.players.find((pp) => pp.id === id);
      return !!p && overlaps(p, b.x, b.y);
    });
  }
}

export function placeBomb(s: GameState, p: PlayerState): boolean {
  if (!p.alive || p.trapped) return false;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  if (s.tiles[cy * s.w + cx] !== Tile.Floor) return false;
  if (s.bombs.some((b) => b.x === cx && b.y === cy)) return false;
  if (s.bombs.filter((b) => b.owner === p.id).length >= p.bombMax) return false;
  s.bombs.push({
    id: s.nextBombId++, x: cx, y: cy, fx: cx, fy: cy, owner: p.id, fuse: FUSE_TICKS, range: p.range,
    passers: s.players.filter((pp) => overlaps(pp, cx, cy)).map((pp) => pp.id),
    slide: Dir.None, fly: 0, flyTotal: 0, sx: cx, sy: cy,
  });
  return true;
}

/** 🧤 발밑 폭탄을 바라보는 방향으로 던진다. 착지 칸이 막혀 있으면 한 칸씩 더 날아간다. */
export function throwBomb(s: GameState, p: PlayerState): boolean {
  if (!p.alive || !p.glove || p.trapped) return false;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const b = groundBombAt(s, cx, cy);
  if (!b || b.slide !== Dir.None) return false;
  const [dx, dy] = DIR_VEC[p.facing === Dir.None ? Dir.Down : p.facing];
  const inside = (x: number, y: number) => x > 0 && y > 0 && x < s.w - 1 && y < s.h - 1;
  let dist = 0;
  for (let k = THROW_DIST; inside(cx + dx * k, cy + dy * k); k++) {
    if (!bombCellBlocked(s, cx + dx * k, cy + dy * k, b, false)) { dist = k; break; }
  }
  if (!dist) { // 앞쪽이 모두 막혔으면 가까운 칸이라도
    for (let k = THROW_DIST - 1; k >= 1; k--) {
      if (inside(cx + dx * k, cy + dy * k) && !bombCellBlocked(s, cx + dx * k, cy + dy * k, b, false)) { dist = k; break; }
    }
  }
  if (!dist) return false;
  b.sx = b.fx; b.sy = b.fy;
  b.x = b.fx = cx + dx * dist;
  b.y = b.fy = cy + dy * dist;
  b.fly = b.flyTotal = THROW_TICKS + Math.max(0, dist - THROW_DIST) * THROW_BOUNCE_TICKS;
  b.passers = [];
  return true;
}

/** 폭탄 키: 글러브가 있고 발밑에 폭탄이 있으면 던지고, 아니면 설치 */
export function bombAction(s: GameState, p: PlayerState): boolean {
  return throwBomb(s, p) || placeBomb(s, p);
}

/** ⚽ 차인 폭탄을 한 틱 미끄러뜨린다. 앞 칸이 막히면 현재 칸 중심에서 멈춤 */
function slideBomb(s: GameState, b: Bomb) {
  const [dx, dy] = DIR_VEC[b.slide];
  const horiz = dx !== 0;
  const d = horiz ? dx : dy;
  const f = horiz ? b.fx : b.fy;
  const c = Math.round(f);
  const ax = horiz ? c + d : b.x, ay = horiz ? b.y : c + d;
  let nf = f + d * KICK_SPEED * DT;
  if (bombCellBlocked(s, ax, ay, b, true)) {
    nf = d > 0 ? Math.min(nf, Math.max(f, c)) : Math.max(nf, Math.min(f, c));
    if (nf === c) b.slide = Dir.None;
  }
  if (horiz) b.fx = nf; else b.fy = nf;
  const nc = Math.round(nf);
  if (nc !== c) {
    if (horiz) b.x = nc; else b.y = nc;
    b.passers = [];
  }
}

function applyItem(p: PlayerState, type: ItemType) {
  switch (type) {
    case ItemType.Bomb: p.bombMax = Math.min(MAX_BOMBS, p.bombMax + 1); break;
    case ItemType.Fire: p.range = Math.min(MAX_RANGE, p.range + 1); break;
    case ItemType.Speed: p.speedLv = Math.min(MAX_SPEED_LV, p.speedLv + 1); break;
    case ItemType.Kick: p.kick = true; break;
    case ItemType.Glove: p.glove = true; break;
  }
}

function rollItem(rand: () => number): ItemType {
  const total = ITEM_WEIGHTS.reduce((a, w) => a + w, 0);
  let r = rand() * total;
  for (let i = 0; i < ITEM_WEIGHTS.length; i++) {
    r -= ITEM_WEIGHTS[i];
    if (r < 0) return i as ItemType;
  }
  return ItemType.Bomb;
}

/** 이동 이후 세계를 한 틱 진행: 폭탄 비행·미끄러짐, 불길 소멸, 폭발(연쇄), 블록 파괴, 사망, 아이템 획득 */
export function stepWorld(s: GameState, rand: () => number): void {
  s.tick++;
  s.flames = s.flames.filter((f) => --f.ttl > 0);
  for (const b of s.bombs) {
    if (b.fly > 0) { // 날아가는 동안에는 시간이 멈춤
      if (--b.fly === 0) b.passers = s.players.filter((p) => overlaps(p, b.x, b.y)).map((p) => p.id);
      continue;
    }
    if (b.slide !== Dir.None) slideBomb(s, b);
    b.fuse--;
  }

  const flameAt = (x: number, y: number) => s.flames.some((f) => f.x === x && f.y === y);
  const addFlame = (x: number, y: number) => {
    const f = s.flames.find((ff) => ff.x === x && ff.y === y);
    if (f) f.ttl = FLAME_TICKS; else s.flames.push({ x, y, ttl: FLAME_TICKS });
  };

  // 🌋 용암 균열 분출: 분출 중인 칸은 불길과 똑같이 위험 (폭탄도 터뜨림)
  for (const [x, y, off] of lavaCracks(s.mapId)) {
    if (lavaState(s.tick, off) !== 2) continue;
    const f = s.flames.find((ff) => ff.x === x && ff.y === y);
    if (f) f.ttl = Math.max(f.ttl, 2); else s.flames.push({ x, y, ttl: 2, lava: true });
  }

  const queue = s.bombs.filter((b) => b.fly === 0 && (b.fuse <= 0 || flameAt(b.x, b.y)));
  const exploded = new Set<number>();
  const broken = new Set<number>();
  while (queue.length) {
    const b = queue.shift()!;
    if (exploded.has(b.id)) continue;
    exploded.add(b.id);
    addFlame(b.x, b.y);
    for (let dir = 1; dir <= 4; dir++) {
      const [dx, dy] = DIR_VEC[dir];
      for (let i = 1; i <= b.range; i++) {
        const x = b.x + dx * i, y = b.y + dy * i;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) break;
        const t = s.tiles[y * s.w + x];
        if (t === Tile.Wall) break;
        addFlame(x, y);
        if (t === Tile.Soft || t === Tile.Frozen || t === Tile.Cracked) { broken.add(y * s.w + x); break; }
        const other = s.bombs.find((o) => o.fly === 0 && o.x === x && o.y === y && !exploded.has(o.id));
        if (other) { queue.push(other); break; }
        const itemIdx = s.items.findIndex((it) => it.x === x && it.y === y);
        if (itemIdx >= 0) { s.items.splice(itemIdx, 1); break; }
      }
    }
  }
  if (exploded.size) s.bombs = s.bombs.filter((b) => !exploded.has(b.id));
  for (const idx of broken) {
    const t = s.tiles[idx];
    if (t === Tile.Frozen) { s.tiles[idx] = Tile.Cracked; continue; } // 🧊 첫 번째: 금만 감
    s.tiles[idx] = Tile.Floor;
    // 금 간 상자는 아이템이 반드시 나옴
    if (t === Tile.Cracked || rand() < ITEM_CHANCE) s.items.push({ x: idx % s.w, y: Math.floor(idx / s.w), type: rollItem(rand) });
  }

  for (const p of s.players) {
    if (!p.alive || p.jump) continue; // 🍄 점프 중에는 공중이라 불길에 안 맞음
    if (p.shield > 0) p.shield--;
    const cx = Math.round(p.x), cy = Math.round(p.y);
    if (p.trapped) {
      // 🫧 시간이 다 되면 물방울이 터지며 탈락
      if (--p.trapped <= 0) { p.trapped = 0; p.alive = false; }
      continue;
    }
    if (flameAt(cx, cy) && p.shield === 0) {
      if (p.team >= 0) { p.trapped = BUBBLE_TICKS; p.mom = 0; } // 팀전: 물방울에 갇힘
      else p.alive = false; // 개인전: 바로 탈락
      continue;
    }
    const i = s.items.findIndex((it) => it.x === cx && it.y === cy);
    if (i >= 0) { applyItem(p, s.items[i].type); s.items.splice(i, 1); }
  }
  if (s.players.some((p) => p.team >= 0)) resolveBubbles(s);
}

/** 🫧 팀전: 갇힌 사람에게 아군이 닿으면 구출, 적이 닿으면 탈락. 팀 전원이 갇히면 그 팀 전멸 */
function resolveBubbles(s: GameState) {
  for (const p of s.players) {
    if (!p.alive || !p.trapped) continue;
    for (const q of s.players) {
      if (q === p || !q.alive || q.trapped || q.jump) continue;
      if (Math.abs(q.x - p.x) > TOUCH_DIST || Math.abs(q.y - p.y) > TOUCH_DIST) continue;
      if (q.team === p.team) { p.trapped = 0; p.shield = RESCUE_SHIELD_TICKS; } // 구출!
      else { p.trapped = 0; p.alive = false; } // 적이 터뜨림
      break;
    }
  }
  for (const team of [0, 1]) {
    const members = s.players.filter((p) => p.team === team && p.alive);
    if (members.length && members.every((p) => p.trapped)) for (const p of members) { p.trapped = 0; p.alive = false; }
  }
}

/** 시드 고정 난수 (테스트·맵 생성용) */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
