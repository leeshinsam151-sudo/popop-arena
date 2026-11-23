import type { WebSocket } from 'ws';
import { CHARACTERS, DT, Dir, END_TICKS, MAX_PLAYERS, ROUND_TICKS } from '../shared/constants.ts';
import { MAP_IDS, type MapId } from '../shared/maps.ts';
import type { ClientMsg, MapPick, MetaPlayer, Mode, Phase, ServerMsg } from '../shared/protocol.ts';
import { bombAction, createGame, movePlayer, stepWorld, updatePassers, type GameState } from '../shared/sim.ts';
import { botThink, newBotMind, type BotMind } from './bot.ts';

const MAX_CLIENTS = 12; // 플레이어 6 + 관전자
const MAX_QUEUE = 8;

interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  char: number;
  team: number; // 팀전에서 고른 팀 (0/1)
  wins: number;
  playing: boolean;
  inputs: { s: number; d: Dir; b: number }[];
  lastB: number; // 마지막으로 받은 폭탄 누적 횟수
  bombPressed: number; // 서버가 처리한 폭탄 누적 횟수
  ack: number;
}

/** 🤖 AI 봇 (사람이 들어오고 나갈 때마다 남는 캐릭터·팀으로 다시 배정) */
interface Bot { id: string; name: string; char: number; team: number }

const randomId = () => Math.random().toString(36).slice(2, 10);

export class Room {
  private clients = new Map<string, Client>();
  private host = '';
  private phase: Phase = 'lobby';
  private pick: MapPick = 'glacier';
  private mapId: MapId = 'glacier';
  private mode: Mode = 'solo';
  private botCount = 0;
  private bots: Bot[] = [];
  private botWins = new Map<string, number>();
  private minds = new Map<string, BotMind>();
  private state: GameState | null = null;
  private timeLeft = 0;
  private endTicks = 0;
  private result: { winner: string | null; team?: number } | undefined;

  constructor(readonly code: string, private onEmpty: () => void) {}

  get size() { return this.clients.size; }

  /** 이번 판에 뛰는 사람 (최대 6명, 나머지는 관전) */
  private humans() { return [...this.clients.values()].slice(0, MAX_PLAYERS); }

  add(ws: WebSocket, name: string, char: number): Client | null {
    if (this.clients.size >= MAX_CLIENTS) return null;
    const taken = new Set([...this.clients.values()].map((c) => c.char));
    if (taken.has(char) || !(char >= 0 && char < CHARACTERS.length)) {
      const free = CHARACTERS.findIndex((_, i) => !taken.has(i));
      char = free >= 0 ? free : 0;
    }
    // 팀은 사람이 적은 쪽으로
    const humans = [...this.clients.values()];
    const team = humans.filter((h) => h.team === 0).length <= humans.filter((h) => h.team === 1).length ? 0 : 1;
    const c: Client = {
      id: randomId(), ws, name, char, team, wins: 0, playing: false,
      inputs: [], lastB: 0, bombPressed: 0, ack: 0,
    };
    this.clients.set(c.id, c);
    if (!this.host) this.host = c.id;
    this.send(c, { t: 'welcome', id: c.id, room: this.code });
    this.refreshLobby();
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
    this.refreshLobby();
  }

  /** 봇 수·캐릭터·팀을 현재 사람들에 맞춰 다시 정하고 모두에게 알림 */
  private refreshLobby() {
    if (this.phase === 'lobby') {
      const humans = this.humans();
      this.botCount = Math.max(0, Math.min(this.botCount, MAX_PLAYERS - humans.length));
      if (this.mode === 'team' && !this.teamPossible()) this.mode = 'solo';
      const usedChars = new Set(humans.map((h) => h.char));
      const freeChars = CHARACTERS.map((_, i) => i).filter((i) => !usedChars.has(i));
      const count = [0, 1].map((t) => humans.filter((h) => h.team === t).length);
      this.bots = Array.from({ length: this.botCount }, (_, i) => {
        const char = freeChars[i] ?? i;
        const team = count[0] <= count[1] ? 0 : 1; // 인원이 적은 팀을 채움
        count[team]++;
        return { id: `bot-${i}`, name: `봇 ${CHARACTERS[char].name}`, char, team };
      });
    }
    this.broadcastMeta();
  }

  private teamPossible() {
    const total = this.humans().length + this.botCount;
    return total >= 4 && total % 2 === 0;
  }

  onMessage(id: string, msg: ClientMsg) {
    const c = this.clients.get(id);
    if (!c) return;
    const isHost = id === this.host;
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
        if (isHost && this.phase === 'lobby') this.startRound(c);
        break;
      case 'map':
        if (isHost && this.phase === 'lobby' && (msg.mapId === 'random' || MAP_IDS.includes(msg.mapId))) {
          this.pick = msg.mapId;
          if (msg.mapId !== 'random') this.mapId = msg.mapId;
          this.broadcastMeta();
        }
        break;
      case 'char': {
        const ch = msg.char;
        if (this.phase !== 'lobby' || !Number.isInteger(ch) || ch < 0 || ch >= CHARACTERS.length) return;
        if ([...this.clients.values()].some((o) => o !== c && o.char === ch)) return;
        c.char = ch;
        this.refreshLobby();
        break;
      }
      case 'bots':
        if (isHost && this.phase === 'lobby' && Number.isInteger(msg.n)) {
          this.botCount = Math.max(0, Math.min(msg.n, MAX_PLAYERS - this.humans().length));
          this.refreshLobby();
        }
        break;
      case 'mode':
        if (isHost && this.phase === 'lobby' && (msg.mode === 'solo' || msg.mode === 'team')) {
          if (msg.mode === 'team' && !this.teamPossible()) {
            this.send(c, { t: 'error', msg: '팀전은 사람과 봇을 합쳐 4명 또는 6명일 때 할 수 있어요.' });
            return;
          }
          this.mode = msg.mode;
          this.refreshLobby();
        }
        break;
      case 'team':
        if (this.phase === 'lobby' && (msg.team === 0 || msg.team === 1)) {
          c.team = msg.team;
          this.refreshLobby();
        }
        break;
    }
  }

  private startRound(host: Client) {
    const all = [...this.clients.values()];
    const humans = this.humans();
    const team = this.mode === 'team';
    if (team) {
      const size = [0, 1].map((t) => humans.filter((h) => h.team === t).length + this.bots.filter((b) => b.team === t).length);
      if (size[0] !== size[1]) {
        this.send(host, { t: 'error', msg: `팀 인원이 맞지 않아요 (A팀 ${size[0]}명, B팀 ${size[1]}명). 팀을 바꾸거나 봇 수를 조절해 주세요.` });
        return;
      }
    }
    for (const c of all) {
      c.playing = humans.includes(c);
      c.inputs = [];
      c.bombPressed = c.lastB; // 라운드 전에 누른 폭탄은 무시
    }
    const ids = [...humans.map((h) => h.id), ...this.bots.map((b) => b.id)];
    const teams = team ? [...humans.map((h) => h.team), ...this.bots.map((b) => b.team)] : undefined;
    if (this.pick === 'random') this.mapId = MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)];
    this.state = createGame(this.mapId, ids, Math.random, teams);
    this.minds = new Map(this.bots.map((b) => [b.id, newBotMind()]));
    if (process.env.DEV_ITEMS === '1') devItems(this.state);
    if (process.env.DEV_CLEAR === '1') { // 개발·테스트용: 부서지는 블록 없이 시작 (기믹 확인용)
      this.state.tiles = this.state.tiles.map((t) => (t === 2 ? 0 : t));
    }
    this.timeLeft = ROUND_TICKS;
    this.phase = 'playing';
    this.result = undefined;
    this.broadcastMeta();
  }

  private endRound(winner: string | null, team?: number) {
    this.phase = 'ended';
    this.endTicks = END_TICKS;
    this.result = { winner, team };
    const winners = team !== undefined
      ? this.state!.players.filter((p) => p.team === team).map((p) => p.id)
      : winner ? [winner] : [];
    for (const id of winners) {
      const c = this.clients.get(id);
      if (c) c.wins++;
      else if (id.startsWith('bot-')) this.botWins.set(id, (this.botWins.get(id) ?? 0) + 1);
    }
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
      // 🤖 봇: 사람과 같은 방식으로 입력
      for (const [id, mind] of this.minds) {
        const p = s.players.find((pp) => pp.id === id);
        if (!p?.alive) continue;
        const inp = botThink(s, p, mind);
        if (inp.bomb) bombAction(s, p);
        movePlayer(s, p, inp.dir, DT);
      }
      updatePassers(s);
      stepWorld(s, Math.random);
      this.timeLeft--;
      this.checkEnd(s);
    } else if (this.phase === 'ended') {
      updatePassers(s);
      stepWorld(s, Math.random); // 불길이 사라지는 모습까지 보여 줌
      if (--this.endTicks <= 0) {
        this.phase = 'lobby';
        this.state = null;
        for (const c of this.clients.values()) c.playing = false;
        this.refreshLobby();
        return;
      }
    }
    const base = this.snapshotBase();
    for (const c of this.clients.values()) this.sendSnapshot(c, base);
  }

  private checkEnd(s: GameState) {
    const alive = s.players.filter((p) => p.alive);
    if (this.mode === 'team' && s.players.some((p) => p.team >= 0)) {
      const teams = new Set(alive.map((p) => p.team));
      if (teams.size === 1) return this.endRound(null, [...teams][0]);
      if (teams.size === 0) return this.endRound(null);
    } else {
      const solo = s.players.length === 1;
      if (solo ? alive.length === 0 : alive.length <= 1) return this.endRound(!solo && alive.length === 1 ? alive[0].id : null);
    }
    if (this.timeLeft <= 0) this.endRound(null);
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
    const team = this.mode === 'team';
    const players: MetaPlayer[] = [
      ...[...this.clients.values()].map((c) => ({
        id: c.id, name: c.name, char: c.char, wins: c.wins, playing: c.playing, team: team ? c.team : -1,
      })),
      ...this.bots.map((b) => ({
        id: b.id, name: b.name, char: b.char, wins: this.botWins.get(b.id) ?? 0,
        playing: this.phase !== 'lobby', bot: true, team: team ? b.team : -1,
      })),
    ];
    const msg: ServerMsg = {
      t: 'meta', host: this.host, phase: this.phase, pick: this.pick, mapId: this.mapId,
      players, mode: this.mode, bots: this.botCount, result: this.result,
    };
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
