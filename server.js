// 快讯分析台 · 服务端入口
//   node server.js              启动网站 + 定时抓取（默认每 20 分钟，见 lib/config.js；来源见 lib/sources/）
//   node server.js --crawl-once 在能直连云数据面的环境（如本机）执行一次抓取并直接入库后退出
//
// 数据流（线上）：
//   定时抓取（华尔街见闻 + 财联社电报）→ 服务端暂存区（落盘）→ 已登录用户浏览器拉取「服务端签名批次」
//   → 调用数据库 ingest_signed() 验签入库 → 数据库返回签名收据 → 浏览器下次拉取时交回收据，服务端确认后移出暂存区
//   之所以由浏览器转交：发布沙箱按平台安全策略不能直连本应用云数据面；签名保证入库内容确实来自本服务端。
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadConfig } from './lib/config.js'
import { createStore } from './lib/store.js'
import { createScheduler } from './lib/scheduler.js'
import { verifyTicket, signBatch, verifyReceipt } from './lib/sign.js'
import { publicSources } from './lib/sources/index.js'
import { DEFAULT_SYSTEM_PROMPT, publicProviders, streamAnalysis, streamChat, testConnection } from './lib/llm.js'
import { searchSymbols } from './lib/symbols.js'

const config = loadConfig()

if (process.argv.includes('--crawl-once')) {
  const { createServerCloud } = await import('./lib/cloud.js')
  const { crawlDirect } = await import('./lib/crawler.js')
  const cloud = createServerCloud(config.publicConfig)
  const runs = await crawlDirect({
    cloud,
    secret: config.crawlerSecret,
    cfg: config.crawler,
    backfillPages: config.crawler.backfillOverride || config.crawler.defaultBackfillPages,
  })
  process.exit(runs.every((r) => r.status === 'ok') ? 0 : 1)
}

if (!config.signingKey) console.warn('[config] 未配置 signingKey，登录校验与入库将不可用')

const store = createStore(config.dataDir)
const scheduler = createScheduler({ store, cfg: config.crawler })
const PUBLIC_DIR = path.join(config.root, 'public')
const require = createRequire(import.meta.url)
const BATCH_ITEMS = 150
const BATCH_RUNS = 50

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}

function sendJson(res, status, obj) {
  if (res.headersSent) return
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

async function readBody(req, limit = 128 * 1024) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > limit) {
      const e = new Error('请求体过大')
      e.status = 413
      throw e
    }
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const e = new Error('请求体不是合法 JSON')
    e.status = 400
    throw e
  }
}

// 简单的按用户限流：每分钟 N 次 + 同时进行的流式分析数
const rate = new Map()
function allow(uid, kind, perMinute) {
  const key = `${kind}:${uid}`
  const now = Date.now()
  const rec = rate.get(key) || { ts: [] }
  rec.ts = rec.ts.filter((t) => now - t < 60_000)
  if (rec.ts.length >= perMinute) return false
  rec.ts.push(now)
  rate.set(key, rec)
  if (rate.size > 5000) rate.clear()
  return true
}
const inflight = new Map()

/** 流式 LLM 请求：每用户同时最多 3 个（分析 + 追问合计） */
async function runStream(req, res, user, { kind, perMinute, label, limit, handler }) {
  if (!allow(user.uid, kind, perMinute)) return sendJson(res, 429, { error: `${label}请求过于频繁，请稍后再试` })
  const running = inflight.get(user.uid) || 0
  if (running >= 3) return sendJson(res, 429, { error: '同时进行的分析 / 追问最多 3 个，请稍候' })
  const body = await readBody(req, limit)
  inflight.set(user.uid, running + 1)
  try {
    await handler(req, res, body)
  } finally {
    const n = (inflight.get(user.uid) || 1) - 1
    if (n <= 0) inflight.delete(user.uid)
    else inflight.set(user.uid, n)
  }
}

/** 校验数据库签发的票据；顺带把票据里的「数据库最新进度 / 抓取设置」同步给调度器 */
function requireUser(req, res, { admin = false } = {}) {
  const t = verifyTicket(config.signingKey, String(req.headers['x-app-ticket'] || ''))
  if (!t) {
    sendJson(res, 401, { error: '登录已失效，请刷新页面后重试', code: 'ticket_invalid' })
    return null
  }
  store.applyTicket(t)
  scheduler.onTicket()
  if (admin && !t.adm) {
    sendJson(res, 403, { error: '仅管理员可执行该操作' })
    return null
  }
  return { uid: String(t.uid), isAdmin: !!t.adm }
}

let lastManualCrawl = 0

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`
  switch (route) {
    case 'GET /api/health':
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() })

    case 'GET /api/status':
      return sendJson(res, 200, scheduler.status())

    case 'GET /api/providers':
      return sendJson(res, 200, { providers: publicProviders(), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, sources: publicSources() })

    // 浏览器拉取待入库批次（服务端签名），随后调用数据库 ingest_signed() 入库；
    // 请求体可带上一批的数据库收据 { receipts: [{payload, sig}] }，验签通过后把那一批移出暂存区
    case 'POST /api/sync/pull': {
      const user = requireUser(req, res)
      if (!user) return
      if (!allow(user.uid, 'sync', 30)) return sendJson(res, 429, { error: '同步过于频繁' })
      const body = await readBody(req, 16 * 1024)
      let confirmed = 0
      for (const rc of Array.isArray(body.receipts) ? body.receipts.slice(0, 10) : []) {
        const bid = verifyReceipt(config.signingKey, rc)
        if (bid) confirmed += store.confirm(bid)
      }
      if (body.peek) return sendJson(res, 200, { count: 0, runs: 0, digests: 0, remaining: store.pendingCount(), confirmed, status: scheduler.status() })
      const batch = store.takeBatch(BATCH_ITEMS, BATCH_RUNS)
      if (!batch) return sendJson(res, 200, { count: 0, runs: 0, digests: 0, remaining: 0, confirmed, status: scheduler.status() })
      const remaining = Math.max(0, store.pendingCount() - batch.items.length)
      const signed = signBatch(config.signingKey, batch)
      return sendJson(res, 200, { ...signed, bid: batch.bid, count: batch.items.length, runs: batch.runs.length, digests: batch.digests.length, remaining, confirmed, status: scheduler.status() })
    }

    // 摘要历史回填：登录用户的浏览器把数据库里已有的快讯分批回传（服务端读不了自己的云数据面），
    // 服务端塞进 recent 缓冲后重新分组，摘要随正常同步链路写回 news_digest；done=true 标记完成（只做一次）
    case 'POST /api/digest/backfill': {
      const user = requireUser(req, res)
      if (!user) return
      if (!allow(user.uid, 'backfill', 20)) return sendJson(res, 429, { error: '回填过于频繁，请稍后再试' })
      const body = await readBody(req, 12 * 1024 * 1024)
      const items = Array.isArray(body.items) ? body.items.slice(0, 800) : []
      let added = 0
      for (const it of items) {
        if (!it || typeof it !== 'object') continue
        if (typeof it.source !== 'string' || !/^[a-z][a-z0-9_]{1,15}$/.test(it.source)) continue
        if (!/^[0-9]{1,18}$/.test(String(it.source_id))) continue
        // display_time 可能是数据库返回的 ISO 字符串，也可能是 epoch 秒；统一转 epoch 秒
        const rawDt = it.display_time
        let epochSec = NaN
        if (typeof rawDt === 'number' && Number.isFinite(rawDt)) epochSec = Math.floor(rawDt)
        else if (typeof rawDt === 'string' && /^[0-9]{9,10}(\.[0-9]+)?$/.test(rawDt.trim())) epochSec = Math.floor(Number(rawDt))
        else if (typeof rawDt === 'string') {
          const t = Date.parse(rawDt)
          if (Number.isFinite(t)) epochSec = Math.floor(t / 1000)
        }
        if (!Number.isFinite(epochSec)) continue
        store.addRecent({
          source: it.source,
          source_id: String(it.source_id),
          title: String(it.title || '').slice(0, 500),
          content_text: String(it.content_text || '').slice(0, 20000),
          score: Number(it.score) || 0,
          channels: Array.isArray(it.channels) ? it.channels.map(String).slice(0, 20) : [],
          uri: String(it.uri || '').slice(0, 500),
          images: Array.isArray(it.images) ? it.images.slice(0, 9) : [],
          symbols: Array.isArray(it.symbols) ? it.symbols.slice(0, 20) : [],
          tags: Array.isArray(it.tags) ? it.tags.slice(0, 10) : [],
          display_time: String(epochSec),
        })
        added++
      }
      const done = body.done === true
      // 回填数据进缓冲后立即重新分组（新组随下次同步下发）；done 时也分组（覆盖正好整除、末页空的情况）
      if (added || done) {
        try {
          store.refreshDigests()
        } catch { /* 下一轮抓取会再分组 */ }
      }
      if (done) store.markBackfillDone()
      return sendJson(res, 200, { added, done, pendingDigests: store.pendingDigestCount() })
    }

    case 'POST /api/crawl/run': {
      const user = requireUser(req, res, { admin: true })
      if (!user) return
      if (Date.now() - lastManualCrawl < 20_000) return sendJson(res, 429, { error: '操作太频繁，请 20 秒后再试' })
      lastManualCrawl = Date.now()
      const run = await scheduler.tick('manual')
      return sendJson(res, 200, { run, status: scheduler.status() })
    }

    // 管理员改完设置后调用：新票据里带着最新设置，requireUser 已完成同步
    case 'POST /api/settings/reload': {
      const user = requireUser(req, res, { admin: true })
      if (!user) return
      return sendJson(res, 200, scheduler.status())
    }

    // 关注列表：证券 / 板块联想搜索
    case 'GET /api/symbols': {
      const user = requireUser(req, res)
      if (!user) return
      if (!allow(user.uid, 'symbols', 60)) return sendJson(res, 429, { error: '搜索过于频繁，请稍后再试' })
      const q = String(url.searchParams.get('q') || '').trim()
      if (!q) return sendJson(res, 200, { items: [] })
      try {
        const { items, source } = await searchSymbols(q)
        return sendJson(res, 200, { items, source })
      } catch (err) {
        console.warn(`[symbols] search failed: ${err && err.message}`)
        return sendJson(res, 502, { error: '证券搜索暂时不可用，可直接输入名称添加', items: [], detail: String((err && err.message) || '').slice(0, 300) })
      }
    }

    case 'POST /api/llm/test': {
      const user = requireUser(req, res)
      if (!user) return
      if (!allow(user.uid, 'test', 10)) return sendJson(res, 429, { error: '测试过于频繁，请稍后再试' })
      const body = await readBody(req)
      return sendJson(res, 200, await testConnection(body))
    }

    case 'POST /api/analyze': {
      const user = requireUser(req, res)
      if (!user) return
      return runStream(req, res, user, { kind: 'analyze', perMinute: 20, label: '分析', limit: 128 * 1024, handler: streamAnalysis })
    }

    // 深度分析后的追问：请求体带上快讯、已有分析与历史对话（服务端不保存，只转发）
    case 'POST /api/chat': {
      const user = requireUser(req, res)
      if (!user) return
      return runStream(req, res, user, { kind: 'chat', perMinute: 30, label: '追问', limit: 1024 * 1024, handler: streamChat })
    }

    default:
      return sendJson(res, 404, { error: 'Not Found' })
  }
}

async function serveFile(res, file, { cache = 'no-cache' } = {}) {
  const ext = path.extname(file).toLowerCase()
  const buf = await readFile(file)
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
    'Content-Length': buf.length,
  })
  res.end(buf)
}

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method Not Allowed' })

  if (url.pathname === '/app-config.js') {
    const body = `window.APP_CONFIG = ${JSON.stringify({ publicConfig: config.publicConfig })};\n`
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
    return res.end(body)
  }
  if (url.pathname === '/vendor/workbuddy-cloud-sdk.global.js') {
    // CDN 不可用时的本地兜底（与页面 CDN 同一个固定版本，见 package.json）
    const sdkEntry = require.resolve('@tencent-ai/workbuddy-cloud-sdk')
    return serveFile(res, path.join(path.dirname(sdkEntry), 'index.global.js'), { cache: 'public, max-age=3600' })
  }

  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.normalize(path.join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' })
  try {
    const st = await stat(file)
    if (!st.isFile()) throw new Error('not file')
  } catch {
    if (!path.extname(rel)) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'))
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not Found')
  }
  const cache = rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache'
  return serveFile(res, file, { cache })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return await handleStatic(req, res, url)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error(`[http] ${req.method} ${url.pathname} failed:`, err && err.message)
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !err.status ? '服务器内部错误' : err.message })
    else if (!res.writableEnded) res.end()
  }
})

server.requestTimeout = 0
server.headersTimeout = 30_000

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[http] 快讯分析台已启动 http://0.0.0.0:${config.port}`)
  scheduler.start()
})

process.on('unhandledRejection', (err) => console.error('[process] unhandledRejection', err && err.message))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    scheduler.stop()
    store.save(true)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
