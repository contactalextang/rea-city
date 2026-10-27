import { wrapAngle, VEHICLE_PARAMS } from '../../config'
import type { RoadGraph, RoadEdge, P2 } from '../../world/RoadGraph'
import { steerFactor } from '../../physics/ArcadeVehicle'
import { SG_BLOCKED_EDGES, type RaceRouteDef } from '../../data/races'
import { t } from '../../i18n'

/** 赛道采样点：位置、弧长、可用半宽（离赛车线中心能偏多少）、单位方向、基准限速（满速线，AI 再乘水平系数） */
export interface RoutePoint { x: number; z: number; s: number; hw: number; dx: number; dz: number; vmax: number }

export interface BuiltRoute {
  def: RaceRouteDef
  pts: RoutePoint[]
  /** 一圈长度（loop）或起终点间距离（sprint） */
  length: number
  loop: boolean
  /** 检查点弧长（升序；loop 最后一个 = length，即起终点线） */
  cps: number[]
  edges: number
}

const STEP = 4            // 重采样间距 (m)
const CP_SPACING = 125    // 检查点间距目标 (m)

interface Raw { x: number; z: number; hw: number }

/** 极简二叉堆（边 id + 代价） */
class Heap {
  private a: number[] = []; private k: number[] = []
  get size() { return this.a.length }
  push(id: number, key: number) {
    const a = this.a, k = this.k; a.push(id); k.push(key)
    let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [a[p], a[i]] = [a[i], a[p]]; [k[p], k[i]] = [k[i], k[p]]; i = p }
  }
  pop(): [number, number] {
    const a = this.a, k = this.k, top: [number, number] = [a[0], k[0]]
    const la = a.pop()!, lk = k.pop()!
    if (a.length) {
      a[0] = la; k[0] = lk; let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1; let m = i
        if (l < a.length && k[l] < k[m]) m = l
        if (r < a.length && k[r] < k[m]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]; [k[m], k[i]] = [k[i], k[m]]; i = m
      }
    }
    return top
  }
}

/** 边到边最短路（状态 = 有向边，转移 = nextEdges：不掉头），返回 src 之后到 dst（含）的边序列；不可达 null */
function edgePath(g: RoadGraph, src: RoadEdge, dst: RoadEdge, banned?: ReadonlySet<number>): RoadEdge[] | null {
  const dist = new Map<number, number>([[src.id, 0]])
  const prev = new Map<number, RoadEdge>()
  const h = new Heap(); h.push(src.id, 0)
  let found = false
  while (h.size) {
    const [u, du] = h.pop()
    if (du > (dist.get(u) ?? Infinity)) continue
    if (u === dst.id && u !== src.id) { found = true; break }
    const eu = g.edges[u]
    for (const o of g.nextEdges(eu)) {
      if (banned?.has(o.id)) continue
      const nd = du + o.length
      if (nd < (dist.get(o.id) ?? Infinity)) { dist.set(o.id, nd); prev.set(o.id, eu); h.push(o.id, nd) }
    }
  }
  if (!found) return null
  const chain: RoadEdge[] = []
  let e: RoadEdge = dst
  while (e !== src) { chain.push(e); e = prev.get(e.id)! }
  return chain.reverse()
}

/** 这条边上赛车线的中心偏移（单向路 = 道路中线；双向路 = 本方向车行道中心）与可用半宽 */
function laneCenter(e: RoadEdge): { lane: number; hw: number } {
  const half = e.lanes * e.laneW / 2
  // lanePoint 偏移 = DRIVE_SIDE·(lane+0.5)·laneW → lane = -0.5 为路中线
  return e.reverse ? { lane: e.lanes / 2 - 0.5, hw: Math.max(0.6, half - 1.1) } : { lane: -0.5, hw: Math.max(0.6, half - 1.1) }
}

function chaikin(p: Raw[], loop: boolean): Raw[] {
  const out: Raw[] = []
  const n = p.length
  if (!loop) out.push(p[0])
  for (let i = 0; i < (loop ? n : n - 1); i++) {
    const a = p[i], b = p[(i + 1) % n], hw = Math.min(a.hw, b.hw)
    out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25, hw }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75, hw })
  }
  if (!loop) out.push(p[n - 1])
  return out
}

function resample(p: Raw[], loop: boolean, step: number): Raw[] {
  const src = loop ? [...p, p[0]] : p
  const out: Raw[] = [{ ...src[0] }]
  let carry = 0
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i], b = src[i + 1]
    const L = Math.hypot(b.x - a.x, b.z - a.z)
    let t = step - carry
    while (t <= L) { const u = t / L; out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, hw: u < 0.5 ? a.hw : b.hw }); t += step }
    carry = L - (t - step)
  }
  if (loop) { const f = out[0], l = out[out.length - 1]; if (Math.hypot(f.x - l.x, f.z - l.z) < step * 0.5) out.pop() }
  else { const l = src[src.length - 1], o = out[out.length - 1]; if (Math.hypot(l.x - o.x, l.z - o.z) > 0.5) out.push({ ...l }) }
  return out
}

/** 满速线弯道限速：v·κ ≤ 0.55·maxSteer·steerFactor(v)（街机物理横向几乎不打滑，限制主要来自转向角速度） */
function cornerSpeed(kappa: number, maxSteer: number) {
  if (kappa < 1e-4) return 60
  let lo = 4, hi = 60
  for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (m * kappa <= 0.55 * maxSteer * steerFactor(m)) lo = m; else hi = m }
  return lo
}

/**
 * 由途经点生成赛道：吸附 → 边链最短路 → 中心线采样 → Chaikin 平滑 → 4 m 重采样 → 曲率限速 + 反向刹车传播 → 检查点。
 * 连不通返回字符串原因。
 */
export function buildRoute(g: RoadGraph, def: RaceRouteDef): BuiltRoute | string {
  const wps = def.wps, n = wps.length
  if (n < 2) return t('途经点不足')
  const heading = (i: number): P2 => {
    const w = wps[i]
    if (w.length >= 4) return { x: w[2], z: w[3] }
    const a = wps[i > 0 ? i - 1 : def.loop ? n - 1 : i], b = wps[i < n - 1 ? i + 1 : def.loop ? 0 : i]
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1
    return { x: dx / l, z: dz / l }
  }
  const targets = wps.map((w, i) => { const h = heading(i); return g.nearestLane(w[0], w[1], h.x, h.z).edge })
  const path: RoadEdge[] = [targets[0]]
  const seq = def.loop ? [...targets.slice(1), targets[0]] : targets.slice(1)
  for (const te of seq) {
    if (path[path.length - 1] === te) continue
    const chain = edgePath(g, path[path.length - 1], te, def.world === 'sg' ? SG_BLOCKED_EDGES : undefined)
    if (!chain) return t('途经点不连通（边 {id}）', { id: te.id })
    path.push(...chain)
  }
  if (def.loop && path.length > 1 && path[path.length - 1] === path[0]) path.pop()

  // 中心线采样（每条边 5 m 一个点）
  const raw: Raw[] = []
  const tmp: P2 = { x: 0, z: 0 }
  for (const e of path) {
    const { lane, hw } = laneCenter(e)
    const cnt = Math.max(1, Math.ceil(e.length / 5))
    for (let k = 0; k <= cnt; k++) {
      g.lanePoint(e, (k / cnt) * e.length, tmp, lane)
      const last = raw[raw.length - 1]
      if (last && Math.hypot(last.x - tmp.x, last.z - tmp.z) < 1.5) { last.hw = Math.min(last.hw, hw); continue }
      raw.push({ x: tmp.x, z: tmp.z, hw })
    }
  }
  if (def.loop) { const f = raw[0], l = raw[raw.length - 1]; if (Math.hypot(f.x - l.x, f.z - l.z) < 1.5) raw.pop() }
  let sm = resample(raw, def.loop, 3)
  sm = chaikin(chaikin(sm, def.loop), def.loop)
  let pts = resample(sm, def.loop, STEP)

  // 起点 = 第一个途经点的投影；sprint 终点 = 最后一个途经点的投影
  const nearestIdx = (x: number, z: number, from = 0) => {
    let bi = from, bd = Infinity
    for (let i = from; i < pts.length; i++) { const d = Math.hypot(pts[i].x - x, pts[i].z - z); if (d < bd) { bd = d; bi = i } }
    return bi
  }
  const i0 = nearestIdx(wps[0][0], wps[0][1])
  if (def.loop) pts = [...pts.slice(i0), ...pts.slice(0, i0)]
  else {
    const last = wps[n - 1]
    // 终点在起点之后最近的那次经过
    const i1 = nearestIdx(last[0], last[1], i0 + 10)
    pts = pts.slice(i0, i1 + 1)
  }
  if (pts.length < 20) return t('路线太短')

  // 弧长与方向
  const N = pts.length
  const out: RoutePoint[] = []
  let s = 0
  for (let i = 0; i < N; i++) {
    if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
    out.push({ x: pts[i].x, z: pts[i].z, s, hw: pts[i].hw, dx: 0, dz: 0, vmax: 60 })
  }
  const length = def.loop ? s + Math.hypot(pts[0].x - pts[N - 1].x, pts[0].z - pts[N - 1].z) : s
  const at = (i: number) => out[def.loop ? ((i % N) + N) % N : Math.max(0, Math.min(N - 1, i))]
  for (let i = 0; i < N; i++) {
    const a = at(i - 1), b = at(i + 1), l = Math.hypot(b.x - a.x, b.z - a.z) || 1
    out[i].dx = (b.x - a.x) / l; out[i].dz = (b.z - a.z) / l
  }
  // 曲率：前后各 3 点（±12 m）的方向变化 / 弧长
  const maxSteer = VEHICLE_PARAMS.luxury.maxSteer
  for (let i = 0; i < N; i++) {
    const a = at(i - 3), b = at(i + 3)
    const h0 = Math.atan2(a.dx, a.dz), h1 = Math.atan2(b.dx, b.dz)
    const kappa = Math.abs(wrapAngle(h1 - h0)) / (6 * STEP)
    out[i].vmax = Math.min(50, cornerSpeed(kappa, maxSteer))
  }
  // 反向传播刹车距离：v_i ≤ sqrt(v_{i+1}² + 2·a·ds)（loop 绕两圈）
  const A_BRAKE = 13
  const passes = def.loop ? 2 * N : N
  for (let k = passes - 1; k >= 0; k--) {
    const i = k % N, j = i + 1
    if (!def.loop && j >= N) continue
    const nx = at(j)
    out[i].vmax = Math.min(out[i].vmax, Math.sqrt(nx.vmax * nx.vmax + 2 * A_BRAKE * STEP))
  }
  // 检查点
  const cps: number[] = []
  if (def.loop) {
    const m = Math.max(4, Math.round(length / CP_SPACING))
    for (let k = 1; k <= m; k++) cps.push((k / m) * length)
  } else {
    const startS = 30, span = length - startS
    const m = Math.max(3, Math.round(span / CP_SPACING))
    for (let k = 1; k <= m; k++) cps.push(startS + (k / m) * span)
  }
  return { def, pts: out, length, loop: def.loop, cps, edges: path.length }
}

/** 弧长 s（可超出一圈，loop 自动取模）处的点（线性插值） */
export function pointAt(r: BuiltRoute, s: number, out: { x: number; z: number; dx: number; dz: number; hw: number }) {
  const N = r.pts.length
  let ss = s
  if (r.loop) ss = ((s % r.length) + r.length) % r.length
  else ss = Math.max(0, Math.min(r.length, s))
  // 均匀采样：索引近似 = s / STEP，再微调
  let i = Math.min(N - 1, Math.max(0, Math.floor(ss / STEP)))
  while (i > 0 && r.pts[i].s > ss) i--
  while (i < N - 1 && r.pts[i + 1].s <= ss) i++
  const a = r.pts[i], b = r.loop ? r.pts[(i + 1) % N] : r.pts[Math.min(N - 1, i + 1)]
  const segEnd = i + 1 < N ? b.s : r.length
  const span = Math.max(1e-6, segEnd - a.s)
  const u = Math.max(0, Math.min(1, (ss - a.s) / span))
  out.x = a.x + (b.x - a.x) * u; out.z = a.z + (b.z - a.z) * u
  out.dx = a.dx; out.dz = a.dz; out.hw = Math.min(a.hw, b.hw)
  return out
}

/** 弧长 s 处的满速线限速 */
export function vmaxAt(r: BuiltRoute, s: number) {
  const N = r.pts.length
  let ss = r.loop ? ((s % r.length) + r.length) % r.length : Math.max(0, Math.min(r.length, s))
  const i = Math.min(N - 1, Math.max(0, Math.round(ss / STEP)))
  return r.pts[i].vmax
}

/**
 * 局部投影：在 [hint - back, hint + fwd] 个点的窗口里找离 (x,z) 最近的线段，返回 圈内弧长 s、横向距离 lat（右正）、点索引。
 * hint < 0 → 全局搜索。
 */
export function project(r: BuiltRoute, x: number, z: number, hint: number, back = 8, fwd = 40): { s: number; lat: number; idx: number; dist: number } {
  const N = r.pts.length
  let from: number, to: number
  if (hint < 0) { from = 0; to = r.loop ? N - 1 : N - 2 }
  else { from = hint - back; to = hint + fwd }
  let best = { s: 0, lat: 0, idx: 0, dist: Infinity }
  for (let k = from; k <= to; k++) {
    let i = k, j = k + 1
    if (r.loop) { i = ((i % N) + N) % N; j = ((j % N) + N) % N } else { if (i < 0 || j > N - 1) continue }
    const a = r.pts[i], b = r.pts[j]
    const sx = b.x - a.x, sz = b.z - a.z, L2 = sx * sx + sz * sz || 1e-6
    let u = ((x - a.x) * sx + (z - a.z) * sz) / L2
    u = u < 0 ? 0 : u > 1 ? 1 : u
    const qx = a.x + sx * u, qz = a.z + sz * u
    const d = Math.hypot(x - qx, z - qz)
    if (d < best.dist) {
      const segLen = j === 0 ? r.length - a.s : b.s - a.s
      // 右侧 = (-dz, dx)
      const L = Math.sqrt(L2), lat = ((x - qx) * (-sz / L) + (z - qz) * (sx / L))
      best = { s: a.s + segLen * u, lat, idx: i, dist: d }
    }
  }
  return best
}
