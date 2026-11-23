// 맵·폭탄·불길·아이템 렌더링. 좌표계: 칸 (x, y) → 월드 (X = x, Z = y)
import * as THREE from 'three';
import { ItemType, Tile } from '../../shared/constants.ts';
import { MAP_ROWS, type MapId } from '../../shared/maps.ts';
import type { Bomb, Flame, Item } from '../../shared/sim.ts';

interface Theme {
  fa: number; fb: number; sky: number;
  wall: THREE.MeshStandardMaterialParameters; cap: number;
  soft: number; band: THREE.MeshStandardMaterialParameters;
  floor: Record<string, number>;
}
const THEMES: Record<MapId, Theme> = {
  glacier: {
    fa: 0xeef6fc, fb: 0xe0edf7, sky: 0xbfe0f2,
    wall: { color: 0x9fd8f0, roughness: 0.12, transparent: true, opacity: 0.92 }, cap: 0xffffff,
    soft: 0xf7fbff, band: { color: 0xc6e1f4 },
    floor: { I: 0xb4e6ff },
  },
  volcano: {
    fa: 0x6a5c5e, fb: 0x5e5153, sky: 0x3a2222,
    wall: { color: 0x2b2427, roughness: 0.95 }, cap: 0x1f1a1c,
    soft: 0xa8765a, band: { color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.2 },
    floor: { L: 0x3a3034 },
  },
  forest: {
    fa: 0x8bcc82, fb: 0x7bbd73, sky: 0xcfeccb,
    wall: { color: 0x8d9289, roughness: 0.9 }, cap: 0x4f9a45,
    soft: 0xc08a50, band: { color: 0x87582c },
    floor: { G: 0x6aaa62, M: 0x7bbd73 },
  },
  desert: {
    fa: 0xf2d797, fb: 0xe9cb87, sky: 0xf7e3b5,
    wall: { color: 0xc99a5b, roughness: 0.9 }, cap: 0xe6c283,
    soft: 0xd98c4a, band: { color: 0xa85f2c },
    floor: { Q: 0xcfa865 },
  },
};

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sph: new THREE.SphereGeometry(1, 18, 12),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  cone: new THREE.ConeGeometry(1, 1, 14),
  leaf: new THREE.ConeGeometry(1, 1, 4),
  torus: new THREE.TorusGeometry(1, 0.08, 8, 32),
};
const dummy = new THREE.Object3D();

/** 같은 (지오메트리, 재질) 조합을 InstancedMesh 하나로 묶는다 */
class Batcher {
  private map = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; shadow: boolean; list: THREE.Matrix4[] }>();
  add(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number,
    sx = 1, sy = 1, sz = 1, ry = 0, rx = 0, shadow = true) {
    const key = geo.uuid + mat.uuid + shadow;
    let b = this.map.get(key);
    if (!b) this.map.set(key, b = { geo, mat, shadow, list: [] });
    dummy.position.set(x, y, z); dummy.scale.set(sx, sy, sz); dummy.rotation.set(rx, ry, 0); dummy.updateMatrix();
    b.list.push(dummy.matrix.clone());
  }
  flush(parent: THREE.Object3D) {
    for (const b of this.map.values()) {
      const im = new THREE.InstancedMesh(b.geo, b.mat, b.list.length);
      b.list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = b.shadow; im.receiveShadow = true;
      parent.add(im);
    }
  }
}

export class Arena {
  readonly group = new THREE.Group();
  mapId: MapId | null = null;
  w = 0; h = 0;
  private statics = new THREE.Group();
  private softBody!: THREE.InstancedMesh;
  private softBand!: THREE.InstancedMesh;
  private tiles = '';
  private lavaMat = new THREE.MeshStandardMaterial({ color: 0xff6a1f, emissive: 0xff3a00, emissiveIntensity: 1, roughness: 0.4 });
  private spinners: THREE.Object3D[] = [];
  private bombs = new Map<number, THREE.Group>();
  private items = new Map<string, THREE.Group>();
  private flameOuter: THREE.InstancedMesh;
  private flameInner: THREE.InstancedMesh;
  private flames: Flame[] = [];
  private debris: { m: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private debrisMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  /** 블록이 부서진 칸 수 (카메라 흔들림 등 연출용) */
  onBreak: ((n: number) => void) | null = null;

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    this.group.add(this.statics);
    const MAXF = 600;
    this.flameOuter = new THREE.InstancedMesh(G.box,
      new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85 }), MAXF);
    this.flameInner = new THREE.InstancedMesh(G.box, new THREE.MeshBasicMaterial({ color: 0xffe066 }), MAXF);
    this.flameOuter.count = this.flameInner.count = 0;
    this.flameOuter.frustumCulled = this.flameInner.frustumCulled = false;
    this.group.add(this.flameOuter, this.flameInner);
  }

  /** 맵 정적 요소(바닥·벽·장식) 생성 */
  build(mapId: MapId) {
    this.clearDynamic();
    this.statics.clear();
    this.spinners = [];
    this.mapId = mapId;
    this.tiles = '';
    const rows = MAP_ROWS[mapId];
    const th = THEMES[mapId];
    this.h = rows.length; this.w = rows[0].length;
    this.scene.background = new THREE.Color(th.sky);
    this.scene.fog = new THREE.Fog(th.sky, 30, 60);

    const B = new Batcher();
    const wallMat = new THREE.MeshStandardMaterial(th.wall);
    const capMat = new THREE.MeshStandardMaterial({ color: th.cap, roughness: 0.9 });
    const mats: Record<string, THREE.MeshStandardMaterial> = {};
    const m = (k: string, p: THREE.MeshStandardMaterialParameters) => mats[k] ??= new THREE.MeshStandardMaterial({ roughness: 0.8, ...p });
    const floor: { x: number; y: number; c: number }[] = [];

    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      const border = x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1;
      if (ch === '#') {
        const hh = border ? 1.05 : 0.95;
        B.add(G.box, wallMat, x, hh / 2, y, 0.94, hh, 0.94);
        B.add(G.box, capMat, x, hh + 0.05, y, 0.99, 0.1, 0.99);
        return;
      }
      if (ch === '~' || ch === '=') {
        B.add(G.box, this.lavaMat, x, -0.28, y, 1, 0.2, 1, 0, 0, false);
        if (ch === '=') {
          B.add(G.box, m('plank', { color: 0x8a5a2e }), x, 0.02, y, 0.8, 0.1, 1);
          for (const s of [-1, 1]) B.add(G.box, m('rope', { color: 0x5b3a1e }), x + s * 0.42, 0.14, y, 0.05, 0.05, 1);
        }
        if (ch === '~') return;
      }
      floor.push({ x, y, c: th.floor[ch] ?? ((x + y) % 2 ? th.fa : th.fb) });
      switch (ch) {
        case 'I':
          B.add(G.box, m('streak', { color: 0xffffff, transparent: true, opacity: 0.7 }), x, 0.005, y, 0.5, 0.01, 0.05, 0.7, 0, false);
          break;
        case 'L':
          B.add(G.box, m('crack', { color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.2 }), x, 0.005, y, 0.75, 0.02, 0.07, 0.5, 0, false);
          B.add(G.box, m('crack', {}), x, 0.006, y, 0.5, 0.02, 0.06, -0.9, 0, false);
          break;
        case 'Q': this.spinRing(x, y, 0.32, m('qRing', { color: 0xa6803f })); break;
        case 'A': case 'B': case 'C': {
          const c = { A: 0x2ff0d0, B: 0xb06bff, C: 0xff5fa2 }[ch];
          B.add(G.box, m('slab', { color: 0x9c8f7c }), x, 0.04, y, 0.86, 0.08, 0.86);
          this.spinRing(x, y, 0.3, m('rune' + ch, { color: c, emissive: c, emissiveIntensity: 1.4 }), 0.1);
          break;
        }
        case 'G':
          for (const [a, b, c, r, k] of [[0, 0.3, 0, 0.36, 1], [-0.22, 0.24, 0.14, 0.26, 2], [0.22, 0.25, -0.12, 0.28, 2], [0.06, 0.5, 0.04, 0.24, 1]])
            B.add(G.sph, m('bush' + k, { color: k === 1 ? 0x2f7d3a : 0x3f9a4a, transparent: true, opacity: 0.88 }), x + a, b, y + c, r, r * 0.9, r);
          break;
        case 'M':
          B.add(G.cyl, m('stem', { color: 0xfff3e0 }), x, 0.17, y, 0.1, 0.34, 0.1);
          B.add(G.sph, m('cap', { color: 0xe8413a, roughness: 0.5 }), x, 0.32, y, 0.36, 0.22, 0.36);
          break;
        case 'T':
          B.add(G.cyl, m('trunk', { color: 0x7a4f2a }), x, 0.6, y, 0.24, 1.2, 0.24);
          B.add(G.sph, m('canopy', { color: 0x2c7a3a }), x, 1.65, y, 0.85, 0.7, 0.85);
          B.add(G.sph, m('canopy2', { color: 0x3f9a4a }), x - 0.45, 1.45, y + 0.25, 0.5, 0.45, 0.5);
          break;
        case 'O':
          B.add(G.cyl, m('rim', { color: 0xb99a62 }), x, 0.03, y, 0.48, 0.06, 0.48);
          B.add(G.cyl, m('water', { color: 0x3fb8e0, roughness: 0.1 }), x, 0.07, y, 0.4, 0.04, 0.4, 0, 0, false);
          B.add(G.cyl, m('palmT', { color: 0x8a6a3e }), x + 0.2, 0.75, y - 0.15, 0.06, 1.5, 0.06, 0, 0.15);
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            B.add(G.leaf, m('palmL', { color: 0x3f9a4a }), x + 0.31 + Math.cos(a) * 0.35, 1.45, y - 0.15 + Math.sin(a) * 0.35, 0.12, 0.8, 0.04, -a, Math.PI / 2 - 0.35);
          }
          break;
      }
    }));
    B.flush(this.statics);

    const fl = new THREE.InstancedMesh(G.box, new THREE.MeshStandardMaterial({ roughness: 0.85 }), floor.length);
    const col = new THREE.Color();
    floor.forEach((f, i) => {
      dummy.position.set(f.x, -0.1, f.y); dummy.scale.set(0.98, 0.2, 0.98); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      fl.setMatrixAt(i, dummy.matrix); fl.setColorAt(i, col.set(f.c));
    });
    fl.receiveShadow = true;
    this.statics.add(fl);

    // 부서지는 블록: 칸 수만큼 미리 잡아 두고 count로 표시 개수 조절
    const n = this.w * this.h;
    this.softBody = new THREE.InstancedMesh(G.box, new THREE.MeshStandardMaterial({ color: th.soft, roughness: 0.9 }), n);
    this.softBand = new THREE.InstancedMesh(G.box, new THREE.MeshStandardMaterial({ roughness: 0.8, ...th.band }), n);
    for (const im of [this.softBody, this.softBand]) { im.count = 0; im.castShadow = true; im.receiveShadow = true; this.statics.add(im); }
    this.debrisMat.color.set(th.soft);
  }

  private spinRing(x: number, y: number, r: number, mat: THREE.Material, h = 0.01) {
    const t = new THREE.Mesh(G.torus, mat);
    t.position.set(x, h, y); t.scale.setScalar(r); t.rotation.x = -Math.PI / 2;
    this.statics.add(t);
    this.spinners.push(t);
  }

  /** 서버 타일 문자열 반영. 사라진 블록 자리에 파편 연출 */
  setTiles(tiles: string) {
    if (tiles === this.tiles) return;
    const prev = this.tiles;
    this.tiles = tiles;
    let i = 0, broken = 0;
    for (let idx = 0; idx < tiles.length; idx++) {
      const x = idx % this.w, y = Math.floor(idx / this.w);
      if (Number(tiles[idx]) === Tile.Soft) {
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(x, 0.4, y); dummy.scale.set(0.84, 0.8, 0.84); dummy.updateMatrix();
        this.softBody.setMatrixAt(i, dummy.matrix);
        dummy.position.set(x, 0.55, y); dummy.scale.set(0.86, 0.08, 0.86); dummy.updateMatrix();
        this.softBand.setMatrixAt(i, dummy.matrix);
        i++;
      } else if (prev && Number(prev[idx]) === Tile.Soft) {
        this.spawnDebris(x, y);
        broken++;
      }
    }
    this.softBody.count = this.softBand.count = i;
    this.softBody.instanceMatrix.needsUpdate = this.softBand.instanceMatrix.needsUpdate = true;
    if (broken && this.onBreak) this.onBreak(broken);
  }

  private spawnDebris(x: number, y: number) {
    for (let k = 0; k < 6; k++) {
      const mm = new THREE.Mesh(G.box, this.debrisMat);
      mm.scale.setScalar(0.12 + Math.random() * 0.1);
      mm.position.set(x + (Math.random() - 0.5) * 0.5, 0.4, y + (Math.random() - 0.5) * 0.5);
      mm.castShadow = true;
      this.group.add(mm);
      this.debris.push({ m: mm, v: new THREE.Vector3((Math.random() - 0.5) * 4, 3 + Math.random() * 3, (Math.random() - 0.5) * 4), life: 0.9 });
    }
  }

  /** 폭탄 생성·제거만 담당. 위치는 매 프레임 poseBomb으로 (보간된 값) */
  syncBombs(list: Bomb[]) {
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      let g = this.bombs.get(b.id);
      if (!g) {
        g = makeBomb();
        g.position.set(b.fx, 0, b.fy);
        this.group.add(g);
        this.bombs.set(b.id, g);
      }
      g.userData.fuse = b.fuse;
    }
    for (const [id, g] of this.bombs) if (!seen.has(id)) { this.group.remove(g); this.bombs.delete(id); }
  }

  /** x, z: 칸 좌표, height: 던져져 날아가는 높이, spin: 굴러가는/날아가는 회전 */
  poseBomb(id: number, x: number, z: number, height: number, spin: number) {
    const g = this.bombs.get(id);
    if (!g) return;
    g.position.set(x, height, z);
    g.userData.airborne = height > 0.01;
    (g.userData.body as THREE.Object3D).rotation.set(spin, 0, 0);
  }

  syncFlames(list: Flame[]) { this.flames = list; }

  syncItems(list: Item[]) {
    const seen = new Set<string>();
    for (const it of list) {
      const key = `${it.x},${it.y},${it.type}`;
      seen.add(key);
      if (!this.items.has(key)) {
        const g = makeItem(it.type);
        g.position.set(it.x, 0, it.y);
        this.group.add(g);
        this.items.set(key, g);
      }
    }
    for (const [k, g] of this.items) if (!seen.has(k)) { this.group.remove(g); this.items.delete(k); }
  }

  clearDynamic() {
    this.syncBombs([]); this.syncItems([]); this.flames = [];
    for (const d of this.debris) this.group.remove(d.m);
    this.debris = [];
  }

  update(t: number, dt: number) {
    this.lavaMat.emissiveIntensity = 0.9 + Math.sin(t * 2) * 0.35;
    for (const s of this.spinners) s.rotation.z += dt;
    for (const g of this.bombs.values()) {
      const fuse = g.userData.fuse as number;
      const speed = 6 + (50 - fuse) * 0.35;
      const k = g.userData.airborne ? 1 : 1 + Math.sin(t * speed) * 0.06;
      g.scale.set(k, 2 - k, k);
      (g.userData.spark as THREE.Mesh).scale.setScalar(0.05 + Math.random() * 0.04);
    }
    for (const g of this.items.values()) {
      (g.userData.icon as THREE.Object3D).position.y = 0.45 + Math.sin(t * 3 + g.position.x) * 0.07;
      (g.userData.icon as THREE.Object3D).rotation.y = t * 1.5;
    }
    let i = 0;
    for (const f of this.flames) {
      const w = 0.12 * Math.sin(t * 30 + f.x * 3 + f.y * 5);
      const fade = Math.min(1, f.ttl / 4);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(f.x, 0.3, f.y); dummy.scale.set(0.92 * fade + w, 0.55 * fade, 0.92 * fade + w); dummy.updateMatrix();
      this.flameOuter.setMatrixAt(i, dummy.matrix);
      dummy.position.set(f.x, 0.32, f.y); dummy.scale.set(0.5 * fade, 0.62 * fade, 0.5 * fade); dummy.updateMatrix();
      this.flameInner.setMatrixAt(i, dummy.matrix);
      i++;
    }
    this.flameOuter.count = this.flameInner.count = i;
    this.flameOuter.instanceMatrix.needsUpdate = this.flameInner.instanceMatrix.needsUpdate = true;

    this.debris = this.debris.filter((d) => {
      d.life -= dt;
      d.v.y -= 14 * dt;
      d.m.position.addScaledVector(d.v, dt);
      if (d.m.position.y < 0.05) { d.m.position.y = 0.05; d.v.multiplyScalar(0.5); d.v.y = Math.abs(d.v.y) * 0.3; }
      d.m.rotation.x += dt * 6;
      if (d.life <= 0) { this.group.remove(d.m); return false; }
      return true;
    });
  }
}

const bombMats = {
  body: new THREE.MeshStandardMaterial({ color: 0x262a36, roughness: 0.3, metalness: 0.2 }),
  cap: new THREE.MeshStandardMaterial({ color: 0xd94b4b }),
  fuse: new THREE.MeshStandardMaterial({ color: 0xc8a46b }),
  spark: new THREE.MeshBasicMaterial({ color: 0xffe066 }),
  shine: new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
};
const fuseGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 0.66, 0), new THREE.Vector3(0.05, 0.78, 0), new THREE.Vector3(0.14, 0.82, 0)]), 12, 0.02, 6);

function makeBomb() {
  const g = new THREE.Group();
  // body: 회전 중심을 폭탄 중심(0.34)에 둔 그룹 → 구르거나 날아갈 때 제자리에서 회전
  const body = new THREE.Group();
  body.position.y = 0.34;
  g.add(body);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, p: number[], s: number[]) => {
    const mm = new THREE.Mesh(geo, mat);
    mm.position.set(p[0], p[1] - 0.34, p[2]); mm.scale.set(s[0], s[1], s[2]); mm.castShadow = true; body.add(mm); return mm;
  };
  add(G.sph, bombMats.body, [0, 0.34, 0], [0.33, 0.33, 0.33]);
  add(G.cyl, bombMats.cap, [0, 0.66, 0], [0.11, 0.08, 0.11]);
  add(G.sph, bombMats.shine, [-0.12, 0.47, 0.22], [0.07, 0.05, 0.03]);
  const fuse = new THREE.Mesh(fuseGeo, bombMats.fuse);
  fuse.position.y = -0.34;
  body.add(fuse);
  g.userData.spark = add(G.sph, bombMats.spark, [0.15, 0.83, 0], [0.06, 0.06, 0.06]);
  g.userData.body = body;
  return g;
}

const ITEM_STYLE: Record<ItemType, number> = {
  [ItemType.Bomb]: 0x5b6bff,
  [ItemType.Fire]: 0xff6a2a,
  [ItemType.Speed]: 0x2fd1a0,
  [ItemType.Kick]: 0x2e9e4f,
  [ItemType.Glove]: 0xb04ad8,
};
function makeItem(type: ItemType) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(G.box, new THREE.MeshStandardMaterial({ color: ITEM_STYLE[type], roughness: 0.4 }));
  base.scale.set(0.7, 0.08, 0.7); base.position.y = 0.04; g.add(base);
  const icon = new THREE.Group();
  icon.position.y = 0.45;
  g.add(icon);
  if (type === ItemType.Bomb) {
    const b = new THREE.Mesh(G.sph, bombMats.body); b.scale.setScalar(0.2); icon.add(b);
    const f = new THREE.Mesh(G.sph, bombMats.spark); f.scale.setScalar(0.06); f.position.set(0.12, 0.2, 0); icon.add(f);
  } else if (type === ItemType.Fire) {
    const c = new THREE.Mesh(G.cone, new THREE.MeshBasicMaterial({ color: 0xff7a1a })); c.scale.set(0.18, 0.4, 0.18); icon.add(c);
    const c2 = new THREE.Mesh(G.cone, new THREE.MeshBasicMaterial({ color: 0xffe066 })); c2.scale.set(0.1, 0.25, 0.1); c2.position.set(0, -0.05, 0.06); icon.add(c2);
  } else if (type === ItemType.Kick) {
    // ⚽ 축구화: 신발 + 축구공
    const shoe = new THREE.Group();
    shoe.position.x = -0.08;
    icon.add(shoe);
    const red = new THREE.MeshStandardMaterial({ color: 0xff4b3e, roughness: 0.4 });
    const sole = new THREE.Mesh(G.box, new THREE.MeshStandardMaterial({ color: 0xffffff }));
    sole.scale.set(0.34, 0.05, 0.16); sole.position.y = -0.12; shoe.add(sole);
    const toe = new THREE.Mesh(G.sph, red); toe.scale.set(0.17, 0.1, 0.09); toe.position.set(0.06, -0.06, 0); shoe.add(toe);
    const ankle = new THREE.Mesh(G.cyl, red); ankle.scale.set(0.085, 0.18, 0.08); ankle.position.set(-0.09, 0.0, 0); shoe.add(ankle);
    for (let i = 0; i < 3; i++) {
      const stud = new THREE.Mesh(G.box, bombMats.body); stud.scale.set(0.03, 0.04, 0.03); stud.position.set(-0.12 + i * 0.11, -0.16, 0); shoe.add(stud);
    }
    const ball = new THREE.Mesh(G.sph, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    ball.scale.setScalar(0.11); ball.position.set(0.2, -0.04, 0.06); icon.add(ball);
    for (const [a, b, c] of [[0.2, 0.06, 0.1], [0.29, -0.04, 0.08], [0.2, -0.08, 0.16]]) {
      const spot = new THREE.Mesh(G.sph, bombMats.body); spot.scale.setScalar(0.035); spot.position.set(a, b, c); icon.add(spot);
    }
  } else if (type === ItemType.Glove) {
    // 🧤 글러브: 손바닥 + 손가락 4개 + 엄지 + 소매
    const white = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 });
    const cuff = new THREE.MeshStandardMaterial({ color: 0xff4b3e, roughness: 0.5 });
    const palm = new THREE.Mesh(G.sph, white); palm.scale.set(0.17, 0.15, 0.08); icon.add(palm);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(G.cyl, white);
      f.scale.set(0.04, 0.14, 0.04); f.position.set(-0.11 + i * 0.075, 0.17, 0); f.rotation.z = (1.5 - i) * 0.08;
      icon.add(f);
    }
    const thumb = new THREE.Mesh(G.cyl, white); thumb.scale.set(0.045, 0.12, 0.045); thumb.position.set(0.17, 0.02, 0); thumb.rotation.z = -0.9; icon.add(thumb);
    const band = new THREE.Mesh(G.cyl, cuff); band.scale.set(0.14, 0.07, 0.08); band.position.y = -0.17; icon.add(band);
  } else {
    const c = new THREE.Mesh(G.cone, new THREE.MeshBasicMaterial({ color: 0x7ff0d0 }));
    c.scale.set(0.16, 0.32, 0.16); c.rotation.z = -Math.PI / 2; icon.add(c);
    const s = new THREE.Mesh(G.box, new THREE.MeshBasicMaterial({ color: 0x7ff0d0 }));
    s.scale.set(0.22, 0.08, 0.08); s.position.x = -0.18; icon.add(s);
  }
  g.userData.icon = icon;
  return g;
}
