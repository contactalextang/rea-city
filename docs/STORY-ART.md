# 剧情过场与宣传图：素材来源与重拍

剧情过场（`src/ui/StoryCard.ts`、剧本 `src/data/storyComics.ts`）和宣传图（`npm run promo:build`）用到的街景线稿，都是用「どこでもロケハン」（<https://tools.oyasumi-gamedev.com/rokehan/>，作者 @sharp_maker）从 OpenStreetMap 渲染出来的漫画线稿和网点。

## 许可
- 导出图可以用在作品里（商用、非商用都行），**但不能再分发或出售原始导出文件**。所以 `public/assets/story/`、`public/assets/promo/` 都在 `.gitignore` 里，不进公开仓库，只随 `dist/` 部署到线上。
- 凡是用到图的地方都要署名「© OpenStreetMap contributors」，含远景地形的再加「© OpenMapTiles」。原图右下角已经嵌了署名；合成图裁切后要重新写上。
- 新克隆的仓库里没有这些图：过场会降级成纯文字分格，标题画面没有背景图，其他功能不受影响。

## 重拍 / 补拍
```bash
node scripts/story-art/shots.mjs scripts/story-art/shots.json          # 全部
node scripts/story-art/shots.mjs scripts/story-art/shots.json '^emp_gold' # 按 id 正则筛选
npm run promo:build                                                      # 合成宣传图，并把 story/*.png 转成 webp
```
- 脚本用无头 Chromium 打开工具页，通过 URL hash（`#ll=纬度,经度&s=范围&tod=时间段`）定位。等镜头列表切换到新地点后，再选机位预设（`center` 平视、`centerLow` 仰视、`centerHigh` 俯视、`ix0` 路口、`wide` 远景），然后从导出对话框保存 PNG（长边默认 2400，宣传图 4800）。
- 机位预设由工具按当地路网生成；如果某个地点没有指定的预设，就退回 `center`。
- 工具改版或限流都可能让脚本失效，这时改用浏览器手动导出，文件名按 `shots.json` 的 `dest` 放好。

## 镜头清单
完整参数见 `scripts/story-art/shots.json`。

| 用途 | 图片 id | 地点 | 机位 / 时间 |
|---|---|---|---|
| 黑帮入行 | ob_gang_1, ob_gang_2 | 芽笼 Lorong 24A / Geylang Rd 路口 | 平视夜 / 路口黄昏 |
| 金领入行 | ob_gold_1, ob_gold_2 | 莱佛士坊 | 仰视白天 / 俯视黄昏 |
| 白领入行 | ob_white_1, ob_white_2 | 丹戎巴葛 | 平视白天 / 路口黄昏 |
| 蓝领入行 | ob_blue_1, ob_blue_2 | 宏茂桥组屋 | 平视白天 / 俯视夜 |
| 黑帮帝国 1–4 | emp_gang_1…4 | 芽笼店屋、双溪加株工业区、牛车水、芽笼远景 | |
| 蓝领帝国 1–4 | emp_blue_1…4 | 旧机场路小贩中心、大巴窑、榜鹅、宏茂桥远景 | |
| 白领帝国 1–4 | emp_white_1…4 | 纬壹科技城（白天 / 夜）、里峇峇利、滨海湾夜景 | |
| 金领帝国 1–4 | emp_gold_1…4 | 乌节路、莱佛士坊远景、海湾舫夜、滨海湾黄昏 | |
| 结尾格 | 复用各线第 4 章的图 | | |
| 宣传 | promo/src/skyline_dusk, skyline_night, chinatown, raffles | 滨海湾天际线、牛车水、莱佛士坊 | 4800 长边 |
