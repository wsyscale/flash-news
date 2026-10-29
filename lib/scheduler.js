// 进程内定时调度：每 checkEverySeconds 秒检查一次是否到期，到期即依次抓取各来源进暂存区。
// 抓取间隔优先级：环境变量 CRAWL_INTERVAL_MINUTES > 数据库 crawler_settings（网站管理员可改，经签名票据同步到服务端）> 默认 20 分钟
import { crawlSource, enabledSources, gapPages } from './crawler.js'
import { publicSources } from './sources/index.js'

export function createScheduler({ store, cfg, log = console }) {
  const state = { running: false, lastRunAt: 0, timer: null, bootAt: Date.now(), lastGapAt: {} }
  const sources = () => enabledSources(cfg)

  function lastRunOf(sourceId) {
    for (let i = store.state.runs.length - 1; i >= 0; i--) if (store.state.runs[i].source === sourceId) return store.state.runs[i]
    return null
  }

  // 恢复上次进程的最后一次抓取时间，避免每次重启都立刻重抓
  {
    const last = store.state.runs[store.state.runs.length - 1]
    if (last) state.lastRunAt = new Date(last.finished_at || last.started_at).getTime()
  }

  function settings() {
    const db = store.state.settings
    const s = {
      intervalMinutes: cfg.defaultIntervalMinutes,
      enabled: true,
      backfillPages: cfg.defaultBackfillPages,
      digestX: 5,
      source: 'default',
      updatedAt: null,
    }
    if (db) {
      s.intervalMinutes = db.interval
      s.enabled = db.enabled
      s.backfillPages = db.backfill
      if (Number.isFinite(Number(db.digestX))) s.digestX = Number(db.digestX)
      s.source = 'database'
      s.updatedAt = db.ts ? new Date(db.ts * 1000).toISOString() : null
    }
    if (cfg.intervalOverride) {
      s.intervalMinutes = cfg.intervalOverride
      s.source = 'env'
    }
    if (cfg.backfillOverride) s.backfillPages = cfg.backfillOverride
    return s
  }

  function waitMs() {
    const base = settings().intervalMinutes * 60_000
    const anyError = sources().some((s) => {
      const r = lastRunOf(s.id)
      return r && r.status === 'error'
    })
    return anyError ? Math.min(base, cfg.retryAfterErrorMinutes * 60_000) : base
  }

  function nextRunAt() {
    return state.lastRunAt ? state.lastRunAt + waitMs() : Date.now()
  }

  /** 依次抓取；only 指定只抓某些来源（补缺口时用） */
  async function runNow(trigger, only = null) {
    if (state.running) return { skipped: 'running' }
    state.running = true
    try {
      const s = settings()
      const runs = []
      for (const src of sources()) {
        if (only && !only.includes(src.id)) continue
        let maxPages = s.backfillPages
        if (trigger === 'gap') maxPages = store.knownLatest(src.id) === 0 ? s.backfillPages : gapPages(src.id, 40)
        runs.push(await crawlSource({ store, cfg, sourceId: src.id, maxPages, trigger, log }))
      }
      if (!only) state.lastRunAt = Date.now()
      // 每轮抓取后重新做跨来源摘要分组（增量：只有变化的组会进待入库队列）
      try {
        const pending = store.refreshDigests()
        if (pending) log.log(`[scheduler] 摘要分组完成，待入库摘要 ${pending} 组`)
      } catch (e) {
        log.error('[scheduler] 摘要分组失败', e)
      }
      return { runs, status: runs.every((r) => r.status === 'ok') ? 'ok' : 'error' }
    } finally {
      state.running = false
    }
  }

  /** trigger: schedule/startup 到期才抓；manual 强制；gap 补缺口 */
  async function tick(trigger = 'schedule', only = null) {
    if (cfg.disabled && trigger !== 'manual') return { skipped: 'disabled_by_env' }
    if (state.running) return { skipped: 'running' }
    if (trigger === 'manual' || trigger === 'gap') return runNow(trigger, only)
    if (!settings().enabled) return { skipped: 'disabled' }
    if (Date.now() < nextRunAt() - 5_000) return { skipped: 'not_due' }
    return runNow(trigger)
  }

  /** 收到新票据后：哪个来源存在缺口，就马上补抓那个来源 */
  function onTicket() {
    if (state.running || !store.state.knownAt) return
    const need = []
    for (const src of sources()) {
      if (!store.state.gap[src.id]) continue
      if (store.knownLatest(src.id) === 0) {
        store.setGap(src.id, false) // 数据库里还没有这个来源：启动时回补的几页即可，无需向前补齐
        continue
      }
      if (Date.now() - (state.lastGapAt[src.id] || 0) < 5 * 60_000) continue
      state.lastGapAt[src.id] = Date.now()
      need.push(src.id)
    }
    if (need.length) tick('gap', need).catch((e) => log.error('[scheduler] gap crawl failed', e))
  }

  function start() {
    if (cfg.disabled) {
      log.log('[scheduler] CRAWLER_DISABLED=1，本进程不执行定时抓取')
      return
    }
    setTimeout(() => tick('startup').catch((e) => log.error('[scheduler] startup tick failed', e)), 1_500)
    state.timer = setInterval(() => tick('schedule').catch((e) => log.error('[scheduler] tick failed', e)), cfg.checkEverySeconds * 1000)
    log.log(`[scheduler] 已启动：每 ${cfg.checkEverySeconds}s 检查一次，抓取间隔 ${settings().intervalMinutes} 分钟，来源 ${sources().map((s) => s.id).join(' + ')}`)
  }

  function stop() {
    if (state.timer) clearInterval(state.timer)
    state.timer = null
  }

  function status() {
    const s = settings()
    const enabled = s.enabled && !cfg.disabled
    const enabledIds = new Set(sources().map((x) => x.id))
    const perSource = publicSources().map((p) => ({
      ...p,
      enabled: enabledIds.has(p.id),
      lastRun: lastRunOf(p.id),
      pending: store.pendingCount(p.id),
    }))
    // 兼容旧前端：lastRun 取最近一次（任一来源）
    const lastRun = perSource.map((x) => x.lastRun).filter(Boolean).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] || null
    return {
      intervalMinutes: s.intervalMinutes,
      enabled,
      backfillPages: s.backfillPages,
      digestX: store.digestX(),
      settingsSource: s.source,
      settingsUpdatedAt: s.updatedAt,
      running: state.running,
      sources: perSource,
      lastRun,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      nextRunAt: enabled ? new Date(Math.max(nextRunAt(), Date.now())).toISOString() : null,
      pending: store.pendingCount(),
      pendingDigests: store.pendingDigestCount(),
      recent: store.recentStats(),
      retentionDays: store.retentionDays(),
      dbSyncedAt: store.state.knownAt ? new Date(store.state.knownAt).toISOString() : null,
      serverTime: new Date().toISOString(),
      bootAt: new Date(state.bootAt).toISOString(),
    }
  }

  return { start, stop, tick, runNow, status, onTicket, settings }
}
