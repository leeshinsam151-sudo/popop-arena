import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, Dir, FUSE_TICKS, JUMP_TIME, ROUND_TICKS, Tile } from './constants.ts';
import { MAP_ROWS, type MapId } from './maps.ts';
import { bombAction, createGame, isBlocked, lavaCracks, seededRandom, suddenSchedule, lavaState, movePlayer, placeBomb, stepWorld, throwBomb, updatePassers, type GameState, type PlayerState } from './sim.ts';

const noRand = () => 0.99; // 랜덤 블록 없음, 아이템 없음

function emptyGame(n = 2): GameState {
  return createGame('glacier', Array.from({ length: n }, (_, i) => 'p' + i), noRand);
}
const run = (s: GameState, ticks: number) => { for (let i = 0; i < ticks; i++) stepWorld(s, noRand); };

test('벽 쪽으로는 칸 중심에서 멈춘다', () => {
  const s = emptyGame();
  const p = s.players[0]; // (1,1), 왼쪽은 외곽 벽
  for (let i = 0; i < 10; i++) movePlayer(s, p, Dir.Left, DT);
  assert.equal(p.x, 1);
  for (let i = 0; i < 10; i++) movePlayer(s, p, Dir.Up, DT);
  assert.equal(p.y, 1);
});

test('빈 길은 속도만큼 이동한다', () => {
  const s = emptyGame();
  const p = s.players[0];
  movePlayer(s, p, Dir.Right, DT);
  assert.ok(Math.abs(p.x - (1 + 3.4 * DT)) < 1e-9);
  assert.equal(p.y, 1);
});

test('모서리 보정: 길에서 살짝 벗어나 있으면 옆 길로 미끄러진다', () => {
  const s = emptyGame();
  const p = s.players[0];
  // (2,2)는 기둥. (1,2)에서 오른쪽은 막혀 있고, y=1.6이면 1번 길과 0.4 차이
  p.x = 1; p.y = 1.6;
  for (let i = 0; i < 6; i++) movePlayer(s, p, Dir.Right, DT);
  assert.equal(p.y, 1);
  assert.ok(p.x > 1);
});

test('폭탄: 설치한 칸은 빠져나갈 때까지 통과, 이후엔 막힘', () => {
  const s = emptyGame();
  const p = s.players[0];
  assert.ok(placeBomb(s, p));
  assert.deepEqual(s.bombs[0].passers, ['p0']);
  for (let i = 0; i < 8; i++) { movePlayer(s, p, Dir.Right, DT); updatePassers(s); }
  assert.ok(p.x >= 2, 'bomb cell exited');
  assert.deepEqual(s.bombs[0].passers, []);
  for (let i = 0; i < 20; i++) { movePlayer(s, p, Dir.Left, DT); updatePassers(s); }
  assert.equal(p.x, 2, 'blocked by own bomb after leaving');
});

test('폭발: 블록 파괴, 사거리 안 플레이어 사망, 벽에서 멈춤', () => {
  const s = emptyGame();
  const p = s.players[0];
  s.tiles[1 * s.w + 4] = Tile.Soft; // (4,1)
  p.x = 3; p.y = 1;
  placeBomb(s, p);
  p.x = 3; p.y = 3; // 사거리 2 안 (세로)
  run(s, FUSE_TICKS);
  assert.equal(s.tiles[1 * s.w + 4], Tile.Floor);
  assert.equal(p.alive, false);
  assert.ok(!s.flames.some((f) => f.x === 2 && f.y === 0), 'wall stops flame');
});

test('연쇄 폭발: 불길에 닿은 폭탄은 같은 틱에 터진다', () => {
  const s = emptyGame();
  const [a, b] = s.players;
  a.x = 3; a.y = 5; placeBomb(s, a);
  run(s, 10);
  b.x = 5; b.y = 5; placeBomb(s, b);
  a.x = 1; a.y = 1; b.x = s.w - 2; b.y = s.h - 2;
  run(s, FUSE_TICKS - 10);
  assert.equal(s.bombs.length, 0, 'both exploded together');
});

test('⚽ 축구화: 폭탄 쪽으로 걸으면 차고, 막힐 때까지 미끄러진다', () => {
  const s = emptyGame();
  const p = s.players[0];
  p.kick = true;
  p.x = 3; p.y = 1; placeBomb(s, p); // (3,1)에 폭탄
  p.x = 1; // 왼쪽으로 떨어져서
  updatePassers(s);
  for (let i = 0; i < 12; i++) { movePlayer(s, p, Dir.Right, DT); updatePassers(s); stepWorld(s, noRand); }
  const b = s.bombs[0];
  assert.ok(b.x > 3, 'bomb slid right');
  for (let i = 0; i < 30 && s.bombs[0].slide; i++) stepWorld(s, noRand);
  assert.equal(b.slide, Dir.None, 'stopped');
  assert.equal(b.x, s.w - 2, 'stopped at the wall');
  assert.equal(b.fx, b.x, 'stopped on cell center');
});

test('⚽ 축구화가 없으면 폭탄은 움직이지 않는다', () => {
  const s = emptyGame();
  const p = s.players[0];
  p.x = 3; p.y = 1; placeBomb(s, p);
  p.x = 1; updatePassers(s);
  for (let i = 0; i < 12; i++) { movePlayer(s, p, Dir.Right, DT); updatePassers(s); stepWorld(s, noRand); }
  assert.equal(s.bombs[0].x, 3);
  assert.equal(p.x, 2, 'stopped in front of the bomb');
});

test('🧤 글러브: 발밑 폭탄을 바라보는 방향 3칸 앞으로 던지고, 나는 동안 시간이 멈춘다', () => {
  const s = emptyGame();
  const p = s.players[0];
  p.glove = true; p.x = 3; p.y = 1; p.facing = Dir.Right;
  assert.ok(bombAction(s, p), 'first press places');
  stepWorld(s, noRand);
  const fuseBefore = s.bombs[0].fuse;
  assert.ok(bombAction(s, p), 'second press throws');
  const b = s.bombs[0];
  assert.equal(b.x, 6);
  assert.ok(b.fly > 0);
  for (let i = 0; i < b.flyTotal; i++) stepWorld(s, noRand);
  assert.equal(b.fly, 0, 'landed');
  assert.equal(b.fuse, fuseBefore, 'fuse paused in flight');
});

test('🧤 글러브: 벽 너머로 던지고, 착지 칸이 막혀 있으면 더 멀리 간다', () => {
  const s = emptyGame();
  const p = s.players[0];
  p.glove = true; p.x = 1; p.y = 1; p.facing = Dir.Down;
  placeBomb(s, p);
  s.tiles[4 * s.w + 1] = Tile.Soft; // (1,4) 막음 → (1,5)로
  throwBomb(s, p);
  assert.equal(s.bombs[0].y, 5);
  assert.equal(s.bombs[0].x, 1);
});

// ---------- 맵 기믹 ----------
const mapGame = (mapId: MapId) => createGame(mapId, ['p0', 'p1'], noRand);
const press = (s: GameState, p: PlayerState, dir: Dir, ticks: number) => {
  for (let i = 0; i < ticks; i++) { movePlayer(s, p, dir, DT); updatePassers(s); }
};

test('🧊 얼음: 손을 떼도 미끄러져서 더 가고, 일반 바닥에서는 바로 멈춘다', () => {
  const s = mapGame('glacier');
  const ice = s.players[0], floor = s.players[1];
  ice.x = 5; ice.y = 5; // (5,5)~ 얼음 호수
  floor.x = 2; floor.y = 1; // 1번 줄 일반 바닥
  press(s, ice, Dir.Right, 4); press(s, floor, Dir.Right, 4);
  const iceAtRelease = ice.x, floorAtRelease = floor.x;
  press(s, ice, Dir.None, 20); press(s, floor, Dir.None, 20);
  assert.equal(floor.x, floorAtRelease, 'floor: stops immediately');
  assert.ok(ice.x - iceAtRelease > 0.8, `ice slid ${(ice.x - iceAtRelease).toFixed(2)} tiles`);
  assert.equal(ice.mom, 0, 'eventually stops');
});

test('🧊 언 상자: 두 번 맞아야 깨지고, 깨지면 아이템이 반드시 나온다', () => {
  const s = mapGame('glacier');
  const p = s.players[0];
  const idx = 3 * s.w + 5; // (5,3) 언 상자
  assert.equal(s.tiles[idx], Tile.Frozen);
  p.x = 5; p.y = 5; placeBomb(s, p); p.x = 1; p.y = 1;
  run(s, FUSE_TICKS + 12);
  assert.equal(s.tiles[idx], Tile.Cracked, 'first hit cracks');
  assert.equal(s.items.length, 0);
  p.x = 5; p.y = 5; placeBomb(s, p); p.x = 1; p.y = 1;
  run(s, FUSE_TICKS + 12);
  assert.equal(s.tiles[idx], Tile.Floor, 'second hit breaks');
  assert.ok(s.items.some((it) => it.x === 5 && it.y === 3), 'guaranteed item');
});

test('🏜️ 유사: 위에 있으면 이동 속도가 60%', () => {
  const s = mapGame('desert');
  const p = s.players[0];
  p.x = 4; p.y = 7; // 유사
  press(s, p, Dir.Right, 1);
  assert.ok(Math.abs(p.x - (4 + 3.4 * 0.6 * DT)) < 1e-9);
});

test('🍄 버섯: 누르는 방향으로 2칸 점프해서 사이의 블록을 넘고, 공중에서는 불길에 안 맞는다', () => {
  const s = mapGame('forest');
  const p = s.players[0];
  s.tiles[4 * s.w + 3] = Tile.Soft; // (3,4) 막음
  p.x = 3; p.y = 5; // (3,5) 버섯
  press(s, p, Dir.Up, 1);
  assert.ok(p.jump, 'launched');
  s.flames.push({ x: 3, y: 4, ttl: 30 }, { x: 3, y: 5, ttl: 30 });
  stepWorld(s, noRand);
  assert.ok(p.alive, 'immune in the air');
  s.flames = [];
  press(s, p, Dir.None, Math.ceil(JUMP_TIME / DT) + 1);
  assert.equal(p.jump, null);
  assert.deepEqual([p.x, p.y], [3, 3], 'landed 2 cells up');
});

test('🌀 워프: 석판 한가운데에 서면 짝 석판으로 이동하고, 벗어나기 전엔 다시 안 탄다', () => {
  const s = mapGame('desert');
  const p = s.players[0];
  p.x = 2; p.y = 3; // A 석판 (3,3) 왼쪽
  for (let i = 0; i < 10 && p.y !== 11; i++) press(s, p, Dir.Right, 1);
  assert.deepEqual([p.x, p.y], [15, 11], 'warped to the other A');
  press(s, p, Dir.None, 10);
  assert.deepEqual([p.x, p.y], [15, 11], 'no bounce back while standing on it');
  press(s, p, Dir.Left, 8); // 석판에서 벗어났다가
  assert.ok(p.x < 14.5);
  for (let i = 0; i < 12 && p.y !== 3; i++) press(s, p, Dir.Right, 1); // 다시 올라서면
  assert.deepEqual([p.x, p.y], [3, 3], 'can warp again after leaving');
});

test('🌋 용암 균열: 주기적으로 분출하고, 분출 중 위에 있으면 죽는다', () => {
  const s = mapGame('volcano');
  const p = s.players[0];
  const [x, y, off] = lavaCracks('volcano')[0];
  p.x = x; p.y = y;
  let erupted = false;
  for (let i = 0; i < 80 && p.alive; i++) {
    stepWorld(s, noRand);
    if (lavaState(s.tick, off) === 2) erupted = true;
  }
  assert.ok(erupted);
  assert.equal(p.alive, false);
});

test('🌀🍄 도착 칸 주변에는 랜덤 블록이 없어서 갇히지 않는다 (시드 200개)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (const mapId of ['desert', 'forest'] as const) {
      const s = createGame(mapId, ['p0'], seededRandom(seed));
      const rows = MAP_ROWS[mapId];
      const arrivals: [number, number][] = [];
      rows.forEach((row, y) => [...row].forEach((ch, x) => {
        if ('ABC'.includes(ch)) arrivals.push([x, y]);
        if (ch === 'M') for (const [dx, dy] of [[0, 2], [0, -2], [2, 0], [-2, 0]]) {
          const tx = x + dx, ty = y + dy;
          if (tx > 0 && ty > 0 && tx < s.w - 1 && ty < s.h - 1) arrivals.push([tx, ty]);
        }
      }));
      for (const [x, y] of arrivals) {
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          assert.notEqual(s.tiles[(y + dy) * s.w + (x + dx)], Tile.Soft, `${mapId} seed ${seed}: soft block next to (${x},${y})`);
        }
      }
    }
  }
});

// ---------- 팀전 🫧 ----------
const teamGame = () => createGame('glacier', ['a1', 'b1', 'a2', 'b2'], noRand, [0, 1, 0, 1]);

test('팀전 스폰: A팀은 왼쪽, B팀은 오른쪽', () => {
  const s = teamGame();
  const [a1, b1, a2, b2] = s.players;
  assert.ok(a1.x === 1 && a2.x === 1);
  assert.ok(b1.x === s.w - 2 && b2.x === s.w - 2);
});

test('🫧 팀전: 불길에 맞으면 갇히고, 아군이 닿으면 구출된다', () => {
  const s = teamGame();
  const [a1, , a2] = s.players;
  s.flames.push({ x: Math.round(a1.x), y: Math.round(a1.y), ttl: 5 });
  stepWorld(s, noRand);
  assert.ok(a1.alive && a1.trapped > 0, 'trapped, not dead');
  assert.equal(placeBomb(s, a1), false, 'no bombs while trapped');
  s.flames = [];
  a2.x = a1.x + 0.5; a2.y = a1.y;
  stepWorld(s, noRand);
  assert.equal(a1.trapped, 0, 'rescued');
  assert.ok(a1.alive && a1.shield > 0);
});

test('🫧 팀전: 적이 닿거나 시간이 다 되면 탈락', () => {
  const s = teamGame();
  const [a1, b1, a2] = s.players;
  a1.trapped = 50;
  b1.x = a1.x; b1.y = a1.y + 0.5;
  stepWorld(s, noRand);
  assert.equal(a1.alive, false, 'popped by enemy');
  a2.trapped = 3;
  run(s, 3);
  assert.equal(a2.alive, false, 'timed out');
});

test('🫧 팀전: 팀원이 모두 갇히면 그 팀은 전멸', () => {
  const s = teamGame();
  const [a1, b1, a2] = s.players;
  a1.trapped = 80; a2.trapped = 80;
  stepWorld(s, noRand);
  assert.equal(a1.alive || a2.alive, false);
  assert.ok(b1.alive);
});

test('개인전은 불길에 맞으면 바로 탈락 (물방울 없음)', () => {
  const s = emptyGame();
  const p = s.players[0];
  s.flames.push({ x: 1, y: 1, ttl: 5 });
  stepWorld(s, noRand);
  assert.equal(p.alive, false);
  assert.equal(p.trapped, 0);
});

// ---------- 놀이공원 🎢 ----------
test('🎢 벨트: 가만히 있어도 화살표 방향으로 실려 간다', () => {
  const s = mapGame('park');
  const p = s.players[0];
  p.x = 6; p.y = 5; // 위쪽 줄 '>' 벨트
  press(s, p, Dir.None, 10);
  assert.ok(Math.abs(p.x - (6 + 1.6 * 0.5)) < 1e-6, `moved to ${p.x}`);
  assert.equal(p.y, 5);
});

test('🎢 벨트: 가로질러 건너갈 수 있다 (벨트 쪽으로 끌려가지 않음)', () => {
  const s = mapGame('park');
  const p = s.players[0];
  p.x = 7; p.y = 4; // 벨트(5번 줄) 바로 위
  press(s, p, Dir.Down, 20);
  assert.ok(p.y >= 6, `crossed to y=${p.y.toFixed(2)}`);
});

test('🎢 벨트: 위에 놓은 폭탄도 실려 가고, 막히면 칸 중심에 멈춘다', () => {
  const s = mapGame('park');
  const p = s.players[0];
  p.x = 6; p.y = 5; placeBomb(s, p);
  p.x = 1; p.y = 1; updatePassers(s);
  run(s, 20);
  const b = s.bombs[0];
  assert.ok(b.x > 6, `bomb carried to ${b.fx.toFixed(2)}`);
  s.tiles[5 * s.w + 10] = Tile.Soft; // 앞을 막으면
  run(s, 20);
  assert.equal(b.fx, 9, 'stopped at the cell before the block');
});

test('🤸 트램펄린: 버섯처럼 2칸 점프', () => {
  const s = mapGame('park');
  const p = s.players[0];
  p.x = 3; p.y = 3; // J
  press(s, p, Dir.Right, 1);
  assert.ok(p.jump);
  press(s, p, Dir.None, Math.ceil(JUMP_TIME / DT) + 1);
  assert.deepEqual([p.x, p.y], [5, 3]);
});

// ---------- 서든데스 ⚠️ ----------
test('⚠️ 서든데스 일정: 바깥부터 떨어지고, 가운데는 남고, 판 끝나기 전에 끝난다', () => {
  for (const mapId of ['glacier', 'volcano', 'forest', 'desert', 'park'] as const) {
    const { cells, interval, start } = suddenSchedule(mapId);
    assert.ok(cells.length > 50, `${mapId}: ${cells.length} cells`);
    assert.ok(start + interval * cells.length <= ROUND_TICKS - 4 * 20, `${mapId}: finishes before the round ends`);
    const [fx, fy] = cells[0];
    assert.ok(fx === 1 || fy === 1, 'starts at the outer ring');
    assert.ok(!cells.some(([x, y]) => x === 9 && y === 7), 'center never falls');
  }
});

test('⚠️ 서든데스: 떨어진 칸은 벽이 되고 그 위 사람은 탈락, 가운데는 살아남는다', () => {
  const s = createGame('glacier', ['p0', 'p1'], noRand, [0, 1]); // 팀전이어도 바로 탈락
  const [corner, center] = s.players;
  corner.x = 1; corner.y = 1;
  center.x = 9; center.y = 7;
  const { cells, start, interval } = suddenSchedule('glacier');
  s.tick = start - 1;
  for (let i = 0; i < cells.length * interval + 2; i++) stepWorld(s, noRand);
  assert.equal(corner.alive, false);
  assert.equal(corner.trapped, 0, 'no bubble: crushed');
  assert.ok(center.alive);
  for (const [x, y] of cells) assert.equal(s.tiles[y * s.w + x], Tile.Fallen);
  assert.ok(isBlocked(s, 1, 1, 'p1'));
});

// ---------- 유령 👻 ----------
test('👻 탈락하면 가장 가까운 경기장 바깥으로 나가 유령이 된다', () => {
  const s = emptyGame();
  const p = s.players[0]; // (1,1): 왼쪽·위쪽 벽이 가깝다
  p.x = 1; p.y = 3;
  s.flames.push({ x: 1, y: 3, ttl: 5 });
  stepWorld(s, noRand);
  assert.equal(p.alive, false);
  assert.ok(p.ghost);
  assert.ok(p.x < -1, `moved out to the left: x=${p.x}`);
  assert.equal(p.y, 3);
});

test('👻 유령은 경기장 밖에서만 움직이고, 안으로 들어가려 하면 막힌다', () => {
  const s = emptyGame();
  const p = s.players[0];
  p.x = 1; p.y = 3;
  s.flames.push({ x: 1, y: 3, ttl: 5 });
  stepWorld(s, noRand);
  press(s, p, Dir.Right, 40); // 경기장 쪽으로 가도
  assert.ok(p.x <= -1, `stops at the arena edge: x=${p.x}`);
  press(s, p, Dir.Up, 40); // 테두리를 따라 위로
  assert.ok(p.y < 3);
  press(s, p, Dir.Left, 200);
  assert.ok(p.x >= -1 - 4.5 - 1e-9, 'cannot wander too far');
});
