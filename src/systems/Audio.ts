/** WebAudio 合成音效：引擎、警笛、撞击。无外部音频文件 */
export class Audio {
  private ac: AudioContext | null = null
  private engine: OscillatorNode | null = null
  private engineGain: GainNode | null = null
  private siren: OscillatorNode | null = null
  private sirenGain: GainNode | null = null
  private noise: AudioBuffer | null = null

  /** 必须在用户手势后调用 */
  unlock() {
    if (this.ac) return
    try {
      this.ac = new AudioContext()
      const ac = this.ac
      const master = ac.createGain(); master.gain.value = 0.6; master.connect(ac.destination)
      this.engine = ac.createOscillator(); this.engine.type = 'sawtooth'
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400
      this.engineGain = ac.createGain(); this.engineGain.gain.value = 0
      this.engine.connect(lp).connect(this.engineGain).connect(master); this.engine.start()
      this.siren = ac.createOscillator(); this.siren.type = 'square'
      this.sirenGain = ac.createGain(); this.sirenGain.gain.value = 0
      this.siren.connect(this.sirenGain).connect(master); this.siren.start()
      const len = ac.sampleRate * 0.3
      this.noise = ac.createBuffer(1, len, ac.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
    } catch { this.ac = null }
  }

  update(time: number, inVehicle: boolean, speed: number, throttle: number, stars: number, policeDist: number) {
    if (!this.ac) return
    const t = this.ac.currentTime
    const rpm = inVehicle ? 55 + Math.abs(speed) * 3.2 + Math.abs(throttle) * 12 : 0
    this.engine!.frequency.setTargetAtTime(Math.max(40, rpm), t, 0.08)
    this.engineGain!.gain.setTargetAtTime(inVehicle ? 0.09 + Math.abs(throttle) * 0.05 : 0, t, 0.1)
    const sirenOn = stars > 0 && policeDist < 160
    const vol = sirenOn ? 0.035 * (1 - Math.min(1, policeDist / 160)) + 0.005 : 0
    this.sirenGain!.gain.setTargetAtTime(vol, t, 0.1)
    this.siren!.frequency.setTargetAtTime(Math.floor(time * 2) % 2 === 0 ? 720 : 960, t, 0.02)
  }

  gunshot() {
    if (!this.ac || !this.noise) return
    const t = this.ac.currentTime
    const src = this.ac.createBufferSource(); src.buffer = this.noise
    const g = this.ac.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.12)
    const hp = this.ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600
    src.connect(hp).connect(g).connect(this.ac.destination); src.start(); src.stop(t + 0.15)
    const osc = this.ac.createOscillator(); osc.type = 'square'; osc.frequency.setValueAtTime(180, t); osc.frequency.exponentialRampToValueAtTime(50, t + 0.08)
    const og = this.ac.createGain(); og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.01, t + 0.1)
    osc.connect(og).connect(this.ac.destination); osc.start(); osc.stop(t + 0.1)
  }

  crash(impulse: number) {
    if (!this.ac || !this.noise) return
    const src = this.ac.createBufferSource(); src.buffer = this.noise
    const g = this.ac.createGain(); g.gain.value = Math.min(0.8, impulse * 0.05)
    const lp = this.ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    src.connect(lp).connect(g).connect(this.ac.destination); src.start()
  }
}
