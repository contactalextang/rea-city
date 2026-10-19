// catalog.json 的人工规则：材质语义（role）、部件中文名、动画别名、预设。
// 判断依据见 scripts/char/README.md。
export type Slot = 'head' | 'body' | 'legs' | 'feet' | 'hat';
export type Gender = 'm' | 'f';
export type Role = 'top' | 'bottom' | 'shoes' | 'skin' | 'hair' | 'hat' | 'accent' | 'fixed';

/** 按 slot + 材质名的通用规则；每个部件可用 ROLE_OVERRIDES 覆盖 */
export const ROLE_RULES: Record<Slot, Record<string, Role>> = {
  head: {
    Skin: 'skin',
    Skin_Darker: 'hair', // Casual2_Head 下巴/脸颊的深色块 = 胡茬，随头发色
    Eyebrows: 'hair',
    Hair: 'hair',
    Hair_Blond: 'hair', // 女 Casual 的金色长发
    Hair_Brown: 'hair', // 女包里 40 tris 的 Hair_Brown 其实是眉毛（与男包 Eyebrows 同色同位置）
    Moustache: 'hair',
    DarkBrown: 'hair', // 女 Worker 的头发
    Red: 'hair', // 男 Punk 莫霍克 / 女 Formal 的红发
    Pink: 'hair', // 女 Punk 的粉发
    Eye: 'fixed',
    Brown: 'fixed', // 女包里 24 tris 的 Brown 是眼睛（与男包 Eye 同色同位置）
    Earrings: 'accent',
    Red_Dark: 'accent', // 男 Punk 头上的小块（发带/剃边）
    Black: 'accent', // 女 Punk 的颈圈
    Worker_Yellow: 'hat', // Worker_Head 自带的安全帽
  },
  body: {
    Skin: 'skin',
    LightBrown: 'top', // Casual2 T 恤 / Beach 背心 / Worker 衬衫
    Purple: 'top', // Casual 卫衣
    Green: 'top', // Adventurer 外套
    LightGreen: 'accent', // Adventurer 内衬
    Suit: 'top', // 西装外套
    Tie: 'accent',
    White: 'accent', // 男 Suit 衬衫 / 男 Punk 内 T 恤（女包里 White 是上衣本体，见覆盖表）
    Black: 'top', // 男 Punk 皮夹克
    Worker_Vest: 'accent', // 反光背心
    Worker_Yellow: 'accent', // 反光背心的黄条
    LimeGreen: 'top', // 女 Formal 连衣裙上半
    Gold: 'accent', // 女 Formal 项链
    Pink: 'top', // 女 Punk 上衣
  },
  legs: {
    Skin: 'skin',
    LightBlue: 'bottom', // 牛仔裤 / 短裤
    Brown: 'bottom', // 工装裤 / 探险裤
    Brown_02: 'bottom', // 女 Worker 工装裤
    Brown2: 'accent', // 裤子上的护膝/口袋
    Suit: 'bottom',
    Red_Dark: 'bottom', // Beach 泳裤
    White: 'accent', // Beach 泳裤条纹
    Orange: 'bottom', // 女 Casual 长裤
    LimeGreen: 'bottom', // 女 Formal 裙摆（与上身同一材质名）
    Black: 'bottom', // 女 Punk 裤
  },
  feet: {
    Skin: 'skin',
    Red_Dark: 'shoes', // Casual2 球鞋 / Beach 凉鞋
    White: 'accent', // 鞋底/鞋带
    Purple: 'shoes', // Casual 球鞋
    Grey: 'shoes', // 靴子
    Black: 'accent', // 靴底（Suit/Punk/女 Worker 整只鞋都是 Black，见覆盖表）
    Red: 'shoes', // 女 Formal 高跟鞋
  },
  hat: {
    Hat: 'hat',
    Helmet: 'hat',
  },
};

/** 部件级覆盖：同一材质名在不同部件上语义不同 */
export const ROLE_OVERRIDES: Record<string, Record<string, Role>> = {
  m_suit_feet: { Black: 'shoes' },
  m_punk_feet: { Black: 'shoes' },
  m_punk_body: { Black: 'top', White: 'accent' },
  f_casual_body: { White: 'top' },
  f_worker_body: { White: 'top' },
  f_casual_feet: { Grey: 'shoes' },
  f_punk_feet: { Black: 'shoes', Grey: 'accent' },
  f_worker_feet: { Black: 'shoes' },
};

export const SET_LABELS: Record<string, string> = {
  adventurer: '探险',
  beach: '沙滩',
  casual: '休闲（卫衣）',
  casual2: '休闲（T 恤）',
  punk: '朋克',
  suit: '西装',
  worker: '工装',
  formal: '礼服',
  procedural: '程序生成',
};

export const PART_LABELS: Record<string, string> = {
  m_adventurer_head: '短发（探险）',
  m_adventurer_body: '探险外套',
  m_adventurer_legs: '探险长裤',
  m_adventurer_feet: '登山靴',
  m_beach_head: '短发 + 耳环',
  m_beach_body: '背心（赤膊）',
  m_beach_legs: '泳裤',
  m_beach_feet: '凉鞋',
  m_casual2_head: '短发 + 胡茬',
  m_casual2_body: 'T 恤',
  m_casual2_legs: '牛仔长裤',
  m_casual2_feet: '球鞋',
  m_casual_head: '短发（卫衣）',
  m_casual_body: '连帽卫衣',
  m_casual_legs: '牛仔短裤',
  m_casual_feet: '球鞋（卫衣）',
  m_punk_head: '莫霍克 + 耳环',
  m_punk_body: 'T 恤 + 皮夹克',
  m_punk_legs: '牛仔裤（朋克）',
  m_punk_feet: '皮靴',
  m_suit_head: '短发（西装）',
  m_suit_body: '西装 + 领带',
  m_suit_legs: '西裤',
  m_suit_feet: '皮鞋',
  m_worker_head: '安全帽 + 胡子',
  m_worker_body: '衬衫 + 反光背心',
  m_worker_legs: '工装裤',
  m_worker_feet: '工靴',
  f_casual_head: '金色长发',
  f_casual_body: '白 T 恤（女）',
  f_casual_legs: '长裤（女）',
  f_casual_feet: '平底鞋',
  f_formal_head: '红色长发',
  f_formal_body: '连衣裙上身',
  f_formal_legs: '连衣裙裙摆',
  f_formal_feet: '高跟鞋',
  f_punk_head: '粉色短发 + 颈圈',
  f_punk_body: '朋克上衣（女）',
  f_punk_legs: '紧身裤（女）',
  f_punk_feet: '皮靴（女）',
  f_worker_head: '安全帽 + 盘发',
  f_worker_body: '衬衫 + 反光背心（女）',
  f_worker_legs: '工装裤（女）',
  f_worker_feet: '工靴（女）',
  cap: '鸭舌帽',
  helmet: '安全帽',
};

/** 规范化动画名 → glb 里的原始 clip 名 */
export const CLIP_ALIASES: Record<string, string> = {
  Idle: 'Idle',
  IdleNeutral: 'Idle_Neutral',
  Walk: 'Walk',
  Run: 'Run',
  RunBack: 'Run_Back',
  RunLeft: 'Run_Left',
  RunRight: 'Run_Right',
  Aim: 'Idle_Gun_Pointing',
  AimIdle: 'Idle_Gun',
  Shoot: 'Gun_Shoot',
  AimShoot: 'Idle_Gun_Shoot',
  RunShoot: 'Run_Shoot',
  Death: 'Death',
  Hit: 'HitRecieve',
  Hit2: 'HitRecieve_2',
  Punch: 'Punch_Right',
  PunchLeft: 'Punch_Left',
  Kick: 'Kick_Right',
  KickLeft: 'Kick_Left',
  Roll: 'Roll',
  Wave: 'Wave',
  Interact: 'Interact',
  IdleSword: 'Idle_Sword',
  SwordSlash: 'Sword_Slash',
};

export const ATTRIBUTION = {
  author: 'Quaternius',
  packs: ['Ultimate Modular Men', 'Ultimate Modular Women'],
  url: 'https://quaternius.com/packs/ultimatemodularcharacters.html',
  license: 'CC0 1.0 Universal (Public Domain Dedication)',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  note: '帽子 part:hat:cap 为本项目程序生成；part:hat:helmet 取自 Worker_Head 的安全帽部分。',
};

export interface Preset {
  id: string;
  label: string;
  body: Gender;
  parts: Partial<Record<Slot, string | null>>;
  colors: Partial<Record<Role, string>>;
  note?: string;
}

const SKIN_LIGHT = '#f1c7a3';
const SKIN_TAN = '#d9a56f';
const SKIN_BROWN = '#a86b3c';
const SKIN_DARK = '#6b3f23';

export const PRESETS: Preset[] = [
  // ---- 四个身份默认 ----
  {
    id: 'default_gang',
    label: '黑帮成员',
    body: 'm',
    parts: { head: 'm_casual2_head', body: 'm_casual2_body', legs: 'm_casual_legs', feet: 'm_casual2_feet', hat: 'cap' },
    colors: { top: '#f2f2f2', bottom: '#2f3b5c', hat: '#c0392b', skin: SKIN_LIGHT, hair: '#2b1b10', shoes: '#333333', accent: '#e6e6e6' },
  },
  {
    id: 'default_gold',
    label: '金色西装',
    body: 'm',
    parts: { head: 'm_suit_head', body: 'm_suit_body', legs: 'm_suit_legs', feet: 'm_suit_feet', hat: null },
    colors: { top: '#c9a227', bottom: '#b8922a', accent: '#fff6d6', shoes: '#2a1a0a', skin: SKIN_TAN, hair: '#1a1a1a' },
  },
  {
    id: 'default_white',
    label: '白衬衫商务',
    body: 'm',
    parts: { head: 'm_suit_head', body: 'm_punk_body', legs: 'm_suit_legs', feet: 'm_suit_feet', hat: null },
    colors: { top: '#f7f7f7', accent: '#f0f0f0', bottom: '#3a3f4b', shoes: '#1c1c1c', skin: SKIN_LIGHT, hair: '#3b2a1a' },
    note: 'm_punk_body 的皮夹克（top）与内衫（accent）都调成白色，近似白衬衫。',
  },
  {
    id: 'default_blue',
    label: '蓝色工装',
    body: 'm',
    parts: { head: 'm_casual_head', body: 'm_worker_body', legs: 'm_worker_legs', feet: 'm_worker_feet', hat: 'helmet' },
    colors: { top: '#2b6cb0', accent: '#f39c12', bottom: '#1f3f66', shoes: '#3a3a3a', hat: '#f5c400', skin: SKIN_TAN, hair: '#1a1a1a' },
  },
  // ---- 行人 ----
  {
    id: 'ped_office_m',
    label: '上班族（男）',
    body: 'm',
    parts: { head: 'm_suit_head', body: 'm_suit_body', legs: 'm_suit_legs', feet: 'm_suit_feet', hat: null },
    colors: { top: '#1f2a44', bottom: '#1f2a44', accent: '#e9eef5', shoes: '#1a1a1a', skin: SKIN_LIGHT, hair: '#101010' },
  },
  {
    id: 'ped_office_f',
    label: '上班族（女）',
    body: 'f',
    parts: { head: 'f_casual_head', body: 'f_formal_body', legs: 'f_formal_legs', feet: 'f_formal_feet', hat: null },
    colors: { top: '#2c3e63', bottom: '#2c3e63', accent: '#d4af37', shoes: '#1a1a1a', skin: SKIN_LIGHT, hair: '#1b1b1b' },
    note: 'Formal 连衣裙上下身共用材质 LimeGreen，top/bottom 应设同色。',
  },
  {
    id: 'ped_hawker_uncle',
    label: '小贩叔叔',
    body: 'm',
    parts: { head: 'm_casual2_head', body: 'm_casual2_body', legs: 'm_casual_legs', feet: 'm_beach_feet', hat: null },
    colors: { top: '#bfc5c9', bottom: '#4a4a4a', shoes: '#3b2a1a', skin: SKIN_TAN, hair: '#8c8c8c', accent: '#ffffff' },
  },
  {
    id: 'ped_student',
    label: '校服学生',
    body: 'f',
    parts: { head: 'f_casual_head', body: 'f_casual_body', legs: 'f_formal_legs', feet: 'f_casual_feet', hat: null },
    colors: { top: '#ffffff', bottom: '#1e3a5f', shoes: '#ffffff', skin: SKIN_LIGHT, hair: '#1a1a1a' },
    note: '白 T 恤 + 深蓝裙摆近似校服。',
  },
  {
    id: 'ped_worker',
    label: '建筑工',
    body: 'm',
    parts: { head: 'm_worker_head', body: 'm_worker_body', legs: 'm_worker_legs', feet: 'm_worker_feet', hat: null },
    colors: { top: '#6b7a8f', accent: '#ff8c00', bottom: '#4b4b4b', shoes: '#2e2e2e', hat: '#f5c400', skin: SKIN_BROWN, hair: '#1a1a1a' },
    note: 'm_worker_head 自带安全帽（材质 Worker_Yellow，role=hat），不再叠 hat 部件。',
  },
  {
    id: 'ped_auntie',
    label: '安娣',
    body: 'f',
    parts: { head: 'f_casual_head', body: 'f_casual_body', legs: 'f_casual_legs', feet: 'f_casual_feet', hat: null },
    colors: { top: '#d96c9b', bottom: '#6b4a3a', shoes: '#3a3a3a', skin: SKIN_TAN, hair: '#4a4a4a' },
  },
  {
    id: 'ped_rider',
    label: '外卖骑手',
    body: 'm',
    parts: { head: 'm_casual_head', body: 'm_casual_body', legs: 'm_casual2_legs', feet: 'm_worker_feet', hat: 'helmet' },
    colors: { top: '#00b14f', bottom: '#2b2b2b', shoes: '#1a1a1a', hat: '#00b14f', skin: SKIN_TAN, hair: '#1a1a1a', accent: '#1a1a1a' },
    note: '包里没有外卖箱/背包部件（Adventurer 的 Backpack 未打包），用绿色卫衣 + 绿色安全帽近似。',
  },
  {
    id: 'ped_malay_f',
    label: '马来头巾（近似）',
    body: 'f',
    parts: { head: 'f_formal_head', body: 'f_worker_body', legs: 'f_casual_legs', feet: 'f_casual_feet', hat: null },
    colors: { hair: '#7b4fa0', top: '#8e6bbf', bottom: '#4a3a6b', accent: '#8e6bbf', shoes: '#2a2a2a', skin: SKIN_TAN },
    note: '包里没有头巾部件：用 f_formal_head 的长发整体染成头巾色近似 tudung，长袖衬衫 + 长裤。',
  },
  {
    id: 'ped_tourist',
    label: '游客（沙滩装）',
    body: 'm',
    parts: { head: 'm_beach_head', body: 'm_beach_body', legs: 'm_beach_legs', feet: 'm_beach_feet', hat: 'cap' },
    colors: { top: '#f4d35e', bottom: '#e76f51', accent: '#ffffff', shoes: '#8d5524', hat: '#f8f8f8', skin: SKIN_LIGHT, hair: '#c9a66b' },
  },
  {
    id: 'ped_punk_f',
    label: '朋克少女',
    body: 'f',
    parts: { head: 'f_punk_head', body: 'f_punk_body', legs: 'f_punk_legs', feet: 'f_punk_feet', hat: null },
    colors: { hair: '#ff3fa4', top: '#2a2a2a', accent: '#8a2be2', bottom: '#1a1a1a', shoes: '#1a1a1a', skin: SKIN_DARK },
  },
];
