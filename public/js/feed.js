// 快讯时间线：分页、搜索、筛选、新消息提示、今日统计
import { cloud } from './cloud.js'
import { state, SENTIMENT } from './state.js'
import { $, $$, escapeHtml, fmtTime, dayKey, dayLabel, debounce, cloudErrorText, toast } from './utils.js'
import { matchWatch, relatedOrFilter } from './watch.js'

const PAGE = 30
const COLS = 'id, wscn_id, title, content_text, content_more, score, channels, uri, article, images, display_time'
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
  newestTime: null,
  seq: 0,
  onAnalyze: () => {},
  onNeedWatch: () => {},
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
  const imgs = Array.isArray(n.images) ? n.images.slice(0, 4) : []
  const done = state.analyses.has(n.id)
  const art = n.article && n.article.uri ? n.article : null
  const watched = matchWatch(n)
  const watchTag = watched.length
    ? `<span class="tag watch" title="${escapeHtml(watched.map((w) => w.name).join('、'))}">关注：${escapeHtml(watched.slice(0, 2).map((w) => w.name).join('、'))}${
        watched.length > 2 ? ` 等 ${watched.length} 项` : ''
      }</span>`
    : ''
  return `
  <article class="flash${important ? ' is-important' : ''}${hasTitle ? '' : ' no-title'}" data-id="${n.id}">
    <div class="flash-time">${fmtTime(n.display_time)}</div>
    <div class="flash-body">
      ${hasTitle ? `<h3 class="flash-title">${escapeHtml(n.title)}</h3>` : ''}
      <div class="flash-text${long ? ' clamp' : ''}">${escapeHtml(text)}</div>
      ${long ? '<button type="button" class="expand-btn" data-expand>展开全文</button>' : ''}
      ${n.content_more ? `<button type="button" class="expand-btn" data-more>查看补充内容</button><div class="flash-more" hidden></div>` : ''}
      ${imgs.length ? `<div class="flash-imgs">${imgs.map((u) => `<img src="${escapeHtml(u)}" loading="lazy" referrerpolicy="no-referrer" alt="" data-zoom />`).join('')}</div>` : ''}
      <div class="flash-meta">
        ${important ? '<span class="tag imp">重要</span>' : ''}
        ${watchTag}
        ${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
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
  const label = { all: '全部快讯', important: '重要快讯', related: '与我关注相关的快讯', analyzed: '我分析过的快讯' }[feed.filter]
  const kw = sanitizeKeyword(feed.keyword)
  $('#feedCount').textContent =
    feed.total === null
      ? '加载中…'
      : `${kw ? `「${kw}」搜索结果` : label} · 共 ${feed.total.toLocaleString()} 条 · 保留近 ${state.retentionDays} 天`
}

export async function loadFirst() {
  const seq = ++feed.seq
  feed.offset = 0
  feed.ended = false
  feed.total = null
  feed.loading = true
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
      renderRows(rows, false)
    }
    if (feed.filter === 'all' && !feed.keyword && rows[0]) feed.newestTime = rows[0].display_time
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
    renderRows(rows, true)
  } catch (err) {
    toast(`加载失败：${cloudErrorText(err)}`, 'error')
  } finally {
    if (seq === feed.seq) {
      feed.loading = false
      updateFoot()
    }
  }
}

/** 轮询：是否有比当前列表更新的快讯 */
export async function checkNew() {
  if (!feed.newestTime || feed.filter !== 'all' || feed.keyword) return
  const { count, error } = await cloud.database
    .from('news_flash')
    .select('id', { count: 'exact', head: true })
    .gt('display_time', feed.newestTime)
  if (error || !count) return
  const b = $('#newBanner')
  b.textContent = `有 ${count} 条新快讯，点击查看`
  b.hidden = false
  document.title = `(${count}) 快讯分析台`
}

export async function loadStats() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const iso = start.toISOString()
  const [today, imp, mine] = await Promise.all([
    cloud.database.from('news_flash').select('id', { count: 'exact', head: true }).gte('display_time', iso),
    cloud.database.from('news_flash').select('id', { count: 'exact', head: true }).gte('display_time', iso).gte('score', 3),
    cloud.database.from('news_analysis').select('id', { count: 'exact', head: true }),
  ])
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

export function initFeed({ onAnalyze, onNeedWatch }) {
  feed.onAnalyze = onAnalyze
  if (onNeedWatch) feed.onNeedWatch = onNeedWatch
  $('#loadMore').addEventListener('click', loadMore)
  $('#refreshFeed').addEventListener('click', () => {
    document.title = '快讯分析台 · 7×24 重要快讯 + AI 深度解读'
    loadFirst()
    loadStats().catch(() => {})
  })
  $('#newBanner').addEventListener('click', () => {
    document.title = '快讯分析台 · 7×24 重要快讯 + AI 深度解读'
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
  $('#searchInput').value = ''
  $$('#filterChips [data-filter]').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === 'all'))
  $('#feedList').innerHTML = ''
  state.news.clear()
}
