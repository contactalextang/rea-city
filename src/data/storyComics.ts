import { t } from '../i18n'

/**
 * 漫画剧情过场卡（StoryCard 播放）：任务开始（INTRO）/ 完成（OUTRO）时一格一屏地放。
 * img 为 public/assets/story/<id> 的文件名（不带扩展名，先试 .webp 再试 .png；图不入库，缺图降级为文字格）。
 * 没有剧本的任务行为不变（只弹原来的一行 toast）。
 */
export interface ComicBubble { who?: string; text: string }
export interface ComicPanel { img?: string; caption?: string; bubbles?: ComicBubble[] }

const BOSS = t('老大'), YOU = t('你'), PARTNER = t('合伙人')

export const STORY_INTRO: Record<string, ComicPanel[]> = {
  ob_gang: [
    { img: 'ob_gang_1', caption: t('芽笼，晚上十一点。巷子里的霓虹比月亮亮。'), bubbles: [{ who: BOSS, text: t('新来的？先把肚子填饱。') }] },
    { img: 'ob_gang_2', caption: t('规矩只有一条：别让老大丢脸。'), bubbles: [{ who: BOSS, text: t('吃饱了去店里收点"茶水费"。第一次，客气点。') }] },
  ],
  ob_gold: [
    { img: 'ob_gold_1', caption: t('莱佛士坊。这里的每一扇窗，都在替别人赚钱。'), bubbles: [{ who: t('秘书'), text: t('董事会九点开始，咖啡在您桌上。') }] },
    { img: 'ob_gold_2', caption: t('先去公司露个脸，再把闲钱投出去。钱不该睡觉——人可以。') },
  ],
  ob_white: [
    { img: 'ob_white_1', caption: t('早上八点，丹戎巴葛站。人潮推着你往前走。'), bubbles: [{ who: t('同事'), text: t('又踩点？经理今天心情不好！') }] },
    { img: 'ob_white_2', caption: t('打卡、开会、吃饭、回家。一天就这么过去。'), bubbles: [{ who: YOU, text: t('……明天也一样吧。') }] },
  ],
  ob_blue: [
    { img: 'ob_blue_1', caption: t('宏茂桥，组屋楼下。天刚亮，咖啡店已经开了。'), bubbles: [{ who: t('安娣'), text: t('后生仔，今天开工啦？的士站就在前面。') }] },
    { img: 'ob_blue_2', caption: t('载一单客，赚一顿饭钱。晚上回到租来的床位。') },
  ],
  emp_gang_1: [
    { img: 'emp_gang_1', bubbles: [{ who: BOSS, text: t('光收茶水费没出息。') }, { who: BOSS, text: t('罩住两家店，那才叫地盘。') }] },
  ],
  emp_gang_2: [
    { img: 'emp_gang_2', caption: t('双溪加株。夜里机器不停，车牌一换，就是另一辆车。'), bubbles: [{ who: BOSS, text: t('偷来的车总得有个去处。') }] },
  ],
  emp_gang_3: [
    { img: 'emp_gang_3', caption: t('牛车水，熟食中心楼上。'), bubbles: [{ who: t('麻将馆老板'), text: t('谁坐镇这间馆，谁就是这条街的话事人候选。') }] },
  ],
  emp_gang_4: [
    { img: 'emp_gang_4', caption: t('地盘、车厂、赌档都有了。'), bubbles: [{ who: BOSS, text: t('身家过二十五万，整条街都得听你的。') }] },
  ],
  emp_blue_1: [
    { img: 'emp_blue_1', caption: t('旧机场路小贩中心。'), bubbles: [{ who: t('档主阿伯'), text: t('我做不动了，这档口你要不要接？') }, { who: YOU, text: t('炒粿条，我来。') }] },
  ],
  emp_blue_2: [
    { img: 'emp_blue_2', caption: t('大巴窑。'), bubbles: [{ who: t('老司机'), text: t('自己开车赚辛苦钱，让车替你跑才赚大钱。') }] },
  ],
  emp_blue_3: [
    { img: 'emp_blue_3', caption: t('榜鹅。刚拿到钥匙的人在楼下拍照。'), bubbles: [{ who: YOU, text: t('租来的床位睡不踏实……是时候了。') }] },
  ],
  emp_blue_4: [
    { img: 'emp_blue_4', caption: t('档口、车队、房子，都齐了。'), bubbles: [{ who: t('街坊'), text: t('老板，早！') }] },
  ],
  emp_white_1: [
    { img: 'emp_white_1', caption: t('纬壹科技城。下班后，共享办公室的灯还亮着。'), bubbles: [{ who: YOU, text: t('KPI 考不完，工资涨不动……那就自己做。') }] },
  ],
  emp_white_2: [
    { img: 'emp_white_2', caption: t('副业的收入快追上工资了。'), bubbles: [{ who: YOU, text: t('公司做到 T3，就递辞职信。') }] },
  ],
  emp_white_3: [
    { img: 'emp_white_3', caption: t('里峇峇利，一栋栋公寓亮起了灯。'), bubbles: [{ who: t('丈母娘'), text: t('创业是好，那你们住哪里？') }] },
  ],
  emp_white_4: [
    { img: 'emp_white_4', caption: t('滨海湾。投资人开始排队了。'), bubbles: [{ who: t('投资人'), text: t('下一轮，我们领投。') }] },
  ],
  emp_gold_1: [
    { img: 'emp_gold_1', caption: t('乌节路。每块地砖下面都是租金。'), bubbles: [{ who: t('经纪'), text: t('这间店面，月租稳稳的。') }] },
  ],
  emp_gold_2: [
    { img: 'emp_gold_2', caption: t('商铺是小钱。'), bubbles: [{ who: PARTNER, text: t('甲级写字楼的股份，才是真资产。') }] },
  ],
  emp_gold_3: [
    { img: 'emp_gold_3', caption: t('海湾舫，酒会门口。泊车小弟只认车标。'), bubbles: [{ who: t('泊车小弟'), text: t('先生，您的车是……？') }] },
  ],
  emp_gold_4: [
    { img: 'emp_gold_4', caption: t('城市天际线上，该有你的名字。'), bubbles: [{ who: PARTNER, text: t('地标项目，就差你这一份。') }] },
  ],
}

export const STORY_OUTRO: Record<string, ComicPanel[]> = {
  emp_gang_4: [{ img: 'emp_gang_4', caption: t('整条街都知道你的名字。话事人。') }],
  emp_blue_4: [{ img: 'emp_blue_4', caption: t('从床位到老板。宏茂桥的早晨，还是那杯咖啡。') }],
  emp_white_4: [{ img: 'emp_white_4', caption: t('独角兽创始人。电梯里再也没人问你 KPI。') }],
  emp_gold_4: [{ img: 'emp_gold_4', caption: t('天际线上，有了你的名字。') }],
}
