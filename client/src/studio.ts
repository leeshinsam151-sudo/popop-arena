// 미리보기 스튜디오: 캐릭터·맵 썸네일 생성, 입장 화면의 캐릭터 3D 미리보기
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/constants.ts';
import { MAP_IDS, MAP_ROWS, type LayoutId, type MapId } from '../../shared/maps.ts';
import { tileFromChar } from '../../shared/sim.ts';
import { Arena } from './arena.ts';
import { createCharacter, type CharacterModel } from './characters.ts';

/** 블록 없이 맵 지형만 있는 타일 문자열 (로비·썸네일용) */
export const lobbyTiles = (layout: LayoutId) =>
  MAP_ROWS[layout].join('').split('').map((ch) => tileFromChar(ch, () => 1)).join('');

export class Studio {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private model: CharacterModel | null = null;
  private char = -1;
  private raf = 0;
  private clock = new THREE.Clock();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 40),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    this.scene.add(shadow);
  }

  private useChar(i: number) {
    if (this.char === i && this.model) return;
    if (this.model) { this.scene.remove(this.model.root); this.model.dispose(); }
    this.model = createCharacter(i);
    this.scene.add(this.model.root);
    this.char = i;
  }

  private frameCharacter(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.position.set(0, 1.25, 3.1);
    this.camera.lookAt(0, 0.66, 0);
    this.camera.updateProjectionMatrix();
  }

  /** 캐릭터 6종 정지 썸네일 (data URL) */
  characterThumbs(size = 160): string[] {
    this.frameCharacter(size, size);
    return CHARACTERS.map((_, i) => {
      this.useChar(i);
      this.model!.root.rotation.y = -0.4;
      this.model!.animate(0.25, 0, false);
      this.renderer.render(this.scene, this.camera);
      return this.canvas.toDataURL('image/png');
    });
  }

  /** 맵 4종 썸네일: 블록 없이 지형만, 위에서 비스듬히 */
  mapThumbs(w = 280, h = 180): Record<MapId, string> {
    const out = {} as Record<MapId, string>;
    this.renderer.setSize(w, h, false);
    for (const id of MAP_IDS) {
      const sc = new THREE.Scene();
      sc.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.0));
      const sun = new THREE.DirectionalLight(0xffffff, 1.5);
      sun.position.set(14, 20, 16);
      sc.add(sun);
      const arena = new Arena(sc);
      arena.build(id);
      arena.setTiles(lobbyTiles(id));
      sc.fog = null;
      const cx = (arena.w - 1) / 2, cy = (arena.h - 1) / 2;
      const cam = new THREE.PerspectiveCamera(34, w / h, 0.1, 200);
      cam.position.set(cx, 19, cy + 13);
      cam.lookAt(cx, 0, cy + 0.6);
      this.renderer.render(sc, cam);
      out[id] = this.canvas.toDataURL('image/jpeg', 0.85);
    }
    return out;
  }

  /** 입장 화면: 고른 캐릭터를 빙글빙글 돌려 보여 줌 */
  startPreview(stage: HTMLElement, char: number) {
    if (this.canvas.parentElement !== stage) stage.append(this.canvas);
    const w = stage.clientWidth || 220, h = stage.clientHeight || 220;
    this.frameCharacter(w, h);
    this.useChar(char);
    cancelAnimationFrame(this.raf);
    const loop = () => {
      const dt = Math.min(0.05, this.clock.getDelta());
      const t = this.clock.elapsedTime;
      this.model!.root.rotation.y = Math.sin(t * 0.8) * 0.7;
      this.model!.animate(t, dt, false);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  setPreviewChar(char: number) { this.useChar(char); }

  stopPreview() { cancelAnimationFrame(this.raf); this.raf = 0; }
}
