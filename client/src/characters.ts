// 캐릭터 6종 모델 (프리미티브 조합). 나중에 glTF로 바꿔도 인터페이스는 유지한다.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/constants.ts';

const sph = new THREE.SphereGeometry(1, 24, 16);
const mat = (c: THREE.ColorRepresentation, o: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, ...o });

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D,
  pos: number[] = [0, 0, 0], scale: number[] = [1, 1, 1], rot: number[] = [0, 0, 0]) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(pos[0], pos[1], pos[2]);
  o.scale.set(scale[0], scale[1], scale[2]);
  o.rotation.set(rot[0], rot[1], rot[2]);
  o.castShadow = true;
  parent.add(o);
  return o;
}

export interface CharacterModel {
  root: THREE.Group;
  /** 매 프레임 호출. moving: 걷는 중, dead: 사망 연출 */
  animate(t: number, dt: number, moving: boolean): void;
  die(): void;
  dispose(): void;
}

export function createCharacter(index: number): CharacterModel {
  const def = CHARACTERS[index] ?? CHARACTERS[0];
  const C = def.color;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const cm = mat(C);
  const dark = mat(new THREE.Color(C).multiplyScalar(0.62));
  const robot = def.id === 'volt';
  const bodyScale = def.id === 'dung' ? 1.15 : 1;
  const bellyColor: Record<string, number> = {
    pop: 0xffb199, dung: 0xbfd4ff, leaf: 0xc9f2c0, volt: 0x4a4f5e, mia: 0xe0ccff, koko: 0xfff0f6,
  };

  mesh(sph, cm, body, [0, 0.42, 0], [0.32 * bodyScale, 0.3, 0.28 * bodyScale]);
  mesh(sph, mat(bellyColor[def.id]), body, [0, 0.4, 0.1 * bodyScale], [0.21 * bodyScale, 0.21, 0.19]);
  const feet: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    mesh(sph, cm, body, [sx * 0.33 * bodyScale, 0.42, 0.05], [0.09, 0.09, 0.09]);
    feet.push(mesh(sph, dark, root, [sx * 0.14, 0.07, 0.04], [0.11, 0.07, 0.14]));
  }
  const head = new THREE.Group();
  head.position.y = 0.95;
  body.add(head);

  if (robot) {
    mesh(new THREE.BoxGeometry(0.74, 0.6, 0.64), cm, head);
    mesh(new THREE.BoxGeometry(0.6, 0.24, 0.04), mat(0x1c2230, { roughness: 0.15 }), head, [0, 0.02, 0.32]);
    const eye = mat(0x5ff8ff, { emissive: 0x2fd8ff, emissiveIntensity: 1.6 });
    for (const sx of [-1, 1]) {
      mesh(new THREE.BoxGeometry(0.12, 0.08, 0.02), eye, head, [sx * 0.14, 0.02, 0.345]);
      mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 16), dark, head, [sx * 0.39, 0, 0], [1, 1, 1], [0, 0, Math.PI / 2]);
    }
    mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8), dark, head, [0, 0.4, 0]);
    mesh(sph, eye, head, [0, 0.54, 0], [0.065, 0.065, 0.065]);
  } else {
    mesh(sph, cm, head, [0, 0, 0], [0.42, 0.38, 0.38]);
    const black = mat(0x1a1a22, { roughness: 0.15 }), white = mat(0xffffff);
    const blush = mat(0xff8a8a, { transparent: true, opacity: 0.75 });
    for (const sx of [-1, 1]) {
      mesh(sph, black, head, [sx * 0.14, 0.02, 0.33], [0.06, 0.085, 0.04]);
      mesh(sph, white, head, [sx * 0.14 + 0.02, 0.055, 0.37], [0.022, 0.022, 0.012]);
      mesh(sph, blush, head, [sx * 0.25, -0.09, 0.28], [0.055, 0.03, 0.02]);
    }
  }

  let wiggle: THREE.Object3D | null = null;
  if (def.id === 'pop') {
    const f1 = mat(0xff7a1a, { emissive: 0xff4a00, emissiveIntensity: 0.7 });
    const f2 = mat(0xffd23c, { emissive: 0xffb000, emissiveIntensity: 0.8 });
    const cone = new THREE.ConeGeometry(0.12, 0.38, 14);
    mesh(cone, f1, head, [0, 0.44, -0.02]);
    mesh(cone, f1, head, [-0.14, 0.37, 0], [0.8, 0.8, 0.8], [0, 0, 0.55]);
    mesh(cone, f1, head, [0.14, 0.37, 0], [0.8, 0.8, 0.8], [0, 0, -0.55]);
    wiggle = mesh(cone, f2, head, [0, 0.4, 0.04], [0.55, 0.6, 0.55]);
  } else if (def.id === 'dung') {
    const inner = mat(0xbfd4ff);
    for (const sx of [-1, 1]) {
      mesh(sph, cm, head, [sx * 0.28, 0.3, -0.02], [0.13, 0.13, 0.09]);
      mesh(sph, inner, head, [sx * 0.28, 0.3, 0.04], [0.075, 0.075, 0.05]);
    }
    mesh(sph, mat(0xdfe8ff), head, [0, -0.1, 0.34], [0.12, 0.08, 0.05]);
    mesh(sph, mat(0x1a1a22), head, [0, -0.07, 0.385], [0.035, 0.025, 0.02]);
  } else if (def.id === 'leaf') {
    const lm = mat(0x7be36a);
    mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), mat(0x2d8a45), head, [0, 0.47, 0]);
    wiggle = new THREE.Group();
    wiggle.position.y = 0.58;
    head.add(wiggle);
    mesh(sph, lm, wiggle, [-0.11, 0, 0], [0.15, 0.025, 0.075], [0, 0, 0.45]);
    mesh(sph, lm, wiggle, [0.11, 0, 0], [0.15, 0.025, 0.075], [0, 0, -0.45]);
    mesh(new THREE.TorusGeometry(0.24, 0.055, 10, 24), mat(0xf6d365), body, [0, 0.66, 0], [1, 1, 1], [Math.PI / 2, 0, 0]);
  } else if (def.id === 'mia') {
    const pink = mat(0xffb3d1);
    for (const sx of [-1, 1]) {
      mesh(new THREE.ConeGeometry(0.11, 0.24, 4), cm, head, [sx * 0.22, 0.33, -0.02], [1, 1, 0.6], [0, Math.PI / 4, -sx * 0.38]);
      mesh(new THREE.ConeGeometry(0.06, 0.14, 4), pink, head, [sx * 0.21, 0.32, 0.03], [1, 1, 0.4], [0, Math.PI / 4, -sx * 0.38]);
    }
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.3, -0.22), new THREE.Vector3(0.05, 0.3, -0.45),
      new THREE.Vector3(0.12, 0.55, -0.55), new THREE.Vector3(0.1, 0.8, -0.45)]);
    wiggle = mesh(new THREE.TubeGeometry(curve, 24, 0.045, 10), cm, body);
  } else if (def.id === 'koko') {
    const inner = mat(0xfff0f6);
    const earL = new THREE.Group(), earR = new THREE.Group();
    earL.position.set(-0.13, 0.3, 0); earR.position.set(0.13, 0.3, 0);
    head.add(earL, earR);
    for (const e of [earL, earR]) {
      mesh(sph, cm, e, [0, 0.26, 0], [0.085, 0.3, 0.055]);
      mesh(sph, inner, e, [0, 0.26, 0.03], [0.045, 0.22, 0.03]);
    }
    earR.rotation.z = -0.55; earL.rotation.z = 0.12;
    wiggle = earR;
    mesh(sph, inner, body, [0, 0.3, -0.27], [0.1, 0.1, 0.1]);
  }

  // 발밑 색 링 (혼전 중 식별용)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.44, 36),
    new THREE.MeshBasicMaterial({ color: C, transparent: true, opacity: 0.85 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  root.add(ring);

  let dying = -1;
  const phase = index * 1.3;
  return {
    root,
    animate(t, dt, moving) {
      if (dying >= 0) {
        dying += dt;
        body.rotation.z = Math.min(1.4, dying * 4);
        root.position.y = Math.max(-0.6, -dying * 0.4);
        const s = Math.max(0.001, 1 - dying * 0.8);
        root.scale.setScalar(s);
        root.visible = dying < 1.3;
        return;
      }
      const p = t * (moving ? 12 : 3) + phase;
      body.position.y = Math.abs(Math.sin(p)) * (moving ? 0.09 : 0.04);
      head.rotation.z = Math.sin(p * 0.5) * (moving ? 0.1 : 0.05);
      feet[0].position.z = 0.04 + (moving ? Math.sin(p) * 0.12 : 0);
      feet[1].position.z = 0.04 - (moving ? Math.sin(p) * 0.12 : 0);
      if (wiggle) {
        if (def.id === 'pop') wiggle.scale.y = 0.6 + Math.sin(t * 14) * 0.12;
        else if (def.id === 'leaf') wiggle.rotation.z = Math.sin(t * 2.2) * 0.15;
        else if (def.id === 'mia') wiggle.rotation.y = Math.sin(t * 2 + phase) * 0.35;
        else if (def.id === 'koko') wiggle.rotation.z = -0.55 + Math.sin(t * 2.4) * 0.12;
      }
    },
    die() { if (dying < 0) dying = 0; },
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry !== sph) o.geometry.dispose();
      });
    },
  };
}
