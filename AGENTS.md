# 给 AI 助手（WorkBuddy 等）的说明

## 用户要「部署 / 搭建 / 上线」这个项目时
严格按 [DEPLOY.md](DEPLOY.md) 第三部分「给 WorkBuddy 的执行步骤」执行，要点：
- 先开通云服务（`applicationMode: "create"`，域名前缀不能用 `flash-news`），再写配置、生成密钥、建库，最后发布。发布的目录必须就是开通云服务的那个目录。
- 建库：`node scripts/setup.mjs step <n>` 逐步取出 `{ mode, sqlBase64, parameters }`，**一次执行一步、串行执行**，第 1 步到最后一步不能跳过。
- 不要修改业务代码，不要手写或改动建库 SQL；遇到报错先看 DEPLOY.md 第四部分「常见问题」。
- 完成后运行 `node scripts/setup.mjs verify <网址>`，全部通过再告诉用户，并提醒用户：打开登录方式开关、认领管理员、填 API Key。

## 修改代码时
- **不要提交** `config/app.json`、`config/secret.json`、`.workbuddy/`、`.wbapp_*.genie`、`data/`。这两个 config 文件发布时又必须上传，所以不能写进 `.gitignore`，由 `scripts/setup.mjs` 写进 `.git/info/exclude`；提交前运行 `node scripts/setup.mjs check`。
- 数据库结构有任何改动，都要同步写进 `db/schema.sql`：用 `-- @step <mode> <说明>` 标记新步骤，保持可以重复执行（`IF NOT EXISTS` / `CREATE OR REPLACE` / 先删后建）。函数权限要先 `REVOKE ... FROM PUBLIC, anon, authenticated` 再按需授予。
- 前端没有构建步骤（原生 ES Module）；视觉风格是浅色简洁资讯风，利好红、利空绿（A 股习惯）。
- 云服务 SDK 固定版本，`package.json` 和 `public/index.html` 里的 CDN 地址要保持一致。
