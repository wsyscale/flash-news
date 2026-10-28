# 在你自己的 WorkBuddy 账号上部署「快讯分析台」

每次部署都会得到一套**完全独立**的应用：新的域名、新的数据库、新的用户体系和新的密钥，和其他人的部署互不影响。功能和界面与原版完全一致。

代码仓库：https://github.com/wsyscale/flash-news

## 一、哪些东西跟账号绑定（仓库里没有，部署时重新生成）

| 文件 / 资源 | 内容 | 新账号怎么处理 |
|---|---|---|
| `.workbuddy/applications.yaml`、`.wbapp_*.genie` | 原账号的应用 ID | 不带。新账号开通云服务时自动生成 |
| `config/app.json` | 原账号的云服务地址和 publishableKey | 不带。用开通云服务返回的配置重新生成 |
| `config/secret.json` | 抓取密钥、签名密钥 | 不带。重新生成，再写进新数据库 |
| 云数据库 | 8 张表、9 个函数、权限、RLS 策略、定时清理 | 用 `db/schema.sql` 重建（共 36 步） |
| 登录方式开关 | 手机号验证码、邮箱 | 在新应用的云服务面板里打开 |
| 用户、分析、追问、模型配置 | 各站点用户自己的数据 | 不共享，用户在你的站点注册后自己填 API Key |
| 快讯 | 抓取来的快讯 | 不用导入。站点启动后自动抓取，首次回补约 100 条 |

仓库里只有代码、建库脚本和部署脚本，上面这些账号相关的文件都不会提交（`.gitignore` 和 `scripts/setup.mjs` 共同保证）。

## 二、操作步骤

### 1. 新建一个 WorkBuddy 任务
在 WorkBuddy 里新建一个任务（建议用一个空的工作目录）。需要你的账号能用「云服务」和「发布为应用」。

### 2. 把下面这段话发给 WorkBuddy

> 请帮我部署 https://github.com/wsyscale/flash-news ：先把仓库克隆到当前工作目录，然后严格按仓库里 `DEPLOY.md` 第三部分「给 WorkBuddy 的执行步骤」完成部署：开通云服务、生成配置和密钥、按顺序执行 36 步建库、发布上线，最后运行上线检查。域名前缀用 `flash-news-<改成你想要的英文>`。不要修改业务代码。

不方便访问 GitHub 时，也可以下载仓库的 ZIP（或用 `node scripts/setup.mjs pack` 打出来的 `flash-news-portable.zip`），解压到工作目录，把上面那段话里的"克隆"改成"使用工作目录下的 `flash-news/`"。

### 3. 部署完成后你自己做
1. 打开新应用的**云服务面板 → 登录方式**，确认「手机号验证码登录」和「邮箱登录」都已打开，否则收不到验证码。
2. 打开新网站并注册登录，**马上**到「设置 → 抓取设置」点「认领管理员」。只有第一个点的人能成为管理员。
3. 到「设置 → 模型配置」填 API Key（DeepSeek 或腾讯云 TokenHub）。Key 属于你的 DeepSeek 或腾讯云账号，跟 WorkBuddy 账号无关；要用联网搜索，需要在 TokenHub 控制台「启用管理 → 应用工具」开通。

## 三、给 WorkBuddy 的执行步骤

以下命令都在项目目录（克隆下来的 `flash-news/`）里执行，用工作区提供的 Node（18.17 以上）。

0. **获取代码**：`git clone https://github.com/wsyscale/flash-news.git`，然后进入 `flash-news/`。已经有代码就跳过这一步。
1. **开通云服务**：调用 `workbuddy_cloud_service`，参数为
   `action: "activate"`、`directory: <flash-news 的绝对路径>`、`applicationMode: "create"`、`appName: "快讯分析台"`、`domainPrefix: <用户给的前缀>`、`appType: "web"`。
   确认弹窗由 WorkBuddy 界面弹出，不要另外询问用户。`flash-news` 这个前缀已经被占用，必须换一个；用户没给就用 `flash-news-` 加一个简短的英文后缀。
2. **写入云服务配置**：把返回结果里的 `publicConfig` 原样传进去：
   `node scripts/setup.mjs app-config '<publicConfig 的 JSON>'`
3. **生成密钥**：`node scripts/setup.mjs secrets`
4. **建库**：`node scripts/setup.mjs steps` 会列出 36 步。从第 1 步到第 36 步，**一次执行一步，前一步成功了再执行下一步**：
   - 运行 `node scripts/setup.mjs step <n>`，得到 `{ mode, sqlBase64, parameters? }`。
   - 调用 `mcp__genie-baas__workbuddy_cloudservice_db_exec_sql`，参数为 `applicationId`（取自 `.workbuddy/applications.yaml`）、`mode`、`sqlBase64`；如果有 `parameters`，一并带上（第 27 步会有）。
   - 脚本可以重复执行。某一步失败了，把问题修好后从这一步继续即可。不要并行执行，否则会报 42P01。
5. **本地自检**：`node scripts/setup.mjs check` 应该全部是 ✅。
6. **发布**：调用 `workbuddy_sites_deploy`，参数为
   `directory: <flash-news 的绝对路径>`、`language: "node"`、`installCmd: "npm install --omit=dev --no-audit --no-fund"`、`startCmd: "node server.js"`、`appName: "快讯分析台"`、`domainPrefix: <与第 1 步相同>`、`userAskedToPublish: true`。
   要发布的就是第 1 步开通云服务的那个目录，这样网站域名才和云服务登记的域名一致；不一致的话，登录和读数据会返回 403。
7. **上线检查**：先 `npm install`，再运行 `node scripts/setup.mjs verify <发布得到的网址>`，应该 11 项全部通过。
8. 把网址告诉用户，并提醒用户完成第二部分第 3 节的三件事。

## 四、常见问题

| 现象 | 原因和处理 |
|---|---|
| 建库报 `42P01 relation does not exist` | 步骤被并行执行了，或者跳过了前面的步骤。按顺序从失败的那一步重新执行 |
| 页面能打开，但登录或读数据报 403 | 网站域名和云服务登记的域名不一致。要在开通云服务的同一个目录里发布，`verify` 的第 3 项会指出这个问题 |
| 一直提示「登录已失效」、快讯不入库 | 数据库里的签名密钥和 `config/secret.json` 不一致。重新执行第 27 步，再重新发布 |
| 收不到短信或邮件验证码 | 云服务面板里对应的登录方式没有打开 |
| 手机打不开 | 如果新账号拿到的也是 `*.app-tencent.workbuddy.host` 内网域名，就只能在公司网络里访问。这由账号类型决定，跟代码无关 |

## 五、以后更新到新版本

1. 在项目目录里 `git pull`。`config/`、`.workbuddy/` 里你自己的配置不在仓库中，不会被覆盖。
2. 如果 `db/schema.sql` 有改动，把全部步骤（现在是 36 步）**按顺序重跑一遍**：脚本可以重复执行，已有的表和数据不受影响。
   - 例：2026-10-28 加入财联社电报时，快讯表从 `wscn_id` 改成了 `source + source_id`，旧库重跑一遍时由「升级旧库」那一步自动完成改名和约束替换，已有快讯、分析、追问都保留。
   - **先升级数据库，紧接着发布新代码，两步连着做**：升级后旧代码还在查 `wscn_id`，发布前新代码又依赖 `source` 字段，所以两步之间页面会短暂加载失败（通常 1–2 分钟），发布完成即恢复。
3. 重新发布（同第三部分第 6 步），再跑一次 `verify`。
