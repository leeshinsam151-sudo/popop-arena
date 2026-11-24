#!/usr/bin/env python3
"""맵 5종 생성기. 모든 기믹을 상하좌우 대칭으로 배치해 스폰마다 공정하게 만든다.
맵마다 두 가지 크기를 만든다:
  - 일반 19x15: 5명 이하 (스폰 6곳)
  - 큰 23x17 ('-xl'): 6~8명 (스폰 8곳: 네 모서리 + 위아래 가운데 + 좌우 가운데)
실행: python3 tools/genmaps.py  → shared/maps.ts 갱신"""
import json, pathlib

def gen(W, H, xl):
    """W, H는 홀수여야 기둥(짝수 좌표) 배치가 맞음"""
    CX, CY = W // 2, H // 2
    spawns = [(1, 1), (CX, 1), (W - 2, 1), (1, H - 2), (CX, H - 2), (W - 2, H - 2)]
    if xl:
        spawns += [(1, CY), (W - 2, CY)]

    def base():
        g = [['.' for _ in range(W)] for _ in range(H)]
        for y in range(H):
            for x in range(W):
                if x in (0, W - 1) or y in (0, H - 1) or (x % 2 == 0 and y % 2 == 0):
                    g[y][x] = '#'
        for sx, sy in spawns:
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
    rx, ry = 6.6 * W / 19, 4.4 * H / 15
    for y in range(H):
        for x in range(W):
            if ((x - CX) / rx) ** 2 + ((y - CY) / ry) ** 2 <= 1:
                if g[y][x] == '.':
                    g[y][x] = 'I'
                if g[y][x] == '#' and abs(x - CX) <= 1 and abs(y - CY) <= 1:
                    g[y][x] = 'I'
    sym(g, [(5, 3), (3, CY)], 'F', '.I')
    maps['glacier'] = g

    # 화산: 가로 용암 강 + 다리 3개, 가운데 다리 앞뒤 균열.
    # 큰 맵은 좌우 가운데 스폰 자리 때문에 강 양 끝 두 칸씩이 땅 (돌아서 건널 수 있음)
    g = base()
    end = 3 if xl else 1
    for x in range(end, W - end):
        g[CY][x] = '~'
    bridges = (5, CX, W - 6) if xl else (3, CX, W - 4)
    for bx in bridges:
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

    # 사막: 십자 유사 + 중앙 오아시스, 워프: 대각선 2쌍 (일반 맵은 좌우 끝을 잇는 1쌍 더)
    g = base()
    for y in range(H):
        for x in range(W):
            if ((abs(x - CX) <= 1 and 3 <= y <= H - 4) or (abs(y - CY) <= 1 and 3 <= x <= W - 4)) and g[y][x] == '.':
                g[y][x] = 'Q'
    pairs = [(((3, 3), (W - 4, H - 4)), 'A'), (((W - 4, 3), (3, H - 4)), 'B')]
    if not xl:
        pairs.append((((1, CY), (W - 2, CY)), 'C'))
    for (a, b), ch in pairs:
        g[a[1]][a[0]] = ch
        g[b[1]][b[0]] = ch
    g[CY][CX] = 'O'
    maps['desert'] = g

    # 놀이공원: 가운데 대관람차(W)를 시계 방향으로 도는 컨베이어 순환 트랙(> v < ^), 귀퉁이 트램펄린(J)
    g = base()
    x0, x1, y0, y1 = 5, W - 6, 5, H - 6  # 홀수 줄·칸이라 기둥과 겹치지 않음
    for x in range(x0, x1): g[y0][x] = '>'
    for y in range(y0, y1): g[y][x1] = 'v'
    for x in range(x1, x0, -1): g[y1][x] = '<'
    for y in range(y1, y0, -1): g[y][x0] = '^'
    g[CY][CX] = 'W'
    sym(g, [(3, 3)], 'J')
    maps['park'] = g

    out = {}
    for k, v in maps.items():
        rows = [''.join(r) for r in v]
        assert len(rows) == H and all(len(r) == W for r in rows), k
        for sx, sy in spawns:
            assert rows[sy][sx] == 'S', (k, sx, sy)
        out[k + ('-xl' if xl else '')] = rows
    return out

layouts = {**gen(19, 15, False), **gen(23, 17, True)}
names = {'glacier': '빙하', 'volcano': '화산', 'forest': '숲속', 'desert': '사막', 'park': '놀이공원'}
lines = ["// 맵 데이터 (tools/genmaps.py로 생성, 상하좌우 대칭) — 직접 수정하지 말고 생성기를 고칠 것",
         "// 일반 19x15 (5명 이하), '-xl' 23x17 (6~8명)",
         "// # 벽  S 스폰  _ 스폰 안전칸  . 바닥(랜덤 블록)",
         "// I 얼음  F 언 상자  ~ 용암 강  = 다리  L 용암 균열  G 덤불  M 버섯  T 나무  Q 유사  A/B/C 워프  O 오아시스",
         "// > v < ^ 컨베이어 벨트(화살표 방향으로 운반)  J 트램펄린  W 대관람차",
         "export type MapId = 'glacier' | 'volcano' | 'forest' | 'desert' | 'park';",
         "/** 실제 칸 배치: 맵 + 크기 */",
         "export type LayoutId = MapId | `${MapId}-xl`;",
         "export const MAP_IDS: MapId[] = ['glacier', 'volcano', 'forest', 'desert', 'park'];",
         "export const MAP_NAMES: Record<MapId, string> = " + json.dumps(names, ensure_ascii=False) + ";",
         "/** 6명 이상이면 큰 맵 */",
         "export const layoutOf = (id: MapId, big: boolean): LayoutId => (big ? `${id}-xl` : id);",
         "export const MAP_ROWS: Record<LayoutId, string[]> = {"]
for k, rows in layouts.items():
    if k.endswith('-xl') and k.startswith('glacier'):
        print(k); print('\n'.join(rows)); print()
    lines.append(f"  '{k}': [")
    lines += [f"    '{r}'," for r in rows]
    lines.append("  ],")
lines.append("};")
pathlib.Path(__file__).resolve().parent.parent.joinpath('shared/maps.ts').write_text('\n'.join(lines) + '\n')
print('layouts:', ', '.join(layouts))
