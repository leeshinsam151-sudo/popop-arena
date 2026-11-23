// 키보드 입력: 방향키/WASD 이동(가장 최근에 누른 방향 우선), 스페이스 폭탄
import { Dir } from '../../shared/constants.ts';

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: Dir.Up, KeyW: Dir.Up,
  ArrowDown: Dir.Down, KeyS: Dir.Down,
  ArrowLeft: Dir.Left, KeyA: Dir.Left,
  ArrowRight: Dir.Right, KeyD: Dir.Right,
};

export class Input {
  private held: Dir[] = [];
  bombCount = 0;
  enabled = true;
  /** 폭탄 키를 누른 순간 (화면에 폭탄을 먼저 그리는 데 사용) */
  onBomb: () => void = () => {};

  constructor() {
    addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      const d = KEY_DIR[e.code];
      if (d) {
        e.preventDefault();
        if (!this.held.includes(d)) this.held.push(d);
      } else if (e.code === 'Space' || e.code === 'KeyJ') {
        e.preventDefault();
        if (!e.repeat) { this.bombCount++; this.onBomb(); }
      }
    });
    addEventListener('keyup', (e) => {
      const d = KEY_DIR[e.code];
      if (d) this.held = this.held.filter((h) => h !== d);
    });
    addEventListener('blur', () => { this.held = []; });
  }

  get dir(): Dir {
    return this.enabled && this.held.length ? this.held[this.held.length - 1] : Dir.None;
  }

  /** 터치 컨트롤 등 외부 입력용 */
  setHeld(d: Dir | null) { this.held = d ? [d] : []; }
  pressBomb() { this.bombCount++; this.onBomb(); }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
