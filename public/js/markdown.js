// Markdown 渲染（marked + DOMPurify，均为本站 vendor 全局变量）与 SSE 读取，分析与追问共用
import { SENTIMENT, parseSentiment } from './state.js'
import { escapeHtml } from './utils.js'

marked.setOptions({ gfm: true, breaks: true })

const PURIFY = { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'img'] }

/**
 * 渲染 Markdown
 *   verdict=true：把首行「综合判断：利好…」渲染成醒目的结论条
 *   sources：联网搜索的引用来源，正文里的 [1] [2] 会变成可点击的角标
 */
export function renderMarkdown(text, { verdict = false, sources = null } = {}) {
  let src = String(text || '')
  if (verdict) {
    src = src.replace(/^\s*[#>*\s]*\**\s*(综合判断[^\n]*)$/m, (line, body) => {
      const s = parseSentiment(body)
      const cls = s ? SENTIMENT[s].cls : 'neu'
      return `<div class="verdict ${cls}">${escapeHtml(body.replace(/\*+/g, '').trim())}</div>\n`
    })
  }
  const html = window.DOMPurify.sanitize(marked.parse(src), PURIFY)
  const hasTable = html.includes('<td')
  const cite = Array.isArray(sources) && sources.length && CITE_TEST.test(html)
  if (!hasTable && !cite) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  if (hasTable) colorizeDirections(tpl.content)
  if (cite) linkCitations(tpl.content, sources)
  return tpl.innerHTML
}

// ---------------- 引用角标 ----------------
const CITE_TEST = /\[(?:\^|citation:\s*)?\d{1,3}\]/
const CITE_RE = /\[(?:\^|citation:\s*)?(\d{1,3})\]/g
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '')

function linkCitations(root, sources) {
  const byIndex = new Map(sources.map((s) => [Number(s.index), s]))
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('code, pre, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const nodes = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (CITE_TEST.test(n.nodeValue)) nodes.push(n)
  for (const node of nodes) {
    const text = node.nodeValue
    const frag = document.createDocumentFragment()
    let last = 0
    for (const m of text.matchAll(CITE_RE)) {
      const src = byIndex.get(Number(m[1]))
      const url = src && safeUrl(src.url)
      if (!url) continue
      frag.append(text.slice(last, m.index))
      const sup = document.createElement('sup')
      sup.className = 'cite'
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.title = [src.title, src.site].filter(Boolean).join(' · ')
      a.textContent = m[1]
      sup.append(a)
      frag.append(sup)
      last = m.index + m[0].length
    }
    if (!last) continue
    frag.append(text.slice(last))
    node.replaceWith(frag)
  }
}

/** 参考来源列表（联网搜索） */
export function renderSources(sources, { open = false } = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => safeUrl(s.url))
  if (!list.length) return ''
  const items = list
    .map((s) => {
      let host = ''
      try {
        host = new URL(s.url).hostname.replace(/^www\./, '')
      } catch {
        /* ignore */
      }
      return `<li value="${Number(s.index) || ''}"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.url)}</a><span class="src-site">${escapeHtml(s.site || host)}</span>${
        s.snippet ? `<div class="src-snippet">${escapeHtml(s.snippet)}</div>` : ''
      }</li>`
    })
    .join('')
  return `<details class="sources"${open ? ' open' : ''}><summary>参考来源（${list.length}）</summary><ol>${items}</ol></details>`
}

/** 复制用的纯文本来源列表 */
export function sourcesText(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => safeUrl(s.url))
  return list.length ? `\n\n参考来源：\n${list.map((s) => `[${s.index}] ${s.title || ''} ${s.url}`).join('\n')}` : ''
}

// 表格单元格以「利好 / 偏多 / 利空 / 偏空 / 中性」开头时，给方向词着色（A 股习惯：利好红、利空绿）
const DIR_RE = /^(\s*)(利好|利多|偏多|正面|利空|偏空|负面|中性)/
const DIR_CLS = { 利好: 'pos', 利多: 'pos', 偏多: 'pos', 正面: 'pos', 利空: 'neg', 偏空: 'neg', 负面: 'neg', 中性: 'neu' }
function colorizeDirections(root) {
  for (const td of root.querySelectorAll('td')) {
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.nodeValue.trim()) node = walker.nextNode()
    if (!node) continue
    const m = DIR_RE.exec(node.nodeValue)
    if (!m) continue
    const span = document.createElement('span')
    span.className = `dir ${DIR_CLS[m[2]]}`
    span.textContent = m[2]
    const rest = node.splitText(m[1].length)
    rest.nodeValue = rest.nodeValue.slice(m[2].length)
    rest.parentNode.insertBefore(span, rest)
  }
}

/**
 * 读取本站服务端归一后的 SSE（event: meta | reasoning | content | sources | usage | error | done）
 * onEvent(event, data) 对每个事件调用一次
 */
export async function readSse(res, onEvent) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue
      let j
      try {
        j = JSON.parse(data)
      } catch {
        continue
      }
      onEvent(event, j)
    }
  }
}

/** 非 2xx 响应转成带中文提示的错误 */
export async function responseError(res) {
  let j = null
  try {
    j = await res.json()
  } catch {
    /* ignore */
  }
  return new Error((j && j.error) || `请求失败（HTTP ${res.status}）`)
}
