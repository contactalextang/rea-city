/**
 * 夜店舞曲（程序合成，WebAudio）：固定 124 BPM 的 house，32 小节 ≈ 62 s。
 * 游戏逻辑用 performance.now() 时钟（与 KeyboardEvent.timeStamp 同源，判定精确）；
 * 音频按“歌曲时间 → AudioContext 时间”换算后前瞻 0.25 s 排程，两个时钟在一首歌内的漂移可忽略。
 * AudioContext 不可用（或被浏览器挂起）时静音照跑，节拍与谱面不受影响。
 */
export const CLUB_BPM = 124
export const BEAT = 60 / CLUB_BPM
export const BAR = BEAT * 4
export const SONG_BARS = 32
export const SONG_LEN = SONG_BARS * BAR
const STEP = BEAT / 4
const LOOKAHEAD = 0.25

const midi = (m: number) => 440 * 2 ** ((m - 69) / 12)
// Am – F – C – G（每小节一个和弦）
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
const BASS = [45, 41, 48, 43]

/** 段落：0–1 前奏（只有底鼓）、2–9 主歌、10–17 渐强、18–25 高潮、26–29 间奏、30–31 尾声 */
export function sectionOf(bar: number): 'intro' | 'verse' | 'build' | 'drop' | 'break' | 'outro' {
  if (bar < 2) return 'intro'
  if (bar < 10) return 'verse'
  if (bar < 18) return 'build'
  if (bar < 26) return 'drop'
  if (bar < 30) return 'break'
  return 'outro'
}

export class ClubTrack {
  private ac: AudioContext | null = null
  private out: GainNode | null = null
  private noise: AudioBuffer | null = null
  private p0 = 0
  private nextStep = 0
  private stopped = false
  /** 已排程的底鼓歌曲时间（测试：与谱面对齐） */
  readonly kicks: number[] = []

  constructor() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC) {
        const ac = new AC()
        this.ac = ac
        void ac.resume?.().catch(() => {})
        const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4
        this.out = ac.createGain(); this.out.gain.value = 0.55
        this.out.connect(comp).connect(ac.destination)
        const len = ac.sampleRate
        this.noise = ac.createBuffer(1, len, ac.sampleRate)
        const d = this.noise.getChannelData(0)
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      }
    } catch { this.ac = null }
  }

  /** 开始：lead 秒后歌曲时间 = 0 */
  start(lead = 0.6) { this.p0 = performance.now() / 1000 + lead; this.nextStep = 0 }
  /** 当前歌曲时间（秒，可为负 = 还没开始） */
  now() { return performance.now() / 1000 - this.p0 }
  /** 事件时间戳（performance 时钟毫秒）→ 歌曲时间 */
  at(timeStampMs: number) { return timeStampMs / 1000 - this.p0 }
  get audible() { return !!this.ac && this.ac.state === 'running' }

  /** 每帧调用：前瞻排程 */
  update() {
    if (this.stopped) return
    const songNow = this.now()
    const total = SONG_BARS * 16
    while (this.nextStep < total && this.nextStep * STEP < songNow + LOOKAHEAD) {
      const st = this.nextStep * STEP
      if (st >= songNow - 0.05) this.schedule(this.nextStep, st, songNow)
      this.nextStep++
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    const ac = this.ac; if (!ac) return
    try { this.out?.gain.setTargetAtTime(0, ac.currentTime, 0.15) } catch { /* 已关闭 */ }
    setTimeout(() => { void ac.close().catch(() => {}) }, 700)
  }

  private schedule(step: number, songT: number, songNow: number) {
    const bar = Math.floor(step / 16), s = step % 16
    const sec = sectionOf(bar)
    // 底鼓：四踩（间奏改半拍感：只踩 1、3 拍）
    const kick = s % 4 === 0 && (sec !== 'break' || s % 8 === 0)
    if (kick) this.kicks.push(songT)
    const ac = this.ac, out = this.out; if (!ac || !out) return
    const t = ac.currentTime + Math.max(0, songT - songNow)
    const ci = bar % 4
    if (kick) this.kick(t, sec === 'intro' ? 0.7 : 1)
    if (sec === 'intro') { if (s % 4 === 2) this.hat(t, 0.025); return }
    // 反拍开镲
    if (s % 4 === 2) this.hat(t, sec === 'drop' ? 0.06 : 0.04, 0.09)
    if (sec === 'drop' && s % 2 === 1) this.hat(t, 0.018)
    // 拍手：2、4 拍（渐强最后两小节改 16 分军鼓滚奏）
    if (sec === 'build' && bar >= 16) { if (s % 2 === 0) this.clap(t, 0.03 + (s / 16) * 0.04) }
    else if ((sec === 'build' || sec === 'drop' || sec === 'outro') && (s === 4 || s === 12)) this.clap(t, 0.07)
    // 贝斯：反拍 8 分音符
    if (sec !== 'break' && s % 4 === 2) this.voice(midi(BASS[ci] - 12), t, STEP * 1.6, sec === 'drop' ? 0.16 : 0.12, 'sawtooth', 380)
    if (sec === 'drop' && s % 4 === 0 && s !== 0) this.voice(midi(BASS[ci] - 12), t, STEP * 0.8, 0.08, 'square', 300)
    // 和弦铺底 / 切分和弦
    if (s === 0 && (sec === 'verse' || sec === 'break' || sec === 'outro')) for (const n of CHORDS[ci]) this.voice(midi(n), t, BAR * 0.95, 0.025, 'triangle', 1800, 0.25)
    if ((sec === 'build' || sec === 'drop') && (s === 3 || s === 6 || s === 10 || s === 14)) for (const n of CHORDS[ci]) this.voice(midi(n + 12), t, STEP * 1.2, 0.03, 'sawtooth', sec === 'drop' ? 4200 : 1500 + (bar - 10) * 300)
    // 高潮旋律：和弦音琶音
    if (sec === 'drop' && s % 2 === 0) {
      const ch = CHORDS[ci], n = ch[(s / 2) % 3] + 24 - (s >= 8 ? 12 : 0)
      this.voice(midi(n), t, STEP * 1.4, 0.022, 'square', 3000)
    }
  }

  private voice(freq: number, at: number, dur: number, vol: number, type: OscillatorType, lp: number, attack = 0.005) {
    const ac = this.ac!, o = ac.createOscillator(), g = ac.createGain(), f = ac.createBiquadFilter()
    o.type = type; o.frequency.value = freq
    f.type = 'lowpass'; f.frequency.value = lp
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(vol, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.08)
    o.connect(f).connect(g).connect(this.out!); o.start(at); o.stop(at + dur + 0.12)
  }

  private kick(at: number, vol: number) {
    const ac = this.ac!, o = ac.createOscillator(), g = ac.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.11)
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(0.5 * vol, at + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3)
    o.connect(g).connect(this.out!); o.start(at); o.stop(at + 0.32)
  }

  private noiseHit(at: number, dur: number, vol: number, type: BiquadFilterType, freq: number) {
    const ac = this.ac!, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain()
    src.buffer = this.noise; f.type = type; f.frequency.value = freq
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(f).connect(g).connect(this.out!); src.start(at, Math.random() * 0.8); src.stop(at + dur + 0.02)
  }
  private hat(at: number, vol: number, dur = 0.04) { this.noiseHit(at, dur, vol, 'highpass', 7500) }
  private clap(at: number, vol: number) { this.noiseHit(at, 0.14, vol, 'bandpass', 1500); this.noiseHit(at + 0.012, 0.1, vol * 0.7, 'bandpass', 2100) }
}
