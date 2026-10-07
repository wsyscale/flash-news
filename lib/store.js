// 服务端暂存区：抓到但尚未写入云数据库的快讯 + 抓取记录，落盘到 data/state.json 防止进程重启丢失
// 去重分三层：暂存区按 wscn_id 合并 → 只下发 id 大于数据库最新 id 的条目 → 数据库唯一约束兜底
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'

const MAX_ITEMS = 3000
const MAX_RUNS = 300
const DAY_MS = 86_400_000

export function createStore(dataDir, log = console) {
  const file = path.join(dataDir, 'state.json')
  const state = {
    items: new Map(), // wscn_id(string) -> item
    runs: [], // 最近的抓取记录（含 run_key）
    knownLatest: null, // 数据库中最大的 wscn_id（来自数据库签名的票据）
    knownLatestAt: 0,
    knownLastRunEpoch: null, // 数据库中最近一条抓取记录的开始时间（秒）
    settings: null, // 数据库 crawler_settings（来自票据）：{ interval, enabled, backfill, ts }
    gapSuspected: false, // 暂存区与数据库之间可能有缺口，需要向前翻页补齐
  }

  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const it of raw.items || []) state.items.set(String(it.wscn_id), it)
      state.runs = Array.isArray(raw.runs) ? raw.runs.slice(-MAX_RUNS) : []
      state.knownLatest = raw.knownLatest ?? null
      state.knownLatestAt = raw.knownLatestAt || 0
      state.knownLastRunEpoch = raw.knownLastRunEpoch ?? null
      state.settings = raw.settings || null
      state.gapSuspected = !!raw.gapSuspected
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
            items: [...state.items.values()],
            runs: state.runs,
            knownLatest: state.knownLatest,
            knownLatestAt: state.knownLatestAt,
            knownLastRunEpoch: state.knownLastRunEpoch,
            settings: state.settings,
            gapSuspected: state.gapSuspected,
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

  const idNum = (id) => Number(id)

  /** 数据库只保留最近 N 天（默认 14，管理员可调 1–14），暂存区同样不留过期快讯 */
  function retentionDays() {
    const d = Number(state.settings && state.settings.retention)
    return Number.isInteger(d) && d >= 1 && d <= 14 ? d : 14
  }
  const fresh = (it) => Number(it.display_time) * 1000 >= Date.now() - retentionDays() * DAY_MS

  function pruneExpired() {
    let n = 0
    for (const [k, it] of state.items) {
      if (!fresh(it)) {
        state.items.delete(k)
        n++
      }
    }
    return n
  }

  function addItems(items) {
    for (const it of items) if (fresh(it)) state.items.set(String(it.wscn_id), it)
    if (state.items.size > MAX_ITEMS) {
      const sorted = [...state.items.keys()].sort((a, b) => idNum(b) - idNum(a))
      for (const k of sorted.slice(MAX_ITEMS)) state.items.delete(k)
    }
  }

  function has(id) {
    return state.items.has(String(id))
  }

  function addRun(run) {
    state.runs.push(run)
    if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS)
  }

  /** 根据数据库签名的票据更新「数据库已有到哪里」，并清理已入库的暂存 */
  function applyTicket(t) {
    if (t.latest !== null && t.latest !== undefined) {
      const latest = Number(t.latest)
      if (Number.isFinite(latest)) {
        state.knownLatest = latest
        state.knownLatestAt = Date.now()
        for (const k of [...state.items.keys()]) if (idNum(k) <= latest) state.items.delete(k)
      }
    } else {
      state.knownLatest = 0 // 数据库为空
      state.knownLatestAt = Date.now()
    }
    if (t.lr !== null && t.lr !== undefined) state.knownLastRunEpoch = Number(t.lr)
    if (t.cs && (!state.settings || (t.cs.ts || 0) >= (state.settings.ts || 0))) state.settings = t.cs
    pruneExpired()
    save()
  }

  /** 待入库条目：id 大于数据库最新 id，按 id 升序（先旧后新，保证分批入库不漏） */
  function pendingItems(limit) {
    const floor = state.knownLatest ?? -1
    pruneExpired()
    return [...state.items.values()]
      .filter((it) => idNum(it.wscn_id) > floor)
      .sort((a, b) => idNum(a.wscn_id) - idNum(b.wscn_id))
      .slice(0, limit)
  }

  function pendingCount() {
    const floor = state.knownLatest ?? -1
    let n = 0
    for (const [k, it] of state.items) if (idNum(k) > floor && fresh(it)) n++
    return n
  }

  function pendingRuns(limit) {
    const after = state.knownLastRunEpoch ?? 0
    return state.runs.filter((r) => Math.floor(new Date(r.started_at).getTime() / 1000) > after).slice(-limit)
  }

  return { state, save, addItems, has, addRun, applyTicket, pendingItems, pendingCount, pendingRuns, retentionDays, pruneExpired }
}
