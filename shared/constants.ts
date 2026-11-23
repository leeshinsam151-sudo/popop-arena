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
/** 아이템 등장 비율 (ItemType 순서: 폭탄, 화력, 속도, 축구화, 글러브) */
export const ITEM_WEIGHTS = [30, 30, 16, 12, 12];

export const KICK_SPEED = 8; // ⚽ 찬 폭탄이 미끄러지는 속도 (칸/초)
export const THROW_DIST = 3; // 🧤 던지는 거리 (칸)
export const THROW_TICKS = 8; // 3칸 비행 시간 (0.4초)
export const THROW_BOUNCE_TICKS = 2; // 착지 칸이 막혀 한 칸 더 갈 때마다 추가 비행 시간

export enum Tile {
  Floor = 0,
  Wall = 1,
  Soft = 2,
  Pit = 3, // 용암 강: 걸어서 못 건너지만 불길은 통과
  Frozen = 4, // 🧊 언 상자: 한 번 맞으면 금이 감
  Cracked = 5, // 🧊 금 간 상자: 한 번 더 맞으면 깨지고 아이템이 반드시 나옴
}

// ---------- 맵 기믹 ----------
export const ICE_DECEL = 4.5; // 🧊 얼음 위에서 손을 떼면 이 감속도(칸/초²)로 미끄러지다 멈춤 → 약 1칸 더 감
export const QUICKSAND_MUL = 0.6; // 🏜️ 유사 위 이동 속도 배율
export const LAVA_CYCLE = 80; // 🌋 용암 균열 주기 4초 (틱)
export const LAVA_WARN = 32; // 분출 전 경고 1.6초
export const LAVA_ERUPT = 16; // 분출 0.8초 (불길과 똑같이 위험)
export const JUMP_TIME = 0.5; // 🍄 버섯 점프 체공 시간(초)
export const JUMP_DIST = 2; // 버섯 점프 거리(칸)
export const SANDSTORM_PERIOD = 45 * TICK_RATE; // 🌪️ 모래폭풍 주기 (연출만)
export const SANDSTORM_TICKS = 8 * TICK_RATE;

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
  Kick = 3, // ⚽ 축구화
  Glove = 4, // 🧤 글러브
}

// 캐릭터 6종 (디자인 시안과 동일한 색)
export const CHARACTERS = [
  { id: 'pop', name: '뿅', color: 0xff4b3e, desc: '불꽃 정령 · 성격 급한 돌격대장' },
  { id: 'dung', name: '둥', color: 0x3d7bff, desc: '곰 후드 · 느긋하고 듬직한 형' },
  { id: 'leaf', name: '리프', color: 0x35c46a, desc: '새싹 요정 · 차분한 전략가' },
  { id: 'volt', name: '볼트', color: 0xffc531, desc: '꼬마 로봇 · 계산적인 발명가' },
  { id: 'mia', name: '미야', color: 0x9b5cff, desc: '고양이 후드 · 못 말리는 장난꾸러기' },
  { id: 'koko', name: '코코', color: 0xff7eb6, desc: '토끼 · 늘 신나는 명랑 담당' },
] as const;
