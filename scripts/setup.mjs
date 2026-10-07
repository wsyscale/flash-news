#!/usr/bin/env node
// 快讯分析台：在新的 WorkBuddy 账号上部署时用的辅助脚本（详见 DEPLOY.md）
//
//   node scripts/setup.mjs secrets [--force]   生成 config/secret.json（抓取密钥 + 签名密钥）
//   node scripts/setup.mjs app-config '<json>'  把开通云服务返回的 publicConfig 写入 config/app.json
//   node scripts/setup.mjs steps                列出建库的全部步骤
//   node scripts/setup.mjs step <序号>          输出某一步的 { mode, sqlBase64, parameters }，供云数据库执行接口使用
//   node scripts/setup.mjs check                本地检查：配置文件、密钥、依赖是否齐全
//   node scripts/setup.mjs verify <网站地址>     上线后检查：网站、抓取、数据库权限、密钥是否一致
//   node scripts/setup.mjs pack [输出.zip]      打包一份不含任何账号信息的项目，带到其他账号部署
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const P = (rel) => path.join(ROOT, rel)
const readJson = (rel) => JSON.parse(readFileSync(P(rel), 'utf8'))
const die = (msg, code = 1) => {
  console.error(msg)
  process.exit(code)
}

// ---------------- git：账号文件只在本机排除 ----------------
// config/app.json、config/secret.json 发布时必须上传（服务端要用），所以不能写进 .gitignore；
// 改为写进 .git/info/exclude（只对本机仓库生效、不会被提交），防止误提交到 GitHub。
const LOCAL_ONLY = ['config/app.json', 'config/secret.json']

function gitDir() {
  try {
    return execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

function excludeLocalFiles() {
  const dir = gitDir()
  if (!dir) return
  const file = path.resolve(ROOT, dir, 'info', 'exclude')
  mkdirSync(path.dirname(file), { recursive: true })
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const missing = LOCAL_ONLY.filter((p) => !cur.split('\n').some((l) => l.trim() === `/${p}` || l.trim() === p))
  if (!missing.length) return
  appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# 快讯分析台：本账号的云服务配置与密钥，只在本机使用，不提交\n${missing.map((p) => `/${p}`).join('\n')}\n`)
  console.log(`已把 ${missing.join('、')} 加入 .git/info/exclude（不会被提交）`)
}

/** 返回被 git 跟踪的账号文件（应为空） */
function trackedLocalFiles() {
  if (!gitDir()) return []
  try {
    const out = execFileSync('git', ['ls-files', '--', ...LOCAL_ONLY, '.workbuddy'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.split('\n').filter(Boolean).concat(
      execFileSync('git', ['ls-files'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter((f) => /(^|\/)\.wbapp_.*\.genie$/.test(f)),
    )
  } catch {
    return []
  }
}

// ---------------- 建库步骤解析 ----------------
/** 解析 db/schema.sql：每个「-- @step <mode> <说明>」开始一条语句 */
export function parseSteps(sqlText) {
  const steps = []
  let cur = null
  for (const line of sqlText.split('\n')) {
    const m = /^--\s*@step\s+(migrate|write|read)\s+(.*)$/.exec(line)
    if (m) {
      if (cur) steps.push(cur)
      cur = { mode: m[1], title: m[2].trim(), params: null, lines: [] }
      continue
    }
    if (!cur) continue
    const pm = /^--\s*@params\s+(\w+)/.exec(line)
    if (pm) {
      cur.params = pm[1]
      continue
    }
    cur.lines.push(line)
  }
  if (cur) steps.push(cur)
  return steps.map((s, i) => {
    // 去掉语句后的分隔注释与空行，以及末尾分号（接口只接受单条语句）
    let sql = s.lines.join('\n')
    sql = sql.replace(/(\n\s*--[^\n]*|\n\s*)+$/g, '').trim().replace(/;\s*$/, '')
    return { index: i + 1, mode: s.mode, title: s.title, params: s.params, sql }
  })
}

function loadSteps() {
  return parseSteps(readFileSync(P('db/schema.sql'), 'utf8'))
}

function secretParams() {
  if (!existsSync(P('config/secret.json'))) die('缺少 config/secret.json，请先运行：node scripts/setup.mjs secrets')
  const s = readJson('config/secret.json')
  if (!s.crawlerSecret || !s.signingKey) die('config/secret.json 缺少 crawlerSecret / signingKey，请运行：node scripts/setup.mjs secrets --force')
  return [createHash('sha256').update(s.crawlerSecret, 'utf8').digest('hex'), s.signingKey]
}

// ---------------- 命令 ----------------
const cmds = {
  secrets(args) {
    excludeLocalFiles()
    const file = P('config/secret.json')
    if (existsSync(file) && !args.includes('--force')) {
      const s = readJson('config/secret.json')
      if (s.crawlerSecret && s.signingKey) {
        console.log('config/secret.json 已存在，保持不变（如需重新生成请加 --force，之后要重新执行写入密钥那一步）')
        return
      }
    }
    const data = { crawlerSecret: `fnc_${randomBytes(32).toString('base64url')}`, signingKey: randomBytes(32).toString('hex') }
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
    chmodSync(file, 0o600)
    console.log('已生成 config/secret.json（权限 600）。接下来执行建库步骤时，写入密钥那一步会自动带上它。')
  },

  'app-config'(args) {
    const raw = args[0]
    if (!raw) die("用法：node scripts/setup.mjs app-config '{\"endpoint\":\"https://...\",\"oauthRelayBaseUrl\":\"...\",\"publishableKey\":\"wbpk_...\"}'")
    let pc
    try {
      pc = JSON.parse(existsSync(raw) ? readFileSync(raw, 'utf8') : raw)
    } catch (e) {
      die(`publicConfig 不是合法 JSON：${e.message}`)
    }
    if (pc.publicConfig) pc = pc.publicConfig
    if (!/^https:\/\//.test(pc.endpoint || '')) die('publicConfig.endpoint 应为 https 地址')
    if (!/^wbpk_/.test(pc.publishableKey || '')) die('publicConfig.publishableKey 应以 wbpk_ 开头')
    const example = readJson('config/app.example.json')
    const out = {
      publicConfig: {
        endpoint: pc.endpoint.replace(/\/+$/, ''),
        oauthRelayBaseUrl: pc.oauthRelayBaseUrl || example.publicConfig.oauthRelayBaseUrl,
        publishableKey: pc.publishableKey,
      },
      crawler: example.crawler,
    }
    excludeLocalFiles()
    writeFileSync(P('config/app.json'), `${JSON.stringify(out, null, 2)}\n`)
    console.log(`已写入 config/app.json，云服务地址：${out.publicConfig.endpoint}`)
  },

  steps() {
    const steps = loadSteps()
    for (const s of steps) console.log(`${String(s.index).padStart(2)}  ${s.mode.padEnd(7)}  ${s.title}${s.params ? ' ← 参数自动生成' : ''}`)
    console.log(`\n共 ${steps.length} 步，请按顺序逐条串行执行；用 \`node scripts/setup.mjs step <序号>\` 取出每一步。`)
  },

  step(args) {
    const steps = loadSteps()
    const n = Number.parseInt(args[0], 10)
    const s = steps.find((x) => x.index === n)
    if (!s) die(`没有第 ${args[0]} 步（共 ${steps.length} 步）`)
    const out = { step: s.index, total: steps.length, mode: s.mode, title: s.title, sqlBase64: Buffer.from(s.sql, 'utf8').toString('base64') }
    if (s.params === 'secret') out.parameters = secretParams()
    if (args.includes('--sql')) out.sql = s.sql
    console.log(JSON.stringify(out, null, 2))
  },

  check() {
    const problems = []
    const ok = (m) => console.log(`✅ ${m}`)
    const bad = (m) => {
      problems.push(m)
      console.log(`❌ ${m}`)
    }
    const major = Number(process.versions.node.split('.')[0])
    major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node 版本过低（${process.versions.node}），需要 18.17 以上`)
    if (!existsSync(P('config/app.json'))) bad('缺少 config/app.json：开通云服务后运行 node scripts/setup.mjs app-config ...')
    else {
      const pc = readJson('config/app.json').publicConfig || {}
      pc.endpoint && /^wbpk_/.test(pc.publishableKey || '') ? ok(`config/app.json：${pc.endpoint}`) : bad('config/app.json 的 publicConfig 不完整')
    }
    if (!existsSync(P('config/secret.json'))) bad('缺少 config/secret.json：运行 node scripts/setup.mjs secrets')
    else {
      const s = readJson('config/secret.json')
      s.crawlerSecret && s.signingKey ? ok('config/secret.json 已生成') : bad('config/secret.json 不完整')
    }
    if (gitDir()) {
      excludeLocalFiles()
      const tracked = trackedLocalFiles()
      tracked.length ? bad(`这些账号文件被 git 跟踪了，推送前请执行 git rm --cached：${tracked.join('、')}`) : ok('git：账号配置、密钥和应用登记都不会被提交')
    }
    existsSync(P('node_modules/@tencent-ai/workbuddy-cloud-sdk')) ? ok('依赖已安装') : console.log('ℹ️  依赖未安装（发布时会自动安装；本机要跑 verify 需先 npm install）')
    ok(`建库脚本共 ${loadSteps().length} 步`)
    if (problems.length) process.exit(1)
  },

  async verify(args) {
    const site = String(args[0] || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(site)) die('用法：node scripts/setup.mjs verify https://你的应用域名')
    const results = []
    const rec = (ok, name, detail = '') => {
      results.push(ok)
      console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
    }
    const get = async (p) => {
      const r = await fetch(site + p, { signal: AbortSignal.timeout(20000) })
      return { status: r.status, text: await r.text() }
    }
    const pc = readJson('config/app.json').publicConfig

    try {
      const h = await get('/api/health')
      rec(h.status === 200, '服务在线 /api/health', `HTTP ${h.status}`)
    } catch (e) {
      rec(false, '服务在线 /api/health', `${e.message}（如果是公司内网域名，需在公司网络下访问）`)
      process.exit(1)
    }
    try {
      const c = await get('/app-config.js')
      rec(c.text.includes(pc.publishableKey), '网站使用的是本账号的云服务配置', c.text.includes(pc.publishableKey) ? pc.endpoint : '不一致，请检查 config/app.json 后重新发布')
      rec(new URL(pc.endpoint).origin === new URL(site).origin, '网站域名与云服务登记的域名一致', `${new URL(site).origin} vs ${new URL(pc.endpoint).origin}`)
    } catch (e) {
      rec(false, '读取 /app-config.js', e.message)
    }
    try {
      const st = JSON.parse((await get('/api/status')).text)
      const lr = st.lastRun
      rec(!!lr && lr.status === 'ok', '服务端抓取', lr ? `${lr.status}，抓取 ${lr.fetched} 条，待入库 ${st.pending} 条，间隔 ${st.intervalMinutes} 分钟（来源：${st.settingsSource}）` : '还没有抓取记录，稍等 1 分钟再试')
    } catch (e) {
      rec(false, '服务端抓取 /api/status', e.message)
    }
    try {
      const pr = JSON.parse((await get('/api/providers')).text)
      const th = (pr.providers || []).find((p) => p.id === 'tokenhub')
      rec(!!th, '模型服务商列表', (pr.providers || []).map((p) => p.id + (p.webSearch ? '(可联网)' : '')).join('、'))
    } catch (e) {
      rec(false, '模型服务商列表 /api/providers', e.message)
    }

    // 以未登录身份检查数据库：设置可读、快讯不可读、密钥不可读、登录才能用的函数被拒、抓取密钥与数据库一致
    let createServerCloud
    try {
      ;({ createServerCloud } = await import('../lib/cloud.js'))
    } catch {
      console.log('ℹ️  本机未安装依赖，跳过数据库检查（先运行 npm install）')
      process.exit(results.every(Boolean) ? 0 : 1)
    }
    const cloud = createServerCloud(pc)
    const db = cloud.database
    const cs = await db.from('crawler_settings').select('interval_minutes, retention_days').eq('id', 1).maybeSingle()
    rec(!cs.error && !!cs.data, '数据库：抓取设置已初始化', cs.error ? cs.error.message : cs.data ? `每 ${cs.data.interval_minutes} 分钟，保留 ${cs.data.retention_days} 天` : '没有 id=1 这一行，请执行建库「初始抓取设置」那一步')
    const nf = await db.from('news_flash').select('id').limit(1)
    rec(!nf.error ? nf.data.length === 0 : true, '数据库：未登录看不到快讯（RLS）', nf.error ? nf.error.code || nf.error.message : `${nf.data.length} 行`)
    const sec = await db.from('crawler_secret').select('id').limit(1)
    rec(!!sec.error || sec.data.length === 0, '数据库：密钥表对客户端不可读', sec.error ? sec.error.code || 'denied' : `${sec.data.length} 行`)
    const tk = await db.rpc('issue_ticket')
    rec(!!tk.error, '数据库：未登录不能领票据', tk.error ? tk.error.code || tk.error.kind : '竟然成功了，请检查函数权限')
    const pg = await db.rpc('purge_expired_news')
    rec(!!pg.error, '数据库：客户端不能直接执行清理', pg.error ? pg.error.code || pg.error.kind : '竟然成功了，请检查函数权限')
    const s = existsSync(P('config/secret.json')) ? readJson('config/secret.json') : {}
    const cr = await db.rpc('crawler_report', { p_secret: s.crawlerSecret || '', p_items: [], p_run: null })
    rec(!cr.error, '数据库：本地密钥与数据库一致', cr.error ? `${cr.error.message}（请重新执行建库「写入抓取密钥」那一步，再重新发布）` : '一致')

    const pass = results.filter(Boolean).length
    console.log(`\n${pass}/${results.length} 项通过${pass === results.length ? '。接下来：注册登录 → 设置 → 抓取设置 → 认领管理员。' : ''}`)
    process.exit(pass === results.length ? 0 : 1)
  },

  pack(args) {
    const out = path.resolve(args[0] || path.join(ROOT, '..', 'flash-news-portable.zip'))
    const tmp = mkdtempSync(path.join(tmpdir(), 'flash-news-pack-'))
    const dest = path.join(tmp, 'flash-news')
    // 不打包：依赖、运行数据、本账号的应用登记与云服务配置、密钥
    const SKIP = new Set(['node_modules', 'data', '.workbuddy', '.git', 'package-lock.json', '.DS_Store'])
    const SKIP_REL = new Set(['config/app.json', 'config/secret.json'])
    cpSync(ROOT, dest, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(ROOT, src).split(path.sep).join('/')
        if (!rel) return true
        const base = path.basename(src)
        return !SKIP.has(base) && !SKIP_REL.has(rel) && !/^\.wbapp_.*\.genie$/.test(base)
      },
    })
    rmSync(out, { force: true })
    try {
      execFileSync('zip', ['-qr', out, 'flash-news'], { cwd: tmp })
    } catch {
      execFileSync('tar', ['--format', 'zip', '-cf', out, 'flash-news'], { cwd: tmp }) // macOS bsdtar
    }
    rmSync(tmp, { recursive: true, force: true })
    console.log(`已打包：${out}\n（已排除 node_modules、data、.workbuddy、.wbapp_*.genie、config/app.json、config/secret.json）`)
  },
}

const [cmd, ...rest] = process.argv.slice(2)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!cmds[cmd]) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    process.exit(cmd ? 1 : 0)
  }
  await cmds[cmd](rest)
}
