// 服务端暂存区：抓到但尚未写入云数据库的快讯 + 抓取记录，落盘到 data/state.json 防止进程重启丢失
//
// 去重与确认：
//   · 暂存区按 (来源, source_id) 合并，重复抓到的条目只保留一份
//   · 条目交给浏览器入库后，只有拿到数据库签名的「收据」（ingest_signed 返回）才移出暂存区；
//     没拿到收据（浏览器中途关闭、网络失败）的批次，过一会儿会重新下发，数据库唯一约束保证不会重复入库
//   · 已确认入库的条目记在 done 里（来源:id → 发布时间），之后重新抓到不会再进暂存区；
//   · 发布时间早于数据库里该来源最新时间 2 小时以上的条目视为已入库，直接清掉（兜底，防止暂存区无限增长）
// 旧版暂存文件（只有华尔街见闻、按 wscn_id 存）启动时自动迁移。
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const MAX_ITEMS_PER_SOURCE = 3000
const MAX_RUNS = 300
const DAY_MS = 86_400_000
const LEASE_MS = 3 * 60_000 // 下发后等收据的时间，超时可重新下发
const STALE_SEC = 2 * 3600 // 比数据库最新时间早这么多的暂存条目直接清掉

export function createStore(dataDir, log = console) {
  const file = path.join(dataDir, 'state.json')
  const state = {
    items: new Map(), // `${source}:${source_id}` -> item
    done: new Map(), // `${source}:${source_id}` -> display_time：已确认入库，重新抓到时跳过
    leases: new Map(), // key -> { bid, until }：已下发、等待数据库收据
    batches: new Map(), // bid -> { keys, runKeys, at }
    runs: [], // 最近的抓取记录（含 run_key、source）
    sentRuns: new Set(), // 已确认写入数据库的抓取记录 run_key
    known: {}, // 来源 -> 数据库中最新发布时间（秒，来自数据库签名的票据）；0 = 数据库里还没有该来源
    knownAt: 0,
    knownLastRunEpoch: null, // 数据库中最近一条抓取记录的开始时间（秒）
    settings: null, // 数据库 crawler_settings（来自票据）：{ interval, enabled, backfill, retention, ts }
    gap: {}, // 来源 -> 暂存区与数据库之间可能有缺口，需要向前翻页补齐
  }
  const keyOf = (source, sid) => `${source}:${sid}`

  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const it of raw.items || []) {
        // 旧格式：{ wscn_id, ... } → { source: 'wscn', source_id, ... }
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
      log.log(`[store] 已从磁盘恢复 ${state.items.size} 条暂存快讯`)
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
            v: 2,
            items: [...state.items.values()],
            runs: state.runs,
            sentRuns: [...state.sentRuns].slice(-MAX_RUNS * 2),
            done: [...state.done.entries()],
            known: state.known,
            knownAt: state.knownAt,
            knownLastRunEpoch: state.knownLastRunEpoch,
            settings: state.settings,
            gap: state.gap,
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
  const fresh = (it) => Number(it.display_time) * 1000 >= Date.now() - retentionDays() * DAY_MS

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
    }
    const mine = [...state.items.entries()].filter(([, it]) => it.source === source)
    if (mine.length > MAX_ITEMS_PER_SOURCE) {
      mine.sort((a, b) => Number(b[1].display_time) - Number(a[1].display_time))
      for (const [k] of mine.slice(MAX_ITEMS_PER_SOURCE)) dropKey(k)
    }
  }

  /** 暂存区里有，或已确认入库 */
  const has = (source, sid) => state.items.has(keyOf(source, sid)) || state.done.has(keyOf(source, sid))

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
    if (t.cs && (!state.settings || (t.cs.ts || 0) >= (state.settings.ts || 0))) state.settings = t.cs
    prune()
    save()
  }

  /** 待入库条目（未下发或下发已超时），按发布时间升序（先旧后新），每批混合各来源 */
  function takeBatch(limit, runLimit) {
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
    if (!items.length && !runs.length) return null
    const bid = `b_${randomBytes(9).toString('base64url')}`
    for (const [k] of items) state.leases.set(k, { bid, until: now + LEASE_MS })
    state.batches.set(bid, { keys: items.map(([k]) => k), runKeys: runs.map((r) => r.run_key), at: now })
    return { bid, items: items.map(([, it]) => it), runs }
  }

  /** 数据库收据确认：这一批已处理完毕，移出暂存区 */
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
    state.batches.delete(bid)
    save()
    return n
  }

  function pendingCount(source) {
    let n = 0
    for (const it of state.items.values()) if ((!source || it.source === source) && fresh(it)) n++
    return n
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
    addRun,
    applyTicket,
    takeBatch,
    confirm,
    pendingCount,
    pendingRunCount,
    retentionDays,
    knownLatest,
    setGap,
    prune,
  }
}
