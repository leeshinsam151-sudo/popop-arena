// 🤖 AI 봇: 서버에서 매 틱 사람과 같은 입력(방향, 폭탄)을 만들어 낸다.
//
// 생각하는 순서
//  1. 위험 지도: 곧 터질 폭탄의 불길 범위(연쇄 포함)와 분출 직전 용암 균열에 "몇 틱 뒤 위험한지" 표시
//  2. 지금 칸이 위험하면 → 제때 도착할 수 있는 가장 가까운 안전한 칸으로 도망
//  3. 안전하면 → 목표(아이템, 부술 블록 옆, 적, 갇힌 아군 구출·적 터뜨리기)를 점수로 골라 이동
//  4. 폭탄을 놓으면 득이 있고 + 놓은 뒤에도 피할 길이 있을 때만 폭탄
import { CONVEYOR_SPEED, DIR_VEC, Dir, FLAME_TICKS, FUSE_TICKS, LAVA_CYCLE, LAVA_WARN, QUICKSAND_MUL, TICK_RATE, Tile } from '../shared/constants.ts';
import { beltAt, featureAt, isBlocked, lavaCracks, playerSpeed, suddenDropAt, suddenSchedule, type GameState, type PlayerState } from '../shared/sim.ts';

const SAFE = Infinity;

export interface BotMind {
  nextBombTick: number; // 폭탄을 너무 연달아 놓지 않도록
  wander: number; // 할 일이 없을 때 잠깐 쉬는 등 사람처럼 보이게
  ghostDir: Dir; // 👻 탈락 후 유령으로 어슬렁거리는 방향
}
export const newBotMind = (): BotMind => ({ nextBombTick: 0, wander: 0, ghostDir: Dir.None });

/** 각 칸이 몇 틱 뒤에 불길이 되는지 (SAFE = 안전) */
function dangerMap(s: GameState, extra?: { x: number; y: number; range: number }): number[] {
  const danger = new Array<number>(s.w * s.h).fill(SAFE);
  for (const f of s.flames) danger[f.y * s.w + f.x] = 0;

  // parent가 있으면 벨트를 따라 움직일 "예상 위치" (진짜 폭탄이 아님)
  type B = { x: number; y: number; range: number; t: number; parent?: B };
  const bombs: B[] = [];
  for (const b of s.bombs) {
    const t = b.fly > 0 ? b.fly + b.fuse : b.fuse;
    const real: B = { x: b.x, y: b.y, range: b.range, t };
    bombs.push(real);
    // 🎢 벨트 위 폭탄은 터질 때까지 벨트를 따라 움직이니, 지나갈 칸마다 터진다고 가정
    if (b.fly === 0 && !b.slide) {
      let x = b.x, y = b.y;
      const steps = Math.ceil((t / TICK_RATE) * CONVEYOR_SPEED) + 1;
      for (let i = 0; i < steps; i++) {
        const dir = beltAt(s.mapId, x, y);
        if (dir === Dir.None) break;
        const [dx, dy] = DIR_VEC[dir];
        if (isBlocked(s, x + dx, y + dy, '')) break;
        x += dx; y += dy;
        bombs.push({ x, y, range: b.range, t, parent: real }); // 어디에 있든 터지는 시각은 같음
      }
    }
  }
  if (extra) bombs.push({ ...extra, t: FUSE_TICKS });
  const blast = (b: B) => {
    const cells: number[] = [b.y * s.w + b.x];
    for (let d = 1; d <= 4; d++) {
      const [dx, dy] = DIR_VEC[d];
      for (let i = 1; i <= b.range; i++) {
        const x = b.x + dx * i, y = b.y + dy * i;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) break;
        const t = s.tiles[y * s.w + x];
        if (t === Tile.Wall || t === Tile.Fallen) break;
        cells.push(y * s.w + x);
        if (t === Tile.Soft || t === Tile.Frozen || t === Tile.Cracked) break;
        if (bombs.some((o) => o !== b && !o.parent && o.x === x && o.y === y)) break;
      }
    }
    return cells;
  };
  const blasts = bombs.map(blast);
  // 연쇄 폭발: 먼저 터지는 폭탄 범위 안의 폭탄은 같이 터짐
  for (let changed = true; changed;) {
    changed = false;
    bombs.forEach((b, i) => {
      for (const c of blasts[i]) for (const o of bombs) {
        if (!o.parent && o.y * s.w + o.x === c && o.t > b.t) { o.t = b.t; changed = true; }
      }
    });
  }
  for (const b of bombs) if (b.parent) b.t = b.parent.t; // 예상 위치는 진짜 폭탄과 같은 시각에 터짐
  bombs.forEach((b, i) => { for (const c of blasts[i]) danger[c] = Math.min(danger[c], b.t); });

  // ⚠️ 서든데스: 곧 벽이 떨어질 칸 (2초 앞까지)
  const sd = suddenSchedule(s.mapId);
  if (s.tick + 40 >= sd.start) {
    for (let k = 0; k <= 40; k++) {
      const cell = suddenDropAt(s.mapId, s.tick + k);
      if (cell) danger[cell[1] * s.w + cell[0]] = Math.min(danger[cell[1] * s.w + cell[0]], k);
    }
  }

  // 🌋 곧 분출할 용암 균열
  for (const [x, y, off] of lavaCracks(s.mapId)) {
    const ph = (s.tick + off) % LAVA_CYCLE;
    const until = ph < LAVA_WARN ? LAVA_WARN - ph : ph < LAVA_WARN + 16 ? 0 : LAVA_CYCLE - ph + LAVA_WARN;
    if (until < 30) danger[y * s.w + x] = Math.min(danger[y * s.w + x], until);
  }
  return danger;
}

interface Node { idx: number; dist: number; first: Dir }

/** 현재 칸에서 갈 수 있는 칸들 (거리, 첫 걸음 방향). passable로 지나갈 수 있는 칸을 정함 */
function bfs(s: GameState, me: PlayerState, passable: (idx: number, dist: number) => boolean): Node[] {
  const sx = Math.round(me.x), sy = Math.round(me.y);
  const start = sy * s.w + sx;
  const seen = new Set([start]);
  const out: Node[] = [{ idx: start, dist: 0, first: Dir.None }];
  for (let qi = 0; qi < out.length; qi++) {
    const cur = out[qi];
    const cx = cur.idx % s.w, cy = Math.floor(cur.idx / s.w);
    for (let d = 1; d <= 4; d++) {
      const [dx, dy] = DIR_VEC[d];
      const nx = cx + dx, ny = cy + dy, ni = ny * s.w + nx;
      if (seen.has(ni) || isBlocked(s, nx, ny, me.id)) continue;
      // 워프·버섯·트램펄린은 엉뚱한 곳으로 보내 버리니 봇은 밟지 않음
      if ('ABCMJ'.includes(featureAt(s.mapId, nx, ny))) continue;
      if (!passable(ni, cur.dist + 1)) continue;
      seen.add(ni);
      out.push({ idx: ni, dist: cur.dist + 1, first: cur.first === Dir.None ? (d as Dir) : cur.first });
    }
  }
  return out;
}

/** 위험 지도 기준으로, 제때 지나갈 수 있는 길로 가장 가까운 안전한 칸 찾기 */
function escape(s: GameState, me: PlayerState, danger: number[]): Node | null {
  // 사막은 유사 때문에 느려질 수 있고, 빙판은 미끄러져 지나치니 여유를 더 둠
  const speed = playerSpeed(me) * (s.mapId === 'desert' ? QUICKSAND_MUL : 1);
  const stepTicks = TICK_RATE / speed;
  const margin = s.mapId === 'glacier' ? 7 : s.mapId === 'park' ? 6 : 3; // 빙판 미끄러짐·벨트에 밀림 대비
  const nodes = bfs(s, me, (idx, dist) => {
    const arrive = dist * stepTicks;
    const t = danger[idx];
    return t === SAFE || arrive + margin < t || arrive > t + FLAME_TICKS + 2;
  });
  return nodes.filter((n) => danger[n.idx] === SAFE).sort((a, b) => a.dist - b.dist)[0] ?? null;
}

/** (x, y)에 폭탄을 놓으면 부술 블록 수·맞힐 적 수 */
function bombValue(s: GameState, me: PlayerState, x: number, y: number): number {
  let v = 0;
  for (let d = 1; d <= 4; d++) {
    const [dx, dy] = DIR_VEC[d];
    for (let i = 1; i <= me.range; i++) {
      const cx = x + dx * i, cy = y + dy * i;
      const t = s.tiles[cy * s.w + cx];
      if (t === undefined || t === Tile.Wall || t === Tile.Fallen) break;
      if (t === Tile.Soft || t === Tile.Frozen || t === Tile.Cracked) { v += 1; break; }
      for (const p of s.players) {
        if (!p.alive || p === me || Math.round(p.x) !== cx || Math.round(p.y) !== cy) continue;
        if (me.team >= 0 && p.team === me.team) v -= 3; // 아군은 피함
        else if (!p.trapped) v += 3;
      }
    }
  }
  return v;
}

/** 봇의 이번 틱 입력 */
export function botThink(s: GameState, me: PlayerState, mind: BotMind): { dir: Dir; bomb: boolean } {
  if (!me.alive) { // 👻 유령: 가끔 방향을 바꿔 가며 어슬렁
    if (Math.random() < 0.03) mind.ghostDir = Math.floor(Math.random() * 5) as Dir;
    return { dir: mind.ghostDir, bomb: false };
  }
  if (me.jump) return { dir: Dir.None, bomb: false };
  const cx = Math.round(me.x), cy = Math.round(me.y);
  const here = cy * s.w + cx;
  const danger = dangerMap(s);

  // 2) 위험하면 도망
  if (danger[here] !== SAFE) {
    const out = escape(s, me, danger);
    return { dir: out?.first ?? Dir.None, bomb: false };
  }
  if (me.trapped) return { dir: Dir.None, bomb: false };

  const sd = suddenSchedule(s.mapId);
  // 3) 안전한 칸으로만 다니며 갈 수 있는 곳 탐색
  const nodes = bfs(s, me, (idx) => danger[idx] === SAFE);
  const myBombs = s.bombs.filter((b) => b.owner === me.id).length;
  const canBomb = myBombs < me.bombMax && s.tick >= mind.nextBombTick && !s.bombs.some((b) => b.x === cx && b.y === cy);

  // 4) 지금 자리에서 폭탄을 놓을 가치가 있고, 놓아도 피할 길이 있으면 폭탄
  const tryBomb = () => {
    if (!canBomb || bombValue(s, me, cx, cy) <= 0) return false;
    const after = dangerMap(s, { x: cx, y: cy, range: me.range });
    return escape(s, me, after) !== null;
  };
  if (tryBomb()) {
    mind.nextBombTick = s.tick + 12 + Math.floor(Math.random() * 10);
    return { dir: Dir.None, bomb: true };
  }

  // 목표 점수: 가까울수록 좋고, 종류별 가중치
  let best: Node | null = null, bestScore = -Infinity;
  for (const n of nodes) {
    if (n.dist === 0) continue;
    const x = n.idx % s.w, y = Math.floor(n.idx / s.w);
    let score = -n.dist;
    if (s.tick >= sd.start - 100) { // ⚠️ 서든데스 직전부터는 가운데로 모이기
      score -= (Math.abs(x - (s.w - 1) / 2) + Math.abs(y - (s.h - 1) / 2)) * 1.5;
    }
    if (beltAt(s.mapId, x, y) !== Dir.None) score -= 3; // 벨트 위에 서 있으면 엉뚱한 데로 실려 감
    if (s.items.some((it) => it.x === x && it.y === y)) score += 14;
    if (canBomb) score += Math.max(0, bombValue(s, me, x, y)) * 4;
    for (const p of s.players) {
      if (!p.alive || p === me || p.jump) continue;
      const near = Math.abs(p.x - x) + Math.abs(p.y - y);
      if (p.trapped && near < 0.6) score += 30; // 🫧 아군 구출 / 적 터뜨리기
      else if (!p.trapped && (me.team < 0 || p.team !== me.team) && near <= 2) score += 2; // 적 근처로
    }
    if (score > bestScore) { bestScore = score; best = n; }
  }
  if (best && bestScore > -best.dist) return { dir: best.first, bomb: false };

  // 할 게 없으면 가끔 아무 안전한 방향으로 어슬렁
  if (mind.wander <= 0) mind.wander = 10 + Math.floor(Math.random() * 20);
  mind.wander--;
  const options = nodes.filter((n) => n.dist === 1);
  if (!options.length || mind.wander > 12) return { dir: Dir.None, bomb: false };
  return { dir: options[Math.floor(Math.random() * options.length)].first, bomb: false };
}
