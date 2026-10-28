// 入口：登录门禁 → 加载数据 → 定时刷新
import { cloud, apiJson, clearTicket } from './cloud.js'
import { syncOnce } from './sync.js'
import { state, activeLlmConfig, providerById, searchSupport, sourceById } from './state.js'
import { $, $$, escapeHtml, fmtDateTime, relTime, toast, maskEmail, maskPhone, cloudErrorText } from './utils.js'
import { initAuth, resetAuthView } from './auth.js'
import { initFeed, loadFirst, loadStats, checkNew, resetFeed, restoreSource, renderTabs } from './feed.js'
import { initAnalysis, openAnalysis, closeDrawer, resumePendingAnalysis, hasPendingAnalysis } from './analysis.js'
import { initChat, resetChat } from './chat.js'
import { sameWatchlist, getWatchlist } from './watch.js'
import { initSettings, openSettings, closeSettings } from './settings.js'

let timers = []
let inApp = false

function show(view) {
  $('#bootView').hidden = view !== 'boot'
  $('#authView').hidden = view !== 'auth'
  $('#appView').hidden = view !== 'app'
}

// ---------- 抓取状态 ----------
/** 状态里各来源的最近一次抓取；旧版服务端没有 sources 字段时退回 lastRun */
function sourceRuns(st) {
  if (Array.isArray(st.sources) && st.sources.length) return st.sources.filter((s) => s.enabled !== false)
  return [{ id: 'wscn', shortName: '见闻', lastRun: st.lastRun }]
}

function renderStatus(st) {
  if (!st) return
  state.status = st
  const pill = $('#crawlPill')
  pill.classList.remove('is-running', 'is-error', 'is-off')
  const runs = sourceRuns(st)
  const failed = runs.filter((s) => s.lastRun && s.lastRun.status === 'error')
  const lastAt = runs.map((s) => s.lastRun && (s.lastRun.finished_at || s.lastRun.started_at)).filter(Boolean).sort().pop()
  let text
  if (!st.enabled) {
    pill.classList.add('is-off')
    text = '自动抓取已暂停'
  } else if (st.running) {
    pill.classList.add('is-running')
    text = '正在抓取最新快讯…'
  } else if (failed.length) {
    pill.classList.add('is-error')
    text = `${failed.map((s) => s.shortName || s.id).join('、')}上次抓取失败 · 稍后自动重试`
  } else {
    const added = runs
      .filter((s) => s.lastRun)
      .map((s) => `${s.shortName || s.id} +${s.lastRun.new_items ?? s.lastRun.inserted ?? 0}`)
      .join(' · ')
    text = `每 ${st.intervalMinutes} 分钟自动抓取 · 上次 ${lastAt ? relTime(lastAt) : '—'}${added ? ` · ${added}` : ''}`
  }
  pill.title = runs
    .map((s) => `${s.name || s.id}：${s.lastRun ? `${s.lastRun.status === 'ok' ? '成功' : '失败'}，${fmtDateTime(s.lastRun.finished_at || s.lastRun.started_at)}${s.lastRun.message ? `（${s.lastRun.message}）` : ''}` : '尚未抓取'}`)
    .join('\n')
  $('#crawlPillText').textContent = text
  renderSideCrawl()
}

/** 侧栏「自动抓取」卡片：显示当前 tab 对应来源的抓取情况 */
function renderSideCrawl() {
  const st = state.status
  if (!st) return
  const cur = sourceRuns(st).find((s) => s.id === state.source)
  const last = cur && cur.lastRun
  $('#kvInterval').textContent = `每 ${st.intervalMinutes} 分钟`
  $('#kvLast').textContent = last ? fmtDateTime(last.finished_at || last.started_at) : '—'
  $('#kvInserted').textContent = last
    ? last.status === 'ok'
      ? `${last.new_items ?? last.inserted ?? 0} 条`
      : '失败'
    : cur
      ? '尚未抓取'
      : '—'
  $('#kvInserted').title = last && last.status !== 'ok' ? last.message || '' : ''
  $('#kvNext').textContent = st.enabled && st.nextRunAt ? relTime(st.nextRunAt) : '已暂停'
}

async function refreshStatus() {
  try {
    renderStatus(await apiJson('/api/status', { auth: false }))
  } catch {
    $('#crawlPillText').textContent = '抓取状态暂不可用'
  }
}

/** 把服务端已抓取、尚未入库的快讯写入云数据库；有新数据时刷新列表 */
async function doSync({ silent = true } = {}) {
  try {
    const r = await syncOnce()
    if (r.status) renderStatus(r.status)
    if (r.inserted > 0) {
      loadStats().catch(() => {})
      await checkNew()
    }
    return r
  } catch (err) {
    if (!silent) toast(`同步失败：${cloudErrorText(err)}`, 'error')
    console.warn('[sync]', err && err.message)
    return null
  }
}

// ---------- 用户与配置 ----------
function renderIdentity() {
  const u = (state.session && state.session.user) || {}
  const label = u.phone ? maskPhone(u.phone) : u.email ? maskEmail(u.email) : '已登录用户'
  const initial = u.email ? u.email[0].toUpperCase() : u.phone ? String(u.phone).slice(-2) : '我'
  $('#avatarBtn').textContent = initial
  $('#menuIdentity').innerHTML = `<b>${escapeHtml(label)}</b>${state.me.isAdmin ? '管理员' : '普通用户'}`
}

async function refreshMe() {
  const { data, error } = await cloud.database.rpc('whoami')
  if (!error && data) state.me = { uid: data.uid, isAdmin: !!data.is_admin, hasAdmin: !!data.has_admin }
  renderIdentity()
}

function renderLlmHint() {
  const cfg = activeLlmConfig()
  const el = $('#llmHintText')
  const wl = getWatchlist()
  const watchLine = wl.length
    ? `<br/>关注 ${wl.length} 项：<b>${escapeHtml(wl.slice(0, 4).map((w) => w.name).join('、'))}${wl.length > 4 ? ' 等' : ''}</b>，分析时会评估对它们的短期与中长期影响。`
    : '<br/>还可以设置关注的板块 / 标的，分析时会额外评估对它们的影响。'
  if (cfg && cfg.apiKey) {
    const p = providerById(cfg.provider)
    const searching = cfg.webSearch && searchSupport(cfg.provider, cfg.model, cfg.baseUrl).ok
    el.innerHTML = `当前模型：<b>${escapeHtml(p ? p.name : cfg.provider)}</b> · ${escapeHtml(cfg.model || (p && p.defaultModel) || '')}${
      cfg.thinking ? ' · 深度思考' : ''
    }${searching ? ' · 联网搜索' : ''}<br/>点击快讯右侧「分析」即可生成深度解读，分析后可继续追问，结果自动保存。${watchLine}`
  } else {
    el.innerHTML = `尚未配置模型。点击快讯右侧「分析」前，请先在设置里填写 DeepSeek 或腾讯云 TokenHub 的 API Key。${watchLine}`
  }
}

async function loadLlmSettings() {
  const { data, error } = await cloud.database
    .from('user_llm_settings')
    .select('id, provider, configs, thinking, web_search, system_prompt, watchlist, updated_at')
    .maybeSingle()
  if (error) throw error
  state.llm = data || null
  renderLlmHint()
}

async function loadAnalysesIndex() {
  const { data, error } = await cloud.database
    .from('news_analysis')
    .select('id, news_id, sentiment, updated_at')
    .order('updated_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  state.analyses = new Map((data || []).map((r) => [r.news_id, { id: r.id, sentiment: r.sentiment, updated_at: r.updated_at }]))
}

// ---------- 数据保留期 ----------
const SOURCE_NOTE = {
  wscn: '华尔街见闻 7×24（编辑评级 2 级及以上，3 级标「重要」）',
  cls: '财联社电报（全部普通电报，加红电报标「重要」，付费栏目不收录）',
}
function renderRetention() {
  const d = state.retentionDays
  const note = SOURCE_NOTE[state.source] || sourceById(state.source).name
  $('#retentionNote').textContent = `当前来源：${note}。按来源分别去重；仅保留近 ${d} 天，过期自动清理。`
}

async function loadRetention() {
  const { data, error } = await cloud.database.from('crawler_settings').select('retention_days').eq('id', 1).maybeSingle()
  if (error) throw error
  if (data && data.retention_days) state.retentionDays = data.retention_days
  renderRetention()
}

function onRetentionChanged(days) {
  state.retentionDays = days
  renderRetention()
  loadFirst()
  loadStats().catch(() => {})
}

async function loadProviders() {
  const r = await apiJson('/api/providers')
  state.providers = r.providers || []
  state.defaultPrompt = r.defaultSystemPrompt || ''
  if (Array.isArray(r.sources) && r.sources.length) {
    const ids = state.sources.map((s) => s.id).join(',')
    state.sources = r.sources
    // 来源列表与页面上的 tab 不一致时重新渲染（服务端新增来源后页面自动跟上）
    if (ids !== r.sources.map((s) => s.id).join(',')) renderTabs()
  }
}

// ---------- 进入 / 离开 ----------
async function enterApp(session) {
  if (inApp) return
  inApp = true
  state.session = session
  show('app')
  renderIdentity()
  restoreSource()
  const results = await Promise.allSettled([refreshMe(), loadProviders(), loadLlmSettings(), loadAnalysesIndex(), loadRetention()])
  renderLlmHint() // 服务商列表与模型配置并行加载，全部完成后再渲染一次
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) toast(`部分数据加载失败：${cloudErrorText(failed.reason)}`, 'error')
  refreshStatus()
  // 先把服务端暂存的新快讯写入数据库，再加载列表
  const first = await doSync()
  loadFirst()
  loadStats().catch(() => {})
  if (first && first.inserted) toast(`已同步 ${first.inserted} 条新快讯`, 'success')
  timers.push(setInterval(() => doSync().then(() => checkNew().catch(() => {})), 60_000))
  timers.push(setInterval(refreshStatus, 60_000))
  timers.push(setInterval(() => loadStats().catch(() => {}), 5 * 60_000))
}

function leaveApp() {
  inApp = false
  timers.forEach(clearInterval)
  timers = []
  state.session = null
  state.llm = null
  state.analyses = new Map()
  state.me = { uid: null, isAdmin: false, hasAdmin: false }
  clearTicket()
  resetChat()
  closeDrawer()
  closeSettings()
  resetFeed()
  resetAuthView()
  show('auth')
}

async function logout() {
  await cloud.auth.signOut()
  leaveApp()
  toast('已退出登录')
}

function initTopbar() {
  $('#openSettings').addEventListener('click', () => openSettings('llm'))
  $$('[data-open-settings]').forEach((b) =>
    b.addEventListener('click', () => {
      $('#userMenu').hidden = true
      openSettings(b.dataset.openSettings)
    }),
  )
  $('#avatarBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    $('#userMenu').hidden = !$('#userMenu').hidden
  })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) $('#userMenu').hidden = true
  })
  $('#logoutBtn').addEventListener('click', logout)
  $('#crawlPill').addEventListener('click', () => openSettings('crawl'))
}

async function boot() {
  initAuth((session) => enterApp(session))
  initTopbar()
  initFeed({
    onAnalyze: (n) => openAnalysis(n),
    onNeedWatch: () => {
      openSettings('llm')
      setTimeout(() => $('#watchInput').focus(), 50)
    },
    onSourceChange: () => {
      renderRetention()
      renderSideCrawl()
    },
  })
  initAnalysis({ openSettings })
  initChat({ openSettings })
  initSettings({
    onLlmSaved: ({ prevWatch } = {}) => {
      renderLlmHint()
      // 关注列表变了：刷新列表上的「关注」标签与「与我相关」筛选
      if (!sameWatchlist(prevWatch, state.llm && state.llm.watchlist)) loadFirst()
      if (hasPendingAnalysis()) {
        closeSettings()
        resumePendingAnalysis()
      }
    },
    onStatus: renderStatus,
    onRetention: onRetentionChanged,
    onLogout: logout,
    refreshMe,
    onCrawled: async () => {
      const r = await doSync({ silent: false })
      if (r) toast(r.inserted ? `已入库 ${r.inserted} 条新快讯` : '没有新的快讯', r.inserted ? 'success' : 'info')
      loadFirst()
      loadStats().catch(() => {})
    },
  })

  cloud.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' && inApp) leaveApp()
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) state.session = session
  })

  const { data: session, error } = await cloud.auth.getSession()
  if (error || !session) {
    show('auth')
    return
  }
  enterApp(session)
}

boot().catch((err) => {
  console.error(err)
  $('#bootView').querySelector('.boot-text').textContent = `加载失败：${err.message || err}，请刷新重试`
})
