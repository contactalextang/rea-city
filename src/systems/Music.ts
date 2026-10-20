/** 背景音乐模式：步行 = 轻柔氛围乐；驾车 = 车载电台（lo-fi / city-pop） */
export type MusicMode = 'ambient' | 'radio'

export interface MusicState { inVehicle: boolean; hour: number; rain: number; stars: number }

const midi = (m: number) => 440 * 2 ** ((m - 69) / 12)

// 和弦进行（每小节一个和弦，MIDI 音高），每 4 小节随机换一套
const PROGRESSIONS: number[][][] = [
  [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]],   // Fmaj7 Em7 Dm7 Cmaj7
  [[48, 52, 55, 59], [45, 52, 55, 60], [50, 53, 57, 60], [43, 53, 55, 59]],   // Cmaj7 Am7 Dm7 G7
  [[53, 57, 60, 64], [55, 59, 62, 64], [52, 55, 59, 62], [45, 52, 55, 60]],   // Fmaj7 G6 Em7 Am7
  [[50, 53, 57, 60], [43, 53, 55, 59], [48, 52, 55, 59], [45, 52, 55, 60]],   // Dm7 G7 Cmaj7 Am7
]
const BPM: Record<MusicMode, number> = { ambient: 76, radio: 98 }
const BUS_VOL: Record<MusicMode, number> = { ambient: 0.55, radio: 0.6 }
const LOOKAHEAD = 0.3

/**
 * WebAudio 程序合成背景音乐：前瞻调度器按 16 分音符排程，16 步 × 4 小节一句。
 * 两个风格各一条总线，切换时交叉淡化；夜间氛围乐更暗，被通缉时整体压低
 */
export class Music {
  private out: GainNode
  private bus: Record<MusicMode, GainNode>
  private ambientLp: BiquadFilterNode
  private noise: AudioBuffer
  private mode: MusicMode = 'ambient'
  private enabled = true
  private step = 0
  private bar = 0
  private prog = PROGRESSIONS[0]
  private nextTime = 0
  private rain = 0

  constructor(private ac: AudioContext, dest: AudioNode) {
    this.out = ac.createGain(); this.out.gain.value = 1; this.out.connect(dest)
    this.ambientLp = ac.createBiquadFilter(); this.ambientLp.type = 'lowpass'; this.ambientLp.frequency.value = 2200
    this.ambientLp.connect(this.out)
    // 电台：低通 + 轻微中频提升，像车内喇叭
    const radioLp = ac.createBiquadFilter(); radioLp.type = 'lowpass'; radioLp.frequency.value = 3400
    const radioMid = ac.createBiquadFilter(); radioMid.type = 'peaking'; radioMid.frequency.value = 1200; radioMid.gain.value = 3
    radioLp.connect(radioMid).connect(this.out)
    this.bus = { ambient: ac.createGain(), radio: ac.createGain() }
    this.bus.ambient.gain.value = 0; this.bus.ambient.connect(this.ambientLp)
    this.bus.radio.gain.value = 0; this.bus.radio.connect(radioLp)
    const len = ac.sampleRate
    this.noise = ac.createBuffer(1, len, ac.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this.switchTo('ambient')
  }

  get currentMode() { return this.mode }
  get on() { return this.enabled }

  setEnabled(on: boolean) {
    this.enabled = on
    this.out.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, 0.3)
    if (on) this.restart()
  }

  update(st: MusicState) {
    const now = this.ac.currentTime
    this.rain = st.rain
    const mode: MusicMode = st.inVehicle ? 'radio' : 'ambient'
    if (mode !== this.mode) this.switchTo(mode)
    const night = st.hour >= 19.5 || st.hour < 5.5
    this.ambientLp.frequency.setTargetAtTime(night ? 1100 : 2200, now, 2)
    const vol = (st.stars > 0 ? 0.5 : 1) * (mode === 'ambient' && night ? 0.8 : 1)
    this.bus[mode].gain.setTargetAtTime(BUS_VOL[mode] * vol, now, 0.5)
    if (!this.enabled) return
    if (this.nextTime < now - 0.5) this.restart()   // 标签页挂起后不补排积压的音符
    while (this.nextTime < now + LOOKAHEAD) {
      this.schedule(this.step, this.nextTime)
      this.nextTime += 60 / BPM[this.mode] / 4
      if (++this.step === 16) {
        this.step = 0
        if (++this.bar === 4) { this.bar = 0; this.prog = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)] }
      }
    }
  }

  /** 约 1.5 s 交叉淡化，新风格从句首开始 */
  private switchTo(mode: MusicMode) {
    const now = this.ac.currentTime
    this.bus[this.mode].gain.setTargetAtTime(0, now, 0.5)
    this.mode = mode
    this.bus[mode].gain.setTargetAtTime(BUS_VOL[mode], now, 0.5)
    this.restart()
  }

  private restart() {
    this.step = 0; this.bar = 0
    this.nextTime = this.ac.currentTime + 0.1
  }

  private schedule(step: number, t: number) {
    const chord = this.prog[this.bar]
    const stepDur = 60 / BPM[this.mode] / 4
    const barDur = stepDur * 16
    const dest = this.bus[this.mode]
    const root = chord[0] - 12
    if (this.mode === 'ambient') {
      if (step === 0) {
        for (const n of chord) this.pad(midi(n), t, barDur, 0.012, 1.2, dest)
        this.voice(midi(root - 12), t, barDur * 0.55, 0.05, 'sine', dest, 0.08, 0.8)
      }
      if (step === 8) this.voice(midi(root - 12 + (Math.random() < 0.5 ? 7 : 0)), t, barDur * 0.45, 0.04, 'sine', dest, 0.08, 0.8)
      // 稀疏电钢琴琶音：雨天更稀
      const p = this.rain > 0.15 ? 0.25 : 0.55
      if ([0, 3, 6, 10, 12].includes(step) && Math.random() < p) this.keys(midi(chord[Math.floor(Math.random() * 4)] + 12), t, 1.4, 0.035, dest)
    } else {
      if (step === 0) for (const n of chord) this.pad(midi(n), t, barDur, 0.007, 0.25, dest)
      // 贝斯：根音 / 五度 切分
      const bassSteps: Record<number, number> = { 0: 0, 3: 0, 6: 7, 8: 0, 11: 12, 14: 7 }
      if (step in bassSteps) this.voice(midi(root - 12 + bassSteps[step]), t, stepDur * 2.2, 0.075, 'triangle', dest, 0.01, 0.12)
      if (step === 0 || step === 8 || (step === 10 && Math.random() < 0.4)) this.kick(t, dest)
      if (step === 4 || step === 12) this.snare(t, dest)
      // 踩镲：8 分音符，反拍带 swing
      if (step % 2 === 0) this.hat(t + (step % 4 === 2 ? stepDur * 0.3 : 0), step % 4 === 2 ? 0.03 : 0.018, dest)
      // 旋律：和弦音高八度，随机点缀
      if ([0, 2, 4, 7, 10, 12, 14].includes(step) && Math.random() < 0.32) {
        this.voice(midi(chord[Math.floor(Math.random() * 4)] + 12), t, stepDur * (Math.random() < 0.3 ? 3 : 1.6), 0.03, 'triangle', dest, 0.01, 0.15)
      }
    }
  }

  /** 单个振荡器音符：线性起音 → 保持 → 指数释放 */
  private voice(freq: number, at: number, dur: number, vol: number, type: OscillatorType, dest: AudioNode, attack: number, release: number, detune = 0) {
    const ac = this.ac
    const o = ac.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(vol, at + attack)
    g.gain.setValueAtTime(vol, at + Math.max(attack, dur - release))
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur + release)
    o.connect(g).connect(dest); o.start(at); o.stop(at + dur + release + 0.05)
  }

  /** 铺底：两只失谐三角波 */
  private pad(freq: number, at: number, dur: number, vol: number, attack: number, dest: AudioNode) {
    this.voice(freq, at, dur, vol, 'triangle', dest, attack, 0.9, -7)
    this.voice(freq, at, dur, vol, 'triangle', dest, attack, 0.9, 7)
  }

  /** 电钢琴：正弦 + 弱二次泛音，快起音长衰减 */
  private keys(freq: number, at: number, dur: number, vol: number, dest: AudioNode) {
    this.voice(freq, at, 0.02, vol, 'sine', dest, 0.01, dur)
    this.voice(freq * 2, at, 0.02, vol * 0.25, 'sine', dest, 0.01, dur * 0.4)
  }

  /** 底鼓：正弦下扫，音量刻意偏轻 */
  private kick(at: number, dest: AudioNode) {
    const ac = this.ac
    const o = ac.createOscillator(); o.type = 'sine'
    o.frequency.setValueAtTime(110, at); o.frequency.exponentialRampToValueAtTime(45, at + 0.12)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(0.11, at + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
    o.connect(g).connect(dest); o.start(at); o.stop(at + 0.25)
  }

  private noiseHit(at: number, dur: number, vol: number, type: BiquadFilterType, freq: number, dest: AudioNode) {
    const ac = this.ac
    const src = ac.createBufferSource(); src.buffer = this.noise
    const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq
    const g = ac.createGain()
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(f).connect(g).connect(dest)
    src.start(at, Math.random() * 0.8); src.stop(at + dur + 0.02)
  }

  private snare(at: number, dest: AudioNode) {
    this.noiseHit(at, 0.16, 0.06, 'bandpass', 1800, dest)
    this.voice(190, at, 0.01, 0.03, 'triangle', dest, 0.003, 0.08)
  }

  private hat(at: number, vol: number, dest: AudioNode) {
    this.noiseHit(at, 0.045, vol, 'highpass', 6500, dest)
  }
}
