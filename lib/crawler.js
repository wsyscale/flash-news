// 抓取华尔街见闻 7x24 快讯（score>=2）
//   crawlToStore  —— 线上服务使用：抓到的数据进入暂存区，签名后由已登录浏览器转交云数据库
//   crawlDirect   —— 命令行使用（node server.js --crawl-once）：在能直连云数据面的环境里直接入库
// 去重：wscn_id + 内容哈希在数据库侧唯一约束，ON CONFLICT DO NOTHING
import { describeDbError } from './cloud.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

function str(v, max) {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return max ? s.slice(0, max) : s
}

export function normalizeItem(it) {
  if (!it || !Number.isFinite(Number(it.id)) || !Number.isFinite(Number(it.display_time))) return null
  const article =
    it.article && typeof it.article === 'object'
      ? { id: it.article.id ?? null, title: str(it.article.title, 300), uri: str(it.article.uri, 500) }
      : null
  const images = Array.isArray(it.images)
    ? it.images
        .map((img) => (typeof img === 'string' ? img : img && img.uri))
        .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
        .slice(0, 9)
    : []
  const symbols = Array.isArray(it.symbols)
    ? it.symbols.slice(0, 20).map((s) => ({
        key: str(s.key || s.symbol || s.code, 40),
        name: str(s.name || s.title, 60),
        market: str(s.market || s.type, 20),
      }))
    : []
  const tags = Array.isArray(it.tags)
    ? it.tags.slice(0, 20).map((t) => (typeof t === 'string' ? t : str(t && (t.name || t.title), 40))).filter(Boolean)
    : []
  return {
    wscn_id: String(it.id),
    title: str(it.title, 500).trim(),
    content_text: str(it.content_text, 20000).trim(),
    content_html: str(it.content, 40000),
    content_more: str(it.content_more, 40000),
    score: Number.parseInt(it.score, 10) || 0,
    channels: Array.isArray(it.channels) ? it.channels.map((c) => str(c, 40)).slice(0, 20) : [],
    uri: str(it.uri, 500),
    article,
    images,
    symbols,
    tags,
    display_time: String(it.display_time),
  }
}

export async function fetchPage(cfg, cursor) {
  const url = new URL(cfg.sourceUrl)
  url.searchParams.set('channel', cfg.channel)
  url.searchParams.set('limit', String(cfg.limit))
  url.searchParams.set('score', String(cfg.score))
  if (cursor) url.searchParams.set('cursor', String(cursor))
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://wallstreetcn.com/' },
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  })
  if (!res.ok) throw new Error(`快讯接口 HTTP ${res.status}`)
  const body = await res.json()
  if (body.code !== 20000 || !body.data) throw new Error(`快讯接口返回异常 code=${body.code} ${body.message || ''}`)
  return { items: Array.isArray(body.data.items) ? body.data.items : [], nextCursor: body.data.next_cursor || null }
}

let runSeq = 0
const bootTag = Date.now().toString(36)

/**
 * 抓取进暂存区。
 * 翻页停止条件：本页出现「已在暂存区」或「不大于数据库最新 id」的条目（说明已接上），或达到页数上限。
 * mode='gap' 时用于补缺口：一直翻到数据库最新 id 为止（上限 maxPages）。
 */
export async function crawlToStore({ store, cfg, maxPages, trigger = 'schedule', log = console }) {
  const startedAt = Date.now()
  const known = store.state.knownLatest
  let pages = 0
  let fetched = 0
  let newItems = 0
  let status = 'ok'
  let message = null
  let cursor = null
  let connected = null // 'db' 接上数据库已有数据 | 'buffer' 接上暂存区 | 'end' 没有更早数据
  let minId = Infinity

  try {
    for (let p = 0; p < maxPages; p++) {
      const { items, nextCursor } = await fetchPage(cfg, cursor)
      pages++
      const normalized = items.map(normalizeItem).filter(Boolean)
      if (!normalized.length) {
        connected = 'end'
        break
      }
      fetched += normalized.length
      let pageConnected = null
      for (const it of normalized) {
        const id = Number(it.wscn_id)
        minId = Math.min(minId, id)
        const inDb = known !== null && id <= known
        if (inDb) pageConnected = 'db'
        else if (!pageConnected && trigger !== 'gap' && store.has(it.wscn_id)) pageConnected = 'buffer'
        if (!inDb && !store.has(it.wscn_id)) newItems++
      }
      store.addItems(normalized.filter((it) => known === null || Number(it.wscn_id) > known))
      if (pageConnected || !nextCursor) {
        connected = pageConnected || 'end'
        break
      }
      cursor = nextCursor
    }
  } catch (err) {
    status = 'error'
    message = String((err && err.message) || err).slice(0, 500)
  }

  // 没接上历史（数据库最新 id 未知，或翻到上限仍没接上）→ 标记可能存在缺口，下次拿到票据时补齐
  if (status === 'ok') {
    if (trigger === 'gap' || connected === 'db' || connected === 'end') store.state.gapSuspected = false // 补缺口已尽力（最多 40 页）
    else if (!connected || known === null) store.state.gapSuspected = true
  }

  const run = {
    run_key: `${bootTag}-${++runSeq}`,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    status,
    trigger,
    pages,
    fetched,
    new_items: newItems,
    duration_ms: Date.now() - startedAt,
    message,
  }
  store.addRun(run)
  store.save()
  log.log(
    `[crawler] ${status} trigger=${trigger} pages=${pages} fetched=${fetched} new=${newItems} pending=${store.pendingCount()} ${run.duration_ms}ms${
      message ? ' msg=' + message : ''
    }${Number.isFinite(minId) ? ` minId=${minId}` : ''}`,
  )
  return run
}

/** 命令行直连入库（需要能访问云数据面的网络环境，例如本机） */
export async function crawlDirect({ cloud, secret, cfg, backfillPages, log = console }) {
  const startedAt = Date.now()
  let pages = 0
  let fetched = 0
  let inserted = 0
  let status = 'ok'
  let message = null
  let cursor = null
  try {
    if (!secret) throw new Error('未配置抓取密钥（config/secret.json 的 crawlerSecret）')
    for (let p = 0; p < backfillPages; p++) {
      const { items, nextCursor } = await fetchPage(cfg, cursor)
      pages++
      const normalized = items.map(normalizeItem).filter(Boolean)
      if (!normalized.length) break
      fetched += normalized.length
      const { data, error } = await cloud.database.rpc('crawler_report', { p_secret: secret, p_items: normalized, p_run: null })
      if (error) throw new Error(`入库失败 ${describeDbError(error)}`)
      const n = Number(data && data.inserted) || 0
      inserted += n
      if (n < normalized.length || !nextCursor) break
      cursor = nextCursor
    }
  } catch (err) {
    status = 'error'
    message = String((err && err.message) || err).slice(0, 500)
  }
  const run = { started_at: new Date(startedAt).toISOString(), status, trigger: 'cli', pages, fetched, inserted, duration_ms: Date.now() - startedAt, message }
  if (secret) {
    const { error } = await cloud.database.rpc('crawler_report', { p_secret: secret, p_items: [], p_run: run })
    if (error) log.warn(`[crawler] 写入抓取日志失败 ${describeDbError(error)}`)
  }
  log.log(`[crawler] ${status} cli pages=${pages} fetched=${fetched} inserted=${inserted}${message ? ' msg=' + message : ''}`)
  return run
}
