import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, Dir, FUSE_TICKS, Tile } from './constants.ts';
import { createGame, movePlayer, placeBomb, stepWorld, updatePassers, type GameState } from './sim.ts';

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
