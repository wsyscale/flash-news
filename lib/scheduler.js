// 进程内定时调度：每 checkEverySeconds 秒检查一次是否到期，到期即抓取进暂存区。
// 抓取间隔优先级：环境变量 CRAWL_INTERVAL_MINUTES > 数据库 crawler_settings（网站管理员可改，经签名票据同步到服务端）> 默认 20 分钟
import { crawlToStore } from './crawler.js'

const GAP_MAX_PAGES = 40

export function createScheduler({ store, cfg, log = console }) {
  const state = { running: false, lastRun: null, lastRunAt: 0, timer: null, bootAt: Date.now(), lastGapAt: 0 }

  // 恢复上次进程的最后一次抓取时间，避免每次重启都立刻重抓
  const persisted = store.state.runs[store.state.runs.length - 1]
  if (persisted) {
    state.lastRun = persisted
    state.lastRunAt = new Date(persisted.finished_at || persisted.started_at).getTime()
  }

  function settings() {
    const db = store.state.settings
    const s = {
      intervalMinutes: cfg.defaultIntervalMinutes,
      enabled: true,
      backfillPages: cfg.defaultBackfillPages,
      source: 'default',
      updatedAt: null,
    }
    if (db) {
      s.intervalMinutes = db.interval
      s.enabled = db.enabled
      s.backfillPages = db.backfill
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
    if (state.lastRun && state.lastRun.status === 'error') return Math.min(base, cfg.retryAfterErrorMinutes * 60_000)
    return base
  }

  function nextRunAt() {
    return state.lastRunAt ? state.lastRunAt + waitMs() : Date.now()
  }

  async function runNow(trigger) {
    if (state.running) return { skipped: 'running' }
    state.running = true
    try {
      const s = settings()
      let maxPages = s.backfillPages
      if (trigger === 'gap') maxPages = store.state.knownLatest === 0 ? s.backfillPages : GAP_MAX_PAGES
      const run = await crawlToStore({ store, cfg, maxPages, trigger, log })
      state.lastRun = run
      state.lastRunAt = Date.now()
      return run
    } finally {
      state.running = false
    }
  }

  /** trigger: schedule/startup 到期才抓；manual 强制；gap 补缺口 */
  async function tick(trigger = 'schedule') {
    if (cfg.disabled && trigger !== 'manual') return { skipped: 'disabled_by_env' }
    if (state.running) return { skipped: 'running' }
    if (trigger === 'manual' || trigger === 'gap') return runNow(trigger)
    if (!settings().enabled) return { skipped: 'disabled' }
    if (Date.now() < nextRunAt() - 5_000) return { skipped: 'not_due' }
    return runNow(trigger)
  }

  /** 收到新票据后：若存在缺口，马上补抓 */
  function onTicket() {
    if (!store.state.gapSuspected || store.state.knownLatest === null) return
    if (store.state.knownLatest === 0) {
      store.state.gapSuspected = false // 数据库为空：启动时回补的几页即可，无需向前补齐
      return
    }
    if (state.running || Date.now() - state.lastGapAt < 5 * 60_000) return
    state.lastGapAt = Date.now()
    tick('gap').catch((e) => log.error('[scheduler] gap crawl failed', e))
  }

  function start() {
    if (cfg.disabled) {
      log.log('[scheduler] CRAWLER_DISABLED=1，本进程不执行定时抓取')
      return
    }
    setTimeout(() => tick('startup').catch((e) => log.error('[scheduler] startup tick failed', e)), 1_500)
    state.timer = setInterval(() => tick('schedule').catch((e) => log.error('[scheduler] tick failed', e)), cfg.checkEverySeconds * 1000)
    log.log(`[scheduler] 已启动：每 ${cfg.checkEverySeconds}s 检查一次，抓取间隔 ${settings().intervalMinutes} 分钟`)
  }

  function stop() {
    if (state.timer) clearInterval(state.timer)
    state.timer = null
  }

  function status() {
    const s = settings()
    const enabled = s.enabled && !cfg.disabled
    return {
      intervalMinutes: s.intervalMinutes,
      enabled,
      backfillPages: s.backfillPages,
      settingsSource: s.source,
      settingsUpdatedAt: s.updatedAt,
      running: state.running,
      lastRun: state.lastRun,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      nextRunAt: enabled ? new Date(Math.max(nextRunAt(), Date.now())).toISOString() : null,
      pending: store.pendingCount(),
      retentionDays: store.retentionDays(),
      dbSyncedAt: store.state.knownLatestAt ? new Date(store.state.knownLatestAt).toISOString() : null,
      serverTime: new Date().toISOString(),
      bootAt: new Date(state.bootAt).toISOString(),
    }
  }

  return { start, stop, tick, runNow, status, onTicket, settings }
}
