# REA City — 类 GTA 开放城市原型（Three.js）

浏览器里跑的低多边形开放城市：程序生成的 10×10 街区、街机手感驾驶、行人与交通 NPC、通缉等级与警察追捕、三个任务。全部几何体由代码生成，无外部美术资源。

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # 产物在 dist/
npm run check      # TypeScript 类型检查
```

## 桌面启动器（macOS）

桌面上的 **REA City.app** 双击即玩：自动构建（源码有改动时）、启动本地服务器（端口 4173），并用 Chrome 独立窗口打开。
图标与打包脚本在 `launcher/`：

```bash
launcher/make-app.sh launcher/icon-mac-1024.png            # 重新生成到 ~/Desktop
launcher/make-app.sh launcher/icon-mac-1024.png /Applications
```

网页端图标与 PWA 清单在 `public/`（favicon、apple-touch-icon、manifest），Chrome 地址栏可"安装"成独立应用。

## 操作

| 按键 | 作用 |
|---|---|
| W / A / S / D（或方向键） | 步行移动 / 驾驶 |
| Shift | 奔跑 |
| Space | 跳跃（步行） / 手刹漂移（驾驶） |
| F | 上车 / 下车（可抢任何 NPC 车） |
| 鼠标 | 转动视角（点击画面锁定指针，Esc 解锁） |
| 鼠标左键 / E / Ctrl | 手枪射击（准星瞄准，步行与车内均可） |
| M | 任务进度提示 |
| Enter | 切换浏览器全屏 |

## 玩法

- **黄色光柱** = 任务起点，走进去开始；**蓝色光柱** = 任务目标点。
  1. 运货：把金色轿车完好送到东南区（110 秒）
  2. 赶时间：限时到达东北区（70 秒）
  3. 街头破坏：撞毁 4 辆车（90 秒），然后甩掉警察
- 撞行人或开枪打倒行人 +1★，撞警车 +1★，撞车/打车累计升星；星级越高警车越多。远离警察约 12 秒后开始降星。
- 血量归零或被警察贴住 → 医院重生，扣 10% 现金，进行中的任务失败。
- 右下角小地图随朝向旋转：黄点任务起点、蓝点目标、红点警车、金点任务车、粉点医院。

## 代码结构

```
src/
  config.ts              全局参数（城市尺寸、NPC 上限、车辆手感）
  core/   Game.ts        主调度：固定步长物理、系统顺序、状态机、window.__game 调试钩子
          Input.ts       键盘采样      Camera.ts  第三人称追尾相机
          Context.ts     系统共享上下文 + 事件总线
  world/  CityGenerator  楼房/路面/人行道/路灯/树/围墙（InstancedMesh + 合并几何）
          RoadGraph      路口节点与有向路段，车道/人行道偏移，寻路
          Colliders      静态 AABB + 空间哈希
  physics/ ArcadeVehicle 街机车辆运动学   Collision 圆-AABB / 圆-圆
  entities/ Player, Vehicle, Pedestrians(InstancedMesh), TrafficAI(运动学车道跟随), PoliceAI(物理追击)
  systems/ Spawner(对象池/环形生成回收), Wanted, Missions, Weapon(手枪射线/特效), Audio(WebAudio 合成)
  ui/     Hud(DOM), Minimap(Canvas2D)
```

调试：控制台 `__game.stats` / `__game.player` / `__game.wanted` / `__game.cars`，`__game.teleport(x, z)`、`__game.addCrime(n)`。
