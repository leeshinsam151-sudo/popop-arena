import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, TICK_RATE, Tile } from '../shared/constants.ts';
import { MAP_IDS } from '../shared/maps.ts';
import { bombAction, createGame, movePlayer, seededRandom, stepWorld, updatePassers } from '../shared/sim.ts';
import { botThink, newBotMind } from './bot.ts';

test('🤖 봇 4명: 맵마다 블록을 부수고, 시작 15초 안에는 거의 죽지 않는다', () => {
  let deaths = 0;
  for (const mapId of MAP_IDS) {
    for (let g = 0; g < 3; g++) {
      const s = createGame(mapId, ['b0', 'b1', 'b2', 'b3'], seededRandom(g + 1));
      const minds = s.players.map(() => newBotMind());
      const soft0 = s.tiles.filter((t) => t === Tile.Soft).length;
      for (let t = 0; t < 15 * TICK_RATE; t++) {
        s.players.forEach((p, i) => {
          if (!p.alive) return;
          const inp = botThink(s, p, minds[i]);
          if (inp.bomb) bombAction(s, p);
          movePlayer(s, p, inp.dir, DT);
        });
        updatePassers(s);
        stepWorld(s, Math.random);
      }
      const broken = soft0 - s.tiles.filter((t) => t === Tile.Soft).length;
      assert.ok(broken >= 4, `${mapId}#${g}: broke ${broken} blocks`);
      deaths += s.players.filter((p) => !p.alive).length;
    }
  }
  // 봇끼리 싸우니 가끔은 죽을 수 있지만, 자폭을 반복하는 봇이면 이 수가 크게 늘어난다
  assert.ok(deaths <= 3, `${deaths} deaths in 12 games (15s each)`);
});
