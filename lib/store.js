// 服务端暂存区：抓到但尚未写入云数据库的快讯 + 抓取记录，落盘到 data/state.json 防止进程重启丢失
//
// 去重与确认：
//   · 暂存区按 (来源, source_id) 合并，重复抓到的条目只保留一份
//   · 条目交给浏览器入库后，只有拿到数据库签名的「收据」（ingest_signed 返回）才移出暂存区；
//     没拿到收据（浏览器中途关闭、网络失败）的批次，过一会儿会重新下发，数据库唯一约束保证不会重复入库
//   · 已确认入库的条目记在 done 里（来源:id → 发布时间），之后重新抓到不会再进暂存区；
//   · 发布时间早于数据库里该来源最新时间 2 小时以上的条目视为已入库，直接清掉（兜底，防止暂存区无限增长）
//
// 跨来源摘要（「全部」tab 的数据）：
//   · recent：近 48 小时抓到的所有快讯（含已入库的），供摘要分组用，与待入库暂存区独立；
//   · 每轮抓取后按 X 连字规则重新分组（lib/digest.js），与上一次快照（digestSent 指纹）比对，
//     新增 / 有变化的组进 digestPending 队列，随签名批次写入数据库 news_digest（ON CONFLICT 更新，幂等）。
// 旧版暂存文件（只有华尔街见闻、按 wscn_id 存）启动时自动迁移。
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { computeDigests } from './digest.js'

const MAX_ITEMS_PER_SOURCE = 3000
const MAX_RUNS = 300
const MAX_RECENT = 20000 // 供摘要分组用的近期快讯上限（保留期内，约 14 天 × 三来源）
const DAY_MS = 86_400_000
const LEASE_MS = 3 * 60_000 // 下发后等收据的时间，超时可重新下发
const DIGEST_HOT_MS = 30 * 60_000 // 摘要组入队后这么久内算「新」，优先下发
const STALE_SEC = 2 * 3600 // 比数据库最新时间早这么多的暂存条目直接清掉

export function createStore(dataDir, log = console) {
  const file = path.join(dataDir, 'state.json')
  const state = {
    items: new Map(), // `${source}:${source_id}` -> item
    done: new Map(), // `${source}:${source_id}` -> display_time：已确认入库，重新抓到时跳过
    leases: new Map(), // key -> { bid, until }：已下发、等待数据库收据
    batches: new Map(), // bid -> { keys, runKeys, digestKeys, at }
    runs: [], // 最近的抓取记录（含 run_key、source）
    sentRuns: new Set(), // 已确认写入数据库的抓取记录 run_key
    known: {}, // 来源 -> 数据库中最新发布时间（秒，来自数据库签名的票据）；0 = 数据库里还没有该来源
    knownAt: 0,
    knownLastRunEpoch: null, // 数据库中最近一条抓取记录的开始时间（秒）
    settings: null, // 数据库 crawler_settings（来自票据）：{ interval, enabled, backfill, retention, digestX, ts }
    gap: {}, // 来源 -> 暂存区与数据库之间可能有缺口，需要向前翻页补齐
    recent: new Map(), // `${source}:${source_id}` -> item：近期全部快讯（含已入库），摘要分组用
    backfillDone: false, // 摘要历史回填（浏览器把库里已有快讯回传）是否已完成
    digestSent: new Map(), // group_key -> 指纹（上一次已入队的分组快照），用于增量比对
    digestPending: new Map(), // group_key -> 摘要行：待写入数据库
    digestLeases: new Map(), // group_key -> { bid, until }
  }
  const keyOf = (source, sid) => `${source}:${sid}`

  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const it of raw.items || []) {
        // 旧格式：{ wscn_id, ... } → { source: 'wscn', source_id }
        const item = it.source ? it : { ...it, source: 'wscn', source_id: String(it.wscn_id) }
        delete item.wscn_id
        state.items.set(keyOf(item.source, item.source_id), item)
      }
      state.runs = Array.isArray(raw.runs) ? raw.runs.slice(-MAX_RUNS).map((r) => ({ source: 'wscn', ...r })) : []
      state.sentRuns = new Set(Array.isArray(raw.sentRuns) ? raw.sentRuns : [])
      for (const [k, t] of Array.isArray(raw.done) ? raw.done : []) state.done.set(k, t)
      state.known = raw.known && typeof raw.known === 'object' ? raw.known : {}
      state.knownAt = raw.knownAt || 0
      state.knownLastRunEpoch = raw.knownLastRunEpoch ?? null
      state.settings = raw.settings || null
      state.gap = raw.gap && typeof raw.gap === 'object' ? raw.gap : raw.gapSuspected ? { wscn: true } : {}
      for (const it of raw.recent || []) state.recent.set(keyOf(it.source, it.source_id), it)
      for (const r of raw.digestPending || []) state.digestPending.set(r.group_key, r)
      state.backfillDone = raw.backfillDone === true
      // digestSent 指纹不落盘：重启后第一次比对会全量重发一遍摘要（入库幂等），代价可控
      log.log(`[store] 已从磁盘恢复 ${state.items.size} 条暂存快讯、${state.recent.size} 条近期快讯、${state.digestPending.size} 条待入库摘要`)
    }
  } catch (err) {
    log.warn(`[store] 读取暂存文件失败，忽略：${err.message}`)
  }

  let saveTimer = null
  function save(immediate = false) {
    clearTimeout(saveTimer)
    const write = () => {
      try {
        mkdirSync(dataDir, { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(
          tmp,
          JSON.stringify({
            v: 3,
            items: [...state.items.values()],
            runs: state.runs,
            sentRuns: [...state.sentRuns].slice(-MAX_RUNS * 2),
            done: [...state.done.entries()],
            known: state.known,
            knownAt: state.knownAt,
            knownLastRunEpoch: state.knownLastRunEpoch,
            settings: state.settings,
            gap: state.gap,
            recent: [...state.recent.values()],
            backfillDone: state.backfillDone,
            digestPending: [...state.digestPending.values()],
          }),
        )
        renameSync(tmp, file)
      } catch (err) {
        log.warn(`[store] 写入暂存文件失败：${err.message}`)
      }
    }
    if (immediate) write()
    else saveTimer = setTimeout(write, 300)
  }

  /** 数据库只保留最近 N 天（默认 14，管理员可调 1–14），暂存区同样不留过期快讯 */
  function retentionDays() {
    const d = Number(state.settings && state.settings.retention)
    return Number.isInteger(d) && d >= 1 && d <= 14 ? d : 14
  }

  /** 摘要去重阈值 X（数据库 crawler_settings.digest_x，经票据同步；默认 5） */
  function digestX() {
    const x = Number(state.settings && state.settings.digestX)
    return Number.isInteger(x) && x >= 1 && x <= 50 ? x : 5
  }

  const fresh = (it) => Number(it.display_time) * 1000 >= Date.now() - retentionDays() * DAY_MS
  const recentFresh = fresh // 摘要分组窗口 = 保留期（14 天）

  function dropKey(k) {
    state.items.delete(k)
    state.leases.delete(k)
  }

  function prune() {
    let n = 0
    for (const [k, it] of state.items) {
      const latest = state.known[it.source]
      const stale = latest && Number(it.display_time) < latest - STALE_SEC
      if (!fresh(it) || stale) {
        dropKey(k)
        n++
      }
    }
    // done 只需要记住「2 小时窗口」内的条目：更早的条目在 addItems 里本来就会被跳过
    for (const [k, t] of state.done) {
      const source = k.slice(0, k.indexOf(':'))
      const latest = state.known[source]
      if ((latest && Number(t) < latest - STALE_SEC) || Number(t) * 1000 < Date.now() - retentionDays() * DAY_MS) state.done.delete(k)
    }
    // 近期快讯按时间窗口裁剪，超量时丢最旧的
    for (const [k, it] of state.recent) if (!recentFresh(it)) state.recent.delete(k)
    if (state.recent.size > MAX_RECENT) {
      const all = [...state.recent.entries()].sort((a, b) => Number(a[1].display_time) - Number(b[1].display_time))
      for (const [k] of all.slice(0, state.recent.size - MAX_RECENT)) state.recent.delete(k)
    }
    // 摘要队列里早于保留期的清掉（数据库侧由 purge 同步清理）
    const digestCutoff = Date.now() / 1000 - retentionDays() * 86400
    for (const [gk, r] of state.digestPending) if (Number(r.last_time) < digestCutoff) state.digestPending.delete(gk)
    const now = Date.now()
    for (const [bid, b] of state.batches) if (now - b.at > LEASE_MS * 4) state.batches.delete(bid)
    return n
  }

  function addItems(source, items) {
    for (const it of items) {
      if (!fresh(it)) continue
      const latest = state.known[source]
      if (latest && Number(it.display_time) < latest - STALE_SEC) continue // 早已入库的旧条目
      const k = keyOf(source, it.source_id)
      if (!state.items.has(k) && !state.done.has(k)) state.items.set(k, it)
      // 近期快讯：无论是否已入库都保留（摘要分组需要已入库的旧成员）
      if (recentFresh(it)) state.recent.set(k, it)
    }
    const mine = [...state.items.entries()].filter(([, it]) => it.source === source)
    if (mine.length > MAX_ITEMS_PER_SOURCE) {
      mine.sort((a, b) => Number(b[1].display_time) - Number(a[1].display_time))
      for (const [k] of mine.slice(MAX_ITEMS_PER_SOURCE)) dropKey(k)
    }
  }

  /** 暂存区里有，或已确认入库 */
  const has = (source, sid) => state.items.has(keyOf(source, sid)) || state.done.has(keyOf(source, sid))

  /** 摘要历史回填：把数据库里已有的快讯塞进 recent 缓冲（不做去重限制，摘要分组用） */
  function addRecent(item) {
    const k = keyOf(item.source, item.source_id)
    if (state.recent.has(k)) return false
    if (!recentFresh(item)) return false
    state.recent.set(k, item)
    return true
  }

  function markBackfillDone() {
    if (!state.backfillDone) {
      state.backfillDone = true
      save(true)
    }
  }

  /**
   * 摘要分组：对近期快讯按 X 连字规则重新分组，与上一次入队的指纹比对，
   * 新增 / 有变化（新成员加入、代表变化、阈值变化）的组进待入库队列。每轮抓取后调用。
   */
  function refreshDigests() {
    prune()
    const x = digestX()
    const rows = computeDigests([...state.recent.values()], x)
    const keepKeys = new Set(rows.map((r) => r.group_key))
    const fp = (r) => JSON.stringify([r.rep_source, r.rep_source_id, r.refs.map((v) => `${v.source}:${v.source_id}`), x])
    // q = 入队时间戳：新产生（或有变化）的组优先下发，避免被回填的历史组堵在队尾
    for (const r of rows) {
      if (state.digestSent.get(r.group_key) !== fp(r)) {
        state.digestPending.set(r.group_key, { ...r, q: Date.now() })
        state.digestSent.set(r.group_key, fp(r))
      }
    }
    for (const gk of state.digestSent.keys()) if (!keepKeys.has(gk)) state.digestSent.delete(gk)
    save()
    return state.digestPending.size
  }

  function addRun(run) {
    state.runs.push(run)
    if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS)
  }

  /** 数据库里该来源最新的发布时间（秒）；null = 还没拿到过票据 */
  function knownLatest(source) {
    if (!state.knownAt) return null
    return Number(state.known[source]) || 0
  }

  function setGap(source, v) {
    state.gap[source] = !!v
  }

  /** 根据数据库签名的票据更新「数据库已有到哪里」 */
  function applyTicket(t) {
    if (t.latest && typeof t.latest === 'object') {
      const known = {}
      for (const [s, v] of Object.entries(t.latest)) if (Number.isFinite(Number(v))) known[s] = Number(v)
      state.known = known
      state.knownAt = Date.now()
    } else if (t.latest === null || t.latest === undefined) {
      // 旧版数据库函数（升级前）不带按来源的进度：不更新，避免误判
    }
    if (t.lr !== null && t.lr !== undefined) state.knownLastRunEpoch = Number(t.lr)
    const prevX = digestX()
    if (t.cs && (!state.settings || (t.cs.ts || 0) >= (state.settings.ts || 0))) state.settings = t.cs
    prune()
    // 去重阈值变了：清掉快照，全部摘要重新比对入队
    if (digestX() !== prevX) {
      state.digestSent.clear()
      refreshDigests()
    }
    save()
  }

  /** 待入库条目（未下发或下发已超时），按发布时间升序（先旧后新），每批混合各来源；摘要行同样取一批 */
  function takeBatch(limit, runLimit, digestLimit = 100) {
    prune()
    const now = Date.now()
    const items = [...state.items.entries()]
      .filter(([k]) => {
        const l = state.leases.get(k)
        return !l || l.until < now
      })
      .sort((a, b) => Number(a[1].display_time) - Number(b[1].display_time))
      .slice(0, limit)
    const after = state.knownLastRunEpoch ?? 0
    const runs = state.runs
      .filter((r) => !state.sentRuns.has(r.run_key) && Math.floor(new Date(r.started_at).getTime() / 1000) > after)
      .slice(-runLimit)
    // 摘要下发顺序：新入队（或刚变化）的组优先，剩下的名额才给历史回填的旧组。
    // 否则一次性回填的上千个历史组会按 first_time 升序堵在队尾之前，把新消息挤到几十批之后。
    const free = [...state.digestPending.entries()].filter(([gk]) => {
      const l = state.digestLeases.get(gk)
      return !l || l.until < now
    })
    const isHot = (r) => now - (Number(r.q) || 0) < DIGEST_HOT_MS
    // 热组：最新发布的先发，保证「全部」tab 顶部跟得上来源 tab
    const hot = free.filter(([, r]) => isHot(r)).sort((a, b) => Number(b[1].first_time) - Number(a[1].first_time))
    // 冷组（回填的历史组 / 排队超时）：先旧后新慢慢补齐
    const cold = free.filter(([, r]) => !isHot(r)).sort((a, b) => Number(a[1].first_time) - Number(b[1].first_time))
    const hotTake = Math.min(hot.length, Math.ceil(digestLimit * 0.7))
    const digests = [...hot.slice(0, hotTake), ...cold.slice(0, Math.max(0, digestLimit - hotTake))].map(([, r]) => r)
    if (!items.length && !runs.length && !digests.length) return null
    const bid = `b_${randomBytes(9).toString('base64url')}`
    for (const [k] of items) state.leases.set(k, { bid, until: now + LEASE_MS })
    for (const r of digests) state.digestLeases.set(r.group_key, { bid, until: now + LEASE_MS })
    state.batches.set(bid, { keys: items.map(([k]) => k), runKeys: runs.map((r) => r.run_key), digestKeys: digests.map((r) => r.group_key), at: now })
    return { bid, items: items.map(([, it]) => it), runs, digests }
  }

  /** 数据库收据确认：这一批（快讯 / 抓取记录 / 摘要）已处理完毕，移出暂存区 */
  function confirm(bid) {
    const b = state.batches.get(bid)
    if (!b) return 0
    let n = 0
    for (const k of b.keys) {
      const l = state.leases.get(k)
      if (l && l.bid === bid) {
        const it = state.items.get(k)
        if (it) state.done.set(k, Number(it.display_time))
        dropKey(k)
        n++
      }
    }
    for (const rk of b.runKeys) state.sentRuns.add(rk)
    for (const gk of b.digestKeys || []) {
      const l = state.digestLeases.get(gk)
      if (l && l.bid === bid) {
        state.digestPending.delete(gk)
        state.digestLeases.delete(gk)
      }
    }
    state.batches.delete(bid)
    save()
    return n
  }

  function pendingCount(source) {
    let n = 0
    for (const it of state.items.values()) if ((!source || it.source === source) && fresh(it)) n++
    return n
  }

  /** 待入库摘要数 */
  function pendingDigestCount() {
    return state.digestPending.size
  }

  /** 摘要分组缓冲（recent）诊断：规模、时间跨度、每个来源最新的几条（排障用） */
  function recentStats(topN = 5) {
    const bySource = {}
    let min = Infinity
    let max = 0
    let bad = 0
    for (const it of state.recent.values()) {
      const t = Number(it.display_time)
      if (!Number.isFinite(t)) {
        bad++
        continue
      }
      if (t < min) min = t
      if (t > max) max = t
      const arr = bySource[it.source] || (bySource[it.source] = [])
      arr.push([String(it.source_id), t])
    }
    const top = {}
    for (const [s, arr] of Object.entries(bySource)) {
      arr.sort((a, b) => b[1] - a[1])
      top[s] = arr.slice(0, topN).map(([sid, t]) => `${sid}@${t}`)
    }
    return {
      size: state.recent.size,
      badTime: bad,
      oldest: min === Infinity ? null : new Date(min * 1000).toISOString(),
      newest: max ? new Date(max * 1000).toISOString() : null,
      newestPerSource: top,
    }
  }

  /** 尚未确认的抓取记录数 */
  function pendingRunCount() {
    const after = state.knownLastRunEpoch ?? 0
    return state.runs.filter((r) => !state.sentRuns.has(r.run_key) && Math.floor(new Date(r.started_at).getTime() / 1000) > after).length
  }

  return {
    state,
    save,
    addItems,
    has,
    addRecent,
    markBackfillDone,
    isBackfillDone: () => state.backfillDone,
    addRun,
    applyTicket,
    takeBatch,
    confirm,
    pendingCount,
    pendingRunCount,
    pendingDigestCount,
    recentStats,
    refreshDigests,
    retentionDays,
    digestX,
    knownLatest,
    setGap,
    prune,
  }
}
