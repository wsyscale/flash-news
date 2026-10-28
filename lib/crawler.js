// 抓取快讯（多来源：华尔街见闻、财联社电报，见 lib/sources/）
//   crawlToStore  —— 线上服务使用：抓到的数据进入暂存区，签名后由已登录浏览器转交云数据库
//   crawlDirect   —— 命令行使用（node server.js --crawl-once）：在能直连云数据面的环境里直接入库
// 去重：数据库按 (source, source_id) 与 (source, 内容哈希) 唯一约束，ON CONFLICT DO NOTHING
import { describeDbError } from './cloud.js'
import { SOURCES, getSource } from './sources/index.js'

// 补缺口时每个来源最多翻的页数：华尔街见闻 20 条/页 ≈ 16 天；财联社 50 条/页 ≈ 5 天
const GAP_PAGES = { wscn: 40, cls: 50 }
// 「接上」的判定余量：发布时间早于数据库最新时间这么多秒的条目，才认为已经接上（财联社有晚发稿，见下）
const CONNECT_MARGIN_SEC = 20 * 60

let runSeq = 0
const bootTag = Date.now().toString(36)

/** 每个来源的抓取配置：来源默认值 + config/app.json 里 crawler.sources[id] 的覆盖 */
export function sourceConfig(cfg, sourceId) {
  const src = getSource(sourceId)
  const override = (cfg.sources && cfg.sources[sourceId]) || {}
  // 兼容旧配置：crawler.sourceUrl / channel / limit / score 只作用于华尔街见闻
  const legacy =
    sourceId === 'wscn'
      ? Object.fromEntries(
          Object.entries({ url: cfg.sourceUrl, channel: cfg.channel, limit: cfg.limit, score: cfg.score }).filter(([, v]) => v !== undefined),
        )
      : {}
  return { ...src.defaults, ...legacy, ...override }
}

/** 本进程要抓的来源（crawler.sources[id].enabled === false 可关闭某个来源） */
export function enabledSources(cfg) {
  return SOURCES.filter((s) => !(cfg.sources && cfg.sources[s.id] && cfg.sources[s.id].enabled === false))
}

/**
 * 抓取一个来源进暂存区。
 * 翻页停止条件：本页最早一条已早于数据库里这个来源的最新时间（减去余量），说明已经和数据库接上；
 * 或本页全部已在暂存区；或达到页数上限 / 没有更早数据。
 *
 * 为什么不用「id 大于数据库最大 id」：财联社的 id 是建稿时分配的，晚发布的稿子 id 反而小（实测 2000 条里 134 处倒挂），
 * 按 id 判断会漏掉这些稿子。改为按发布时间判断 + 数据库收据确认（见 lib/store.js）。
 */
export async function crawlSource({ store, cfg, sourceId, maxPages, trigger = 'schedule', log = console }) {
  const src = getSource(sourceId)
  const scfg = sourceConfig(cfg, sourceId)
  const startedAt = Date.now()
  const known = store.knownLatest(sourceId) // 数据库里该来源最新的发布时间（秒）；null 未知，0 表示数据库里还没有
  let pages = 0
  let fetched = 0
  let newItems = 0
  let status = 'ok'
  let message = null
  let cursor = null
  let connected = null // 'db' 接上数据库已有数据 | 'buffer' 接上暂存区 | 'end' 没有更早数据

  try {
    for (let p = 0; p < maxPages; p++) {
      const { items, rawCount, nextCursor } = await src.fetchPage(scfg, cursor, { timeoutMs: cfg.requestTimeoutMs })
      pages++
      if (!rawCount) {
        connected = 'end'
        break
      }
      fetched += items.length
      // 先判断「整页都已在暂存区」（说明上次已经抓到这里），再加入暂存区
      const allBuffered = items.length > 0 && items.every((it) => store.has(sourceId, it.source_id))
      const before = store.pendingCount(sourceId)
      store.addItems(sourceId, items)
      newItems += Math.max(0, store.pendingCount(sourceId) - before)
      const oldest = items.reduce((m, it) => Math.min(m, Number(it.display_time)), Infinity)
      if (known && Number.isFinite(oldest) && oldest < known - CONNECT_MARGIN_SEC) connected = 'db'
      else if (trigger !== 'gap' && allBuffered) connected = 'buffer'
      if (connected) break
      if (!nextCursor) {
        connected = 'end'
        break
      }
      cursor = nextCursor
    }
  } catch (err) {
    status = 'error'
    message = String((err && err.message) || err).slice(0, 500)
  }

  // 没接上历史（数据库进度未知，或翻到上限仍没接上）→ 标记可能存在缺口，下次拿到票据时补齐
  if (status === 'ok') {
    if (trigger === 'gap' || connected === 'db' || connected === 'end') store.setGap(sourceId, false)
    else if (!connected || known === null) store.setGap(sourceId, true)
  }

  const run = {
    run_key: `${bootTag}-${++runSeq}`,
    source: sourceId,
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
    `[crawler] ${src.id} ${status} trigger=${trigger} pages=${pages} fetched=${fetched} new=${newItems} pending=${store.pendingCount(sourceId)} ${run.duration_ms}ms${
      message ? ' msg=' + message : ''
    }`,
  )
  return run
}

export function gapPages(sourceId, fallback) {
  return GAP_PAGES[sourceId] || fallback
}

/** 命令行直连入库（需要能访问云数据面的网络环境，例如本机）；每个来源单独记录一次抓取 */
export async function crawlDirect({ cloud, secret, cfg, backfillPages, log = console }) {
  const runs = []
  for (const src of enabledSources(cfg)) {
    const scfg = sourceConfig(cfg, src.id)
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
        const { items, rawCount, nextCursor } = await src.fetchPage(scfg, cursor, { timeoutMs: cfg.requestTimeoutMs })
        pages++
        if (!rawCount) break
        fetched += items.length
        if (items.length) {
          const { data, error } = await cloud.database.rpc('crawler_report', { p_secret: secret, p_items: items, p_run: null })
          if (error) throw new Error(`入库失败 ${describeDbError(error)}`)
          const n = Number(data && data.inserted) || 0
          inserted += n
          if (n === 0) break // 整页都已入库，说明接上了
        }
        if (!nextCursor) break
        cursor = nextCursor
      }
    } catch (err) {
      status = 'error'
      message = String((err && err.message) || err).slice(0, 500)
    }
    const run = { source: src.id, started_at: new Date(startedAt).toISOString(), status, trigger: 'cli', pages, fetched, inserted, duration_ms: Date.now() - startedAt, message }
    if (secret) {
      const { error } = await cloud.database.rpc('crawler_report', { p_secret: secret, p_items: [], p_run: run })
      if (error) log.warn(`[crawler] 写入抓取日志失败 ${describeDbError(error)}`)
    }
    log.log(`[crawler] ${src.id} ${status} cli pages=${pages} fetched=${fetched} inserted=${inserted}${message ? ' msg=' + message : ''}`)
    runs.push(run)
  }
  return runs
}
