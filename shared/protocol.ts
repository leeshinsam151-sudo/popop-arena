// 클라이언트 ↔ 서버 메시지 형식 (JSON over WebSocket, 경로 /ws)
import type { Dir } from './constants.ts';
import type { MapId } from './maps.ts';
import type { Bomb, Flame, Item, PlayerState } from './sim.ts';

export type Phase = 'lobby' | 'playing' | 'ended';
/** 방장이 고른 맵. 'random'이면 판마다 무작위 */
export type MapPick = MapId | 'random';

export type ClientMsg =
  | { t: 'join'; room: string; name: string; char: number }
  | { t: 'in'; s: number; d: Dir; b: number } // s=입력 순번, d=방향, b=폭탄 누른 누적 횟수
  | { t: 'start' }
  | { t: 'map'; mapId: MapPick }
  | { t: 'char'; char: number }
  | { t: 'ping'; c: number }; // 왕복 시간 측정 (c = 클라이언트 시각)

export interface MetaPlayer {
  id: string;
  name: string;
  char: number;
  wins: number;
  playing: boolean; // 이번 라운드 참가 여부 (false면 관전)
}

export type ServerMsg =
  | { t: 'welcome'; id: string; room: string }
  | {
      t: 'meta';
      host: string;
      phase: Phase;
      pick: MapPick; // 방장이 고른 맵 (랜덤 포함)
      mapId: MapId; // 실제로 쓰는 맵 (진행 중인 판, 또는 로비 미리보기)
      players: MetaPlayer[];
      result?: { winner: string | null }; // phase === 'ended'일 때. null이면 무승부
    }
  | {
      t: 's';
      ack: number; // 서버가 처리한 내 마지막 입력 순번
      tick: number;
      timeLeft: number; // 남은 틱
      tiles: string;
      players: PlayerState[];
      bombs: Bomb[];
      flames: Flame[];
      items: Item[];
    }
  | { t: 'pong'; c: number }
  | { t: 'error'; msg: string };

export const ROOM_CODE_RE = /^[a-z0-9]{4,12}$/;
export const NAME_MAX = 12;
