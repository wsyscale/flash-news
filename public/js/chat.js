// 深度分析后的追问对话：每条快讯一个对话线程，按账号私有保存在 news_chat 表
//   · 上下文 = 快讯 + 已保存的深度分析 + 历史追问，由本站服务端转发给模型
//   · 关闭抽屉不打断回答，完成后自动保存；没拿到回答时撤回本轮并把问题放回输入框
import { cloud, api } from './cloud.js'
import { state, activeLlmConfig, providerById } from './state.js'
import { $, escapeHtml, toast, cloudErrorText } from './utils.js'
import { renderMarkdown, renderSources, sourcesText, readSse, responseError } from './markdown.js'
import { getWatchlist } from './watch.js'

const MAX_QUESTION = 4000
const SUGGESTIONS = [
  '这条消息对 A 股哪些板块影响最大？',
  '历史上类似事件发生后，市场通常怎么走？',
  '影响能持续多久？需要跟踪哪些关键信号？',
  '有哪些风险可能让上面的判断失效？',
]

const threads = new Map() // news_id -> { loaded, loading, messages, run }
let active = null // { news, analysis }
let openSettingsCb = () => {}
let keySeq = 0

function thread(newsId) {
  let t = threads.get(newsId)
  if (!t) {
    t = { loaded: false, loading: null, loadError: null, messages: [], run: null }
    threads.set(newsId, t)
  }
  return t
}

const isActive = (newsId) => !!active && active.news.id === newsId

function rowToMsg(r) {
  return {
    key: ++keySeq,
    id: r.id,
    role: r.role,
    content: r.content,
    reasoning: r.reasoning || '',
    provider: r.provider,
    model: r.model,
    usage: r.usage,
    sources: Array.isArray(r.sources) ? r.sources : [],
    webSearch: Array.isArray(r.sources),
  }
}

async function loadThread(newsId) {
  const t = thread(newsId)
  if (t.loaded) return t
  if (!t.loading) {
    t.loading = (async () => {
      const { data, error } = await cloud.database
        .from('news_chat')
        .select('id, role, content, reasoning, provider, model, usage, sources, created_at')
        .eq('news_id', newsId)
        .order('id', { ascending: true })
        .limit(400)
      if (error) throw error
      t.messages = (data || []).map(rowToMsg).concat(t.messages.filter((m) => m.pending))
      t.loaded = true
      t.loadError = null
    })()
      .catch((err) => {
        t.loadError = err
        throw err
      })
      .finally(() => {
        t.loading = null
      })
  }
  await t.loading
  return t
}

// ---------------- 渲染 ----------------
function botMetaHtml(m) {
  const p = providerById(m.provider)
  const parts = [p ? p.name : m.provider, m.model].filter(Boolean).map(escapeHtml)
  if (m.searchError) parts.push(`<span class="st-err" title="${escapeHtml(m.searchError)}">联网搜索不可用，本次未联网</span>`)
  else if (m.webSearch) {
    const calls = m.usage && m.usage.tool_usage && m.usage.tool_usage.web_search_call
    parts.push(calls ? `联网搜索 ${calls} 次` : m.sources && m.sources.length ? '联网搜索' : '联网 · 未触发搜索')
  }
  if (m.stopped) parts.push('已停止')
  if (m.unsaved) parts.push('<span class="st-err">未保存</span>')
  if (m.usage && m.usage.total_tokens) parts.push(`${m.usage.total_tokens} tokens`)
  return parts.join(' · ')
}

function msgHtml(m) {
  if (m.role === 'user') {
    return `<div class="msg me" data-key="${m.key}"><div class="msg-bubble">${escapeHtml(m.content)}</div></div>`
  }
  const waiting = m.streaming && !m.content ? (m.reasoning ? '思考中…' : '正在连接模型…') : ''
  return `<div class="msg bot" data-key="${m.key}">
    <div class="msg-avatar">AI</div>
    <div class="msg-main">
      <details class="reasoning sm"${m.reasoning ? '' : ' hidden'}>
        <summary>思考过程 <span class="r-len">${m.reasoning ? `（${m.reasoning.length} 字）` : ''}</span></summary>
        <div class="reasoning-body">${escapeHtml(m.reasoning)}</div>
      </details>
      <div class="msg-state">${waiting}</div>
      <div class="md${m.streaming && m.content ? ' typing' : ''}">${m.content ? renderMarkdown(m.content, { sources: m.sources }) : ''}</div>
      <div class="msg-sources">${renderSources(m.sources)}</div>
      <div class="msg-foot"${m.streaming ? ' hidden' : ''}>
        <span>${botMetaHtml(m)}</span>
        <button type="button" class="link-btn" data-copy-msg="${m.key}">复制</button>
      </div>
    </div>
  </div>`
}

function setChatError(text) {
  const el = $('#chatError')
  el.textContent = text || ''
  el.hidden = !text
}

function renderComposer() {
  const t = active && threads.get(active.news.id)
  const busy = !!(t && t.run)
  const btn = $('#chatSend')
  btn.textContent = busy ? '停止' : '发送'
  btn.classList.toggle('btn-primary', !busy)
  btn.classList.toggle('btn-ghost', busy)
  btn.disabled = !busy && !$('#chatInput').value.trim()
}

function renderThread() {
  const section = $('#chatSection')
  const composer = $('#chatComposer')
  if (!active) {
    section.hidden = true
    composer.hidden = true
    return
  }
  section.hidden = false
  composer.hidden = false
  const t = thread(active.news.id)
  const list = $('#chatList')
  if (!t.loaded) {
    list.innerHTML = t.loadError
      ? `<div class="chat-tip err">读取追问记录失败：${escapeHtml(cloudErrorText(t.loadError))} <button type="button" class="link-btn" data-chat-retry>重试</button></div>`
      : '<div class="chat-tip">正在读取追问记录…</div>'
  } else {
    list.innerHTML = t.messages.map(msgHtml).join('')
  }
  const empty = t.loaded && !t.messages.length
  $('#chatSuggest').hidden = !empty
  $('#chatSuggest').innerHTML = empty
    ? SUGGESTIONS.map((s) => `<button type="button" class="chip" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')
    : ''
  $('#chatClear').hidden = !t.loaded || !t.messages.length || !!t.run
  const days = state.retentionDays || 14
  $('#chatSub').textContent = `基于这条快讯和上面的分析继续提问 · 对话自动保存，随快讯在 ${days} 天后清理`
  renderComposer()
}

// 流式更新：只改正在生成的那条消息，避免整列表重绘（保留「思考过程」展开状态）
const pendingUpdates = new Set()
let rafQueued = false
function queueUpdate(newsId, msg) {
  if (!isActive(newsId)) return
  pendingUpdates.add(msg)
  if (rafQueued) return
  rafQueued = true
  requestAnimationFrame(() => {
    rafQueued = false
    const nearBottom = isNearBottom()
    for (const m of pendingUpdates) {
      const el = document.querySelector(`#chatList [data-key="${m.key}"]`)
      if (!el) continue
      const md = el.querySelector('.md')
      md.innerHTML = m.content ? renderMarkdown(m.content, { sources: m.sources }) : ''
      const srcCount = (m.sources || []).length
      if (el.dataset.src !== String(srcCount)) {
        el.dataset.src = String(srcCount)
        el.querySelector('.msg-sources').innerHTML = renderSources(m.sources)
      }
      md.classList.toggle('typing', !!m.streaming && !!m.content)
      el.querySelector('.msg-state').textContent = m.streaming && !m.content ? (m.reasoning ? '思考中…' : '正在连接模型…') : ''
      if (m.reasoning) {
        const det = el.querySelector('details')
        det.hidden = false
        const rb = det.querySelector('.reasoning-body')
        rb.textContent = m.reasoning
        det.querySelector('.r-len').textContent = `（${m.reasoning.length} 字）`
        if (det.open && !m.content) rb.scrollTop = rb.scrollHeight
      }
    }
    pendingUpdates.clear()
    if (nearBottom) scrollToBottom()
  })
}

function isNearBottom() {
  const b = $('#drawerBody')
  return b.scrollHeight - b.scrollTop - b.clientHeight < 160
}

function scrollToBottom(smooth = false) {
  const b = $('#drawerBody')
  b.scrollTo({ top: b.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function autoGrow() {
  const el = $('#chatInput')
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`
}

// ---------------- 发送 ----------------
async function send(text) {
  if (!active) return
  const q = String(text || '').trim()
  if (!q) return
  if (q.length > MAX_QUESTION) return toast(`问题太长了，请控制在 ${MAX_QUESTION} 字以内`, 'error')
  const { news, analysis } = active
  const t = thread(news.id)
  if (t.run) return toast('上一个问题还在回答中')
  const cfg = activeLlmConfig()
  if (!cfg || !cfg.apiKey) {
    toast('请先配置模型 API Key', 'error')
    openSettingsCb('llm')
    return
  }
  const provider = providerById(cfg.provider)
  const model = cfg.model || (provider && provider.defaultModel) || ''
  if (!model) {
    toast('请先在设置中填写模型名称', 'error')
    openSettingsCb('llm')
    return
  }
  if (!t.loaded) {
    try {
      await loadThread(news.id)
    } catch (err) {
      setChatError(`读取追问记录失败：${cloudErrorText(err)}`)
      return
    }
  }

  const history = t.messages.filter((m) => m.content && !m.streaming).map((m) => ({ role: m.role, content: m.content }))
  const userMsg = { key: ++keySeq, role: 'user', content: q, pending: true }
  const botMsg = { key: ++keySeq, role: 'assistant', content: '', reasoning: '', sources: [], provider: cfg.provider, model, pending: true, streaming: true }
  t.messages.push(userMsg, botMsg)
  const ac = new AbortController()
  t.run = { ac }
  setChatError('')
  if (isActive(news.id)) {
    $('#chatInput').value = ''
    autoGrow()
    renderThread()
    scrollToBottom(true)
  }

  let usage = null
  let errorMsg = ''
  try {
    const res = await api('/api/chat', {
      method: 'POST',
      signal: ac.signal,
      body: {
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model,
        baseUrl: cfg.baseUrl,
        thinking: cfg.thinking,
        webSearch: cfg.webSearch,
        news: {
          id: news.id,
          source: news.source,
          title: news.title,
          content_text: news.content_text,
          content_more: news.content_more,
          display_time: news.display_time,
          article: news.article,
          symbols: news.symbols,
          tags: news.tags,
        },
        analysis,
        history,
        question: q,
        watchlist: getWatchlist(),
      },
    })
    if (!res.ok) throw await responseError(res)
    await readSse(res, (event, j) => {
      if (event === 'meta') {
        botMsg.webSearch = !!j.webSearch
        if (j.searchError) botMsg.searchError = j.searchError
      } else if (event === 'sources') {
        botMsg.sources = Array.isArray(j.items) ? j.items : []
        queueUpdate(news.id, botMsg)
      } else if (event === 'reasoning') {
        botMsg.reasoning += j.delta
        queueUpdate(news.id, botMsg)
      } else if (event === 'content') {
        botMsg.content += j.delta
        queueUpdate(news.id, botMsg)
      } else if (event === 'usage') {
        usage = j
      } else if (event === 'error') {
        errorMsg = j.message || '生成失败'
      }
    })
  } catch (err) {
    errorMsg = err.name === 'AbortError' ? '__aborted__' : err.message || '生成失败'
  }

  botMsg.streaming = false
  t.run = null
  const aborted = errorMsg === '__aborted__'

  if (!botMsg.content.trim()) {
    // 没拿到回答：撤回本轮，把问题放回输入框，方便重试
    t.messages = t.messages.filter((m) => m !== userMsg && m !== botMsg)
    if (isActive(news.id)) {
      const input = $('#chatInput')
      if (!input.value.trim()) {
        input.value = q
        autoGrow()
      }
      renderThread()
      if (!aborted) setChatError(errorMsg || '模型没有返回内容，请重试')
    } else if (!aborted) {
      toast(`追问失败：${errorMsg || '模型没有返回内容'}`, 'error')
    }
    return
  }

  botMsg.stopped = aborted
  botMsg.usage = usage
  if (isActive(news.id)) {
    renderThread()
    if (errorMsg && !aborted) setChatError(`${errorMsg}（已保存已生成的部分）`)
  }

  try {
    const { data, error } = await cloud.database
      .from('news_chat')
      .insert([
        { news_id: news.id, role: 'user', content: q },
        {
          news_id: news.id,
          role: 'assistant',
          content: botMsg.content.slice(0, 60000),
          reasoning: botMsg.reasoning ? botMsg.reasoning.slice(0, 100000) : null,
          sources: botMsg.webSearch ? botMsg.sources.slice(0, 50) : null,
          provider: botMsg.provider,
          model: botMsg.model,
          usage,
        },
      ])
      .select('id, role')
    if (error) throw error
    const rows = data || []
    userMsg.id = rows.find((r) => r.role === 'user')?.id
    botMsg.id = rows.find((r) => r.role === 'assistant')?.id
    if (!isActive(news.id)) toast('一条追问已回答并保存', 'success')
  } catch (err) {
    botMsg.unsaved = true
    toast(`追问记录保存失败：${cloudErrorText(err)}`, 'error')
  } finally {
    userMsg.pending = false
    botMsg.pending = false
    if (isActive(news.id)) renderThread()
  }
}

// ---------------- 对外接口 ----------------
/** 分析结果可用时挂上对话区（analysis 为当前分析正文，作为追问上下文） */
export function attachChat(news, analysis) {
  active = { news, analysis }
  setChatError('')
  renderThread()
  const t = thread(news.id)
  if (!t.loaded) {
    loadThread(news.id)
      .catch(() => {})
      .finally(() => isActive(news.id) && renderThread())
  }
}

/** 分析生成中 / 切换快讯时收起对话区 */
export function detachChat() {
  active = null
  setChatError('')
  renderThread()
}

export function isChatBusy(newsId) {
  const t = threads.get(newsId)
  return !!(t && t.run)
}

/** 该条快讯已保存的追问条数（未加载时查数据库） */
export async function chatCount(newsId) {
  const t = threads.get(newsId)
  if (t && t.loaded) return t.messages.length
  const { count, error } = await cloud.database.from('news_chat').select('id', { count: 'exact', head: true }).eq('news_id', newsId)
  if (error) throw error
  return count || 0
}

export async function clearChat(newsId) {
  const { error } = await cloud.database.from('news_chat').delete().eq('news_id', newsId)
  if (error) throw error
  const t = thread(newsId)
  t.messages = []
  t.loaded = true
  if (isActive(newsId)) renderThread()
}

/** 退出登录时清空 */
export function resetChat() {
  for (const t of threads.values()) if (t.run) t.run.ac.abort()
  threads.clear()
  active = null
  $('#chatInput').value = ''
  renderThread()
}

export function initChat({ openSettings }) {
  openSettingsCb = openSettings
  const input = $('#chatInput')
  input.addEventListener('input', () => {
    autoGrow()
    renderComposer()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      const t = active && threads.get(active.news.id)
      if (!(t && t.run)) send(input.value)
    }
  })
  $('#chatSend').addEventListener('click', () => {
    const t = active && threads.get(active.news.id)
    if (t && t.run) t.run.ac.abort()
    else send(input.value)
  })
  $('#chatSuggest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-suggest]')
    if (b) send(b.dataset.suggest)
  })
  $('#chatList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-chat-retry]') && active) {
      attachChat(active.news, active.analysis)
      return
    }
    const copy = e.target.closest('[data-copy-msg]')
    if (copy && active) {
      const m = thread(active.news.id).messages.find((x) => String(x.key) === copy.dataset.copyMsg)
      if (!m) return
      try {
        await navigator.clipboard.writeText(m.content + sourcesText(m.sources))
        toast('已复制', 'success')
      } catch {
        toast('复制失败，请手动选择文本复制', 'error')
      }
    }
  })
  $('#chatClear').addEventListener('click', async () => {
    if (!active) return
    const newsId = active.news.id
    const n = thread(newsId).messages.length
    if (!n || !confirm(`确定清空这条快讯下的 ${n} 条追问记录吗？清空后无法恢复。`)) return
    try {
      await clearChat(newsId)
      toast('已清空追问记录', 'success')
    } catch (err) {
      toast(`清空失败：${cloudErrorText(err)}`, 'error')
    }
  })
}
