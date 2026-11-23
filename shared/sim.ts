// 게임 시뮬레이션. 서버는 이 코드로 게임을 진행하고,
// 클라이언트는 같은 movePlayer로 내 캐릭터 이동을 미리 예측한다.
import {
  BASE_SPEED, CORNER_ASSIST, DIR_VEC, Dir, FLAME_TICKS, FUSE_TICKS, ITEM_CHANCE,
  ItemType, MAX_BOMBS, MAX_RANGE, MAX_SPEED_LV, SOFT_DENSITY, SPEED_STEP, Tile,
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
  facing: Dir;
}
export interface Bomb {
  id: number;
  x: number;
  y: number;
  owner: string;
  fuse: number;
  range: number;
  passers: string[]; // 설치 순간 겹쳐 있던 플레이어: 빠져나갈 때까지 통과 가능
}
export interface Flame { x: number; y: number; ttl: number }
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
export const SPAWN_ORDER: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [21, 17], [21, 1], [1, 17], [11, 1], [11, 17],
];

export function tileFromChar(ch: string, rand: () => number): Tile {
  switch (ch) {
    case '#': case 'T': case 'O': return Tile.Wall;
    case '~': return Tile.Pit;
    case 'F': return Tile.Soft;
    case '.': return rand() < SOFT_DENSITY ? Tile.Soft : Tile.Floor;
    default: return Tile.Floor;
  }
}

export function createGame(mapId: MapId, playerIds: string[], rand: () => number): GameState {
  const rows = MAP_ROWS[mapId];
  const h = rows.length, w = rows[0].length;
  const tiles: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push(tileFromChar(rows[y][x], rand));
  const players = playerIds.map((id, slot): PlayerState => ({
    id, slot,
    x: SPAWN_ORDER[slot][0], y: SPAWN_ORDER[slot][1],
    alive: true, bombMax: 1, range: 2, speedLv: 0, facing: Dir.Down,
  }));
  return { mapId, w, h, tiles, players, bombs: [], flames: [], items: [], tick: 0, nextBombId: 1 };
}

export const playerSpeed = (p: PlayerState) => BASE_SPEED + p.speedLv * SPEED_STEP;

export function isBlocked(s: GameState, cx: number, cy: number, pid: string): boolean {
  if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return true;
  if (s.tiles[cy * s.w + cx] !== Tile.Floor) return true;
  for (const b of s.bombs) if (b.x === cx && b.y === cy && !b.passers.includes(pid)) return true;
  return false;
}

/** 한 틱 이동. 길 중앙에 맞춰 정렬하고, 모서리에 살짝 걸리면 옆 길로 미끄러뜨린다. */
export function movePlayer(s: GameState, p: PlayerState, dir: Dir, dt: number): void {
  if (!p.alive || dir === Dir.None) return;
  p.facing = dir;
  let dist = playerSpeed(p) * dt;
  const [dx, dy] = DIR_VEC[dir];
  const horiz = dx !== 0;
  const d = horiz ? dx : dy;
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
    }
    m = next;
  }

  if (horiz) { p.x = m; p.y = q; } else { p.y = m; p.x = q; }
}

const overlaps = (p: PlayerState, x: number, y: number) =>
  p.alive && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1;

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
  if (!p.alive) return false;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  if (s.tiles[cy * s.w + cx] !== Tile.Floor) return false;
  if (s.bombs.some((b) => b.x === cx && b.y === cy)) return false;
  if (s.bombs.filter((b) => b.owner === p.id).length >= p.bombMax) return false;
  s.bombs.push({
    id: s.nextBombId++, x: cx, y: cy, owner: p.id, fuse: FUSE_TICKS, range: p.range,
    passers: s.players.filter((pp) => overlaps(pp, cx, cy)).map((pp) => pp.id),
  });
  return true;
}

function applyItem(p: PlayerState, type: ItemType) {
  if (type === ItemType.Bomb) p.bombMax = Math.min(MAX_BOMBS, p.bombMax + 1);
  else if (type === ItemType.Fire) p.range = Math.min(MAX_RANGE, p.range + 1);
  else p.speedLv = Math.min(MAX_SPEED_LV, p.speedLv + 1);
}

function rollItem(rand: () => number): ItemType {
  const r = rand();
  return r < 0.4 ? ItemType.Bomb : r < 0.8 ? ItemType.Fire : ItemType.Speed;
}

/** 이동 이후 세계를 한 틱 진행: 불길 소멸, 폭발(연쇄), 블록 파괴, 사망, 아이템 획득 */
export function stepWorld(s: GameState, rand: () => number): void {
  s.tick++;
  s.flames = s.flames.filter((f) => --f.ttl > 0);
  for (const b of s.bombs) b.fuse--;

  const flameAt = (x: number, y: number) => s.flames.some((f) => f.x === x && f.y === y);
  const addFlame = (x: number, y: number) => {
    const f = s.flames.find((ff) => ff.x === x && ff.y === y);
    if (f) f.ttl = FLAME_TICKS; else s.flames.push({ x, y, ttl: FLAME_TICKS });
  };

  const queue = s.bombs.filter((b) => b.fuse <= 0 || flameAt(b.x, b.y));
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
        if (t === Tile.Soft) { broken.add(y * s.w + x); break; }
        const other = s.bombs.find((o) => o.x === x && o.y === y && !exploded.has(o.id));
        if (other) { queue.push(other); break; }
        const itemIdx = s.items.findIndex((it) => it.x === x && it.y === y);
        if (itemIdx >= 0) { s.items.splice(itemIdx, 1); break; }
      }
    }
  }
  if (exploded.size) s.bombs = s.bombs.filter((b) => !exploded.has(b.id));
  for (const idx of broken) {
    s.tiles[idx] = Tile.Floor;
    if (rand() < ITEM_CHANCE) s.items.push({ x: idx % s.w, y: Math.floor(idx / s.w), type: rollItem(rand) });
  }

  for (const p of s.players) {
    if (!p.alive) continue;
    const cx = Math.round(p.x), cy = Math.round(p.y);
    if (flameAt(cx, cy)) { p.alive = false; continue; }
    const i = s.items.findIndex((it) => it.x === cx && it.y === cy);
    if (i >= 0) { applyItem(p, s.items[i].type); s.items.splice(i, 1); }
  }
}

/** 시드 고정 난수 (테스트·맵 생성용) */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
