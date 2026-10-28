// 快讯时间线：来源 tab、分页、搜索、筛选、新消息提示、今日统计
import { cloud } from './cloud.js'
import { state, SENTIMENT, sourceById, getDedupX } from './state.js'
import { $, $$, escapeHtml, fmtTime, dayKey, dayLabel, debounce, cloudErrorText, toast } from './utils.js'
import { matchWatch, relatedOrFilter } from './watch.js'

const PAGE = 30
const COLS = 'id, source, source_id, title, content_text, content_more, score, channels, uri, article, images, symbols, tags, display_time'
const TAB_KEY = 'flash-news.source'
const CHANNELS = {
  'a-stock-channel': 'A股',
  'hk-stock-channel': '港股',
  'us-stock-channel': '美股',
  'forex-channel': '外汇',
  'oil-channel': '原油',
  'gold-channel': '黄金',
  'goldc-channel': '黄金',
  'gold-forex-channel': '黄金',
  'commodity-channel': '商品',
  'bond-channel': '债券',
  'financing-channel': '投融资',
}

const feed = {
  filter: 'all',
  keyword: '',
  offset: 0,
  total: null,
  loading: false,
  ended: false,
  lastDay: null,
  newestTime: null, // 当前 tab 列表里最新一条的时间（「有 N 条新快讯」提示用）
  seenTime: {}, // 每个来源看过的最新时间（另一个 tab 上的未读角标用）
  seq: 0,
  rows: [], // 「全部」tab 已加载的原始条目（跨页累积，去重在渲染前做）
  visibleCount: 0, // 「全部」tab 去重后展示的条数
  onSourceChange: () => {},
  onAnalyze: () => {},
  onNeedWatch: () => {},
}

/** 真实来源（不含虚拟的 all） */
function realSources() {
  return state.sources.filter((s) => s.id !== 'all')
}

function sanitizeKeyword(s) {
  return String(s || '')
    .replace(/[,()*%\\:."']/g, ' ')
    .trim()
    .slice(0, 40)
}

async function analyzedIds() {
  const { data, error } = await cloud.database
    .from('news_analysis')
    .select('news_id')
    .order('updated_at', { ascending: false })
    .limit(1000)
  if (error) throw error
  return (data || []).map((r) => r.news_id)
}

// 注意：查询构造器是 thenable，不能直接从 async 函数 return（会被自动执行），所以包一层对象
async function buildQuery(withCount) {
  let q = cloud.database
    .from('news_flash')
    .select(COLS, withCount ? { count: 'exact' } : undefined)
  // 「全部」tab 不按来源过滤，整合所有来源
  if (state.source !== 'all') q = q.eq('source', state.source)
  q = q
    .order('display_time', { ascending: false })
    .order('id', { ascending: false })
  if (feed.filter === 'important') q = q.gte('score', 3)
  if (feed.filter === 'related') q = q.or(relatedOrFilter())
  if (feed.filter === 'analyzed') {
    const ids = await analyzedIds()
    q = q.in('id', ids.length ? ids : [-1])
  }
  const kw = sanitizeKeyword(feed.keyword)
  if (kw) {
    // 多个词按先后顺序模糊匹配：「美联储 降息」→ *美联储*降息*
    const pattern = kw.split(/\s+/).filter(Boolean).slice(0, 4).join('*')
    q = q.or(`title.ilike.*${pattern}*,content_text.ilike.*${pattern}*`)
  }
  return { q }
}

function channelTags(channels) {
  const seen = new Set()
  const out = []
  for (const c of channels || []) {
    const label = CHANNELS[c]
    if (label && !seen.has(label)) {
      seen.add(label)
      out.push(label)
    }
  }
  return out.slice(0, 4)
}

/** 来源标注的相关个股（财联社电报带）；点击跳转到对应来源的详情 / 行情不做，只展示 */
function stockChips(symbols) {
  const list = (Array.isArray(symbols) ? symbols : []).filter((s) => s && s.name).slice(0, 4)
  if (!list.length) return ''
  const more = (symbols.length || 0) - list.length
  return (
    list.map((s) => `<span class="stock-chip" title="${escapeHtml([s.name, s.code || s.key, s.market].filter(Boolean).join(' · '))}">${escapeHtml(s.name)}</span>`).join('') +
    (more > 0 ? `<span class="stock-chip" title="${escapeHtml(symbols.slice(4).map((s) => s.name).join('、'))}">+${more}</span>` : '')
  )
}

function topicTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .filter(Boolean)
    .slice(0, 2)
    .map((t) => `<span class="tag topic">${escapeHtml(t)}</span>`)
    .join('')
}

function sentimentBadge(newsId) {
  const a = state.analyses.get(newsId)
  if (!a) return ''
  const s = SENTIMENT[a.sentiment]
  if (!s) return `<span class="sentiment neu" data-open="${newsId}">已分析</span>`
  return `<span class="sentiment ${s.cls}" data-open="${newsId}" title="查看 AI 分析">AI：${s.text}</span>`
}

function renderItem(n) {
  const important = n.score >= 3
  const hasTitle = !!(n.title && n.title.trim())
  const text = n.content_text || ''
  const long = text.length > 180
  const tags = channelTags(n.channels)
  const isCls = n.source === 'cls'
  const imgs = Array.isArray(n.images) ? n.images.slice(0, 4) : []
  const done = state.analyses.has(n.id)
  const art = n.article && n.article.uri ? n.article : null
  const watched = matchWatch(n)
  const dupTag =
    n._dup && n._dup.sources.length > 1
      ? `<span class="tag dup" title="${escapeHtml('被 ' + n._dup.sources.map((s) => sourceById(s).name).join('、') + ' 重复报道，此处保留最早发布的一条')}">${n._dup.sources.length} 家来源报道</span>`
      : ''
  const watchTag = watched.length
    ? `<span class="tag watch" title="${escapeHtml(watched.map((w) => w.name).join('、'))}">关注：${escapeHtml(watched.slice(0, 2).map((w) => w.name).join('、'))}${
        watched.length > 2 ? ` 等 ${watched.length} 项` : ''
      }</span>`
    : ''
  return `
  <article class="flash${important ? ' is-important' : ''}${hasTitle ? '' : ' no-title'}" data-id="${n.id}" data-source="${escapeHtml(n.source || 'wscn')}">
    <div class="flash-time">${fmtTime(n.display_time)}</div>
    <div class="flash-body">
      ${hasTitle ? `<h3 class="flash-title">${escapeHtml(n.title)}</h3>` : ''}
      <div class="flash-text${long ? ' clamp' : ''}">${escapeHtml(text)}</div>
      ${long ? '<button type="button" class="expand-btn" data-expand>展开全文</button>' : ''}
      ${n.content_more ? `<button type="button" class="expand-btn" data-more>查看补充内容</button><div class="flash-more" hidden></div>` : ''}
      ${imgs.length ? `<div class="flash-imgs">${imgs.map((u) => `<img src="${escapeHtml(u)}" loading="lazy" referrerpolicy="no-referrer" alt="" data-zoom />`).join('')}</div>` : ''}
      <div class="flash-meta">
        ${important ? '<span class="tag imp">重要</span>' : ''}
        ${dupTag}
        ${watchTag}
        ${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
        ${isCls ? topicTags(n.tags) : ''}
        ${isCls ? stockChips(n.symbols) : ''}
        ${sentimentBadge(n.id)}
        ${art ? `<a class="meta-link" href="${escapeHtml(art.uri)}" target="_blank" rel="noopener noreferrer">相关：${escapeHtml((art.title || '').slice(0, 28))}</a>` : ''}
        ${n.uri ? `<a class="meta-link" href="${escapeHtml(n.uri)}" target="_blank" rel="noopener noreferrer">原文 ↗</a>` : ''}
      </div>
    </div>
    <div class="flash-action">
      <button type="button" class="btn-analyze${done ? ' done' : ''}" data-analyze="${n.id}">${done ? '查看分析' : '分析'}</button>
    </div>
  </article>`
}

/**
 * 「全部」tab 跨来源去重：两条快讯的（标题+正文）里存在至少 X 个连续相同的字 → 判为同一条（并查集合并）。
 * 只统计含汉字的片段，避免纯数字 / 代码 / 英文报错号互相误判。
 * 每组保留最早发布的一条，并记 _dup = { count, sources } 供渲染「N 家来源报道」标签。
 */
function dedupAll(rows, x) {
  if (!Number.isInteger(x) || x < 2 || rows.length < 2) return rows
  const n = rows.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a, b) => {
    a = find(a)
    b = find(b)
    if (a !== b) parent[b] = a
  }
  const gramMap = new Map() // X 连字 → 第一次出现的行号
  for (let i = 0; i < n; i++) {
    const text = (String(rows[i].title || '') + String(rows[i].content_text || '')).replace(/\s+/g, '')
    for (let j = 0; j + x <= text.length; j++) {
      const g = text.slice(j, j + x)
      if (!/[\u4e00-\u9fff]/.test(g)) continue
      const first = gramMap.get(g)
      if (first === undefined) gramMap.set(g, i)
      else if (first !== i) union(first, i)
    }
  }
  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(rows[i])
  }
  const out = []
  for (const g of groups.values()) {
    g.sort((a, b) => new Date(a.display_time) - new Date(b.display_time)) // 最早发布的排前
    const rep = g[0]
    rep._dup = g.length > 1 ? { count: g.length, sources: [...new Set(g.map((r) => r.source))] } : null
    out.push(rep)
  }
  out.sort((a, b) => new Date(b.display_time) - new Date(a.display_time) || b.id - a.id)
  return out
}

/** 单页 / 加载更多之后统一走这里：普通来源直接追加渲染，「全部」跨页累积后整体去重重渲染 */
function applyRows(rows, append) {
  if (state.source !== 'all') {
    renderRows(rows, append)
    feed.visibleCount = rows.length
    return
  }
  feed.rows = append ? feed.rows.concat(rows) : rows.slice()
  const visible = dedupAll(feed.rows, getDedupX())
  feed.visibleCount = visible.length
  renderRows(visible, false)
}

function renderRows(rows, append) {
  const list = $('#feedList')
  if (!append) {
    list.innerHTML = ''
    feed.lastDay = null
  }
  let html = ''
  for (const n of rows) {
    state.news.set(n.id, n)
    const k = dayKey(n.display_time)
    if (k !== feed.lastDay) {
      feed.lastDay = k
      const lab = dayLabel(n.display_time)
      html += `<div class="day-head">${lab.badge ? `<span class="badge-day">${lab.badge}</span>` : ''}${lab.text}</div>`
    }
    html += renderItem(n)
  }
  list.insertAdjacentHTML('beforeend', html)
}

function skeleton() {
  $('#feedList').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"><i></i><i></i></div>').join('')
}

function updateFoot() {
  $('#loadMore').hidden = feed.ended || feed.loading
  $('#feedEnd').hidden = !feed.ended || feed.offset === 0
}

function updateCount() {
  const src = sourceById(state.source).name
  const isAll = state.source === 'all'
  const label = { all: isAll ? '全部来源（跨来源去重）' : src, important: `${src} · 重要`, related: `${src} · 与我关注相关`, analyzed: `${src} · 我分析过` }[feed.filter]
  const kw = sanitizeKeyword(feed.keyword)
  if (feed.total === null) {
    $('#feedCount').textContent = '加载中…'
    return
  }
  const dedupInfo = isAll && !kw ? ` · 去重后 ${feed.visibleCount.toLocaleString()} 条` : ''
  $('#feedCount').textContent =
    `${kw ? `${src}「${kw}」搜索结果` : label} · 共 ${feed.total.toLocaleString()} 条${dedupInfo} · 保留近 ${state.retentionDays} 天`
}

export async function loadFirst() {
  const seq = ++feed.seq
  feed.offset = 0
  feed.ended = false
  feed.total = null
  feed.loading = true
  feed.rows = []
  feed.visibleCount = 0
  $('#newBanner').hidden = true
  updateCount()
  updateFoot()
  skeleton()
  try {
    // 还没设置关注项时「与我相关」不必查询
    if (feed.filter === 'related' && !relatedOrFilter()) {
      feed.total = 0
      feed.ended = true
      $('#feedList').innerHTML =
        '<div class="empty">还没有设置关注的板块 / 标的。<button type="button" class="link-btn" id="goWatch">去设置 →</button></div>'
      $('#goWatch').addEventListener('click', () => feed.onNeedWatch())
      return
    }
    const { q } = await buildQuery(true)
    const { data, error, count } = await q.range(0, PAGE - 1)
    if (seq !== feed.seq) return
    if (error) throw error
    const rows = data || []
    feed.total = typeof count === 'number' ? count : rows.length
    feed.offset = rows.length
    feed.ended = rows.length < PAGE
    if (!rows.length) {
      $('#feedList').innerHTML = `<div class="empty">${
        feed.filter === 'related'
          ? '近期快讯中暂未提到你关注的板块 / 标的'
          : feed.filter === 'analyzed'
            ? '还没有分析过的快讯，点击快讯右侧「分析」试试'
            : feed.keyword
              ? '没有找到相关快讯'
              : '暂无快讯，稍后自动抓取后将显示在这里'
      }</div>`
    } else {
      applyRows(rows, false)
    }
    if (feed.filter === 'all' && !feed.keyword && rows[0]) {
      feed.newestTime = rows[0].display_time
      feed.seenTime[state.source] = rows[0].display_time
    }
  } catch (err) {
    if (seq !== feed.seq) return
    $('#feedList').innerHTML = `<div class="empty">加载失败：${escapeHtml(cloudErrorText(err))} <button type="button" class="link-btn" id="retryFeed">重试</button></div>`
    $('#retryFeed')?.addEventListener('click', loadFirst)
  } finally {
    if (seq === feed.seq) {
      feed.loading = false
      updateCount()
      updateFoot()
    }
  }
}

async function loadMore() {
  if (feed.loading || feed.ended) return
  const seq = feed.seq
  feed.loading = true
  updateFoot()
  try {
    const { q } = await buildQuery(false)
    const { data, error } = await q.range(feed.offset, feed.offset + PAGE - 1)
    if (seq !== feed.seq) return
    if (error) throw error
    const rows = data || []
    feed.offset += rows.length
    feed.ended = rows.length < PAGE
    applyRows(rows, true)
  } catch (err) {
    toast(`加载失败：${cloudErrorText(err)}`, 'error')
  } finally {
    if (seq === feed.seq) {
      feed.loading = false
      updateFoot()
    }
  }
}

/** 轮询：当前 tab 是否有比列表更新的快讯；其他 tab 显示未读角标 */
export async function checkNew() {
  const real = realSources()
  const tasks = real.map(async (s) => {
    const since = s.id === state.source ? feed.newestTime : feed.seenTime[s.id]
    if (!since) return [s.id, 0]
    const { count, error } = await cloud.database
      .from('news_flash')
      .select('id', { count: 'exact', head: true })
      .eq('source', s.id)
      .gt('display_time', since)
    return [s.id, error ? 0 : count || 0]
  })
  const counts = Object.fromEntries(await Promise.all(tasks))
  for (const s of real) if (s.id !== state.source) setTabBadge(s.id, counts[s.id])
  if (feed.filter !== 'all' || feed.keyword) return
  // 「全部」tab 的新快讯数 = 各来源之和；来源 tab = 自己的
  const n =
    state.source === 'all'
      ? real.reduce((t, s) => t + (counts[s.id] || 0), 0)
      : counts[state.source] || 0
  if (!n) return
  const b = $('#newBanner')
  b.textContent = `有 ${n} 条新快讯，点击查看`
  b.hidden = false
  document.title = `(${n}) 快讯分析台`
}

function setTabBadge(sourceId, n) {
  const el = $(`#sourceTabs [data-source="${sourceId}"] .tab-badge`)
  if (!el) return
  el.hidden = !n
  el.textContent = n > 99 ? '99+' : String(n || '')
}

/** 其他 tab 的未读起点：首次进入时用该来源最新一条的时间 */
async function initSeen() {
  await Promise.all(
    realSources()
      .filter((s) => s.id !== state.source && !feed.seenTime[s.id])
      .map(async (s) => {
        const { data } = await cloud.database.from('news_flash').select('display_time').eq('source', s.id).order('display_time', { ascending: false }).limit(1)
        if (data && data[0]) feed.seenTime[s.id] = data[0].display_time
      }),
  )
}

export function renderTabs() {
  // 来源列表以服务端 /api/providers 为准：tab 按钮动态生成（新增来源无需改页面）
  const box = $('#sourceTabs')
  const want = state.sources.map((s) => s.id).join(',')
  const cur = $$('#sourceTabs [data-source]').map((t) => t.dataset.source).join(',')
  if (want !== cur) {
    box.innerHTML = state.sources
      .map(
        (s) =>
          `<button type="button" class="source-tab" role="tab" aria-selected="false" data-source="${escapeHtml(s.id)}">${escapeHtml(s.name)}<span class="tab-badge" hidden></span></button>`,
      )
      .join('')
  }
  $$('#sourceTabs [data-source]').forEach((t) => {
    const on = t.dataset.source === state.source
    t.classList.toggle('is-active', on)
    t.setAttribute('aria-selected', on ? 'true' : 'false')
  })
}

/** 切换来源 tab：记住选择，重新加载列表与统计 */
export function setSource(id, { reload = true } = {}) {
  if (!state.sources.some((s) => s.id === id)) return
  if (id !== state.source) {
    state.source = id
    feed.newestTime = null
    try {
      localStorage.setItem(TAB_KEY, id)
    } catch {
      /* ignore */
    }
  }
  setTabBadge(id, 0)
  renderTabs()
  document.title = '快讯分析台 · 7×24 快讯 + AI 深度解读'
  feed.onSourceChange(id)
  if (reload) {
    loadFirst()
    loadStats().catch(() => {})
  }
}

/** 恢复上次看的 tab */
export function restoreSource() {
  let id = null
  try {
    id = localStorage.getItem(TAB_KEY)
  } catch {
    /* ignore */
  }
  setSource(state.sources.some((s) => s.id === id) ? id : state.sources[0].id, { reload: false })
  initSeen().catch(() => {})
}

export async function loadStats() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const iso = start.toISOString()
  const src = state.source
  const all = src === 'all'
  const srcQ = (q) => (all ? q : q.eq('source', src))
  const [today, imp, mine] = await Promise.all([
    srcQ(cloud.database.from('news_flash').select('id', { count: 'exact', head: true })).gte('display_time', iso),
    srcQ(cloud.database.from('news_flash').select('id', { count: 'exact', head: true })).gte('display_time', iso).gte('score', 3),
    cloud.database.from('news_analysis').select('id', { count: 'exact', head: true }),
  ])
  if (src !== state.source) return // 统计还没回来就切了 tab
  $('#statToday').textContent = today.error ? '—' : today.count ?? 0
  $('#statImportant').textContent = imp.error ? '—' : imp.count ?? 0
  $('#statMine').textContent = mine.error ? '—' : mine.count ?? 0
}

/** 分析完成后刷新该条的按钮与情绪标签 */
export function markAnalyzed(newsId) {
  const el = $(`.flash[data-id="${newsId}"]`)
  if (!el) return
  const btn = el.querySelector('[data-analyze]')
  if (btn) {
    btn.classList.add('done')
    btn.classList.remove('busy')
    btn.textContent = '查看分析'
  }
  const meta = el.querySelector('.flash-meta')
  meta.querySelector('.sentiment')?.remove()
  const badge = sentimentBadge(newsId)
  if (badge) {
    const anchor = meta.querySelector('.meta-link')
    if (anchor) anchor.insertAdjacentHTML('beforebegin', badge)
    else meta.insertAdjacentHTML('beforeend', badge)
  }
  $('#statMine').textContent = state.analyses.size
}

export function setBusy(newsId, busy) {
  const btn = $(`.flash[data-id="${newsId}"] [data-analyze]`)
  if (!btn) return
  btn.classList.toggle('busy', busy)
  if (busy) btn.textContent = '分析中…'
  else btn.textContent = state.analyses.has(newsId) ? '查看分析' : '分析'
}

export function initFeed({ onAnalyze, onNeedWatch, onSourceChange }) {
  feed.onAnalyze = onAnalyze
  if (onNeedWatch) feed.onNeedWatch = onNeedWatch
  if (onSourceChange) feed.onSourceChange = onSourceChange
  $('#sourceTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-source]')
    if (t && t.dataset.source !== state.source) {
      setSource(t.dataset.source)
      window.scrollTo({ top: 0 })
    }
  })
  $('#loadMore').addEventListener('click', loadMore)
  $('#refreshFeed').addEventListener('click', () => {
    document.title = '快讯分析台 · 7×24 快讯 + AI 深度解读'
    loadFirst()
    loadStats().catch(() => {})
  })
  $('#newBanner').addEventListener('click', () => {
    document.title = '快讯分析台 · 7×24 快讯 + AI 深度解读'
    loadFirst()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
  $('#searchInput').addEventListener(
    'input',
    debounce((e) => {
      feed.keyword = e.target.value
      loadFirst()
    }, 400),
  )
  $$('#filterChips [data-filter]').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#filterChips [data-filter]').forEach((c) => c.classList.toggle('is-active', c === chip))
      feed.filter = chip.dataset.filter
      loadFirst()
    }),
  )

  // 列表事件委托
  $('#feedList').addEventListener('click', (e) => {
    const t = e.target
    const analyze = t.closest('[data-analyze]')
    if (analyze) {
      const n = state.news.get(Number(analyze.dataset.analyze))
      if (n) feed.onAnalyze(n)
      return
    }
    const open = t.closest('[data-open]')
    if (open) {
      const n = state.news.get(Number(open.dataset.open))
      if (n) feed.onAnalyze(n)
      return
    }
    if (t.matches('[data-expand]')) {
      const text = t.parentElement.querySelector('.flash-text')
      const clamped = text.classList.toggle('clamp')
      t.textContent = clamped ? '展开全文' : '收起'
      return
    }
    if (t.matches('[data-more]')) {
      const box = t.nextElementSibling
      const n = state.news.get(Number(t.closest('.flash').dataset.id))
      if (box.hidden && n && !box.dataset.ready) {
        box.innerHTML = window.DOMPurify.sanitize(n.content_more, { FORBID_TAGS: ['style', 'form', 'input'], ADD_ATTR: ['target'] })
        box.querySelectorAll('a').forEach((a) => {
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
        })
        box.querySelectorAll('img').forEach((img) => (img.referrerPolicy = 'no-referrer'))
        box.dataset.ready = '1'
      }
      box.hidden = !box.hidden
      t.textContent = box.hidden ? '查看补充内容' : '收起补充内容'
      return
    }
    if (t.matches('[data-zoom]')) {
      const lb = document.createElement('div')
      lb.className = 'lightbox'
      lb.innerHTML = `<img src="${escapeHtml(t.src)}" referrerpolicy="no-referrer" alt="" />`
      lb.addEventListener('click', () => lb.remove())
      document.body.appendChild(lb)
    }
  })

  // 滚动到底自动加载
  const io = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) loadMore()
  }, { rootMargin: '400px' })
  io.observe($('.feed-foot'))
}

export function resetFeed() {
  feed.seq++
  feed.filter = 'all'
  feed.keyword = ''
  feed.newestTime = null
  feed.seenTime = {}
  feed.rows = []
  feed.visibleCount = 0
  for (const s of realSources()) setTabBadge(s.id, 0)
  $('#searchInput').value = ''
  $$('#filterChips [data-filter]').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === 'all'))
  $('#feedList').innerHTML = ''
  state.news.clear()
}
