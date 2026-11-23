// 효과음·배경음: 음원 파일 없이 Web Audio API로 직접 합성한다.
// 브라우저 정책상 첫 클릭/키 입력 이후에만 소리가 난다 (unlock).
import type { MapId } from '../../shared/maps.ts';

export type Sfx =
  | 'place' | 'explode' | 'pickup' | 'power' | 'kick' | 'throw' | 'land' | 'death'
  | 'warp' | 'boing' | 'lava' | 'crack' | 'tick' | 'start' | 'win' | 'lose' | 'trap' | 'rescue';
export type MusicId = MapId | 'lobby';

const load = (k: string) => { try { return localStorage.getItem(k) !== '0'; } catch { return true; } };
const save = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* 무시 */ } };
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// ---------- 배경음 곡 정의 (맵 분위기별) ----------
interface Song {
  bpm: number;
  root: number; // 멜로디 기준음 (MIDI)
  scale: number[]; // 반음 간격
  prog: number[]; // 마디별 화음 (음계 도수)
  lead: OscillatorType;
  bass: OscillatorType;
  drums: 'full' | 'light' | 'tabla';
  arp: boolean;
  seed: number;
}
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN_DOM = [0, 1, 4, 5, 7, 8, 10];
const SONGS: Record<MusicId, Song> = {
  lobby: { bpm: 96, root: 65, scale: MAJOR, prog: [0, 4, 5, 3], lead: 'triangle', bass: 'triangle', drums: 'light', arp: false, seed: 7 },
  glacier: { bpm: 108, root: 72, scale: MAJOR, prog: [0, 5, 3, 4], lead: 'triangle', bass: 'triangle', drums: 'light', arp: true, seed: 11 },
  volcano: { bpm: 138, root: 69, scale: MINOR, prog: [0, 5, 6, 4], lead: 'square', bass: 'sawtooth', drums: 'full', arp: false, seed: 23 },
  forest: { bpm: 100, root: 67, scale: MAJOR, prog: [0, 3, 0, 4], lead: 'sine', bass: 'triangle', drums: 'light', arp: true, seed: 37 },
  desert: { bpm: 116, root: 62, scale: PHRYGIAN_DOM, prog: [0, 0, 6, 1], lead: 'sawtooth', bass: 'triangle', drums: 'tabla', arp: false, seed: 51 },
  park: { bpm: 128, root: 67, scale: MAJOR, prog: [0, 3, 4, 0], lead: 'square', bass: 'triangle', drums: 'full', arp: true, seed: 61 }, // 🎠 축제
};

/** 곡마다 고정된 4마디 멜로디 (8분음표 32칸, null = 쉼표) */
function composeMelody(song: Song): (number | null)[] {
  let s = song.seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const deg = (d: number) => {
    const n = song.scale.length;
    return song.root + song.scale[((d % n) + n) % n] + 12 * Math.floor(d / n);
  };
  const motif: (number | null)[] = [];
  for (let bar = 0; bar < 2; bar++) {
    const chord = song.prog[bar];
    for (let i = 0; i < 8; i++) {
      if (i > 0 && rnd() < 0.3) { motif.push(null); continue; }
      const tone = rnd() < 0.7 ? chord + [0, 2, 4][Math.floor(rnd() * 3)] : chord + Math.floor(rnd() * 7);
      motif.push(deg(tone));
    }
  }
  // 3~4마디: 앞 두 마디를 반복하되 화음에 맞춰 옮기고 끝을 살짝 바꿈
  const out = [...motif];
  for (let i = 0; i < 16; i++) {
    const n = motif[i];
    const bar = 2 + Math.floor(i / 8);
    const shift = song.scale[((song.prog[bar] % 7) + 7) % 7] - song.scale[((song.prog[bar - 2] % 7) + 7) % 7];
    out.push(n === null ? null : i >= 12 && rnd() < 0.5 ? deg(song.prog[bar] + [0, 2, 4][Math.floor(rnd() * 3)]) : n + shift);
  }
  return out;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private sfxGain!: GainNode;
  private musicGain!: GainNode;
  private noise!: AudioBuffer;
  private music: MusicId | null = null;
  private timer = 0;
  private step = 0;
  private nextTime = 0;
  private melody: (number | null)[] = [];
  sfxOn = load('popop.sfx');
  musicOn = load('popop.music');

  /** 첫 사용자 입력 때 호출 (브라우저 자동재생 정책) */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor(); // 폭발이 겹쳐도 찢어지지 않게
      comp.connect(ctx.destination);
      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = this.sfxOn ? 0.7 : 0;
      this.sfxGain.connect(comp);
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = this.musicOn ? 0.14 : 0;
      this.musicGain.connect(comp);
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      if (this.music) this.startSequencer();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleSfx() {
    this.sfxOn = !this.sfxOn;
    save('popop.sfx', this.sfxOn);
    if (this.ctx) this.sfxGain.gain.value = this.sfxOn ? 0.7 : 0;
    return this.sfxOn;
  }
  toggleMusic() {
    this.musicOn = !this.musicOn;
    save('popop.music', this.musicOn);
    if (this.ctx) this.musicGain.gain.setTargetAtTime(this.musicOn ? 0.14 : 0, this.ctx.currentTime, 0.1);
    return this.musicOn;
  }

  // ---------- 합성 도구 ----------
  private out(vol: number, pan: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.sfxGain);
    } else {
      g.connect(this.sfxGain);
    }
    return g;
  }
  private tone(dest: AudioNode, f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  private hiss(dest: AudioNode, dur: number, filter: BiquadFilterType, f0: number, f1: number, vol: number, delay = 0, q = 1) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bf = ctx.createBiquadFilter();
    bf.type = filter;
    bf.Q.value = q;
    bf.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bf.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bf).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }
  private notes(dest: AudioNode, freqs: number[], gap: number, len: number, type: OscillatorType, vol: number) {
    freqs.forEach((f, i) => this.tone(dest, f, f, i === freqs.length - 1 ? len * 2.5 : len, type, vol, i * gap));
  }

  /** 효과음. vol 0~1 (거리 감쇠 반영), pan -1(왼쪽)~1(오른쪽) */
  play(name: Sfx, vol = 1, pan = 0) {
    if (!this.ctx || !this.sfxOn || this.ctx.state !== 'running') return;
    const o = this.out(vol, pan);
    switch (name) {
      case 'place':
        this.tone(o, 520, 180, 0.1, 'sine', 0.5);
        this.hiss(o, 0.03, 'highpass', 3000, 3000, 0.15);
        break;
      case 'explode':
        this.hiss(o, 0.75, 'lowpass', 2600, 110, 0.95);
        this.tone(o, 115, 35, 0.5, 'sine', 0.9);
        this.tone(o, 62, 30, 0.7, 'triangle', 0.45);
        break;
      case 'pickup':
        this.notes(o, [784, 988, 1319], 0.055, 0.07, 'triangle', 0.35);
        break;
      case 'power':
        this.notes(o, [523, 659, 784, 1047, 1319], 0.05, 0.07, 'square', 0.16);
        this.notes(o, [1047, 1319, 1568, 2093], 0.05, 0.06, 'triangle', 0.18);
        break;
      case 'kick':
        this.tone(o, 170, 60, 0.13, 'sine', 0.85);
        this.hiss(o, 0.06, 'bandpass', 1400, 700, 0.35, 0, 2);
        break;
      case 'throw':
        this.hiss(o, 0.34, 'bandpass', 450, 2600, 0.5, 0, 3);
        break;
      case 'land':
        this.tone(o, 150, 70, 0.14, 'sine', 0.6);
        break;
      case 'death':
        this.tone(o, 660, 110, 0.6, 'square', 0.14);
        this.tone(o, 330, 55, 0.6, 'triangle', 0.35);
        this.hiss(o, 0.3, 'bandpass', 900, 300, 0.2, 0.05, 2);
        break;
      case 'warp':
        this.tone(o, 300, 1700, 0.26, 'sine', 0.35);
        this.tone(o, 450, 2500, 0.26, 'triangle', 0.15, 0.04);
        break;
      case 'boing':
        this.tone(o, 180, 560, 0.12, 'sine', 0.5);
        this.tone(o, 560, 280, 0.2, 'sine', 0.35, 0.12);
        break;
      case 'lava':
        this.hiss(o, 0.85, 'lowpass', 700, 160, 0.55);
        this.tone(o, 75, 42, 0.75, 'sawtooth', 0.08);
        break;
      case 'crack':
        this.hiss(o, 0.16, 'highpass', 4200, 4200, 0.45);
        this.tone(o, 2500, 1800, 0.09, 'triangle', 0.15);
        break;
      case 'trap': // 🫧 물방울에 갇힘: 보글보글
        for (let i = 0; i < 4; i++) this.tone(o, 400 + i * 90, 900 + i * 160, 0.09, 'sine', 0.3, i * 0.06);
        break;
      case 'rescue': // 🫧 구출: 물방울이 톡 터지며 반짝
        this.hiss(o, 0.06, 'highpass', 2500, 2500, 0.35);
        this.notes(o, [880, 1175, 1568], 0.06, 0.07, 'triangle', 0.32);
        break;
      case 'tick':
        this.tone(o, 1250, 1250, 0.06, 'square', 0.12);
        break;
      case 'start':
        this.notes(o, [523, 659, 784, 1047], 0.11, 0.1, 'triangle', 0.4);
        break;
      case 'win':
        this.notes(o, [523, 659, 784, 1047, 784, 1047], 0.12, 0.11, 'square', 0.18);
        this.notes(o, [262, 330, 392, 523, 392, 523], 0.12, 0.11, 'triangle', 0.3);
        break;
      case 'lose':
        this.notes(o, [392, 330, 262], 0.18, 0.16, 'triangle', 0.35);
        break;
    }
  }

  // ---------- 배경음 ----------
  setMusic(id: MusicId) {
    if (this.music === id) return;
    this.music = id;
    this.melody = composeMelody(SONGS[id]);
    if (this.ctx) this.startSequencer();
  }

  private startSequencer() {
    clearInterval(this.timer);
    this.step = 0;
    this.nextTime = this.ctx!.currentTime + 0.1;
    // 미리 0.15초 앞까지 음을 예약해 두는 방식 (타이머가 조금 늦어도 박자가 안 흔들림)
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || !this.music) return;
    const song = SONGS[this.music];
    const sixteenth = 60 / song.bpm / 4;
    while (this.nextTime < ctx.currentTime + 0.15) {
      this.playStep(song, this.step % 64, this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step++;
    }
  }

  private playStep(song: Song, step: number, t: number, len: number) {
    const bar = Math.floor(step / 16);
    const inBar = step % 16;
    const chord = song.prog[bar];
    const scaleNote = (d: number) => song.root + song.scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);

    // 멜로디 (8분음표)
    if (step % 2 === 0) {
      const n = this.melody[step / 2];
      if (n != null) {
        const restAfter = this.melody[step / 2 + 1] == null;
        this.voice(song.lead, midi(n), t, len * (restAfter ? 3.6 : 1.8), song.lead === 'sine' ? 0.5 : 0.32, song.lead === 'sawtooth' ? 1400 : 0);
      }
    }
    // 베이스 (4분음표)
    if (inBar % 4 === 0) {
      const beat = inBar / 4;
      const root = scaleNote(chord) - 24;
      const n = song.drums === 'full' ? (beat === 2 ? root + 7 : root) : beat % 2 === 0 ? root : root + 7;
      this.voice(song.bass, midi(n), t, len * 3.5, 0.45, 700);
    }
    // 반짝이는 아르페지오 (16분음표, 아주 작게)
    if (song.arp && inBar % 2 === 1) {
      const tone = chord + [0, 2, 4, 2][(inBar >> 1) % 4];
      this.voice('sine', midi(scaleNote(tone) + 12), t, len * 0.9, 0.12, 0);
    }
    // 드럼
    const kick = song.drums === 'full' ? inBar % 4 === 0 : song.drums === 'tabla' ? inBar === 0 || inBar === 6 || inBar === 10 : inBar === 0 || inBar === 8;
    if (kick) this.drum('kick', t);
    if (song.drums === 'full' && (inBar === 4 || inBar === 12)) this.drum('snare', t);
    if (song.drums === 'tabla' && (inBar === 4 || inBar === 12 || inBar === 14)) this.drum('tabla', t);
    if (inBar % 2 === 0 && (song.drums === 'full' || inBar % 4 === 2)) this.drum('hat', t);
  }

  private voice(type: OscillatorType, f: number, t: number, dur: number, vol: number, lowpass: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(vol * 0.5, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = o;
    if (lowpass) {
      const bf = ctx.createBiquadFilter();
      bf.type = 'lowpass';
      bf.frequency.value = lowpass;
      node = o.connect(bf);
    }
    node.connect(g).connect(this.musicGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private drum(kind: 'kick' | 'snare' | 'hat' | 'tabla', t: number) {
    const ctx = this.ctx!;
    if (kind === 'kick' || kind === 'tabla') {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const [f0, f1, v] = kind === 'kick' ? [150, 45, 0.9] : [320, 180, 0.5];
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(this.musicGain);
      o.start(t);
      o.stop(t + 0.2);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bf = ctx.createBiquadFilter();
    bf.type = kind === 'hat' ? 'highpass' : 'bandpass';
    bf.frequency.value = kind === 'hat' ? 7000 : 1800;
    const g = ctx.createGain();
    const dur = kind === 'hat' ? 0.035 : 0.13;
    g.gain.setValueAtTime(kind === 'hat' ? 0.15 : 0.45, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bf).connect(g).connect(this.musicGain);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}
