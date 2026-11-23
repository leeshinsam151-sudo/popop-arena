// 경기장 밖 풍경: 맵마다 바닥, 장식, 경기장 둘레를 돌아다니는 동물·사람, 하늘을 나는 생물.
// 게임 판정과는 무관한 순수 연출이라 클라이언트에서만 만든다.
import * as THREE from 'three';
import type { MapId } from '../../shared/maps.ts';

export interface Scenery {
  group: THREE.Group;
  update(t: number, dt: number): void;
}

// ---------- 공용 도형 ----------
const G = {
  sph: new THREE.SphereGeometry(1, 16, 12),
  hemi: new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
  cone: new THREE.ConeGeometry(1, 1, 12),
  cone4: new THREE.ConeGeometry(1, 1, 4),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  dodec: new THREE.DodecahedronGeometry(1),
  circle: new THREE.CircleGeometry(1, 24),
};
const matCache = new Map<string, THREE.Material>();
const M = (color: number, o: THREE.MeshStandardMaterialParameters = {}) => {
  const key = color + JSON.stringify(o);
  let m = matCache.get(key);
  if (!m) matCache.set(key, m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...o }));
  return m;
};
function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
  p: [number, number, number], s: [number, number, number], r: [number, number, number] = [0, 0, 0]) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...p); m.scale.set(...s); m.rotation.set(...r);
  parent.add(m);
  return m;
}
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---------- 생물 (앞쪽이 +z) ----------
interface Critter { root: THREE.Group; anim(t: number, moving: boolean): void }

function legs(root: THREE.Object3D, mat: THREE.Material, xs: number, zs: number, len: number, r: number, y: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const [x, z] of [[-xs, zs], [xs, zs], [-xs, -zs], [xs, -zs]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    part(pivot, G.cyl, mat, [0, -len / 2, 0], [r, len, r]);
    root.add(pivot);
    out.push(pivot);
  }
  return out;
}
const walkLegs = (ls: THREE.Object3D[], t: number, moving: boolean, speed = 8, amp = 0.5) =>
  ls.forEach((l, i) => { l.rotation.x = moving ? Math.sin(t * speed + (i === 0 || i === 3 ? 0 : Math.PI)) * amp : 0; });

function polarBear(): Critter {
  const root = new THREE.Group();
  const white = M(0xf4f1e8), black = M(0x1a1a22);
  part(root, G.sph, white, [0, 0.62, 0], [0.42, 0.34, 0.62]);
  part(root, G.sph, white, [0, 0.78, 0.62], [0.24, 0.22, 0.26]);
  part(root, G.sph, white, [0, 0.72, 0.84], [0.11, 0.09, 0.12]);
  part(root, G.sph, black, [0, 0.74, 0.95], [0.04, 0.03, 0.03]);
  for (const s of [-1, 1]) {
    part(root, G.sph, white, [s * 0.15, 0.98, 0.58], [0.07, 0.07, 0.05]);
    part(root, G.sph, black, [s * 0.09, 0.84, 0.82], [0.025, 0.025, 0.02]);
  }
  const ls = legs(root, white, 0.24, 0.36, 0.42, 0.11, 0.42);
  root.scale.setScalar(1.3);
  return { root, anim: (t, m) => walkLegs(ls, t, m, 6, 0.4) };
}

function penguin(): Critter {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  part(body, G.sph, M(0x22252e), [0, 0.42, 0], [0.24, 0.38, 0.22]);
  part(body, G.sph, M(0xffffff), [0, 0.38, 0.08], [0.18, 0.3, 0.16]);
  part(body, G.cone, M(0xffa62b), [0, 0.6, 0.24], [0.05, 0.12, 0.05], [Math.PI / 2, 0, 0]);
  for (const s of [-1, 1]) {
    part(body, G.sph, M(0xffffff), [s * 0.08, 0.68, 0.17], [0.04, 0.04, 0.02]);
    part(body, G.box, M(0x22252e), [s * 0.24, 0.42, 0], [0.04, 0.24, 0.12], [0, 0, s * 0.3]);
    part(root, G.sph, M(0xffa62b), [s * 0.09, 0.03, 0.08], [0.07, 0.03, 0.1]);
  }
  return { root, anim: (t, m) => { body.rotation.z = m ? Math.sin(t * 9) * 0.18 : Math.sin(t * 2) * 0.04; } };
}

function lizard(): Critter {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = M(0xff5a1f, { emissive: 0x8a1f00, emissiveIntensity: 0.6 });
  part(body, G.sph, skin, [0, 0.14, 0], [0.13, 0.09, 0.32]);
  part(body, G.sph, skin, [0, 0.15, 0.34], [0.1, 0.07, 0.12]);
  part(body, G.cone, skin, [0, 0.12, -0.5], [0.07, 0.42, 0.07], [-Math.PI / 2, 0, 0]);
  part(body, G.sph, M(0xffd23c, { emissive: 0xffa000 }), [0, 0.24, 0], [0.05, 0.03, 0.2]);
  const ls = legs(root, skin, 0.14, 0.16, 0.12, 0.03, 0.12);
  return { root, anim: (t, m) => { body.rotation.y = m ? Math.sin(t * 12) * 0.2 : 0; walkLegs(ls, t, m, 12, 0.7); } };
}

function deer(): Critter {
  const root = new THREE.Group();
  const fur = M(0xa86b3c), light = M(0xf3e2c7), horn = M(0xe8d8b8);
  part(root, G.sph, fur, [0, 0.82, 0], [0.24, 0.24, 0.5]);
  part(root, G.cyl, fur, [0, 1.08, 0.38], [0.08, 0.42, 0.08], [0.5, 0, 0]);
  const head = new THREE.Group();
  head.position.set(0, 1.3, 0.5);
  root.add(head);
  part(head, G.sph, fur, [0, 0, 0.06], [0.11, 0.11, 0.18]);
  part(head, G.sph, M(0x1a1a22), [0, -0.02, 0.24], [0.03, 0.03, 0.03]);
  for (const s of [-1, 1]) {
    part(head, G.cyl, horn, [s * 0.08, 0.2, 0], [0.015, 0.28, 0.015], [0, 0, s * 0.4]);
    part(head, G.cyl, horn, [s * 0.16, 0.28, 0.03], [0.012, 0.14, 0.012], [0.6, 0, s * 0.9]);
    part(head, G.sph, fur, [s * 0.11, 0.08, -0.04], [0.05, 0.03, 0.07]);
  }
  part(root, G.sph, light, [0, 0.9, -0.5], [0.06, 0.07, 0.04]);
  const ls = legs(root, fur, 0.13, 0.32, 0.62, 0.035, 0.66);
  return { root, anim: (t, m) => { walkLegs(ls, t, m, 7, 0.45); head.rotation.x = m ? 0 : Math.sin(t * 0.8) * 0.3 + 0.3; } };
}

function rabbit(): Critter {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const fur = M(0xd9d4cc), pink = M(0xffb3c6);
  part(body, G.sph, fur, [0, 0.16, 0], [0.13, 0.12, 0.17]);
  part(body, G.sph, fur, [0, 0.27, 0.14], [0.09, 0.09, 0.09]);
  part(body, G.sph, M(0xffffff), [0, 0.18, -0.17], [0.05, 0.05, 0.05]);
  for (const s of [-1, 1]) {
    part(body, G.sph, fur, [s * 0.04, 0.43, 0.12], [0.03, 0.1, 0.02], [0, 0, s * 0.15]);
    part(body, G.sph, pink, [s * 0.04, 0.43, 0.135], [0.015, 0.07, 0.01], [0, 0, s * 0.15]);
  }
  return { root, anim: (t, m) => { body.position.y = m ? Math.abs(Math.sin(t * 7)) * 0.22 : 0; } };
}

function camel(): Critter {
  const root = new THREE.Group();
  const fur = M(0xc8955a);
  part(root, G.sph, fur, [0, 1.05, 0], [0.3, 0.26, 0.58]);
  part(root, G.sph, fur, [0, 1.32, 0.2], [0.18, 0.2, 0.18]);
  part(root, G.sph, fur, [0, 1.32, -0.22], [0.18, 0.2, 0.18]);
  part(root, G.cyl, fur, [0, 1.3, 0.62], [0.08, 0.5, 0.08], [0.6, 0, 0]);
  part(root, G.sph, fur, [0, 1.52, 0.86], [0.1, 0.09, 0.2]);
  const ls = legs(root, fur, 0.16, 0.38, 0.85, 0.05, 0.9);
  return { root, anim: (t, m) => walkLegs(ls, t, m, 5, 0.4) };
}

function tumbleweed(): Critter {
  const root = new THREE.Group();
  const ball = part(root, G.dodec, new THREE.MeshBasicMaterial({ color: 0x9c7a45, wireframe: true }), [0, 0.32, 0], [0.32, 0.32, 0.32]);
  return { root, anim: (t, m) => { if (m) ball.rotation.x = t * 6; ball.position.y = 0.32 + Math.abs(Math.sin(t * 5)) * 0.15; } };
}

function visitor(r: () => number): Critter {
  const root = new THREE.Group();
  const shirts = [0xff5d73, 0x3d7bff, 0x35c46a, 0xffc531, 0x9b5cff, 0xff9f43];
  const skin = M([0xf3d1b0, 0xd9a77e, 0x9c6b47][Math.floor(r() * 3)]);
  const shirt = M(shirts[Math.floor(r() * shirts.length)]);
  part(root, G.cyl, shirt, [0, 0.62, 0], [0.16, 0.42, 0.13]);
  part(root, G.sph, skin, [0, 0.98, 0], [0.13, 0.14, 0.13]);
  part(root, G.sph, M(0x3a2a1a), [0, 1.06, -0.02], [0.135, 0.08, 0.135]);
  const ls: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.07, 0.42, 0);
    part(pivot, G.cyl, M(0x2e3a59), [0, -0.21, 0], [0.05, 0.42, 0.05]);
    root.add(pivot);
    ls.push(pivot);
  }
  if (r() < 0.5) { // 풍선 든 사람
    const col = shirts[Math.floor(r() * shirts.length)];
    part(root, G.cyl, M(0xffffff), [0.2, 1.15, 0], [0.005, 0.9, 0.005]);
    part(root, G.sph, M(col, { roughness: 0.3 }), [0.2, 1.68, 0], [0.16, 0.2, 0.16]);
  }
  return { root, anim: (t, m) => ls.forEach((l, i) => { l.rotation.x = m ? Math.sin(t * 8 + i * Math.PI) * 0.5 : 0; }) };
}

/** 날개 달린 것: 박쥐·독수리 (하늘에서 원을 그리며 돎) */
function flyer(color: number, span: number): Critter {
  const root = new THREE.Group();
  const mat = M(color);
  part(root, G.sph, mat, [0, 0, 0], [0.12 * span, 0.1 * span, 0.22 * span]);
  const wings: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    part(pivot, G.box, mat, [s * 0.32 * span, 0, 0], [0.6 * span, 0.02, 0.22 * span]);
    root.add(pivot);
    wings.push(pivot);
  }
  return { root, anim: (t) => wings.forEach((w, i) => { w.rotation.z = Math.sin(t * 10) * 0.6 * (i ? -1 : 1); }) };
}

// ---------- 경기장 둘레를 도는 경로 ----------
interface Walker { c: Critter; d: number; u: number; speed: number; pause: number; y: number }

/** 경기장 바깥으로 d만큼 떨어진 직사각형 둘레 위의 위치·방향 */
function ringPos(w: number, h: number, d: number, u: number): [number, number, number] {
  const x0 = -0.5 - d, y0 = -0.5 - d, x1 = w - 0.5 + d, y1 = h - 0.5 + d;
  const W = x1 - x0, H = y1 - y0, P = 2 * (W + H);
  u = ((u % P) + P) % P;
  if (u < W) return [x0 + u, y0, Math.PI / 2];
  if ((u -= W) < H) return [x1, y0 + u, 0];
  if ((u -= H) < W) return [x1 - u, y1, -Math.PI / 2];
  u -= W;
  return [x0, y1 - u, Math.PI];
}

/** 경기장 바깥 고리 영역의 무작위 지점 (장식 배치용) */
function ringSpot(w: number, h: number, r: () => number, dMin: number, dMax: number): [number, number] {
  const d = dMin + r() * (dMax - dMin);
  const [x, z] = ringPos(w, h, d, r() * 1000);
  return [x + (r() - 0.5) * 1.2, z + (r() - 0.5) * 1.2];
}

// ---------- 맵별 구성 ----------
export function buildScenery(mapId: MapId, w: number, h: number): Scenery {
  const group = new THREE.Group();
  const r = rng(mapId.length * 977 + w * 31);
  const walkers: Walker[] = [];
  const extras: ((t: number, dt: number) => void)[] = [];
  const cx = (w - 1) / 2, cz = (h - 1) / 2;

  const ground = (color: number) => {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), M(color, { roughness: 1 }));
    g.rotation.x = -Math.PI / 2;
    g.position.set(cx, -0.21, cz);
    g.receiveShadow = true;
    group.add(g);
  };
  const place = (obj: THREE.Object3D, dMin: number, dMax: number, scale = 1) => {
    const [x, z] = ringSpot(w, h, r, dMin, dMax);
    obj.position.set(x, 0, z);
    obj.rotation.y = r() * Math.PI * 2;
    obj.scale.multiplyScalar(scale * (0.8 + r() * 0.5));
    group.add(obj);
    return obj;
  };
  const walk = (c: Critter, d: number, speed: number, u = r() * 100, y = 0) => {
    group.add(c.root);
    walkers.push({ c, d, u, speed, pause: 0, y });
  };

  if (mapId === 'glacier') {
    ground(0xf2f7fb);
    for (let i = 0; i < 14; i++) { // 빙산
      const g = new THREE.Group();
      part(g, G.cone6, M(0xbfe8ff, { roughness: 0.2 }), [0, 0.9, 0], [0.9, 1.8, 0.9]);
      part(g, G.cone6, M(0xe6f6ff, { roughness: 0.3 }), [0.6, 0.5, 0.3], [0.5, 1, 0.5]);
      place(g, 4, 12, 1 + r());
    }
    for (let i = 0; i < 16; i++) { const m = new THREE.Group(); part(m, G.hemi, M(0xffffff), [0, 0, 0], [0.8, 0.35, 0.6]); place(m, 1.5, 12); }
    const igloo = new THREE.Group();
    part(igloo, G.hemi, M(0xf8fbff), [0, 0, 0], [1.3, 1.1, 1.3]);
    part(igloo, G.box, M(0x5f7d95), [0, 0.35, 1.2], [0.5, 0.7, 0.3]);
    igloo.position.set(-4.5, 0, cz - 2); igloo.rotation.y = Math.PI / 2; group.add(igloo);
    for (let i = 0; i < 3; i++) walk(polarBear(), 2.4 + i * 1.6, (r() < 0.5 ? -1 : 1) * 0.6);
    const dir = r() < 0.5 ? -1 : 1; // 펭귄은 한 줄로 뒤뚱뒤뚱
    const u0 = r() * 100;
    for (let i = 0; i < 5; i++) walk(penguin(), 1.6, dir * 0.9, u0 - dir * i * 0.7);
    for (let i = 0; i < 3; i++) walk(penguin(), 3.8, -dir * 0.7, u0 + 20 + i * 0.6);
  } else if (mapId === 'volcano') {
    ground(0x3a2c2c);
    // 경기장 왼쪽의 연기 나는 화산 (카메라가 내려다보니 옆에 둬야 보임)
    const vx = -8.5, vz = cz - 1, vh = 7;
    const volc = new THREE.Group();
    part(volc, G.cone, M(0x2a2024), [0, vh / 2, 0], [5.5, vh, 5.5]);
    part(volc, G.cyl, M(0xff5a1f, { emissive: 0xff3300, emissiveIntensity: 1.5 }), [0, vh - 0.6, 0], [0.9, 0.25, 0.9]);
    for (let i = 0; i < 4; i++) part(volc, G.box, M(0xff5a1f, { emissive: 0xff3300, emissiveIntensity: 1.2 }), [Math.cos(i * 1.6) * 1.6, vh * 0.45, Math.sin(i * 1.6) * 1.6], [0.2, vh * 0.6, 0.15], [Math.sin(i * 1.6) * 0.6, 0, -Math.cos(i * 1.6) * 0.6]);
    volc.position.set(vx, -0.2, vz);
    group.add(volc);
    const puffs: THREE.Mesh[] = [];
    for (let i = 0; i < 8; i++) puffs.push(part(group, G.sph, new THREE.MeshStandardMaterial({ color: 0x777077, transparent: true, opacity: 0.5 }), [vx, vh, vz], [1, 1, 1]));
    extras.push((t) => puffs.forEach((p, i) => {
      const k = ((t * 0.15 + i / puffs.length) % 1);
      p.position.set(vx + Math.sin(i * 3) * k * 1.5, vh + k * 6, vz + k * 1.5);
      p.scale.setScalar(0.5 + k * 1.8);
      (p.material as THREE.MeshStandardMaterial).opacity = 0.55 * (1 - k);
    }));
    for (let i = 0; i < 18; i++) { const g = new THREE.Group(); part(g, G.dodec, M(0x241c1e), [0, 0.3, 0], [0.6, 0.5, 0.6]); place(g, 1.5, 12, 1 + r()); }
    const pools: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xff6a1f, emissive: 0xff3a00, emissiveIntensity: 1.2 });
      pools.push(mat);
      part(g, G.circle, mat, [0, -0.19, 0], [1, 1, 1], [-Math.PI / 2, 0, 0]);
      place(g, 2.5, 11, 1 + r());
    }
    extras.push((t) => pools.forEach((m, i) => { m.emissiveIntensity = 1 + Math.sin(t * 2 + i) * 0.4; }));
    for (let i = 0; i < 5; i++) walk(lizard(), 1.6 + r() * 3, (r() < 0.5 ? -1 : 1) * (0.8 + r()));
    for (let i = 0; i < 6; i++) walk(flyer(0x2b2030, 1), 3 + r() * 6, (r() < 0.5 ? -1 : 1) * 2.2, r() * 100, 3 + r() * 2);
  } else if (mapId === 'forest') {
    ground(0x6fae5f);
    for (let i = 0; i < 40; i++) {
      const g = new THREE.Group();
      part(g, G.cyl, M(0x7a4f2a), [0, 0.6, 0], [0.18, 1.2, 0.18]);
      if (r() < 0.5) {
        part(g, G.cone, M(0x2f7d3a), [0, 1.7, 0], [0.9, 1.4, 0.9]);
        part(g, G.cone, M(0x3f9a4a), [0, 2.4, 0], [0.65, 1.1, 0.65]);
      } else {
        part(g, G.sph, M(0x3f9a4a), [0, 1.8, 0], [0.9, 0.8, 0.9]);
        part(g, G.sph, M(0x2f7d3a), [0.4, 1.5, 0.2], [0.55, 0.5, 0.55]);
      }
      place(g, 3, 14, 1 + r() * 0.6);
    }
    const flowerCols = [0xff7eb6, 0xffd166, 0xffffff, 0x9b5cff, 0xff5d73];
    for (let i = 0; i < 40; i++) {
      const g = new THREE.Group();
      part(g, G.cyl, M(0x3f9a4a), [0, 0.12, 0], [0.015, 0.24, 0.015]);
      part(g, G.sph, M(flowerCols[i % flowerCols.length]), [0, 0.26, 0], [0.07, 0.05, 0.07]);
      place(g, 1, 6);
    }
    for (let i = 0; i < 5; i++) { const g = new THREE.Group(); part(g, G.cyl, M(0x8a5a2e), [0, 0.18, 0], [0.18, 1.2, 0.18], [0, 0, Math.PI / 2]); place(g, 1.5, 7); }
    for (let i = 0; i < 3; i++) walk(deer(), 2.6 + i * 1.5, (r() < 0.5 ? -1 : 1) * 0.7);
    for (let i = 0; i < 5; i++) walk(rabbit(), 1.4 + r() * 3, (r() < 0.5 ? -1 : 1) * 1.6);
    // 🦋 나비: 꽃밭 위를 팔랑팔랑
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Group();
      const col = flowerCols[i % flowerCols.length];
      const wings = [-1, 1].map((s) => {
        const p = new THREE.Group();
        part(p, G.circle, new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }), [s * 0.09, 0, 0], [0.09, 0.07, 1], [-Math.PI / 2, 0, 0]);
        b.add(p); return p;
      });
      const [bx, bz] = ringSpot(w, h, r, 1, 5);
      const ph = r() * 10;
      group.add(b);
      extras.push((t) => {
        b.position.set(bx + Math.sin(t * 0.7 + ph) * 1.2, 0.8 + Math.sin(t * 2.3 + ph) * 0.3, bz + Math.cos(t * 0.5 + ph) * 1.2);
        b.rotation.y = t * 0.7 + ph;
        wings.forEach((wg, k) => { wg.rotation.z = Math.sin(t * 18 + ph) * 0.9 * (k ? -1 : 1); });
      });
    }
  } else if (mapId === 'desert') {
    ground(0xe8cc8c);
    for (const [x, z, s] of [[-9, cz - 2, 5.5], [w + 7.5, cz + 1, 6.5], [w + 5, -5.5, 3.5]] as [number, number, number][]) {
      part(group, G.cone4, M(0xdcb66f), [x, s / 2 - 0.2, z], [s, s, s], [0, Math.PI / 4, 0]); // 피라미드
    }
    for (let i = 0; i < 14; i++) { // 선인장
      const g = new THREE.Group();
      const green = M(0x4f9a45);
      part(g, G.cyl, green, [0, 0.75, 0], [0.16, 1.5, 0.16]);
      part(g, G.cyl, green, [0.28, 0.9, 0], [0.09, 0.5, 0.09]);
      part(g, G.cyl, green, [0.18, 0.66, 0], [0.09, 0.22, 0.09], [0, 0, Math.PI / 2]);
      part(g, G.cyl, green, [-0.26, 1.1, 0], [0.08, 0.4, 0.08]);
      part(g, G.cyl, green, [-0.17, 0.9, 0], [0.08, 0.2, 0.08], [0, 0, Math.PI / 2]);
      place(g, 2, 12);
    }
    for (let i = 0; i < 10; i++) { const g = new THREE.Group(); part(g, G.hemi, M(0xdfc07f), [0, 0, 0], [2.4, 0.5, 1.4]); place(g, 4, 13, 1 + r()); }
    for (let i = 0; i < 8; i++) { const g = new THREE.Group(); part(g, G.dodec, M(0xb58a52), [0, 0.2, 0], [0.4, 0.3, 0.35]); place(g, 1.5, 10); }
    const dir = r() < 0.5 ? -1 : 1, u0 = r() * 100; // 낙타 대상(隊商)
    for (let i = 0; i < 3; i++) walk(camel(), 3.4, dir * 0.55, u0 - dir * i * 1.6);
    for (let i = 0; i < 3; i++) walk(tumbleweed(), 1.6 + r() * 4, (r() < 0.5 ? -1 : 1) * 2.2);
    for (let i = 0; i < 3; i++) walk(flyer(0x5b4030, 1.6), 5 + r() * 5, (r() < 0.5 ? -1 : 1) * 1.6, r() * 100, 5 + r() * 2);
  } else if (mapId === 'park') {
    ground(0x9fd98a);
    // 서커스 천막
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const cols = [0xff5d73, 0x7ad3ff, 0xffd166, 0x9b5cff, 0x35c46a];
      part(g, G.cyl, M(0xffffff), [0, 0.8, 0], [1.4, 1.6, 1.4]);
      part(g, G.cyl, M(cols[i]), [0, 0.8, 0], [1.42, 0.3, 1.42]);
      part(g, G.cone, M(cols[i]), [0, 2.3, 0], [1.6, 1.4, 1.6]);
      part(g, G.cyl, M(0xffffff), [0, 3.2, 0], [0.03, 0.6, 0.03]);
      part(g, G.box, M(cols[(i + 1) % 5]), [0.25, 3.4, 0], [0.4, 0.22, 0.02]);
      place(g, 6, 13);
    }
    // 회전목마
    const carousel = new THREE.Group();
    part(carousel, G.cyl, M(0xffd166), [0, 0.12, 0], [2, 0.24, 2]);
    part(carousel, G.cyl, M(0xffffff), [0, 1.1, 0], [0.15, 2, 0.15]);
    part(carousel, G.cone, M(0xff5d73), [0, 2.5, 0], [2.2, 0.9, 2.2]);
    const horses: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      part(carousel, G.cyl, M(0xffd166), [Math.cos(a) * 1.5, 1.1, Math.sin(a) * 1.5], [0.03, 2, 0.03]);
      horses.push(part(carousel, G.sph, M([0xffffff, 0x7ad3ff, 0xff9fb3][i % 3]), [Math.cos(a) * 1.5, 0.9, Math.sin(a) * 1.5], [0.18, 0.2, 0.4], [0, -a, 0]));
    }
    carousel.position.set(w + 5, 0, cz);
    group.add(carousel);
    extras.push((t) => { carousel.rotation.y = t * 0.6; horses.forEach((hh, i) => { hh.position.y = 0.9 + Math.sin(t * 3 + i) * 0.2; }); });
    // 간식 가게, 가로등, 나무
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      part(g, G.box, M(0xfff3e0), [0, 0.5, 0], [1.2, 1, 0.8]);
      part(g, G.box, M([0xff5d73, 0x7ad3ff, 0xffd166][i % 3]), [0, 1.15, 0.15], [1.4, 0.12, 1.1], [0.2, 0, 0]);
      place(g, 2.5, 6);
    }
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      part(g, G.cyl, M(0x4a4f5e), [0, 0.9, 0], [0.04, 1.8, 0.04]);
      part(g, G.sph, M(0xfff2b3, { emissive: 0xffd166, emissiveIntensity: 0.8 }), [0, 1.85, 0], [0.13, 0.13, 0.13]);
      place(g, 1.2, 3);
    }
    for (let i = 0; i < 12; i++) {
      const g = new THREE.Group();
      part(g, G.cyl, M(0x7a4f2a), [0, 0.5, 0], [0.12, 1, 0.12]);
      part(g, G.sph, M(0x5fb85a), [0, 1.4, 0], [0.7, 0.6, 0.7]);
      place(g, 7, 14);
    }
    for (let i = 0; i < 9; i++) walk(visitor(r), 1.4 + r() * 3.6, (r() < 0.5 ? -1 : 1) * (0.7 + r() * 0.6));
    // 🎈 하늘로 날아가는 풍선
    const balloonCols = [0xff5d73, 0xffd166, 0x7ad3ff, 0x9b5cff, 0x35c46a];
    for (let i = 0; i < 10; i++) {
      const b = part(group, G.sph, M(balloonCols[i % 5], { roughness: 0.3 }), [0, 0, 0], [0.22, 0.27, 0.22]);
      const [bx, bz] = ringSpot(w, h, r, 2, 9);
      const ph = r();
      extras.push((t) => {
        const k = (t * 0.06 + ph) % 1;
        b.position.set(bx + Math.sin(t + i) * 0.4, k * 16, bz);
        b.visible = k > 0.02;
      });
    }
  }

  return {
    group,
    update(t, dt) {
      for (const wk of walkers) {
        // 가끔 멈춰서 쉬었다가 다시 걷기
        if (wk.pause > 0) wk.pause -= dt;
        else {
          wk.u += wk.speed * dt;
          if (Math.random() < dt * 0.06 && wk.y === 0) wk.pause = 1 + Math.random() * 2.5;
        }
        const moving = wk.pause <= 0;
        const [x, z, ang] = ringPos(w, h, wk.d, wk.u);
        const heading = wk.speed > 0 ? ang : ang + Math.PI;
        const root = wk.c.root;
        root.position.set(x, wk.y ? wk.y + Math.sin(t * 2 + wk.d) * 0.4 : 0, z);
        let diff = heading - root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        root.rotation.y += diff * Math.min(1, dt * 5);
        wk.c.anim(t, moving);
      }
      for (const e of extras) e(t, dt);
    },
  };
}
