import * as THREE from 'three'
import type { Vehicle } from '../entities/Vehicle'
import { clamp } from '../config'
import type { StaticWorld } from '../world/Colliders'

/**
 * 夜间真实光源（DayNight 持有，构造时一次性加入场景）：
 *  - 路灯：固定 N 盏无阴影 PointLight 池，每 0.25 s 重新分配到玩家附近最近的路灯头；换灯时先淡出再淡入，强度 × 夜间 lights。
 *  - 玩家车前灯：2 盏无阴影 SpotLight，跟随玩家所驾车辆，夜间/暴雨自动开。
 *  - NPC 车前灯：路面加法光锥贴花（InstancedMesh，一次 draw），湿路时更亮并拉出反光。
 * 光源数量从开局固定（关灯只把强度设 0、不改 visible），避免灯数变化触发全场景着色器重编译。
 */

const REASSIGN_SEC = 0.25
/** 路灯点光：坎德拉（physically correct，decay 2）；distance 截断范围 */
const LAMP_I = 10, LAMP_DIST = 16, LAMP_COLOR = 0xffc988
const HEAD_I = 220, HEAD_DIST = 48, HEAD_ANGLE = 0.42, HEAD_COLOR = 0xfff1dc
const WALL_PROBE = [0.6, 1.2, 2, 3, 4.5, 6]
const CONE_LEN = 16, CONE_W = 8.5, CONE_Y = 0.13, CONE_CAP = 64, CONE_FAR = 140

interface Slot { light: THREE.PointLight; lamp: number; target: number; fade: number }

export class NightLights {
  private slots: Slot[] = []
  private heads: Float32Array = new Float32Array(0)
  private headCount = 0
  private timer = 0
  private best: number[] = []
  private bestD: number[] = []
  private spots: THREE.SpotLight[] = []
  private spotOn = 0
  /** 车头前方最近障碍（墙）距离对应的车灯衰减：贴墙时 1/d² 会把墙照爆，按 (d/6)^decay 封顶墙面照度 */
  private wallK = 1; private wallTarget = 1; private wallTimer = 0
  private cone: THREE.InstancedMesh
  private coneMat: THREE.ShaderMaterial
  private tmpM = new THREE.Matrix4(); private tmpQ = new THREE.Quaternion(); private tmpS = new THREE.Vector3(); private tmpP = new THREE.Vector3()
  private yAxis = new THREE.Vector3(0, 1, 0)

  constructor(scene: THREE.Scene, count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(LAMP_COLOR, 0, LAMP_DIST, 2)
      l.castShadow = false
      l.position.set(0, -50, 0)
      scene.add(l)
      this.slots.push({ light: l, lamp: -1, target: -1, fade: 0 })
    }
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(HEAD_COLOR, 0, HEAD_DIST, HEAD_ANGLE, 0.55, 1.6)
      s.castShadow = false
      s.position.set(0, -50, 0)
      scene.add(s, s.target)
      this.spots.push(s)
    }
    this.coneMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uWet: { value: 0 }, uColor: { value: new THREE.Color(0xffeccc) }, uFar: { value: CONE_FAR } },
      vertexShader: /* glsl */`
        varying vec2 vP;      // x = 横向 -1..1，y = 纵向 0..1（车头 → 远端）
        varying float vD;
        void main() {
          vP = vec2(position.x * 2.0, position.z);
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vD = distance(w.xz, cameraPosition.xz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity, uWet, uFar; uniform vec3 uColor;
        varying vec2 vP; varying float vD;
        void main() {
          float t = vP.y;
          // 光锥：近窄远宽、两侧软边；纵向近处升起（车头下方不亮）、远处衰减
          float half_ = 0.22 + 0.78 * t;
          float edge = 1.0 - smoothstep(half_ * 0.55, half_, abs(vP.x));
          float along = smoothstep(0.0, 0.12, t) * pow(clamp(1.0 - t, 0.0, 1.0), 1.6);
          // 两盏灯的光斑：横向两个高斯叠加（近处分得开，远处合成一片）
          float lq = (abs(vP.x) - 0.35 * half_) / (0.3 * half_);
          float lobes = 0.7 + 0.3 * exp(-lq * lq);
          // 湿路：整体更亮 + 中线一条朝前拉长的反光
          float sheen = uWet * exp(-vP.x * vP.x * 18.0) * smoothstep(0.05, 0.3, t) * (1.0 - t);
          float a = edge * along * lobes * (1.0 + 0.25 * uWet) + 0.6 * sheen;
          float fade = 1.0 - smoothstep(uFar * 0.6, uFar, vD);
          gl_FragColor = vec4(uColor * a * uOpacity * fade, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    })
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5)   // x ∈ ±0.5，z ∈ 0..1
    this.cone = new THREE.InstancedMesh(g, this.coneMat, CONE_CAP)
    this.cone.count = 0
    this.cone.frustumCulled = false
    this.cone.renderOrder = 1
    scene.add(this.cone)
  }

  /** 路灯头世界坐标（xyz 交错）：DayNight 重建路灯光晕时同步 */
  setLamps(heads: Float32Array, n: number) {
    this.heads = heads; this.headCount = n
    this.timer = REASSIGN_SEC   // 下一帧立即重新分配
    // 流式区块重写实例后下标可能整体重排：按灯的世界位置把已点亮的槽重新对上新下标，找不到（灯被卸载）就让它淡出重分配
    for (const s of this.slots) {
      if (s.lamp < 0) { s.target = -1; continue }
      const p = s.light.position
      let found = -1
      for (let i = 0; i < n; i++) if (Math.abs(heads[i * 3] - p.x) < 0.01 && Math.abs(heads[i * 3 + 2] - p.z) < 0.01) { found = i; break }
      if (found >= 0) s.lamp = s.target = found
      else { s.target = -1; s.lamp = -2; s.fade = 0 }   // 对不上（灯已卸载，通常在远处）：直接熄灭，等下次重分配
    }
  }

  /**
   * @param lights 夜间灯光开启度 0–1（DayNight.lights）
   * @param head 车前灯开启度 0–1（夜间或暴雨）
   */
  update(dt: number, px: number, pz: number, cam: THREE.Camera, vehicles: readonly Vehicle[], playerCar: Vehicle | null, lights: number, head: number, wet: number, world: StaticWorld) {
    this.updateLamps(dt, px, pz, lights, wet)
    this.updateHeadlights(dt, playerCar, head, wet, world)
    this.updateCones(cam, vehicles, playerCar, head, wet)
  }

  private updateLamps(dt: number, px: number, pz: number, lights: number, wet: number) {
    // 湿路面（低粗糙度）把点光镜面反射成大片亮斑：湿时点光收一点
    const wetK = 1 - 0.4 * clamp(wet, 0, 1)
    const slots = this.slots, n = slots.length
    this.timer += dt
    if (this.timer >= REASSIGN_SEC && lights > 0.01) {
      this.timer = 0
      // 选最近的 n 盏（插入排序，n 很小）
      const best = this.best, bd = this.bestD
      best.length = 0; bd.length = 0
      const h = this.heads
      for (let i = 0; i < this.headCount; i++) {
        const dx = h[i * 3] - px, dz = h[i * 3 + 2] - pz
        const d = dx * dx + dz * dz
        if (best.length < n) { best.push(i); bd.push(d) } else if (d < bd[n - 1]) { best[n - 1] = i; bd[n - 1] = d } else continue
        for (let k = best.length - 1; k > 0 && bd[k - 1] > bd[k]; k--) {
          const ti = best[k]; best[k] = best[k - 1]; best[k - 1] = ti
          const td = bd[k]; bd[k] = bd[k - 1]; bd[k - 1] = td
        }
      }
      // 已占用且仍在名单里的槽保持不动；其余槽依次领取剩下的灯
      const taken = new Set<number>()
      for (const s of slots) if (s.target >= 0 && best.includes(s.target)) taken.add(s.target)
      let j = 0
      for (const s of slots) {
        if (s.target >= 0 && taken.has(s.target)) continue
        while (j < best.length && taken.has(best[j])) j++
        s.target = j < best.length ? best[j++] : -1
        if (s.target >= 0) taken.add(s.target)
      }
    }
    for (const s of slots) {
      if (s.lamp !== s.target) {
        s.fade -= dt * 8
        if (s.fade <= 0) {
          s.fade = 0; s.lamp = s.target
          if (s.lamp >= 0) s.light.position.set(this.heads[s.lamp * 3], this.heads[s.lamp * 3 + 1] - 0.6, this.heads[s.lamp * 3 + 2])
        }
      } else if (s.lamp >= 0) s.fade = Math.min(1, s.fade + dt * 4)
      s.light.intensity = s.lamp >= 0 ? LAMP_I * lights * s.fade * wetK : 0
    }
  }

  private updateHeadlights(dt: number, car: Vehicle | null, head: number, wet: number, world: StaticWorld) {
    const on = car && !car.wrecked ? head : 0
    this.spotOn += (on - this.spotOn) * (1 - Math.exp(-dt * 6))
    const [s0, s1] = this.spots
    if (!car || this.spotOn < 0.005) { s0.intensity = s1.intensity = 0; return }
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw)
    const hy = car.headY, hz = car.headZ, side = car.model === 'bus' ? 0.9 : 0.64
    this.wallTimer -= dt
    if (this.wallTimer <= 0) {
      this.wallTimer = 0.1
      let d = WALL_PROBE[WALL_PROBE.length - 1]
      for (const t of WALL_PROBE) if (world.contains(car.x + fx * (hz + t), car.z + fz * (hz + t))) { d = t; break }
      this.wallTarget = Math.min(1, Math.pow(Math.max(d, 0.6) / WALL_PROBE[WALL_PROBE.length - 1], 1.6))
    }
    this.wallK += (this.wallTarget - this.wallK) * (1 - Math.exp(-dt * 10))
    for (let i = 0; i < 2; i++) {
      const s = this.spots[i], sx = i === 0 ? side : -side
      // 车身坐标（x 右，z 前）→ 世界：x' = x·cos + z·sin，z' = -x·sin + z·cos
      const wx = car.x + sx * fz + hz * fx, wz = car.z - sx * fx + hz * fz
      s.position.set(wx, hy + 0.05, wz)
      // 近光：朝前下方 ~22 m 处打到路面
      s.target.position.set(wx + fx * 22, 0, wz + fz * 22)
      s.target.updateMatrixWorld()
      s.intensity = HEAD_I * this.spotOn * (1 - 0.3 * wet) * this.wallK
    }
  }

  private updateCones(cam: THREE.Camera, vehicles: readonly Vehicle[], playerCar: Vehicle | null, head: number, wet: number) {
    this.coneMat.uniforms.uOpacity.value = 0.32 * head
    this.coneMat.uniforms.uWet.value = clamp(wet, 0, 1)
    if (head < 0.01) { this.cone.count = 0; this.cone.visible = false; return }
    this.cone.visible = true
    const cx = cam.position.x, cz = cam.position.z, far2 = CONE_FAR * CONE_FAR
    let k = 0
    for (const v of vehicles) {
      if (k >= CONE_CAP) break
      if (!v.active || v.wrecked || v === playerCar || v.driver === 'none') continue
      const dx = v.x - cx, dz = v.z - cz
      if (dx * dx + dz * dz > far2) continue
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw), hz = v.headZ - 0.2
      this.tmpP.set(v.x + fx * hz, CONE_Y, v.z + fz * hz)
      this.tmpQ.setFromAxisAngle(this.yAxis, v.yaw)
      const big = v.model === 'bus' ? 1.2 : 1
      this.tmpS.set(CONE_W * big, 1, CONE_LEN * big)
      this.cone.setMatrixAt(k++, this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS))
    }
    this.cone.count = k
    if (k > 0) this.cone.instanceMatrix.needsUpdate = true
  }

  /** 调试：当前点亮的路灯点光数 / 车灯强度 / NPC 光锥数 */
  get stats() {
    return { lampLights: this.slots.filter((s) => s.light.intensity > 0.01).length, slots: this.slots.length, headlight: +this.spots[0].intensity.toFixed(1), cones: this.cone.count }
  }
}
