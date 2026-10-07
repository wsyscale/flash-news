// 分析抽屉：查看历史分析 / 流式生成新分析 / 保存到云端；分析完成后可继续追问（chat.js）
import { cloud, api } from './cloud.js'
import { state, SENTIMENT, parseSentiment, activeLlmConfig, providerById } from './state.js'
import { $, escapeHtml, fmtDateTime, toast, cloudErrorText } from './utils.js'
import { markAnalyzed, setBusy } from './feed.js'
import { renderMarkdown, renderSources, sourcesText, readSse, responseError } from './markdown.js'
import { attachChat, detachChat, chatCount, clearChat, isChatBusy } from './chat.js'
import { getWatchlist, sameWatchlist } from './watch.js'

let current = null // { news, ac, content, reasoning, meta, streaming }
const runs = new Map() // news_id -> 正在生成的 run（关闭抽屉也继续，完成后自动保存）
let pendingNews = null // 未配置 Key 时点了「分析」，保存配置后自动继续
let openSettingsCb = () => {}

let rafPending = false
function scheduleRender() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    if (!current) return
    const body = $('#analysisBody')
    body.innerHTML = renderMarkdown(current.content, { verdict: true, sources: current.sources })
    body.classList.toggle('typing', !!current.streaming && !!current.content)
    $('#analysisSources').innerHTML = renderSources(current.sources)
    if (current.reasoning) {
      $('#reasoningBox').hidden = false
      $('#reasoningBody').textContent = current.reasoning
      $('#reasoningLen').textContent = `（${current.reasoning.length} 字）`
      if (current.streaming && !current.content) {
        const rb = $('#reasoningBody')
        rb.scrollTop = rb.scrollHeight
      }
    }
  })
}

function setState(html) {
  $('#analysisState').innerHTML = html || ''
}

function renderMeta(meta) {
  if (!meta) {
    $('#analysisMeta').innerHTML = ''
    return
  }
  const p = providerById(meta.provider)
  const s = meta.sentiment && SENTIMENT[meta.sentiment]
  $('#analysisMeta').innerHTML = [
    s ? `<span class="sentiment ${s.cls}">${s.text}</span>` : '',
    `<span class="pill">${escapeHtml(p ? p.name : meta.provider)}</span>`,
    `<span class="pill">${escapeHtml(meta.model)}</span>`,
    meta.thinking ? '<span class="pill">深度思考</span>' : '',
    searchPill(meta),
    meta.watchlist && meta.watchlist.length
      ? `<span class="pill" title="${escapeHtml(meta.watchlist.map((w) => w.name).join('、'))}">结合关注 ${meta.watchlist.length} 项</span>`
      : '',
    meta.time ? `<span>${meta.streaming ? '' : '生成于 '}${escapeHtml(meta.time)}</span>` : '',
    meta.usage && meta.usage.total_tokens ? `<span>· ${meta.usage.total_tokens} tokens</span>` : '',
  ].join('')
}

/** 联网搜索状态：已搜 N 次 / 未触发搜索 / 搜索不可用已降级 */
function searchPill(meta) {
  if (meta.searchError) return `<span class="pill warn" title="${escapeHtml(meta.searchError)}">联网搜索不可用，已改为不联网</span>`
  if (!meta.webSearch) return ''
  const calls = meta.usage && meta.usage.tool_usage && meta.usage.tool_usage.web_search_call
  if (meta.streaming) return '<span class="pill web">联网搜索</span>'
  return `<span class="pill web">${calls ? `联网搜索 ${calls} 次` : meta.sourceCount ? '联网搜索' : '联网 · 未触发搜索'}</span>`
}

function renderNews(n) {
  $('#drawerNews').innerHTML = `
    <div class="dn-time">${escapeHtml(fmtDateTime(n.display_time))}${n.score >= 3 ? ' · <b style="color:var(--up)">重要</b>' : ''}</div>
    ${n.title ? `<div class="dn-title">${escapeHtml(n.title)}</div>` : ''}
    <div class="dn-text">${escapeHtml(n.content_text)}</div>
    ${n.uri ? `<a href="${escapeHtml(n.uri)}" target="_blank" rel="noopener noreferrer" style="font-size:12px">查看原文 ↗</a>` : ''}`
}

function setFooter({ streaming, hasContent }) {
  $('#stopBtn').hidden = !streaming
  $('#copyBtn').hidden = streaming || !hasContent
  $('#reanalyzeBtn').hidden = streaming
  $('#reanalyzeBtn').textContent = hasContent ? '重新分析' : '开始分析'
}

function openDrawer() {
  $('#drawerMask').hidden = false
  const d = $('#drawer')
  d.setAttribute('aria-hidden', 'false')
  requestAnimationFrame(() => d.classList.add('is-open'))
  document.body.style.overflow = 'hidden'
}

export function closeDrawer() {
  const d = $('#drawer')
  d.classList.remove('is-open')
  d.setAttribute('aria-hidden', 'true')
  $('#drawerMask').hidden = true
  document.body.style.overflow = ''
  // 关闭抽屉不打断后台生成：生成完会自动保存
}

function resetBody() {
  $('#analysisBody').innerHTML = ''
  $('#analysisBody').classList.remove('typing')
  $('#reasoningBox').hidden = true
  $('#reasoningBox').open = false
  $('#reasoningBody').textContent = ''
  $('#reasoningLen').textContent = ''
  $('#analysisSources').innerHTML = ''
  setState('')
  renderMeta(null)
}

async function showSaved(news) {
  setState('正在读取历史分析…')
  const { data, error } = await cloud.database
    .from('news_analysis')
    .select('id, provider, model, content, reasoning, sentiment, usage, watchlist, sources, updated_at')
    .eq('news_id', news.id)
    .maybeSingle()
  if (current?.news.id !== news.id) return
  if (error) {
    setState(`<span class="err">读取失败：${escapeHtml(cloudErrorText(error))}</span>`)
    setFooter({ streaming: false, hasContent: false })
    return
  }
  if (!data) {
    state.analyses.delete(news.id)
    setState('')
    return startAnalysis(news)
  }
  current.content = data.content
  current.reasoning = data.reasoning || ''
  current.sources = Array.isArray(data.sources) ? data.sources : []
  current.meta = {
    provider: data.provider,
    model: data.model,
    sentiment: data.sentiment,
    usage: data.usage,
    thinking: !!data.reasoning,
    watchlist: data.watchlist,
    webSearch: Array.isArray(data.sources), // 保存为数组 = 当时开启了联网搜索
    sourceCount: current.sources.length,
    time: fmtDateTime(data.updated_at),
  }
  setState(staleWatchNote(data.watchlist))
  renderMeta(current.meta)
  scheduleRender()
  setFooter({ streaming: false, hasContent: true })
  attachChat(news, data.content)
}

/** 关注列表在分析之后改过：提示可按新列表重新分析 */
function staleWatchNote(snapshot) {
  const now = getWatchlist()
  if (!now.length && !(snapshot && snapshot.length)) return ''
  if (sameWatchlist(snapshot, now)) return ''
  const was = snapshot && snapshot.length ? `当时关注 ${snapshot.length} 项` : '生成时还没有设置关注列表'
  return `<div class="analysis-note">你的关注列表已更新（当前 ${now.length} 项，这份分析${was}）。<button type="button" class="link-btn" data-reanalyze>按新列表重新分析</button></div>`
}

async function saveAnalysis(newsId, payload) {
  const existing = state.analyses.get(newsId)
  let res
  if (existing && existing.id) {
    res = await cloud.database
      .from('news_analysis')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('id, sentiment, updated_at')
  }
  if (!res || res.error || !res.data || !res.data.length) {
    res = await cloud.database.from('news_analysis').insert({ news_id: newsId, ...payload }).select('id, sentiment, updated_at')
    if (res.error && res.error.code && String(res.error.code).includes('23505')) {
      res = await cloud.database
        .from('news_analysis')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('news_id', newsId)
        .select('id, sentiment, updated_at')
    }
  }
  if (res.error) throw res.error
  const row = res.data && res.data[0]
  if (row) state.analyses.set(newsId, row)
  return row
}

async function startAnalysis(news) {
  const cfg = activeLlmConfig()
  if (!cfg || !cfg.apiKey) {
    setState('<span class="err">还没有配置模型 API Key，请先在「设置 → 模型配置」中填写。</span>')
    setFooter({ streaming: false, hasContent: false })
    toast('请先配置模型 API Key', 'error')
    openSettingsCb('llm')
    return
  }
  const provider = providerById(cfg.provider)
  const model = cfg.model || (provider && provider.defaultModel) || ''
  if (!model) {
    setState('<span class="err">请先在设置中填写模型名称。</span>')
    openSettingsCb('llm')
    return
  }

  const ac = new AbortController()
  current.ac = ac
  current.content = ''
  current.reasoning = ''
  current.sources = []
  current.streaming = true
  const watchlist = getWatchlist().map(({ name, code, market, type }) => ({ name, code: code || '', market: market || '', type: type || 'custom' }))
  current.meta = { provider: cfg.provider, model, thinking: cfg.thinking, watchlist, streaming: true, time: '生成中…' }
  const myRun = current
  runs.set(news.id, myRun)
  detachChat()
  resetBody()
  renderMeta(current.meta)
  setState('正在连接模型…')
  setFooter({ streaming: true, hasContent: false })
  setBusy(news.id, true)

  let usage = null
  let errorMsg = ''
  try {
    const res = await api('/api/analyze', {
      method: 'POST',
      signal: ac.signal,
      body: {
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model,
        baseUrl: cfg.baseUrl,
        thinking: cfg.thinking,
        systemPrompt: cfg.systemPrompt,
        webSearch: cfg.webSearch,
        watchlist,
        news: {
          id: news.id,
          title: news.title,
          content_text: news.content_text,
          content_more: news.content_more,
          display_time: news.display_time,
          uri: news.uri,
          article: news.article,
        },
      },
    })
    if (!res.ok) throw await responseError(res)
    await readSse(res, (event, j) => {
      if (event === 'meta') {
        myRun.meta.thinking = j.thinking
        myRun.meta.webSearch = !!j.webSearch
        if (j.searchError) {
          myRun.meta.searchError = j.searchError
          toast(j.searchError, 'error')
        }
        if (myRun === current) renderMeta(myRun.meta)
      } else if (event === 'sources') {
        myRun.sources = Array.isArray(j.items) ? j.items : []
        if (myRun === current) scheduleRender()
      } else if (event === 'reasoning') {
        myRun.reasoning += j.delta
        if (myRun === current) {
          setState(myRun.content ? '' : '模型思考中…')
          scheduleRender()
        }
      } else if (event === 'content') {
        myRun.content += j.delta
        if (myRun === current) {
          setState('')
          scheduleRender()
        }
      } else if (event === 'usage') {
        usage = j
      } else if (event === 'error') {
        errorMsg = j.message || '生成失败'
      }
    })
  } catch (err) {
    if (err.name === 'AbortError') errorMsg = '__aborted__'
    else errorMsg = err.message || '生成失败'
  } finally {
    myRun.streaming = false
    runs.delete(news.id)
    setBusy(news.id, false)
  }

  const isCurrent = myRun === current
  const aborted = errorMsg === '__aborted__'
  if (isCurrent) {
    $('#analysisBody').classList.remove('typing')
    scheduleRender()
  }

  if (!myRun.content || (errorMsg && !aborted && myRun.content.length < 40)) {
    if (isCurrent) {
      setState(aborted ? '已停止生成。' : `<span class="err">${escapeHtml(errorMsg || '模型没有返回内容')}</span>`)
      setFooter({ streaming: false, hasContent: !!myRun.content })
      myRun.meta.time = ''
      renderMeta(myRun.meta)
    } else if (!aborted) {
      toast(`分析失败：${errorMsg}`, 'error')
    }
    return
  }

  if (aborted) {
    if (isCurrent) {
      setState('已停止生成，本次部分结果未保存。')
      setFooter({ streaming: false, hasContent: true })
    }
    return
  }

  const sentiment = parseSentiment(myRun.content)
  myRun.meta = { ...myRun.meta, sentiment, usage, sourceCount: myRun.sources.length, streaming: false, time: fmtDateTime(new Date()) }
  if (isCurrent) {
    renderMeta(myRun.meta)
    setFooter({ streaming: false, hasContent: true })
    if (errorMsg) setState(`<span class="err">${escapeHtml(errorMsg)}（已保存已生成部分）</span>`)
  }
  try {
    await saveAnalysis(news.id, {
      provider: myRun.meta.provider,
      model: myRun.meta.model,
      content: myRun.content,
      reasoning: myRun.reasoning || null,
      sources: myRun.meta.webSearch ? myRun.sources.slice(0, 50) : null,
      sentiment,
      usage,
      watchlist: watchlist.length ? watchlist : null,
    })
    markAnalyzed(news.id)
    if (!isCurrent) toast('一条后台分析已完成并保存', 'success')
  } catch (err) {
    toast(`分析结果保存失败：${cloudErrorText(err)}`, 'error')
  }
  // 分析完成后可以继续追问
  if (myRun === current) attachChat(news, myRun.content)
}

export function openAnalysis(news, { force = false } = {}) {
  if (current && current.streaming && current.news.id !== news.id) {
    toast('上一条分析仍在后台生成，完成后会自动保存')
  }
  // 该条正在后台生成 → 直接接回显示
  const running = runs.get(news.id)
  detachChat()
  if (running) {
    current = running
    renderNews(news)
    resetBody()
    renderMeta(current.meta)
    setState(current.content ? '' : current.reasoning ? '模型思考中…' : '正在连接模型…')
    setFooter({ streaming: true, hasContent: false })
    scheduleRender()
    openDrawer()
    return
  }
  // 没有历史结果且未配置 Key：先去配置，保存后自动继续分析
  const cfg = activeLlmConfig()
  if ((force || !state.analyses.has(news.id)) && (!cfg || !cfg.apiKey)) {
    pendingNews = news
    toast('请先配置模型 API Key，保存后将自动开始分析')
    openSettingsCb('llm')
    return
  }
  current = { news, ac: null, content: '', reasoning: '', sources: [], meta: null, streaming: false }
  renderNews(news)
  resetBody()
  setFooter({ streaming: false, hasContent: false })
  openDrawer()
  if (!force && state.analyses.has(news.id)) return showSaved(news)
  return startAnalysis(news)
}

export const hasPendingAnalysis = () => !!pendingNews

/** 模型配置保存后：如有待分析的快讯，自动开始 */
export function resumePendingAnalysis() {
  const n = pendingNews
  pendingNews = null
  if (!n) return false
  openAnalysis(n)
  return true
}

export function initAnalysis({ openSettings }) {
  openSettingsCb = openSettings
  $('#drawerClose').addEventListener('click', closeDrawer)
  $('#drawerMask').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#drawer').classList.contains('is-open') && $('#settingsMask').hidden) closeDrawer()
  })
  $('#stopBtn').addEventListener('click', () => current && current.ac && current.ac.abort())
  $('#analysisState').addEventListener('click', (e) => {
    if (e.target.closest('[data-reanalyze]')) $('#reanalyzeBtn').click()
  })
  $('#reanalyzeBtn').addEventListener('click', async () => {
    if (!current || current.streaming) return
    const news = current.news
    if (isChatBusy(news.id)) return toast('追问还在回答中，请稍后再重新分析')
    // 重新分析会让旧的追问失去上下文：有追问记录时先确认并清空
    let n = 0
    try {
      n = await chatCount(news.id)
    } catch {
      n = 0
    }
    if (n > 0) {
      if (!confirm(`重新分析会清空这条快讯下的 ${n} 条追问记录，确定继续吗？`)) return
      try {
        await clearChat(news.id)
      } catch (err) {
        toast(`清空追问记录失败：${cloudErrorText(err)}`, 'error')
        return
      }
    }
    if (current && current.news.id === news.id && !current.streaming) startAnalysis(news)
  })
  $('#copyBtn').addEventListener('click', async () => {
    if (!current || !current.content) return
    const n = current.news
    const text = `【快讯】${n.title || ''}\n${n.content_text}\n\n${current.content}${sourcesText(current.sources)}`
    try {
      await navigator.clipboard.writeText(text)
      toast('已复制到剪贴板', 'success')
    } catch {
      toast('复制失败，请手动选择文本复制', 'error')
    }
  })
}
