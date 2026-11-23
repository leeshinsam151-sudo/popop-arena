#!/usr/bin/env python3
"""맵 4종 생성기. 모든 기믹을 상하좌우 대칭으로 배치해 스폰마다 공정하게 만든다.
실행: python3 tools/genmaps.py  → shared/maps.ts 갱신"""
import json, pathlib
W, H = 19, 15            # 홀수여야 기둥(짝수 좌표) 배치가 맞음
CX, CY = W // 2, H // 2  # 중앙 (9, 7)
SPAWNS = [(1, 1), (CX, 1), (W - 2, 1), (1, H - 2), (CX, H - 2), (W - 2, H - 2)]

def base():
    g = [['.' for _ in range(W)] for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if x in (0, W - 1) or y in (0, H - 1) or (x % 2 == 0 and y % 2 == 0):
                g[y][x] = '#'
    for sx, sy in SPAWNS:
        g[sy][sx] = 'S'
        for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            if g[sy + dy][sx + dx] == '.':
                g[sy + dy][sx + dx] = '_'
    return g

def sym(g, pts, ch, over='.'):
    for x, y in pts:
        for px, py in {(x, y), (W - 1 - x, y), (x, H - 1 - y), (W - 1 - x, H - 1 - y)}:
            if g[py][px] in over:
                g[py][px] = ch

maps = {}

# 빙하: 가운데 타원형 얼음 호수 + 중앙 기둥 4개를 없앤 빙판, 언 상자 6개
g = base()
for y in range(H):
    for x in range(W):
        if ((x - CX) / 6.6) ** 2 + ((y - CY) / 4.4) ** 2 <= 1:
            if g[y][x] == '.':
                g[y][x] = 'I'
            if g[y][x] == '#' and abs(x - CX) <= 1 and abs(y - CY) <= 1:
                g[y][x] = 'I'
sym(g, [(5, 3), (3, CY)], 'F', '.I')
maps['glacier'] = g

# 화산: 가로 용암 강 + 다리 3개, 가운데 다리 앞뒤 균열, 균열 10개
g = base()
for x in range(1, W - 1):
    g[CY][x] = '~'
for bx in (3, CX, W - 4):
    g[CY][bx] = '='
sym(g, [(CX, CY - 1), (5, 3), (3, 5)], 'L')
maps['volcano'] = g

# 숲속: 중앙 덤불 고리, 모서리 덤불 무리, 나무 3그루, 버섯 6개
g = base()
for y in range(H):
    for x in range(W):
        if 2 <= abs(x - CX) + abs(y - CY) <= 3 and g[y][x] == '.':
            g[y][x] = 'G'
sym(g, [(3, 4), (4, 3), (5, 4)], 'G')
for tx in (CX, 5, W - 6):
    g[CY][tx] = 'T'
sym(g, [(3, 5), (CX, 4)], 'M', '.G')
maps['forest'] = g

# 사막: 십자 유사 + 중앙 오아시스, 워프 3쌍(대각선 2쌍, 좌우 1쌍)
g = base()
for y in range(H):
    for x in range(W):
        if ((abs(x - CX) <= 1 and 3 <= y <= H - 4) or (abs(y - CY) <= 1 and 3 <= x <= W - 4)) and g[y][x] == '.':
            g[y][x] = 'Q'
for (a, b), ch in [(((3, 3), (W - 4, H - 4)), 'A'), (((W - 4, 3), (3, H - 4)), 'B'), (((1, CY), (W - 2, CY)), 'C')]:
    g[a[1]][a[0]] = ch
    g[b[1]][b[0]] = ch
g[CY][CX] = 'O'
maps['desert'] = g

names = {'glacier': '빙하', 'volcano': '화산', 'forest': '숲속', 'desert': '사막'}
out = [f"// {W}x{H} 맵 데이터 (tools/genmaps.py로 생성, 상하좌우 대칭) — 직접 수정하지 말고 생성기를 고칠 것",
       "// # 벽  S 스폰  _ 스폰 안전칸  . 바닥(랜덤 블록)",
       "// I 얼음  F 언 상자  ~ 용암 강  = 다리  L 용암 균열  G 덤불  M 버섯  T 나무  Q 유사  A/B/C 워프  O 오아시스",
       "export type MapId = 'glacier' | 'volcano' | 'forest' | 'desert';",
       "export const MAP_IDS: MapId[] = ['glacier', 'volcano', 'forest', 'desert'];",
       "export const MAP_NAMES: Record<MapId, string> = " + json.dumps(names, ensure_ascii=False) + ";",
       "export const MAP_ROWS: Record<MapId, string[]> = {"]
for k, v in maps.items():
    rows = [''.join(r) for r in v]
    assert len(rows) == H and all(len(r) == W for r in rows), k
    print(k); print('\n'.join(rows)); print()
    out.append(f"  {k}: [")
    out += [f"    '{r}'," for r in rows]
    out.append("  ],")
out.append("};")
pathlib.Path(__file__).resolve().parent.parent.joinpath('shared/maps.ts').write_text('\n'.join(out) + '\n')
