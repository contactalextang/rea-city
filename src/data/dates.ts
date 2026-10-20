import type { PoiType } from '../systems/Poi'

/**
 * P10.E 恋爱关系数据：8 位可约会 NPC、对话题库、礼物 / 酒水目录、约会地点。
 * 内容保持 PG-13：调情、约会、牵手 / 拥抱级别。玩家可自由选择对象，不限性别。
 * 逻辑在 activities/club/Relations.ts。
 */

/** 对话选项语气：NPC 的 tones 表给每种语气打分（−4..+4） */
export type Tone = 'funny' | 'flirt' | 'sincere' | 'smart' | 'bold' | 'humble'
/** 话题标签：NPC 的 loves / hates 命中时额外加减分 */
export type Topic = 'work' | 'money' | 'party' | 'family' | 'gossip' | 'gambling' | 'music' | 'food' | 'art' | 'travel' | 'sports' | 'fashion' | 'books' | 'cars'

export type Stage = 'stranger' | 'contact' | 'dating' | 'lover'
export const STAGE_LABEL: Record<Stage, string> = { stranger: '陌生', contact: '认识', dating: '约会中', lover: '恋人' }

/** NPC 出现的地点：POI 类型（可限定 id 候选）+ 时段 [开, 关)（跨午夜允许 关 < 开）；weekend = 只在周五 / 周六晚 */
export interface Spot { type: PoiType; ids?: string[]; hours: [number, number]; chance?: number; weekend?: boolean }

export interface NpcLook {
  /** 部件 id（catalog parts，性别前缀须与 NpcDef.gender 一致：m_* / f_*；hat 为 'cap' / 'helmet' / null） */
  head: string; body: string; legs: string; feet: string; hat: string | null
  skin: string; hair: string; top: string; bottom: string; shoes: string
  /** 帽子颜色（hat 非空时） */
  hatColor?: string
  /** 点缀色（西装领带 / 衬衫、工装反光条、裙子金饰） */
  accent?: string
}

export interface NpcDef {
  id: string
  name: string
  /** 英文 / 本名 */
  alias: string
  age: number
  gender: 'f' | 'm'
  /** 族裔 / 背景（展示用） */
  origin: string
  job: string
  /** 性格一句话 */
  persona: string
  /** 陌生时面板上的外貌描述 */
  blurb: string
  /** 头像主题色 */
  theme: string
  look: NpcLook
  tones: Partial<Record<Tone, number>>
  loves: Topic[]
  hates: Topic[]
  drink: string
  gifts: { love: string[]; hate: string[] }
  places: string[]
  spots: Spot[]
  /** 高端：VIP 卡座更容易遇见 */
  vip?: boolean
  /** 舞池常客：舞跳得好时优先被吸引过来 */
  dancer?: boolean
  /** 生日：每 30 天循环中的第几天（day % 30） */
  bday: number
  intro: string
  greet: string[]
  react: { good: string[]; ok: string[]; bad: string[] }
  sms: string[]
  /** 专属话题（会和通用题库混抽） */
  prompts: Prompt[]
}

export interface PromptOption { text: string; tone: Tone; topic?: Topic }
export interface Prompt { line: string; options: PromptOption[] }

// ---------------------------------------------------------------- 酒水 / 礼物

export interface DrinkDef { id: string; name: string; price: number; units: number; desc: string; vipOnly?: boolean }
export const DRINKS: DrinkDef[] = [
  { id: 'beer', name: 'Tiger 啤酒', price: 14, units: 1, desc: '冰镇一扎' },
  { id: 'cocktail', name: 'Singapore Sling', price: 24, units: 1.5, desc: '本地经典鸡尾酒' },
  { id: 'whisky', name: '单一麦芽威士忌', price: 32, units: 2, desc: '加一块冰' },
  { id: 'mocktail', name: '无酒精特调', price: 12, units: 0, desc: '青柠薄荷苏打' },
  { id: 'champagne', name: '香槟塔', price: 480, units: 3, desc: '全场欢呼，VIP 卡座专享', vipOnly: true },
]
export const drinkById = (id: string) => DRINKS.find((d) => d.id === id) ?? null

export interface GiftDef { id: string; name: string; price: number; value: number; desc: string }
/** value = 基础好感加成（喜欢 ×2，讨厌 ×0.3 且扣分） */
export const GIFTS: GiftDef[] = [
  { id: 'chocolate', name: '手工巧克力', price: 28, value: 3, desc: 'Ion 楼下的比利时巧克力' },
  { id: 'plush', name: '鱼尾狮公仔', price: 35, value: 3, desc: '软乎乎的纪念品' },
  { id: 'book', name: '签名小说', price: 45, value: 4, desc: '本地作家新书' },
  { id: 'flowers', name: '一束花', price: 68, value: 5, desc: '胡姬花 + 玫瑰' },
  { id: 'perfume', name: '香水', price: 180, value: 8, desc: '小众沙龙香' },
  { id: 'concert', name: '演唱会门票', price: 320, value: 10, desc: '室内体育馆两张连座' },
  { id: 'bag', name: '名牌包', price: 2600, value: 18, desc: '乌节路旗舰店' },
  { id: 'watch', name: '名表', price: 5800, value: 22, desc: '经典三针款' },
]
export const giftById = (id: string) => GIFTS.find((g) => g.id === id) ?? null
/** 联系人页“快递送礼”的运费 */
export const DELIVERY_FEE = 15

// ---------------------------------------------------------------- 约会地点

export interface DatePlaceDef {
  id: string
  name: string
  /** POI 候选 id（按顺序取世界里第一个存在的），都不存在时取 fallbackType 的第一个 */
  pois: string[]
  fallbackType: PoiType
  /** 可约时段 [开, 关)（跨午夜允许） */
  hours: [number, number]
  /** 约会第一步：三档活动（花费 / 好感） */
  acts: { label: string; cost: number; aff: number; line: string }[]
}
export const DATE_PLACES: DatePlaceDef[] = [
  { id: 'hawker', name: '小贩中心宵夜', pois: ['hawker_makansutra_gluttons_bay', 'hawker_lau_pa_sat', 'hawker_maxwell'], fallbackType: 'hawker', hours: [11, 24],
    acts: [
      { label: '两碗鸡饭 + 两杯甘蔗水', cost: 14, aff: 3, line: '简单的才最好吃。' },
      { label: '沙爹 + 炒粿条 + 蚝煎', cost: 38, aff: 5, line: '哇，一桌子！你很会点。' },
      { label: '辣椒螃蟹大餐', cost: 120, aff: 7, line: '手都辣红了，太过瘾了！' },
    ] },
  { id: 'flyer', name: '新加坡摩天轮', pois: ['landmark_singapore_flyer', 'landmark_merlion'], fallbackType: 'landmark', hours: [10, 23],
    acts: [
      { label: '普通座舱 × 2', cost: 80, aff: 5, line: '整个滨海湾都在脚下。' },
      { label: '座舱 + 鸡尾酒套票', cost: 180, aff: 7, line: '一边喝一边看夜景，太会安排了。' },
      { label: '包下一整个座舱', cost: 650, aff: 10, line: '只有我们两个……有点不好意思。' },
    ] },
  { id: 'gardens', name: '滨海湾花园', pois: ['landmark_gardens_by_the_bay', 'landmark_merlion'], fallbackType: 'landmark', hours: [8, 24],
    acts: [
      { label: '超级树下看灯光秀', cost: 0, aff: 4, line: '躺在地上看灯，好浪漫。' },
      { label: '云雾林 + 花穹门票', cost: 64, aff: 6, line: '里面好凉快，像去了另一个世界。' },
      { label: '空中步道 + 树顶餐厅', cost: 260, aff: 8, line: '在树顶吃晚餐，这辈子第一次。' },
    ] },
  { id: 'club', name: '克拉码头夜店', pois: ['club_clarke_quay'], fallbackType: 'club', hours: [21, 4],
    acts: [
      { label: '吧台两杯啤酒', cost: 28, aff: 3, line: '干杯！' },
      { label: '舞池旁的高脚桌 + 鸡尾酒', cost: 90, aff: 5, line: '这首歌我超爱！' },
      { label: 'VIP 卡座 + 香槟', cost: 600, aff: 8, line: '今晚我们是全场焦点。' },
    ] },
  { id: 'casino', name: '金沙赌场', pois: ['casino_mbs'], fallbackType: 'casino', hours: [0, 24],
    acts: [
      { label: '老虎机小玩几把', cost: 40, aff: 3, line: '叮叮叮——又没中，哈哈。' },
      { label: '轮盘一起押红色', cost: 150, aff: 5, line: '红色！真的是红色！' },
      { label: '高额厅观战 + 晚餐', cost: 500, aff: 7, line: '原来有钱人是这样玩的。' },
    ] },
]
export const datePlaceById = (id: string) => DATE_PLACES.find((p) => p.id === id) ?? null

// ---------------------------------------------------------------- 通用对话题库

export const PROMPTS: Prompt[] = [
  { line: '今晚一个人来的？', options: [
    { text: '本来是，现在好像不是了。', tone: 'flirt' },
    { text: '朋友放我鸽子，只好自己出来透透气。', tone: 'sincere' },
    { text: '我一个人就是一支队伍。', tone: 'funny' },
  ] },
  { line: '你平时都做什么的？', options: [
    { text: '说出来怕吓到你——我很会赚钱。', tone: 'bold', topic: 'money' },
    { text: '普通上班族，每天在 MRT 上思考人生。', tone: 'humble', topic: 'work' },
    { text: '白天打工，晚上研究哪家小贩中心最好吃。', tone: 'funny', topic: 'food' },
  ] },
  { line: '最近有什么开心的事吗？', options: [
    { text: '现在就挺开心的。', tone: 'flirt' },
    { text: '刚看完一本很好的书，还在回味。', tone: 'smart', topic: 'books' },
    { text: '昨晚在赌场赢了一把大的。', tone: 'bold', topic: 'gambling' },
  ] },
  { line: '你觉得新加坡最棒的是什么？', options: [
    { text: '凌晨两点还能吃到肉骨茶。', tone: 'funny', topic: 'food' },
    { text: '什么人都能在这里找到自己的位置。', tone: 'sincere' },
    { text: '滨海湾的夜景，配上合适的人。', tone: 'flirt' },
  ] },
  { line: '周末一般怎么过？', options: [
    { text: '东海岸骑车，然后吃一顿海鲜。', tone: 'sincere', topic: 'sports' },
    { text: '去看展，最近国家美术馆有新展。', tone: 'smart', topic: 'art' },
    { text: '派对！哪里热闹去哪里。', tone: 'bold', topic: 'party' },
  ] },
  { line: '你听说了吗？那边那桌在吵架。', options: [
    { text: '快说快说，发生什么了？', tone: 'bold', topic: 'gossip' },
    { text: '别人的事，我更想听听你的。', tone: 'flirt' },
    { text: '希望他们没事吧。', tone: 'humble' },
  ] },
  { line: '如果可以马上出发去旅行，你想去哪？', options: [
    { text: '北海道，冬天泡温泉看雪。', tone: 'sincere', topic: 'travel' },
    { text: '摩纳哥，开着跑车去赌场。', tone: 'bold', topic: 'cars' },
    { text: '哪里都行，只要有人陪。', tone: 'flirt', topic: 'travel' },
  ] },
  { line: '你家人也在新加坡吗？', options: [
    { text: '在啊，每周日都要回去吃饭。', tone: 'sincere', topic: 'family' },
    { text: '我妈每天问我什么时候结婚。', tone: 'funny', topic: 'family' },
    { text: '我比较独立，自己过得挺好。', tone: 'humble' },
  ] },
  { line: '你喜欢什么音乐？', options: [
    { text: '这首就不错，节奏很带劲。', tone: 'bold', topic: 'music' },
    { text: '爵士，安静的晚上一个人听。', tone: 'smart', topic: 'music' },
    { text: '我唱 K 能把麦克风唱哭。', tone: 'funny', topic: 'music' },
  ] },
  { line: '你看起来有点紧张？', options: [
    { text: '被你看出来了，你太好看了。', tone: 'flirt' },
    { text: '其实我不太擅长和陌生人聊天。', tone: 'humble' },
    { text: '紧张？我是在酝酿一个笑话。', tone: 'funny' },
  ] },
  { line: '工作累吗？', options: [
    { text: '累，但我喜欢把事情做好。', tone: 'sincere', topic: 'work' },
    { text: '累死了，今晚不想谈工作。', tone: 'funny' },
    { text: '我在想怎么让钱替我工作。', tone: 'smart', topic: 'money' },
  ] },
  { line: '你觉得我今天这身怎么样？', options: [
    { text: '颜色很衬你，很有品味。', tone: 'smart', topic: 'fashion' },
    { text: '好看，不过人更好看。', tone: 'flirt', topic: 'fashion' },
    { text: '说实话我不太懂穿搭……但我觉得很舒服。', tone: 'humble' },
  ] },
  { line: '你相信一见钟情吗？', options: [
    { text: '以前不信，今晚开始考虑。', tone: 'flirt' },
    { text: '我更相信慢慢了解一个人。', tone: 'sincere' },
    { text: '我相信一见钟情，二见更钟情。', tone: 'funny' },
  ] },
  { line: '要是中了一千万，你会做什么？', options: [
    { text: '买一辆超跑，再买一辆。', tone: 'bold', topic: 'cars' },
    { text: '给爸妈换个大房子。', tone: 'sincere', topic: 'family' },
    { text: '先请你吃一年的鸡饭。', tone: 'funny', topic: 'food' },
  ] },
]

/** 短信回复的小对话（联系人页“发消息”） */
export const TEXT_PROMPTS: Prompt[] = [
  { line: '在干嘛呢？', options: [
    { text: '在想你啊。', tone: 'flirt' },
    { text: '刚下班，在吃宵夜。', tone: 'sincere', topic: 'food' },
    { text: '在研究怎么让猫喜欢我（失败中）。', tone: 'funny' },
  ] },
  { line: '今天好累……', options: [
    { text: '辛苦了，早点休息，明天请你喝咖啡。', tone: 'sincere' },
    { text: '要不要我讲个冷笑话给你提提神？', tone: 'funny' },
    { text: '累就对了，说明你在进步。', tone: 'smart', topic: 'work' },
  ] },
  { line: '你周末有空吗？', options: [
    { text: '对你一直有空。', tone: 'flirt' },
    { text: '有啊，想去哪我陪你。', tone: 'sincere' },
    { text: '看情况，我很忙的（其实不忙）。', tone: 'funny' },
  ] },
  { line: '刚看到一只超胖的鸽子，想起你了。', options: [
    { text: '……我该开心还是伤心？', tone: 'funny' },
    { text: '那说明你一直在想我。', tone: 'flirt' },
    { text: '拍照了吗？我也想看。', tone: 'humble' },
  ] },
]

// ---------------------------------------------------------------- 8 位 NPC

const NIGHT: [number, number] = [21, 4]

export const NPCS: NpcDef[] = [
  {
    id: 'jasmine', name: '林佳慧', alias: 'Jasmine Lim', age: 26, gender: 'f', origin: '华人', job: '广告公司创意策划',
    persona: '外向爱玩、点子多，讨厌下班后谈工作', blurb: '吧台边笑得很大声的红裙女生', theme: '#e8456b',
    look: { head: 'f_casual_head', body: 'f_formal_body', legs: 'f_formal_legs', feet: 'f_formal_feet', hat: null, skin: '#f1c7a3', hair: '#2b1b10', top: '#e74c3c', bottom: '#e74c3c', shoes: '#1a1a1a', accent: '#f2c14e' },
    tones: { funny: 4, flirt: 3, bold: 1, sincere: 0, smart: -1, humble: -2 }, loves: ['party', 'music', 'fashion'], hates: ['work', 'money'],
    drink: 'cocktail', gifts: { love: ['flowers', 'perfume', 'concert'], hate: ['book'] }, places: ['club', 'gardens'],
    spots: [{ type: 'club', hours: [21, 2], chance: 0.8 }, { type: 'shop', ids: ['shop_raffles_city_shopping_centre', 'shop_marina_square', 'shop_fairprice'], hours: [14, 19], chance: 0.5 }],
    dancer: true, bday: 7,
    intro: '嘿！你也是来逃离 deadline 的吗？',
    greet: ['又见面啦！', '你来得正好，我刚好无聊。', '嗨～今晚很精神嘛。'],
    react: { good: ['哈哈哈你太好笑了！', '我喜欢你这种说话方式。', '好，你过关了 😄'], ok: ['嗯哼～', '还行吧，继续。', '哈，有点意思。'], bad: ['呃……我们换个话题？', '好扫兴哦。', '你是在开会吗？'] },
    sms: ['今晚出来吗？我想去跳舞！', '刚看到一家超可爱的咖啡店，下次一起去～', '老板又改需求了 😭 快说点好笑的', '周末天气好好，想去滨海湾花园！'],
    prompts: [
      { line: '我刚做完一个广告方案，你猜主题是什么？', options: [
        { text: '“爱在鱼尾狮下”？', tone: 'funny' },
        { text: '先别管方案了，今晚放松一下。', tone: 'sincere' },
        { text: '投放预算多少？ROI 怎么算？', tone: 'smart', topic: 'work' },
      ] },
    ],
  },
  {
    id: 'arjun', name: '阿俊', alias: 'Arjun Nair', age: 31, gender: 'm', origin: '印度裔', job: '中央医院心脏科医生',
    persona: '温和真诚、爱读书，最反感炫富', blurb: '安静坐在角落、只喝苏打水的斯文男士', theme: '#3a7bd5',
    look: { head: 'm_casual_head', body: 'm_casual_body', legs: 'm_suit_legs', feet: 'm_suit_feet', hat: null, skin: '#b8794a', hair: '#101010', top: '#ecf0f1', bottom: '#1f2a44', shoes: '#3b2a1a' },
    tones: { sincere: 4, smart: 3, humble: 2, funny: 1, flirt: -1, bold: -3 }, loves: ['books', 'family', 'food'], hates: ['money', 'gambling', 'cars'],
    drink: 'mocktail', gifts: { love: ['book', 'chocolate'], hate: ['watch', 'bag'] }, places: ['hawker', 'gardens'],
    spots: [{ type: 'club', hours: [22, 1], chance: 0.45, weekend: true }, { type: 'hawker', ids: ['hawker_lau_pa_sat', 'hawker_maxwell_food_centre_kim_hua_market', 'hawker_maxwell'], hours: [12, 14], chance: 0.8 }],
    bday: 13,
    intro: '你好。抱歉，我刚下夜班，可能有点呆。',
    greet: ['你好，又见面了。', '今天的病人都平安，所以我心情不错。', '嗨，最近好吗？'],
    react: { good: ['你说得真好。', '和你聊天很舒服。', '我很少遇到想法这么相近的人。'], ok: ['嗯，有道理。', '也是。', '哈哈，可以。'], bad: ['……这个我不太认同。', '我不太喜欢这种话题。', '我们好像不太合拍。'] },
    sms: ['今天做了三台手术，累但值得。你吃饭了吗？', '推荐你一本书，我觉得你会喜欢。', '下班了，想吃 Maxwell 的鸡饭，一起吗？', '记得多喝水，医生的叮嘱 :)'],
    prompts: [
      { line: '当医生最难的不是手术，是告诉家属坏消息。', options: [
        { text: '那一定很不容易，你很了不起。', tone: 'sincere', topic: 'work' },
        { text: '你们医生收入那么高，也算有补偿吧。', tone: 'bold', topic: 'money' },
        { text: '所以你才来这里放空一下？', tone: 'humble' },
      ] },
    ],
  },
  {
    id: 'nurul', name: '努鲁', alias: 'Nurul Aisyah', age: 24, gender: 'f', origin: '马来裔', job: '自由插画师',
    persona: '害羞文艺、不喝酒，喜欢真诚和安静', blurb: '在本子上画画的戴头巾女生', theme: '#2ec4a6',
    look: { head: 'f_formal_head', body: 'f_casual_body', legs: 'f_casual_legs', feet: 'f_casual_feet', hat: null, skin: '#d9a56f', hair: '#ecf0f1', top: '#1abc9c', bottom: '#ecf0f1', shoes: '#ffffff' },
    tones: { sincere: 4, humble: 3, smart: 2, funny: 1, flirt: -2, bold: -3 }, loves: ['art', 'books', 'food', 'travel'], hates: ['party', 'gossip', 'gambling'],
    drink: 'mocktail', gifts: { love: ['plush', 'book', 'chocolate'], hate: ['bag'] }, places: ['gardens', 'hawker', 'flyer'],
    spots: [{ type: 'hawker', ids: ['hawker_makansutra_gluttons_bay', 'hawker_maxwell', 'hawker_maxwell_food_centre_kim_hua_market'], hours: [18, 22], chance: 0.75 }, { type: 'shop', ids: ['shop_marina_square', 'shop_funan', 'shop_fairprice'], hours: [13, 18], chance: 0.6 }],
    bday: 21,
    intro: '啊……你好。我在画对面的店屋，你挡住光了一点点。',
    greet: ['你来啦。', '我今天画了一张新的，等下给你看。', '嗨……今天还好吗？'],
    react: { good: ['（她笑着低下头）谢谢你。', '你真的很懂我。', '我可以把这句话画下来吗？'], ok: ['嗯。', '这样啊。', '（她点点头）'], bad: ['我……不太习惯这样。', '可以小声一点吗？', '（她看起来有点不自在）'] },
    sms: ['今天画了 Gardens 的超级树，送你一张 :)', '下雨天最适合画画了。', 'Gluttons Bay 的沙爹今晚好香，你要来吗？', '你上次说的那本书我开始看了！'],
    prompts: [
      { line: '你觉得画画需要天分吗？', options: [
        { text: '需要热爱，你明显有。', tone: 'sincere', topic: 'art' },
        { text: '画画能赚钱吗？', tone: 'bold', topic: 'money' },
        { text: '我画火柴人都会画歪，所以我很佩服你。', tone: 'humble', topic: 'art' },
      ] },
    ],
  },
  {
    id: 'marcus', name: '陈俊杰', alias: 'Marcus Tan', age: 41, gender: 'm', origin: '华人', job: '对冲基金合伙人',
    persona: '自信强势、讲究排场，不耐烦婆婆妈妈', blurb: 'VIP 卡座里开香槟的西装大叔', theme: '#c9a227',
    look: { head: 'm_suit_head', body: 'm_suit_body', legs: 'm_suit_legs', feet: 'm_suit_feet', hat: null, skin: '#f1c7a3', hair: '#4a3222', top: '#1f2a44', bottom: '#1f2a44', shoes: '#1a1a1a', accent: '#e8e8e8' },
    tones: { bold: 4, smart: 3, flirt: 1, funny: 0, sincere: -1, humble: -3 }, loves: ['money', 'cars', 'travel', 'gambling'], hates: ['family', 'gossip'],
    drink: 'champagne', gifts: { love: ['watch', 'concert'], hate: ['plush', 'chocolate'] }, places: ['casino', 'club', 'flyer'],
    spots: [{ type: 'club', hours: [22, 3], chance: 0.55 }, { type: 'casino', hours: [20, 4], chance: 0.7 }],
    vip: true, bday: 2,
    intro: '这桌是我的。不过，你可以坐下。',
    greet: ['准时，我欣赏。', '今晚我请。', '又是你，有意思。'],
    react: { good: ['哈！我喜欢有野心的人。', '你比看起来有趣。', '不错，继续。'], ok: ['嗯。', '还行。', '然后呢？'], bad: ['我对这个没兴趣。', '浪费时间。', '你可以说点有价值的吗？'] },
    sms: ['今晚金沙，有局，来不来？', '刚平仓赚了一笔，想庆祝一下。', '我的游艇周末出海，留个位置给你。', '别让我等太久。'],
    prompts: [
      { line: '我今天亏了七位数，你猜我为什么还在笑？', options: [
        { text: '因为你明天会赚回来十倍。', tone: 'bold', topic: 'money' },
        { text: '因为钱不是最重要的？', tone: 'sincere' },
        { text: '因为香槟已经开了，不喝浪费。', tone: 'funny' },
      ] },
    ],
  },
  {
    id: 'sophie', name: '苏菲', alias: 'Sophie Laurent', age: 29, gender: 'f', origin: '法国外籍', job: '金沙酒店侍酒师',
    persona: '机智毒舌、懂酒懂吃，讨厌吹牛', blurb: '举着香槟杯打量全场的金发女士', theme: '#9b59b6',
    look: { head: 'f_casual_head', body: 'f_formal_body', legs: 'f_formal_legs', feet: 'f_formal_feet', hat: null, skin: '#f5d6b8', hair: '#c9a66b', top: '#9b59b6', bottom: '#9b59b6', shoes: '#2e2e2e' },
    tones: { smart: 4, funny: 3, flirt: 2, sincere: 1, humble: 0, bold: -3 }, loves: ['food', 'travel', 'art', 'fashion'], hates: ['money', 'cars'],
    drink: 'champagne', gifts: { love: ['perfume', 'flowers', 'book'], hate: ['plush'] }, places: ['flyer', 'casino', 'hawker'],
    spots: [{ type: 'casino', hours: [21, 2], chance: 0.65 }, { type: 'club', hours: [23, 4], chance: 0.5 }],
    vip: true, bday: 16,
    intro: 'Bonsoir. 你点的这杯酒……嗯，勇气可嘉。',
    greet: ['Salut！', '今天想喝点什么？我推荐。', '你又来考验我的耐心了？（笑）'],
    react: { good: ['Ha! Très bien.', '你有点意思，我喜欢。', '这句话值一杯好酒。'], ok: ['Bof, 还行。', '嗯哼。', '继续，我在听。'], bad: ['哦拜托。', '典型的新加坡 banker 台词。', '这太无聊了，mon ami。'] },
    sms: ['今晚有一支勃艮第，你一定要尝尝。', '我发现新加坡最好吃的不是米其林，是小贩中心。', '下班了，滨海湾的风好舒服。', '你欠我一顿辣椒螃蟹。'],
    prompts: [
      { line: '你知道为什么香槟要用细长的杯子吗？', options: [
        { text: '为了让气泡升得更久、香气更集中。', tone: 'smart', topic: 'food' },
        { text: '因为贵的东西都要显得高级。', tone: 'bold', topic: 'money' },
        { text: '不知道，但你可以慢慢教我。', tone: 'flirt' },
      ] },
    ],
  },
  {
    id: 'kai', name: '黄凯', alias: 'Kai Wong', age: 23, gender: 'm', origin: '华人', job: '驻场 DJ / 音乐学院学生',
    persona: '热情奔放、活在节拍里，讨厌说教', blurb: '舞池中央跳得最疯的潮男', theme: '#ff6b1a',
    look: { head: 'm_casual2_head', body: 'm_casual2_body', legs: 'm_casual2_legs', feet: 'm_casual2_feet', hat: 'cap', skin: '#f1c7a3', hair: '#7a4a2a', top: '#e67e22', bottom: '#2b2b2b', shoes: '#ffffff', hatColor: '#f2f2f2' },
    tones: { bold: 3, funny: 3, flirt: 2, sincere: 1, smart: -2, humble: -1 }, loves: ['music', 'party', 'sports'], hates: ['work', 'money'],
    drink: 'beer', gifts: { love: ['concert', 'chocolate'], hate: ['book', 'watch'] }, places: ['club', 'hawker'],
    spots: [{ type: 'club', hours: NIGHT, chance: 0.9 }],
    dancer: true, bday: 25,
    intro: '兄弟/姐妹你刚才那几步可以啊！这首是我混的！',
    greet: ['Yo！来得正好，下一首超炸！', '你来啦！今晚的 set 送给你。', '嘿！舞池等你很久了。'],
    react: { good: ['哇靠，你太懂了！', '这个 vibe 对了！', '哈哈哈 legend！'], ok: ['嗯嗯。', 'Ok ok。', '哈，还行～'], bad: ['呃……你好像我爸。', '别这么严肃嘛。', '这话题好 boring。'] },
    sms: ['今晚我打碟！23 点！一定要来！', '新歌 demo 发你了，听完告诉我！', '凌晨饿了，去不去吃宵夜？', '明天考试…但我在混音 lol'],
    prompts: [
      { line: '你觉得这首歌 drop 的地方怎么样？', options: [
        { text: '炸！我差点把鞋甩出去。', tone: 'bold', topic: 'music' },
        { text: '前面铺垫有点长，不过 drop 很爽。', tone: 'smart', topic: 'music' },
        { text: '你毕业以后打算找什么工作？', tone: 'sincere', topic: 'work' },
      ] },
    ],
  },
  {
    id: 'priya', name: '普丽娅', alias: 'Priya Menon', age: 33, gender: 'f', origin: '印度裔', job: '莱佛士坊律所合伙人',
    persona: '犀利直接、效率至上，最讨厌八卦和含糊', blurb: '一身干练套装、边喝威士忌边回邮件的女士', theme: '#d35400',
    look: { head: 'f_casual_head', body: 'f_formal_body', legs: 'f_formal_legs', feet: 'f_formal_feet', hat: null, skin: '#8d5a3a', hair: '#101010', top: '#2b2b2b', bottom: '#2b2b2b', shoes: '#1a1a1a' },
    tones: { smart: 4, bold: 2, sincere: 2, funny: 1, humble: -1, flirt: -2 }, loves: ['books', 'travel', 'work'], hates: ['gossip', 'party'],
    drink: 'whisky', gifts: { love: ['watch', 'book', 'perfume'], hate: ['plush'] }, places: ['flyer', 'hawker', 'casino'],
    spots: [{ type: 'office', hours: [9, 19], chance: 0.7 }, { type: 'club', hours: [22, 1], chance: 0.55, weekend: true }],
    vip: true, bday: 10,
    intro: '你有三十秒，说服我别回去改合同。',
    greet: ['长话短说。', '今天赢了一个案子，你运气好。', '嗨，你来了。'],
    react: { good: ['很好，逻辑清晰。', '我喜欢直接的人。', '你比大多数人有意思。'], ok: ['可以。', '嗯，继续。', '还算合理。'], bad: ['跑题了。', '这个我没兴趣听。', '请说重点。'] },
    sms: ['今天开庭，晚点回你。', '刚结束一个 deal，想喝一杯。', '这周末我难得空，你安排？', '你上次说的观点我想了想，你是对的。'],
    prompts: [
      { line: '如果你是律师，你会为明知有罪的客户辩护吗？', options: [
        { text: '会，程序正义本身就是正义的一部分。', tone: 'smart', topic: 'work' },
        { text: '只要钱够多。', tone: 'bold', topic: 'money' },
        { text: '我可能会失眠吧。', tone: 'sincere' },
      ] },
    ],
  },
  {
    id: 'hafiz', name: '哈菲兹', alias: 'Hafiz Rahman', age: 28, gender: 'm', origin: '马来裔', job: 'SCDF 消防员',
    persona: '阳光幽默、讲义气，受不了装腔作势', blurb: '和朋友们大笑、点着拉茶的壮实男生', theme: '#e74c3c',
    look: { head: 'm_casual_head', body: 'm_worker_body', legs: 'm_worker_legs', feet: 'm_worker_feet', hat: null, skin: '#d9a56f', hair: '#101010', top: '#c0392b', bottom: '#1f2a44', shoes: '#333333', accent: '#f5c400' },
    tones: { funny: 4, sincere: 3, humble: 2, bold: 0, flirt: 1, smart: -1 }, loves: ['sports', 'food', 'family'], hates: ['money', 'fashion', 'gossip'],
    drink: 'mocktail', gifts: { love: ['chocolate', 'concert', 'plush'], hate: ['perfume', 'bag'] }, places: ['hawker', 'gardens', 'flyer'],
    spots: [{ type: 'hawker', hours: [19, 23], chance: 0.6 }, { type: 'club', hours: [22, 24], chance: 0.4 }],
    bday: 4,
    intro: '哈哈，你也被朋友拖来的？我只喝拉茶，别笑。',
    greet: ['Eh！又见面了 bro/sis！', '今天没火警，开心！', '来来来，坐。'],
    react: { good: ['哈哈哈你好好笑！', '我喜欢你，真的。', '你这个人很实在。'], ok: ['OK lah。', '可以可以。', '嗯嗯。'], bad: ['哎呀，太装了啦。', '这个我听不懂 leh。', '我们讲点开心的好吗？'] },
    sms: ['今天救了一只卡在水沟的猫 😂', '下班了！去吃 nasi lemak 吗？', '明天值 24 小时班，祝我好运。', '周末东海岸 BBQ，来不来？'],
    prompts: [
      { line: '我们队长说我做饭比灭火还危险。', options: [
        { text: '那下次让我尝尝，我带灭火器。', tone: 'funny', topic: 'food' },
        { text: '消防员真的很伟大，谢谢你们。', tone: 'sincere', topic: 'work' },
        { text: '我请私厨就好了，何必自己做。', tone: 'bold', topic: 'money' },
      ] },
    ],
  },
]
export const npcById = (id: string) => NPCS.find((n) => n.id === id) ?? null
