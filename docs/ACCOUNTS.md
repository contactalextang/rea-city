# 账号与云存档设计（未实现）

> 状态：设计稿，2026-10-23。目前存档只在浏览器 localStorage（`src/systems/Save.ts`）。上线账号系统时按本文实施，部署仍是同一个 Cloudflare Worker（`wrangler.jsonc`），域名不变。

## 目标

- 玩家可以注册 / 登录，每个账号有自己的资料（昵称、建角色外观、身份、统计）和多个存档槽，换设备也能接着玩
- 不登录照样能玩（游客模式，继续用 localStorage）；登录后可以把本地存档上传到账号

## 架构

```
浏览器 ──▶ rea.alextang.dev（同一个 Worker）
            ├─ /api/*  → Worker 代码 worker/index.ts → D1（SQLite）
            └─ 其余    → 静态资源 dist/（不经过 Worker，不计费）
```

`wrangler.jsonc` 需要增加：

```jsonc
"main": "worker/index.ts",
"assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": ["/api/*"] },
"d1_databases": [{ "binding": "DB", "database_name": "rea-city", "database_id": "<wrangler d1 create 输出>" }]
```

同源 + HttpOnly Cookie，不用处理 CORS，也不用把 token 存在 localStorage。

## 数据表（`migrations/0001_init.sql`，用 `wrangler d1 migrations apply` 管理）

| 表 | 字段 |
|---|---|
| `users` | `id` TEXT PK（随机 UUID）、`username` TEXT UNIQUE（3–20 位，忽略大小写）、`email` TEXT UNIQUE NULL、`pass_hash` BLOB、`salt` BLOB、`iter` INT、`created_at` INT |
| `sessions` | `token_hash` BLOB PK（session token 的 SHA-256）、`user_id`、`expires_at` INT（30 天，滚动续期） |
| `profiles` | `user_id` PK、`nickname`、`appearance` TEXT（建角色外观 JSON）、`role`、`stats` TEXT（等级、成就、终身统计 JSON）、`updated_at` |
| `saves` | (`user_id`, `slot`) PK、`data` TEXT（`SaveData` JSON，D1 单行上限 2 MB，实际约 50 KB）、`version` INT、`updated_at` INT |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | `{username, password, email?, turnstileToken}`，成功后直接登录（Set-Cookie） |
| POST | `/api/login` / `/api/logout` | 登录 / 注销当前会话 |
| GET | `/api/me` | 当前用户 + 资料；未登录 401 |
| GET / PUT | `/api/profile` | 读 / 改资料 |
| GET | `/api/saves` | 列出槽位（slot、version、updated_at，不含 data） |
| GET / PUT / DELETE | `/api/saves/:slot` | 读 / 写 / 删存档。PUT 带 `baseVersion`，与库里不一致返回 409（多个标签页或多台设备同时玩时不会互相覆盖），客户端提示「云端有更新的存档」 |

## 安全

- 密码：WebCrypto PBKDF2-SHA256，16 字节随机盐，迭代次数存在 `iter` 字段里，以后可以调高并在登录时重新哈希
- 注册：Cloudflare Turnstile 人机验证（免费）；用户名、密码长度在服务端校验
- 登录：Workers Rate Limiting 绑定，按 IP + 用户名限速（比如每分钟 5 次）
- Cookie：`HttpOnly; Secure; SameSite=Lax; Path=/api`；库里只存 token 的哈希
- 写接口要求 `Content-Type: application/json`，并校验 `Origin`，防 CSRF

## 客户端改动

- `Save.ts` 抽出 `SaveStore` 接口：`LocalStore`（就是现在的实现，同步）和 `CloudStore`（fetch，异步）；`Game.ts` 里的存档调用改成 async，读档前显示加载提示
- 登录入口放在手机「存档」页和建角色界面；登录后如果本地有存档，弹窗选「上传到账号 / 保留云端 / 先不管」
- 自动存档节流：手动存档、回家睡觉、离开室内时写入，另外最多每 3 分钟写一次，控制 D1 写入量
- 离线或 5xx 时退回 `LocalStore`，同时标记「待同步」，恢复后再上传

## 费用

估算前提：一次完整加载压缩后约 10–12 MB，1 万次游玩约 120 GB；每位玩家云存档约 50 KB；活跃玩家平均每次游玩约 20 次 API 请求。

### 阶段 A：纯静态（现在）

| 方案 | 月费 |
|---|---|
| **Cloudflare Workers 静态资源（当前方案）** | **$0**，静态资源请求和流量不计费、不限量 |
| AWS S3 + CloudFront 按量 | 每月永久免费 1 TB 流量 + 1000 万次请求，约 8 万次游玩以内 $0；超出后亚太约 $0.12–0.14/GB |
| CloudFront 包月 Free / Pro | $0（约 100 GB）/ $15（约 50 TB），不收超量费；额度以官方页面为准 |
| 现有 Lightsail（alextang.dev 服务器） | 不新增费用，但占用套餐自带流量，超出后约 $0.09/GB |

### 阶段 B：账号与云存档

| 方案 | 月费 | 说明 |
|---|---|---|
| **Cloudflare Worker + D1（推荐）** | 开发期 $0；开放注册后 **$5/月** | 免费版每天 10 万次 Worker 请求，D1 容量 5 GB、每天读 500 万行、写 10 万行，但每次请求 CPU 上限只有 10 ms，PBKDF2 哈希会超时。Workers Paid 每月 $5：每月 1000 万次请求、CPU 上限 30 s，D1 额度大幅提高；1 万名玩家的存档约 0.5 GB |
| AWS：Cognito + API Gateway HTTP API + Lambda + DynamoDB + S3/CloudFront | 小规模约 $0–3/月 | Cognito 每月 1 万 MAU 免费，Lambda 和 DynamoDB 有永久免费额度，HTTP API 约 $1/百万次请求；功能完整，但组件多、IAM 和部署配置更复杂 |
| 现有 Lightsail 自己跑 Node + SQLite | $0 新增 | 最省钱，但只有单机，备份、扩容、DDoS 防护都要自己做，还会和网站抢 CPU 和内存 |
| Supabase / Firebase 托管认证与数据库 | 免费起步 | 认证功能现成，但多一个供应商；Supabase 免费项目闲置一周会被暂停 |

结论：Cloudflare 静态阶段 $0，开放账号后 $5/月能撑到上万玩家；同一平台、同源、域名不变，性价比最高。
