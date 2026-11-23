// 게임 규칙 상수. 서버와 클라이언트(예측)가 같은 값을 쓴다.
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS = 6;
export const FUSE_TICKS = 50; // 2.5초
export const FLAME_TICKS = 10; // 0.5초
export const ROUND_TICKS = 150 * TICK_RATE; // 2분 30초
export const END_TICKS = 4 * TICK_RATE; // 결과 화면 4초

export const BASE_SPEED = 3.4; // 칸/초
export const SPEED_STEP = 0.45;
export const MAX_SPEED_LV = 5;
export const MAX_BOMBS = 8;
export const MAX_RANGE = 8;
export const CORNER_ASSIST = 0.65; // 모서리 보정: 옆 길까지 이 거리 이내면 자동으로 미끄러짐(칸)

export const SOFT_DENSITY = 0.45;
export const ITEM_CHANCE = 0.32;

export enum Tile {
  Floor = 0,
  Wall = 1,
  Soft = 2,
  Pit = 3, // 용암 강: 걸어서 못 건너지만 불길은 통과
}

export enum Dir {
  None = 0,
  Up = 1,
  Down = 2,
  Left = 3,
  Right = 4,
}
export const DIR_VEC: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

export enum ItemType {
  Bomb = 0,
  Fire = 1,
  Speed = 2,
}

// 캐릭터 6종 (디자인 시안과 동일한 색)
export const CHARACTERS = [
  { id: 'pop', name: '뿅', color: 0xff4b3e },
  { id: 'dung', name: '둥', color: 0x3d7bff },
  { id: 'leaf', name: '리프', color: 0x35c46a },
  { id: 'volt', name: '볼트', color: 0xffc531 },
  { id: 'mia', name: '미야', color: 0x9b5cff },
  { id: 'koko', name: '코코', color: 0xff7eb6 },
] as const;
