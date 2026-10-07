#!/usr/bin/env node
// 检测 TokenHub 联网搜索是否可用，并找出流式返回里引用来源所在的字段。
// 不经过本站服务，不读写数据库；API Key 只从环境变量读取，不会写入任何文件。
//
// 用法（在 flash-news 目录下）：
//   read -s TOKENHUB_API_KEY && export TOKENHUB_API_KEY     # 粘贴 Key 后回车，屏幕不显示
//   node scripts/check-websearch.mjs                         # 默认模型 deepseek-v4-flash
//   node scripts/check-websearch.mjs hy3                     # 指定模型
//
// 可选环境变量：TOKENHUB_BASE_URL（默认广州 https://tokenhub.tencentmaas.com/v1）、SEARCH_SOURCE（默认 lite）

const KEY = process.env.TOKENHUB_API_KEY || ''
const BASE = (process.env.TOKENHUB_BASE_URL || 'https://tokenhub.tencentmaas.com/v1').replace(/\/+$/, '')
const MODEL = process.argv[2] || 'deepseek-v4-flash'
const SOURCE = process.env.SEARCH_SOURCE || 'lite'

// 本站 lib/llm.js 里 extractSources() 已兼容的位置
const SUPPORTED = new Set([
  'choices[0].delta.search_results',
  'choices[0].message.search_results',
  'choices[0].search_results',
  'search_results',
  'search_info.search_results',
  'choices[0].delta.annotations',
  'choices[0].message.annotations',
])

if (!KEY) {
  console.error('缺少 API Key。请先执行：read -s TOKENHUB_API_KEY && export TOKENHUB_API_KEY')
  process.exit(2)
}

const today = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date())
const QUESTION = `请联网搜索：${today}（北京时间）A 股或全球市场有哪些重要财经新闻？列出 3 条，每条一句话，并在句末用 [序号] 标注来源。`

const body = (stream) => ({
  model: MODEL,
  messages: [{ role: 'user', content: QUESTION }],
  stream,
  ...(stream ? { stream_options: { include_usage: true } } : {}),
  max_tokens: 1024,
  thinking: { type: 'disabled' },
  web_search_options: { enable: true, search_source: SOURCE },
})

const post = (stream) =>
  fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body(stream)),
    signal: AbortSignal.timeout(120_000),
  })

function errText(status, text) {
  try {
    const j = JSON.parse(text)
    const e = j.error || j
    return `HTTP ${status}：${e.message_zh || e.message || e.code || text}`.slice(0, 400)
  } catch {
    return `HTTP ${status}：${String(text).slice(0, 400)}`
  }
}

/** 递归找出名字像「来源 / 引用 / 搜索」的数组字段，返回 { path: array } */
function findSourceArrays(obj, path = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    const p = Array.isArray(obj) ? `${path}[${k}]` : path ? `${path}.${k}` : k
    if (Array.isArray(v) && v.length && /search|annotation|citation|reference|source/i.test(p)) {
      out[p] = v // 命中后不再深入，避免把来源条目内部的数组也算进来
      continue
    }
    if (v && typeof v === 'object') findSourceArrays(v, p, out)
  }
  return out
}

const brief = (s) => {
  const c = (s && s.url_citation) || s || {}
  return `${c.index ?? c.idx ?? '?'} | ${String(c.title || c.name || '').slice(0, 40)} | ${c.url || c.link || ''}`
}

function verdictForPaths(paths) {
  if (!paths.length) return null
  const ok = paths.filter((p) => SUPPORTED.has(p))
  return ok.length
    ? `✅ 网站已兼容该位置（${ok.join('、')}），上线后「参考来源」能正常显示`
    : `⚠️ 网站暂未兼容这些位置：${paths.join('、')}。把本输出发给开发者，补一行解析即可`
}

console.log(`接入地址：${BASE}\n模型：${MODEL}　搜索版本：${SOURCE}\n测试问题：${QUESTION}\n`)

// ---------- 1. 非流式 ----------
console.log('━━ 第 1 步：非流式请求 ━━')
let ok1 = false
try {
  const r = await post(false)
  const text = await r.text()
  if (!r.ok) {
    console.log(`❌ 请求失败 ${errText(r.status, text)}`)
    if (r.status === 401) console.log('   → Key 无效，或不是 TokenHub 的 Key')
    else console.log('   → 如果提到 search / 工具 / 未开通：请到 TokenHub 控制台「启用管理 → 应用工具」领取联网搜索资源包或开通后付费')
  } else {
    const j = JSON.parse(text)
    const found = findSourceArrays(j)
    const calls = j.usage && j.usage.tool_usage && j.usage.tool_usage.web_search_call
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
    ok1 = true
    console.log(`HTTP 200　搜索次数（usage.tool_usage.web_search_call）：${calls ?? '未返回'}`)
    console.log(`来源字段：${Object.keys(found).map((p) => `${p}（${found[p].length} 条）`).join('、') || '无'}`)
    for (const s of (Object.values(found)[0] || []).slice(0, 3)) console.log(`   ${brief(s)}`)
    console.log(`回答开头：${content.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
} catch (e) {
  console.log(`❌ 网络错误：${e.message}`)
}

// ---------- 2. 流式（网站实际使用的方式） ----------
console.log('\n━━ 第 2 步：流式请求（网站实际用的方式） ━━')
const pathsSeen = new Map() // path -> { first chunk no, count, sample }
let chunks = 0
let content = ''
let usage = null
try {
  const r = await post(true)
  if (!r.ok) {
    console.log(`❌ 请求失败 ${errText(r.status, await r.text())}`)
  } else {
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let j
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        chunks++
        if (j.usage) usage = j.usage
        const d = j.choices && j.choices[0] && j.choices[0].delta
        if (d && d.content) content += d.content
        for (const [p, arr] of Object.entries(findSourceArrays(j))) {
          const seen = pathsSeen.get(p)
          if (seen) seen.count++
          else pathsSeen.set(p, { first: chunks, count: 1, sample: arr.slice(0, 3), size: arr.length })
        }
      }
    }
    const calls = usage && usage.tool_usage && usage.tool_usage.web_search_call
    console.log(`共 ${chunks} 个数据块　搜索次数：${calls ?? '未返回'}　回答 ${content.length} 字`)
    if (pathsSeen.size) {
      for (const [p, s] of pathsSeen) {
        console.log(`来源字段：${p}　首次出现在第 ${s.first} 块，共出现 ${s.count} 次，${s.size} 条`)
        for (const x of s.sample) console.log(`   ${brief(x)}`)
      }
    } else {
      console.log('来源字段：流式返回里没找到')
    }
    console.log(`回答开头：${content.replace(/\s+/g, ' ').slice(0, 160)}`)
    if (usage) console.log(`usage：${JSON.stringify(usage).slice(0, 300)}`)
  }
} catch (e) {
  console.log(`❌ 网络错误：${e.message}`)
}

// ---------- 结论 ----------
console.log('\n━━ 结论 ━━')
const v = verdictForPaths([...pathsSeen.keys()])
const calls = usage && usage.tool_usage && usage.tool_usage.web_search_call
if (v) {
  console.log('✅ 联网搜索可用')
  console.log(v)
} else if (calls) {
  console.log(`⚠️ 模型搜索了 ${calls} 次，但流式返回里没找到来源列表：网站会显示「联网搜索 N 次」，但没有角标和「参考来源」。请把本输出发给开发者`)
} else if (chunks) {
  console.log(
    ok1
      ? '⚠️ 请求成功但没有触发搜索。可能是搜索没开通被静默忽略，也可能是模型这次判断不需要搜索。可以再运行一次，或换 hy3 试试；也去 TokenHub 控制台看搜索资源包有没有消耗'
      : '⚠️ 流式成功但没有触发搜索，见上面第 1 步的报错',
  )
} else {
  console.log('❌ 联网搜索不可用，见上面的报错')
}
