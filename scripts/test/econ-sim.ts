// 经济平衡模拟（P8.4）：node --import ./scripts/lib/ts-resolve.mjs scripts/test/econ-sim.ts（Node 22 原生跑 .ts；npm run econ:sim）
// 按身份模拟一个「典型玩家」：一直打本身份最赚钱的工，饿了吃、困了 / 夜深了回家睡；
// 一有钱就买回本最快的产业动作（新开 / 升档 / 雇经理），每隔一阵绕一圈收钱柜。
// 数值全部取自 src/data/*（产业、商店、工资、工作参数、XP 与解锁门槛），真实秒 ↔ 游戏小时用 GAME_HOUR_SEC。
// 随机事件按期望值折算（景气 / 低迷对称抵消；黑帮突袭 / 查封、被捕按频率扣），结果确定、可断言。
// 心情（P10）：mood 0–100，<30 工资 / XP ×0.85、>75 ×1.1；清醒时 3/h 衰减到 40 为止，上班 / 被捕扣、吃饭 / 睡觉 / 娱乐加（同 Needs.wireMood）。
// 娱乐消费（P10）：每游戏天睡前（一晚花费 ≤ 现金 4%）出去玩一晚，21 点后夜店 / 赌场轮流、更早只去赌场，夜店 / 赌场轮流，按期望花费与心情计。
// 断言：首个产业 ≤ 13 真实分钟；中期目标（见 MID）落在 42–78 分钟（60 ± 30%）。
import { GAME_HOUR_SEC } from '../../src/config.ts'
import { BIZ_TYPES, BIZ_RESALE, COLLECT_BONUS, type BizType } from '../../src/data/business.ts'
import { SHOP } from '../../src/data/shop.ts'
import { ECONOMY, HAWKER_MENU } from '../../src/data/menus.ts'
import { JOB_PARAMS } from '../../src/data/jobs.ts'
import { XP, xpFor, MAX_LEVEL, unlockLevel } from '../../src/data/progression.ts'
import { ROLES, type RoleId } from '../../src/data/roles.ts'
import { MOOD } from '../../src/data/mood.ts'
import { DRINKS } from '../../src/data/dates.ts'

// ---------- 典型玩家假设（真实秒） ----------
const A = {
  /** 黑帮偷车一单：找车 + 开到销赃点 + 偶尔失败（成功率 80%），车况加成均值 $70 */
  steal: { sec: 210, pay: (JOB_PARAMS.steal.reward + 70) * 0.8 },
  /** 黑帮收保护费一轮：走 3 家店 */
  protect: { sec: 240, pay: JOB_PARAMS.protect.stores * (JOB_PARAMS.protect.min + JOB_PARAMS.protect.max) / 2 },
  /** 黑帮街头破坏：90 s 撞车 + 甩掉警察，成功率 70% */
  wreck: { sec: 240, pay: JOB_PARAMS.wreck.reward * 0.7 },
  /** 黑帮每 20 真实分钟被捕 / 倒下一次：罚 10%、钱柜清零、耽误 45 s */
  bustEverySec: 20 * 60, bustLostSec: 45,
  /** 金领赶会议：开车 1.5 km 左右，含接单与偶尔迟到（85% 准时） */
  meeting: { sec: 130, pay: JOB_PARAMS.meeting.reward * (0.85 + 0.15 / 2) },
  /** 蓝领工地：面板里连点，每次 4 s（游戏跳 1 小时、精力 −12、饱食 −6） */
  siteClickSec: 4,
  /** 走路 / 开车往返家、饭店、工地、办公楼 */
  travelSec: 75,
  /** 吃饭：饱食 < 30 时去吃（含路程），按小贩中心菜单均价 */
  eatSec: 40, eatBelow: 30,
  /** 睡觉：精力 < 20，或 23:00 后（典型作息） */
  sleepEnergy: 20, bedHour: 23,
  /** 收钱：每 10 真实分钟绕一圈，每处无经理的产业 25 s */
  collectEverySec: 10 * 60, collectSecPer: 25,
  /** 产业动作回本上限（游戏天）：回本更慢的动作不做 */
  maxPaybackDays: 14,
  /** 雇经理的价值：省下的收钱损失按每日收入的 25% 计 */
  managerValue: 0.25,
  /** 留给吃饭 / 房租的现金 */
  reserve: 60,
}

// ---------- 娱乐（每晚一次，夜店 / 赌场轮流；真实秒按一晚约 1 游戏小时计） ----------
const beer = DRINKS.find((d) => d.id === 'beer')!.price, sling = DRINKS.find((d) => d.id === 'cocktail')!.price
const FUN = {
  /** 夜店 21 点开门（更早收工的晚上去 24 小时的赌场） */
  clubFrom: 21,
  /** 一晚花的真实秒（≈ 40 游戏分钟：进场、喝两杯、跳一曲 / 玩二十来局快局） */
  sec: 120,
  /** 量入为出：一晚花费不超过手头现金的这个比例才去（穷的时候不出去玩） */
  budgetShare: 0.04,
  /** 夜店：门票平日 $30 / 周末 $40（均值 ≈ $32.9）+ 啤酒 + 新加坡司令；心情 = 两杯酒 2×drink + 一曲舞（85% 准确率 → round(0.85×8)） */
  club: { cost: (30 * 5 + 40 * 2) / 7 + beer + sling, mood: 2 * MOOD.drink + Math.round(0.85 * 8), xp: 0 },
  /** 赌场：期望输额（20 局 × $20，混合玩法庄家优势约 2.7%）；心情按 45% 胜率 × 20 局，输局扣到 workFloor 为止 → 约 +8 */
  casino: { cost: 20 * 20 * 0.027, mood: Math.round(20 * (0.45 * MOOD.gambleWin + 0.55 * MOOD.gambleLose * 0.5)), xp: 20 * XP.gambleRound },
}

/** 中期目标（任一满足）：产业升到 T3 / 买下该身份对应的房产；金领产业只有一档，以第二级产业「写字楼股份」代替 T3 */
const MID: Record<RoleId, { tier3?: string; biz?: string; property: string; label: string }> = {
  gang: { tier3: 'biz_protect', property: 'home_shophouse', label: '保护费 T3 / 店屋' },
  blue: { tier3: 'biz_hawker', property: 'home_hdb', label: '档口 T3 / HDB' },
  white: { tier3: 'biz_startup', property: 'home_condo', label: '创业公司 T3 / 公寓' },
  gold: { biz: 'biz_office', property: 'home_penthouse', label: '写字楼股份 / 豪宅' },
}
const FIRST_BIZ_MAX = 13, MID_MIN = 42, MID_MAX = 78

const meal = HAWKER_MENU.reduce((a, m) => a + m.price, 0) / HAWKER_MENU.length
const mealHunger = HAWKER_MENU.reduce((a, m) => a + m.hunger, 0) / HAWKER_MENU.length

interface OwnBiz { t: BizType; tier: number; till: number; manager: boolean; invested: number }
interface Result { day60: number; job60: number; role: RoleId; firstBiz: number | null; mid: number | null; midWhat: string; nw60: number; nw180: number; level60: number; level180: number; biz180: string }

function simulate(role: RoleId): Result {
  const R = ROLES[role]
  let sec = 0
  let abs = 7.5          // 游戏绝对小时（第 1 天 07:30 开局）
  let cash = R.cash
  let hunger = 80, energy = 100
  let mood: number = MOOD.start, moodLow = 0, moodHigh = 0, moodSamples = 0, moodSum = 0
  let funNight = -1, funNights = 0, funSpent = 0, clubNights = 0
  const mul = () => mood < MOOD.low ? MOOD.lowMul : mood > MOOD.high ? MOOD.highMul : 1
  const addMood = (n: number, floor?: number) => { if (n < 0 && floor !== undefined) { if (mood <= floor) return; mood = Math.max(floor, mood + n) } else mood = Math.min(100, Math.max(0, mood + n)) }
  let level = 1, xp = 0
  const biz: OwnBiz[] = []
  const props = new Set<string>()
  let firstBiz: number | null = null, mid: number | null = null, midWhat = ''
  let nw60 = 0, nw180 = 0, level60 = 1, day60 = 0, job60 = 0, jobTotal = 0
  let lastCollect = 0, lastBust = 0
  let shiftDay = -1, otDone = 0
  let assetValue = 0

  const hour = () => abs % 24
  const day = () => Math.floor(abs / 24) + 1
  const addXp = (n: number) => {
    if (level >= MAX_LEVEL || !(n > 0)) return
    xp += n * mul()
    while (level < MAX_LEVEL && xp >= xpFor(level)) { xp -= xpFor(level); level++; if (process.env.ECON_DEBUG) console.log(`  ${role} Lv${level} @ ${(sec / 60).toFixed(1)} 分`) }
  }
  const earn = (n: number, job = true, kind: 'shift' | 'job' | 'site' = 'job') => { n *= mul(); addMood(kind === 'shift' ? MOOD.clockIn : kind === 'site' ? MOOD.siteHour : MOOD.jobDone, MOOD.workFloor); cash += n; jobTotal += n; if (job) addXp(n * XP.perJobDollar) }
  const nw = () => cash + assetValue * 0.6 + biz.reduce((a, b) => a + b.invested, 0) * BIZ_RESALE
  /** 产业每日收入期望（黑帮：查封 5% 停业、突袭 8% 损失半个钱柜 + 一天收入 → 约 ×0.85） */
  const eff = (t: BizType) => t.risk.raidPerDay > 0 ? 1 - (t.risk.inspectPerDay ?? 0) - t.risk.raidPerDay * (1 + t.risk.lossPct * 0.5) : 1

  /** 推进 dh 游戏小时（产业累积 / 经理入账 / 需求衰减） */
  const passHours = (dh: number, needs = true) => {
    if (dh <= 0) return
    abs += dh
    if (needs) { hunger = Math.max(0, hunger - 6 * R.needsRate * dh); energy = Math.max(0, energy - 4 * R.needsRate * dh); if (mood > MOOD.decayFloor) mood = Math.max(MOOD.decayFloor, mood - MOOD.decayPerHour * dh) }
    moodSamples++; moodSum += mood; if (mood < MOOD.low) moodLow++; if (mood > MOOD.high) moodHigh++
    for (const b of biz) {
      const tier = b.t.tiers[b.tier - 1]
      const rate = tier.perDay / 24 * eff(b.t)
      if (b.manager) { const pay = rate * dh * b.t.manager.cut; cash += pay; addXp(pay / XP.bizIncomeDiv) }
      else b.till = Math.min(tier.cap, b.till + rate * dh)
    }
  }
  /** 花 s 真实秒（游戏时间随之流逝） */
  const spendSec = (s: number) => {
    const before = sec
    sec += s
    passHours(s / GAME_HOUR_SEC)
    if (before < 60 * 60 && sec >= 60 * 60) { nw60 = nw(); level60 = level; day60 = abs / 24; job60 = jobTotal }
    if (before < 180 * 60 && sec >= 180 * 60) nw180 = nw()
  }
  const checkMid = () => {
    if (mid !== null) return
    const m = MID[role]
    const t3 = m.tier3 && biz.find((b) => b.t.id === m.tier3 && b.tier >= 3)
    const b2 = m.biz && biz.find((b) => b.t.id === m.biz)
    if (t3 || b2 || props.has(m.property)) { mid = sec / 60; midWhat = t3 ? 'T3' : b2 ? b2.t.name : '房产' }
  }

  // ---------- 产业决策 ----------
  type Opt = { cost: number; gain: number; apply: () => void; what?: string }
  const options = (): Opt[] => {
    const out: Opt[] = []
    for (const t of BIZ_TYPES) {
      if (!t.roles.includes(role) || level < unlockLevel(role, t.id)) continue
      if (biz.filter((b) => b.t.id === t.id).length < t.maxOwned) {
        out.push({ what: `买${t.name}`, cost: t.tiers[0].cost, gain: t.tiers[0].perDay * eff(t), apply: () => { biz.push({ t, tier: 1, till: 0, manager: false, invested: t.tiers[0].cost }); if (firstBiz === null) firstBiz = sec / 60 } })
      }
    }
    for (const b of biz) {
      const next = b.t.tiers[b.tier]
      if (next) out.push({ what: `${b.t.name}→T${b.tier + 1}`, cost: next.cost, gain: (next.perDay - b.t.tiers[b.tier - 1].perDay) * eff(b.t), apply: () => { b.tier++; b.invested += next.cost } })
      if (!b.manager) out.push({ what: `${b.t.name}雇经理`, cost: b.t.manager.cost, gain: b.t.tiers[b.tier - 1].perDay * A.managerValue, apply: () => { b.manager = true; b.invested += b.t.manager.cost; cash += b.till * COLLECT_BONUS; b.till = 0 } })
    }
    return out.filter((o) => o.cost / o.gain <= A.maxPaybackDays).sort((a, b) => a.cost / a.gain - b.cost / b.gain)
  }
  const dbg = (o: { what?: string; cost: number }) => { if (process.env.ECON_DEBUG) console.log(`  ${role} ${(sec / 60).toFixed(1)} 分 ${o.what} $${o.cost} 余 $${Math.round(cash)}`) }
  const invest = () => {
    for (let guard = 0; guard < 50; guard++) {
      // 中期目标房产：钱够就买
      const goal = SHOP.find((s) => s.id === MID[role].property)!
      if (!props.has(goal.id) && cash - A.reserve >= goal.price) { cash -= goal.price; props.add(goal.id); assetValue += goal.price; addXp(Math.min(XP.purchaseCap, goal.price / XP.purchaseDiv)); checkMid(); continue }
      const opts = options()
      if (!opts.length) return
      // 回本最快的那个买得起就买；买不起就攒钱（不去买回本更慢的）
      const best = opts[0]
      if (cash - A.reserve < best.cost) {
        // 最划算的还买不起：如果它要攒很久（> 2 天的工钱），先买得起的次优
        const alt = opts.find((o) => cash - A.reserve >= o.cost)
        if (!alt || best.cost < cash * 3) return
        cash -= alt.cost; alt.apply(); dbg(alt); addXp(Math.min(XP.purchaseCap, alt.cost / XP.purchaseDiv)); checkMid(); continue
      }
      cash -= best.cost; best.apply(); dbg(best); addXp(Math.min(XP.purchaseCap, best.cost / XP.purchaseDiv)); checkMid()
    }
  }
  const collect = () => {
    const open = biz.filter((b) => !b.manager && b.till > 0)
    if (!open.length) return
    spendSec(Math.min(90, A.collectSecPer * open.length))
    for (const b of open) { const amt = b.till * COLLECT_BONUS; b.till = 0; cash += amt; addXp(amt / XP.bizIncomeDiv) }
    lastCollect = sec
  }
  const ownHome = () => [...props].some((id) => { const s = SHOP.find((x) => x.id === id); return s?.poi?.includes(R.home) })
  const sleep = () => {
    goOut()
    spendSec(A.travelSec)
    const h = hour()
    passHours(h < 7 ? 7 - h : 24 - h + 7, false)
    energy = 100
    hunger = Math.max(0, hunger - (props.size ? 10 : 20))
    if (R.systems.rent && !ownHome()) cash -= ECONOMY.rent[role] ?? 0
    addXp(XP.slept); addMood(MOOD.slept); mood = Math.max(mood, MOOD.sleepFloor)
    otDone = 0
  }
  const eat = () => {
    spendSec(A.eatSec); passHours(20 / 60, false); cash -= meal; hunger = Math.min(100, hunger + mealHunger); addXp(XP.ate); addMood(MOOD.ate)
    // 在小贩中心吃饭：顺手收自己档口的钱柜（蓝领档口就开在那里）
    for (const b of biz) if (!b.manager && b.t.poiType === 'hawker' && b.till > 0) { const amt = b.till * COLLECT_BONUS; b.till = 0; cash += amt; addXp(amt / XP.bizIncomeDiv); break }
  }

  /** 睡前出去玩一晚（每游戏天一次；21 点前只有赌场开着，之后夜店 / 赌场轮流）：钱够当晚花费 + 预留才去 */
  const goOut = () => {
    if (funNight === day()) return
    const kind = hour() < FUN.clubFrom || funNights % 2 === 1 ? FUN.casino : FUN.club
    if (cash - kind.cost < A.reserve || kind.cost > cash * FUN.budgetShare) return
    funNight = day(); funNights++
    if (kind === FUN.club) clubNights++
    spendSec(FUN.sec); cash -= kind.cost; funSpent += kind.cost; addMood(kind.mood); addXp(kind.xp)
  }

  /** 一次工作动作（按身份选最赚钱的） */
  const work = () => {
    const h = hour()
    switch (role) {
      case 'gang': {
        const best = [A.steal, A.protect, A.wreck].sort((a, b) => b.pay / b.sec - a.pay / a.sec)[0]
        spendSec(best.sec); earn(best.pay)
        if (sec - lastBust >= A.bustEverySec) {
          lastBust = sec
          cash -= Math.ceil(Math.max(0, cash) * 0.1)
          for (const b of biz) if (b.t.roles.includes('gang')) b.till = 0
          spendSec(A.bustLostSec); addMood(MOOD.busted)
        }
        return
      }
      case 'gold': {
        if (shiftDay !== day() && h >= 9 && h < 9.5) { shiftDay = day(); passHours(18 - h); hunger -= 30; energy -= 25; earn(ECONOMY.salary.gold, true, 'shift'); addXp(XP.clockIn); return }
        // 典型玩家会掐着点上班：快到 9 点时不再接会议（一单约 0.7 游戏小时，会错过 09:00–09:30 打卡窗口），在楼下等
        if (shiftDay !== day() && h >= 9 - A.meeting.sec / GAME_HOUR_SEC && h < 9) { spendSec((9 - h) * GAME_HOUR_SEC); return }
        spendSec(A.meeting.sec); earn(A.meeting.pay); return
      }
      case 'white': {
        const sal = ECONOMY.salary.white
        if (shiftDay !== day() && h >= 9 && h < 9.5) { spendSec(10); shiftDay = day(); passHours(18 - hour()); hunger -= 30; energy -= 25; earn(sal, true, 'shift'); addXp(XP.clockIn); return }
        const O = JOB_PARAMS.overtime
        if (h >= O.from && h < O.to && otDone < 2) { spendSec(10); otDone++; passHours(O.hours, false); hunger -= 10; energy -= 15; earn(O.pay); return }
        // 没活干：等到 09:00 / 18:00（期间收钱、闲逛）
        spendSec(30); return
      }
      case 'blue': {
        if (energy >= 15) { spendSec(A.siteClickSec); passHours(1, false); hunger -= 6; energy -= 12; earn(ECONOMY.siteWage, true, 'site'); return }
        spendSec(30); return
      }
    }
  }

  let lastWhere = ''
  while (sec < 180 * 60) {
    hunger = Math.max(0, hunger); energy = Math.max(0, energy)
    if (hunger < A.eatBelow) { eat(); lastWhere = 'eat'; continue }
    const h = hour()
    if (energy < A.sleepEnergy || (h >= A.bedHour && !(role === 'white' && otDone < 2 && h < JOB_PARAMS.overtime.to))) { sleep(); lastWhere = 'home'; continue }
    if (sec - lastCollect >= A.collectEverySec) collect()
    invest()
    // 蓝领 / 白领上班要先走到工地 / 办公楼
    const workplace = role === 'blue' ? 'site' : role === 'white' ? 'office' : 'street'
    if (lastWhere !== workplace) { spendSec(A.travelSec); lastWhere = workplace; continue }
    work()
  }
  console.log(`  [mood] ${role}: 平均 ${(moodSum / moodSamples).toFixed(1)} · <30 占比 ${(moodLow / moodSamples * 100).toFixed(1)}% · >75 占比 ${(moodHigh / moodSamples * 100).toFixed(1)}% · 结束 ${mood.toFixed(0)} · 娱乐 ${funNights} 晚（夜店 ${clubNights}）共 $${Math.round(funSpent)}（均 $${funNights ? Math.round(funSpent / funNights) : 0}/晚）`)
  return { day60, job60, role, firstBiz, mid, midWhat, nw60, nw180, level60, level180: level, biz180: biz.map((b) => `${b.t.name}T${b.tier}${b.manager ? '+经理' : ''}`).join(' ') }
}

// ---------- 输出 ----------
const roles: RoleId[] = ['gang', 'blue', 'white', 'gold']
const fmtMin = (m: number | null) => (m === null ? '—' : `${m.toFixed(1)} 分`)
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
let fails = 0
console.log(`GAME_HOUR_SEC=${GAME_HOUR_SEC}（真实 1 分钟 = 游戏 ${(60 / GAME_HOUR_SEC * 60).toFixed(0)} 分钟）`)
console.log('身份  | 首个产业 | 中期目标             | 达成     | 60 分净资产 | 180 分净资产 | Lv@60/180 | 180 分产业')
for (const r of roles) {
  const x = simulate(r)
  const okFirst = x.firstBiz !== null && x.firstBiz <= FIRST_BIZ_MAX
  const okMid = x.mid !== null && x.mid >= MID_MIN && x.mid <= MID_MAX
  if (!okFirst || !okMid) fails++
  console.log(`${r.padEnd(5)} | ${fmtMin(x.firstBiz).padEnd(8)}${okFirst ? '' : '✗'} | ${MID[r].label.padEnd(14)} | ${fmtMin(x.mid).padEnd(8)}${okMid ? '' : '✗'}${x.midWhat ? `(${x.midWhat})` : ''} | ${usd(x.nw60).padEnd(10)} | ${usd(x.nw180).padEnd(11)} | ${x.level60}/${x.level180} | ${x.biz180} | 60 分：游戏 ${x.day60.toFixed(1)} 天、工钱 ${usd(x.job60)}`)
}
console.log(fails ? `econ-sim FAIL：${fails} 个身份不达标（首个产业 ≤ ${FIRST_BIZ_MAX} 分、中期目标 ${MID_MIN}–${MID_MAX} 分）` : 'econ-sim PASS')
process.exit(fails ? 1 : 0)
