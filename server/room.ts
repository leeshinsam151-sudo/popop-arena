import type { WebSocket } from 'ws';
import { CHARACTERS, DT, Dir, END_TICKS, MAX_PLAYERS, ROUND_TICKS } from '../shared/constants.ts';
import { MAP_IDS, type MapId } from '../shared/maps.ts';
import type { ClientMsg, MetaPlayer, Phase, ServerMsg } from '../shared/protocol.ts';
import { bombAction, createGame, movePlayer, stepWorld, updatePassers, type GameState } from '../shared/sim.ts';

const MAX_CLIENTS = 12; // 플레이어 6 + 관전자
const MAX_QUEUE = 8;

interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  char: number;
  wins: number;
  playing: boolean;
  inputs: { s: number; d: Dir; b: number }[];
  lastB: number; // 마지막으로 받은 폭탄 누적 횟수
  bombPressed: number; // 서버가 처리한 폭탄 누적 횟수
  ack: number;
}

const randomId = () => Math.random().toString(36).slice(2, 10);

export class Room {
  private clients = new Map<string, Client>();
  private host = '';
  private phase: Phase = 'lobby';
  private mapId: MapId = 'glacier';
  private state: GameState | null = null;
  private timeLeft = 0;
  private endTicks = 0;
  private result: { winner: string | null } | undefined;

  constructor(readonly code: string, private onEmpty: () => void) {}

  get size() { return this.clients.size; }

  add(ws: WebSocket, name: string, char: number): Client | null {
    if (this.clients.size >= MAX_CLIENTS) return null;
    const taken = new Set([...this.clients.values()].map((c) => c.char));
    if (taken.has(char) || !(char >= 0 && char < CHARACTERS.length)) {
      const free = CHARACTERS.findIndex((_, i) => !taken.has(i));
      char = free >= 0 ? free : 0;
    }
    const c: Client = {
      id: randomId(), ws, name, char, wins: 0, playing: false,
      inputs: [], lastB: 0, bombPressed: 0, ack: 0,
    };
    this.clients.set(c.id, c);
    if (!this.host) this.host = c.id;
    this.send(c, { t: 'welcome', id: c.id, room: this.code });
    this.broadcastMeta();
    if (this.state) this.sendSnapshot(c, this.snapshotBase());
    return c;
  }

  remove(id: string) {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    const p = this.state?.players.find((pp) => pp.id === id);
    if (p) p.alive = false;
    if (this.host === id) this.host = this.clients.keys().next().value ?? '';
    if (this.clients.size === 0) { this.onEmpty(); return; }
    this.broadcastMeta();
  }

  onMessage(id: string, msg: ClientMsg) {
    const c = this.clients.get(id);
    if (!c) return;
    switch (msg.t) {
      case 'in': {
        const d = msg.d as number;
        if (!Number.isInteger(d) || d < 0 || d > 4) return;
        if (!Number.isFinite(msg.s) || !Number.isInteger(msg.b) || msg.b < 0) return;
        c.lastB = msg.b;
        if (!c.playing) { c.ack = msg.s; return; }
        c.inputs.push({ s: msg.s, d: d as Dir, b: msg.b });
        if (c.inputs.length > MAX_QUEUE) c.inputs.shift();
        break;
      }
      case 'start':
        if (id === this.host && this.phase === 'lobby') this.startRound();
        break;
      case 'map':
        if (id === this.host && this.phase === 'lobby' && MAP_IDS.includes(msg.mapId)) {
          this.mapId = msg.mapId;
          this.broadcastMeta();
        }
        break;
      case 'char': {
        const ch = msg.char;
        if (this.phase !== 'lobby' || !Number.isInteger(ch) || ch < 0 || ch >= CHARACTERS.length) return;
        if ([...this.clients.values()].some((o) => o !== c && o.char === ch)) return;
        c.char = ch;
        this.broadcastMeta();
        break;
      }
    }
  }

  private startRound() {
    const all = [...this.clients.values()];
    const players = all.slice(0, MAX_PLAYERS);
    for (const c of all) {
      c.playing = players.includes(c);
      c.inputs = [];
      c.bombPressed = c.lastB; // 라운드 전에 누른 폭탄은 무시
    }
    this.state = createGame(this.mapId, players.map((c) => c.id), Math.random);
    if (process.env.DEV_ITEMS === '1') devItems(this.state);
    this.timeLeft = ROUND_TICKS;
    this.phase = 'playing';
    this.result = undefined;
    this.broadcastMeta();
  }

  private endRound(winner: string | null) {
    this.phase = 'ended';
    this.endTicks = END_TICKS;
    this.result = { winner };
    const w = winner ? this.clients.get(winner) : undefined;
    if (w) w.wins++;
    this.broadcastMeta();
  }

  tick() {
    const s = this.state;
    if (!s) return;
    if (this.phase === 'playing') {
      for (const c of this.clients.values()) {
        if (!c.playing) continue;
        const p = s.players.find((pp) => pp.id === c.id);
        if (!p) continue;
        // 보통 틱당 입력 1개. 밀린 입력이 많으면 따라잡기 위해 2개까지 처리
        const n = c.inputs.length > 2 ? 2 : c.inputs.length;
        for (let i = 0; i < n; i++) {
          const inp = c.inputs.shift()!;
          c.ack = inp.s;
          if (inp.b > c.bombPressed) { c.bombPressed = inp.b; bombAction(s, p); }
          movePlayer(s, p, inp.d, DT);
        }
      }
      updatePassers(s);
      stepWorld(s, Math.random);
      this.timeLeft--;
      const alive = s.players.filter((p) => p.alive);
      const solo = s.players.length === 1;
      if (solo ? alive.length === 0 : alive.length <= 1) this.endRound(!solo && alive.length === 1 ? alive[0].id : null);
      else if (this.timeLeft <= 0) this.endRound(null);
    } else if (this.phase === 'ended') {
      updatePassers(s);
      stepWorld(s, Math.random); // 불길이 사라지는 모습까지 보여 줌
      if (--this.endTicks <= 0) {
        this.phase = 'lobby';
        this.state = null;
        for (const c of this.clients.values()) c.playing = false;
        this.broadcastMeta();
        return;
      }
    }
    const base = this.snapshotBase();
    for (const c of this.clients.values()) this.sendSnapshot(c, base);
  }

  private snapshotBase(): string {
    const s = this.state!;
    return JSON.stringify({
      tick: s.tick, timeLeft: this.timeLeft, tiles: s.tiles.join(''),
      players: s.players, bombs: s.bombs, flames: s.flames, items: s.items,
    });
  }

  private sendSnapshot(c: Client, base: string) {
    // 플레이어마다 ack만 다르므로 본문은 한 번만 직렬화
    if (c.ws.readyState === 1) c.ws.send(`{"t":"s","ack":${c.ack},${base.slice(1)}`);
  }

  private broadcastMeta() {
    const players: MetaPlayer[] = [...this.clients.values()].map((c) => ({
      id: c.id, name: c.name, char: c.char, wins: c.wins, playing: c.playing,
    }));
    const msg: ServerMsg = { t: 'meta', host: this.host, phase: this.phase, mapId: this.mapId, players, result: this.result };
    const text = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(text);
  }

  private send(c: Client, msg: ServerMsg) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }
}

/** 개발·테스트용 (DEV_ITEMS=1): 시작부터 축구화·글러브 지급, 첫 스폰 오른쪽에 아이템 5종 배치 */
function devItems(s: GameState) {
  for (const p of s.players) { p.kick = true; p.glove = true; }
  for (let i = 0; i < 5; i++) {
    const x = 3 + i, y = 1;
    s.tiles[y * s.w + x] = 0;
    s.items.push({ x, y: y + 2, type: i });
    s.tiles[(y + 2) * s.w + x] = s.tiles[(y + 2) * s.w + x] === 1 ? 1 : 0;
  }
}
