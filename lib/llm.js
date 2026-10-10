// LLM 代理：DeepSeek / 腾讯云 TokenHub / 自定义 OpenAI 兼容服务
// 浏览器无法直连 TokenHub（无 CORS），所以统一由服务端转发并以 SSE 流式回传。
// API Key 由前端随请求传入，服务端只转发、不落盘、不打日志。
import dns from 'node:dns/promises'
import net from 'node:net'

// 模型表字段说明：
//   thinking：toggle = 支持 thinking 参数开关；always = 思考常开、不可关闭；auto = 文档未列出思考参数，按模型默认行为（不传参）
//   region：cn = 仅广州（国内站）；intl = 仅新加坡 / 硅谷（国际站）；不写 = 两边都有
//   aliases：同一个模型的其他 model 参数值（不在下拉框里单独列出，手动填写时也能正确识别）
//   note：用途提示；special：专用模型（角色扮演 / 翻译 / 编程），会提示不适合财经分析；deprecated：官方标注「即将下线」
// 不在表里的模型可以在设置里手动填写，按「未收录模型」处理（见 resolveTarget）。

/**
 * 腾讯云 TokenHub 语言模型，来源：官方文档「语言模型调用概览」（2026-10-09 更新）、「深度思考」（2026-09-29 更新）。
 * 平台模型会持续更新，最新列表以控制台或 GET /v1/models 为准。
 */
const TOKENHUB_MODELS = [
  // DeepSeek
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', group: 'DeepSeek', thinking: 'toggle' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', group: 'DeepSeek', thinking: 'toggle' },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 正式版', group: 'DeepSeek', thinking: 'toggle' },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813 正式版', group: 'DeepSeek', thinking: 'toggle' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', group: 'DeepSeek', thinking: 'toggle' },
  { id: 'deepseek/deepseek-flash', name: 'DeepSeek V4.1 Flash · 原厂直供', group: 'DeepSeek', thinking: 'toggle' },
  {
    id: 'deepseek-v4-flash-202605',
    name: 'DeepSeek V4 Flash 0731 · 原厂直供',
    group: 'DeepSeek',
    thinking: 'toggle',
    aliases: ['deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash'],
  },
  {
    id: 'deepseek-v4-pro-202606',
    name: 'DeepSeek V4 Pro 0813 · 原厂直供',
    group: 'DeepSeek',
    thinking: 'toggle',
    aliases: ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro'],
  },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp · 原厂直供', group: 'DeepSeek', thinking: 'toggle', note: '视觉实验版' },
  // 腾讯混元
  { id: 'hy4-preview', name: 'Hy4 Preview', group: '腾讯混元', thinking: 'toggle' },
  { id: 'hy3', name: 'Hy3', group: '腾讯混元', thinking: 'toggle' },
  { id: 'hunyuan-role-latest', name: 'Hy-Role-Latest', group: '腾讯混元', thinking: 'auto', region: 'cn', note: '角色扮演模型', special: true },
  { id: 'hy-role', name: 'Hy-Role', group: '腾讯混元', thinking: 'auto', region: 'cn', note: '角色扮演模型', special: true },
  { id: 'hy-mt2-pro', name: 'Hy-MT2-Pro', group: '腾讯混元', thinking: 'auto', region: 'cn', note: '翻译专用模型', special: true },
  { id: 'hy-mt2-plus', name: 'Hy-MT2-Plus', group: '腾讯混元', thinking: 'auto', note: '翻译专用模型', special: true },
  { id: 'hy-mt2-lite', name: 'Hy-MT2-Lite', group: '腾讯混元', thinking: 'auto', region: 'cn', note: '翻译专用模型', special: true },
  // 智谱 GLM
  { id: 'glm-5.3', name: 'GLM-5.3', group: '智谱 GLM', thinking: 'always' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', group: '智谱 GLM', thinking: 'always' },
  { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', group: '智谱 GLM', thinking: 'always' },
  { id: 'glm-5.2', name: 'GLM-5.2', group: '智谱 GLM', thinking: 'toggle' },
  { id: 'glm-5.1', name: 'GLM-5.1', group: '智谱 GLM', thinking: 'toggle', deprecated: true },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo', group: '智谱 GLM', thinking: 'toggle', deprecated: true },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', group: '智谱 GLM', thinking: 'toggle', deprecated: true, note: '视觉模型' },
  { id: 'glm-5', name: 'GLM-5', group: '智谱 GLM', thinking: 'toggle', deprecated: true },
  // 月之暗面 Kimi
  { id: 'kimi-k3', name: 'Kimi K3', group: 'Kimi', thinking: 'always' },
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview', group: 'Kimi', thinking: 'auto' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', group: 'Kimi', thinking: 'always', note: '编程专用模型', special: true },
  { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed', group: 'Kimi', thinking: 'always', note: '编程专用模型', special: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', group: 'Kimi', thinking: 'toggle' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', group: 'Kimi', thinking: 'toggle', region: 'intl' },
  // MiniMax
  { id: 'minimax-m3', name: 'MiniMax-M3', group: 'MiniMax', thinking: 'toggle' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', group: 'MiniMax', thinking: 'always' },
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5', group: 'MiniMax', thinking: 'always', region: 'intl' },
  // 通义千问 Qwen
  { id: 'qwen3.5-plus', name: 'Qwen3.5-Plus', group: '通义千问 Qwen', thinking: 'toggle', region: 'cn' },
  { id: 'qwen3.5-flash', name: 'Qwen3.5-Flash', group: '通义千问 Qwen', thinking: 'toggle', region: 'cn' },
  // 小米 MiMo
  { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', group: '小米 MiMo', thinking: 'auto' },
  { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', group: '小米 MiMo', thinking: 'auto' },
  { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', group: '小米 MiMo', thinking: 'auto' },
  // 阶跃星辰 Step
  { id: 'step-5-preview', name: 'Step 5 Preview', group: '阶跃星辰 Step', thinking: 'auto' },
]

export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrls: [{ url: 'https://api.deepseek.com', label: 'DeepSeek 官方' }],
    defaultModel: 'deepseek-v4-flash',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', group: 'DeepSeek', thinking: 'toggle', note: '快速、低价' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', group: 'DeepSeek', thinking: 'toggle', note: '强推理' },
    ],
    thinking: 'param',
    keyHint: 'sk-…，在 platform.deepseek.com → API Keys 创建',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  tokenhub: {
    id: 'tokenhub',
    name: '腾讯云 TokenHub',
    baseUrls: [
      { url: 'https://tokenhub.tencentmaas.com/v1', label: '广州（中国大陆）' },
      { url: 'https://tokenhub.tencentcloudmaas.com/v1', label: '广州（备用域名）' },
      { url: 'https://tokenhub-intl.tencentcloudmaas.com/v1', label: '新加坡（国际站）' },
      { url: 'https://tokenhub-us.tencentcloudmaas.tech/v1', label: '硅谷（美国）' },
    ],
    defaultModel: 'deepseek-v4-flash',
    models: TOKENHUB_MODELS,
    thinking: 'param',
    // 联网搜索（Chat API 的 web_search_options）：官方「联网搜索」文档（2026-09-29）列出的模型，且仅广州地域可用
    webSearch: {
      source: 'lite',
      models: ['hy3', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813'],
      baseUrls: ['https://tokenhub.tencentmaas.com/v1', 'https://tokenhub.tencentcloudmaas.com/v1'],
      consoleUrl: 'https://console.cloud.tencent.com/tokenhub/open-management?regionId=1&tab=tools',
    },
    keyHint: '在腾讯云 TokenHub 控制台创建 API Key，并先开通对应模型服务',
    keyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
  },
  custom: {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrls: [],
    defaultModel: '',
    models: [],
    thinking: 'none',
    keyHint: '任意兼容 /chat/completions 的服务，Base URL 需包含版本路径，如 https://example.com/v1',
    keyUrl: '',
  },
}

export const DEFAULT_SYSTEM_PROMPT = `你是一名资深的宏观与证券市场分析师，擅长从财经快讯中提炼投资含义。请基于用户提供的一条财经快讯做深度分析，使用简体中文、Markdown 输出，结构如下：

第一行固定格式：综合判断：利好 / 利空 / 中性（影响强度 ★1~5）——三选一，并给出星级。

## 一句话结论
## 事件解读
发生了什么、关键数据或表态、与市场预期的差异。
## 背景与逻辑
事件的来龙去脉、传导路径。
## 市场影响
用表格列出：| 维度 | 方向 | 说明 |，按需覆盖宏观/利率/汇率、A股、港股、美股、大宗商品等。
## 受影响的行业与标的
列出可能受益/受损的行业与代表性 A 股、港股或美股标的（附代码），说明逻辑；不确定的标注「待确认」。
## 后续关注
后续需要跟踪的数据、事件、时间点。
## 风险提示

最后一行：*以上内容由 AI 生成，仅供参考，不构成投资建议。*

要求：区分事实与推测；不要编造数据；如果快讯信息量很小，请精简篇幅，不要硬凑。`

const SEARCH_ERR_RE = /search|搜索|web_search|tool|工具|资源包|未开通|not (?:enabled|activated|open)/i
const THINK_ERR_RE = /think|reasoning|思考/i

const MODEL_RE = /^[A-Za-z0-9._:/@+\-]{1,120}$/

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fmtBeijing(ts) {
  const d = ts ? new Date(ts) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

export const CHAT_SYSTEM_PROMPT = `你是一名资深的宏观与证券市场分析师。你刚刚就一条财经快讯给出了深度分析，现在用户会围绕这条快讯和你的分析继续追问。

回答要求：
- 使用简体中文，紧扣这条快讯、你之前的分析和用户的问题，直接回答，不要重复完整的分析框架；
- 区分事实与推测，不要编造数据、日期或公司公告；不确定的内容标注「待确认」；
- 需要时用 Markdown 列表或表格，篇幅与问题匹配；
- 提到具体标的时附代码；涉及买卖判断时提示风险，不构成投资建议；
- 如果用户的问题与这条快讯无关，可以简要回答，并提醒对话主题是这条快讯。`

// 快讯上下文（分析与追问共用）
function newsContext(news) {
  const parts = []
  parts.push(`快讯发布时间：${fmtBeijing(news.display_time)}（北京时间）`)
  if (news.title) parts.push(`标题：${String(news.title).slice(0, 500)}`)
  parts.push(`正文：${String(news.content_text || '').slice(0, 8000)}`)
  const more = stripHtml(news.content_more).slice(0, 8000)
  if (more) parts.push(`补充内容：${more}`)
  if (news.article && news.article.title) parts.push(`相关文章：${String(news.article.title).slice(0, 300)}`)
  parts.push(`当前时间：${fmtBeijing()}（北京时间）`)
  return parts.join('\n')
}

// ---------------- 关注的板块 / 标的 ----------------
const WATCH_TYPES = { stock: '个股', fund: '基金', sector: '板块', index: '指数', custom: '自定义' }
export const MAX_WATCH = 20

/** 校验并规范化前端传来的关注列表（只取名称 / 代码 / 市场 / 类型，最多 20 项） */
export function normalizeWatchlist(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const it of list.slice(0, 40)) {
    if (!it || typeof it !== 'object') continue
    const clean = (v, n) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)
    const name = clean(it.name, 40)
    if (!name) continue
    const code = clean(it.code, 20)
    const market = clean(it.market, 20)
    const type = Object.hasOwn(WATCH_TYPES, it.type) ? it.type : 'custom'
    const key = `${code.toUpperCase()}|${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, code, market, type })
    if (out.length >= MAX_WATCH) break
  }
  return out
}

function watchLines(list) {
  return list
    .map((it, i) => {
      const extra = [it.code, it.market || WATCH_TYPES[it.type]].filter(Boolean).join('，')
      return `${i + 1}. ${it.name}${extra ? `（${extra}）` : ''}`
    })
    .join('\n')
}

const WATCH_INSTRUCTION = `请在「风险提示」之前增加一节「## 对我关注的板块 / 标的影响」（如果没有「风险提示」一节，就放在正文最后、免责声明之前）：
- 先用一句话说明这条快讯与上述关注列表的整体关联程度；
- 用表格列出与本条快讯有实际关联的关注项：| 关注项 | 关联度（高/中/低） | 短期影响（1 个月内） | 中长期影响（3–12 个月） | 逻辑与关键变量 |；两个影响栏都以「利好」「利空」或「中性」开头，再简述原因；
- 短期侧重情绪、资金与预期差，中长期侧重基本面、业绩与产业趋势；
- 与本条快讯关联很弱的关注项不要逐个展开，在表格后合并为一行「其余关注项：关联较弱（列出名称）」；不要为了凑关联而牵强附会。`

const SEARCH_INSTRUCTION = `本次可以联网搜索。需要时请搜索核实或补充：事件背景与最新进展、相关公司公告与业绩、行业与市场数据、政策原文等；快讯信息已足够时可直接分析，不要为了搜索而搜索。
引用搜索得到的事实时，在句末用 [序号] 标注来源；注意区分旧闻与快讯发布后的新进展；搜索结果与快讯矛盾时指出分歧并说明哪方更可信；不要编造来源或数据。`

const CHAT_SEARCH_RULE = `
- 本次可以联网搜索：需要实时信息（行情、公告、最新进展、数据）时再搜索；引用搜索结果时在句末用 [序号] 标注来源，不要编造来源。`

export function buildMessages(news, systemPrompt, watchlist = [], { webSearch = false } = {}) {
  const sys = (systemPrompt && String(systemPrompt).trim()) || DEFAULT_SYSTEM_PROMPT
  let user = newsContext(news)
  if (watchlist.length) user += `\n\n我关注的板块 / 标的（共 ${watchlist.length} 项）：\n${watchLines(watchlist)}\n\n${WATCH_INSTRUCTION}`
  if (webSearch) user += `\n\n${SEARCH_INSTRUCTION}`
  return [
    { role: 'system', content: sys.slice(0, 8000) },
    { role: 'user', content: user },
  ]
}

const CHAT_INPUT_BUDGET = 60_000 // 发送给模型的总字符上限，超出时从最早的追问开始丢弃
const CHAT_MAX_QUESTION = 4000

/**
 * 追问上下文：系统提示 → 快讯（用户）→ 之前的深度分析（助手）→ 历史追问 → 本次问题。
 * 历史只取正文，不回传思考过程（DeepSeek 等思考模型要求多轮对话中不携带 reasoning_content）。
 */
export function buildChatMessages({ news, analysis, history, question, watchlist = [], webSearch = false }) {
  const q = String(question || '').trim().slice(0, CHAT_MAX_QUESTION)
  const ana = String(analysis || '').trim().slice(0, 20_000)
  const watch = watchlist.length
    ? `\n\n我关注的板块 / 标的（共 ${watchlist.length} 项，回答时如相关请结合它们，区分短期 1 个月内与中长期 3–12 个月的影响）：\n${watchLines(watchlist)}`
    : ''
  const base = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT + (webSearch ? CHAT_SEARCH_RULE : '') },
    { role: 'user', content: `${newsContext(news)}${watch}\n\n请对这条快讯做深度分析。` },
    { role: 'assistant', content: ana },
  ]
  const hist = []
  for (const m of Array.isArray(history) ? history.slice(-80) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const content = String(m.content || '').trim().slice(0, 12_000)
    if (!content) continue
    const last = hist[hist.length - 1]
    if (last && last.role === m.role) last.content += `\n\n${content}`
    else hist.push({ role: m.role, content })
  }
  // 历史需以「用户」开头、以「助手」结尾，保证与本次问题衔接后严格交替
  while (hist.length && hist[0].role !== 'user') hist.shift()
  while (hist.length && hist[hist.length - 1].role !== 'assistant') hist.pop()
  const fixed = base.reduce((n, m) => n + m.content.length, 0) + q.length
  let total = hist.reduce((n, m) => n + m.content.length, 0)
  let dropped = 0
  while (hist.length && fixed + total > CHAT_INPUT_BUDGET) {
    const pair = hist.splice(0, 2)
    total -= pair.reduce((n, m) => n + m.content.length, 0)
    dropped += pair.length
  }
  return { messages: [...base, ...hist, { role: 'user', content: q }], dropped }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  const v = ip.toLowerCase()
  if (v === '::1' || v === '::') return true
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7))
  return false
}

async function assertPublicHttps(urlStr) {
  let u
  try {
    u = new URL(urlStr)
  } catch {
    throw httpError(400, 'Base URL 格式不正确')
  }
  if (u.protocol !== 'https:') throw httpError(400, 'Base URL 必须是 https 地址')
  if (u.username || u.password) throw httpError(400, 'Base URL 不能包含账号密码')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw httpError(400, 'Base URL 不能指向内网地址')
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => [])
  if (!addrs.length) throw httpError(400, 'Base URL 域名无法解析')
  if (addrs.some((a) => isPrivateIp(a.address))) throw httpError(400, 'Base URL 不能指向内网地址')
  return u.toString().replace(/\/+$/, '')
}

export function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

/** 校验并解析出上游调用参数 */
export async function resolveTarget(body) {
  const provider = PROVIDERS[body && body.provider]
  if (!provider) throw httpError(400, '不支持的模型服务商')
  const apiKey = String(body.apiKey || '').trim()
  if (!apiKey) throw httpError(400, '请先在「设置」中填写 API Key')
  if (apiKey.length > 512 || /\s/.test(apiKey)) throw httpError(400, 'API Key 格式不正确')

  const model = String(body.model || provider.defaultModel || '').trim()
  if (!MODEL_RE.test(model)) throw httpError(400, '模型名称不正确')

  let baseUrl
  if (provider.id === 'custom') {
    baseUrl = await assertPublicHttps(String(body.baseUrl || '').trim())
  } else {
    const wanted = String(body.baseUrl || '').trim().replace(/\/+$/, '')
    const hit = provider.baseUrls.find((b) => b.url === wanted)
    baseUrl = (hit || provider.baseUrls[0]).url
  }

  // 思考模式：none = 服务商不支持思考参数；toggle / always / auto 见模型表；unknown = 手动填写、表里没有的模型
  const info = findModel(provider, model)
  const thinkingMode = provider.thinking !== 'param' ? 'none' : info ? info.thinking : 'unknown'
  const payloadExtra = {}
  const sendThinking = thinkingMode === 'toggle' || thinkingMode === 'unknown'
  if (sendThinking) payloadExtra.thinking = { type: body.thinking ? 'enabled' : 'disabled' }
  const thinkingOn = thinkingMode === 'always' || (sendThinking && !!body.thinking)
  const searchOn = !!body.webSearch && searchSupport(provider, model, baseUrl).ok
  if (searchOn) payloadExtra.web_search_options = { enable: true, search_source: provider.webSearch.source }
  return { provider, apiKey, model, baseUrl, payloadExtra, thinkingOn, thinkingMode, searchOn }
}

/** 在服务商模型表里查找模型（含别名），找不到返回 null */
export function findModel(provider, model) {
  if (!provider || !model) return null
  return provider.models.find((m) => m.id === model || (m.aliases || []).includes(model)) || null
}

/** 当前服务商 / 模型 / 接入地址能否联网搜索；不能时给出原因 */
export function searchSupport(provider, model, baseUrl) {
  const ws = provider && provider.webSearch
  if (!ws) return { ok: false, reason: 'provider' }
  if (!ws.models.includes(model)) return { ok: false, reason: 'model' }
  if (!ws.baseUrls.includes(baseUrl)) return { ok: false, reason: 'region' }
  return { ok: true }
}

// ---------------- 联网搜索引用来源 ----------------
const MAX_SOURCES = 30
function cleanText(v, n) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
}

/** 规范化一条来源；url 只接受 http(s) */
function normSource(raw, fallbackIndex) {
  if (!raw || typeof raw !== 'object') return null
  const c = raw.url_citation && typeof raw.url_citation === 'object' ? { ...raw, ...raw.url_citation } : raw
  const url = cleanText(c.url || c.link || c.href, 1000)
  if (!/^https?:\/\//i.test(url)) return null
  const idx = Number.parseInt(c.index ?? c.idx ?? c.id, 10)
  return {
    index: Number.isInteger(idx) && idx > 0 && idx < 1000 ? idx : fallbackIndex,
    url,
    title: cleanText(c.name || c.title || c.site_name || url, 200),
    snippet: cleanText(c.snippet || c.summary || c.content, 400),
    site: cleanText(c.site || c.site_name || c.source || c.host, 60),
  }
}

/**
 * 从一个流式 chunk 中找出引用来源。TokenHub 文档只写明了非流式位置（choices[0].message.search_results），
 * 流式位置未说明，这里兼容常见的几种放法。
 */
function extractSources(j) {
  const choice = (j.choices && j.choices[0]) || {}
  const cands = [
    choice.delta && choice.delta.search_results,
    choice.message && choice.message.search_results,
    choice.search_results,
    j.search_results,
    j.search_info && j.search_info.search_results,
    choice.delta && choice.delta.annotations,
    choice.message && choice.message.annotations,
  ]
  const out = []
  for (const arr of cands) if (Array.isArray(arr)) out.push(...arr)
  return out
}

function upstreamDetail(status, text) {
  let detail = ''
  try {
    const j = JSON.parse(text)
    detail = (j.error && (j.error.message_zh || j.error.message || j.error.code)) || j.message || j.msg || ''
  } catch {
    detail = String(text || '')
  }
  return `HTTP ${status}${detail ? `：${String(detail).slice(0, 160)}` : ''}`
}

function upstreamErrorMessage(status, text) {
  let detail = ''
  try {
    const j = JSON.parse(text)
    detail = (j.error && (j.error.message_zh || j.error.message || j.error.code)) || j.message || j.msg || ''
  } catch {
    detail = String(text || '').slice(0, 200)
  }
  const map = {
    400: '请求参数被拒绝（检查模型名称或参数）',
    401: 'API Key 无效或已过期',
    402: '账户余额不足，或该模型服务尚未开通',
    403: '无权访问该模型（检查 Key 权限或模型开通状态）',
    404: '模型或接口地址不存在（检查模型名称 / Base URL）',
    408: '上游请求超时',
    413: '输入内容过长',
    422: '请求参数不合法',
    429: '请求过于频繁或并发超限，请稍后再试',
  }
  const head = map[status] || (status >= 500 ? `模型服务暂时不可用（HTTP ${status}）` : `模型服务返回错误（HTTP ${status}）`)
  return detail ? `${head}：${String(detail).slice(0, 300)}` : head
}

/** 连通性测试（非流式、极短输出） */
export async function testConnection(body) {
  const t = await resolveTarget(body)
  const started = Date.now()
  const payload = {
    model: t.model,
    messages: [{ role: 'user', content: '请只回复两个字母：OK' }],
    // 思考常开 / 按默认 / 未收录的模型可能先输出思考内容，给足 token
    max_tokens: t.thinkingMode === 'toggle' || t.thinkingMode === 'none' ? 16 : 512,
    stream: false,
  }
  // 只对确认支持开关的模型传「关闭思考」；未收录的模型不传，避免测试时被参数校验拦下
  if (t.thinkingMode === 'toggle') payload.thinking = { type: 'disabled' }
  let res
  try {
    res = await fetch(`${t.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (err) {
    throw httpError(502, `无法连接模型服务：${err.name === 'TimeoutError' ? '请求超时' : err.message}`)
  }
  const text = await res.text()
  if (!res.ok) throw httpError(502, upstreamErrorMessage(res.status, text))
  let reply = ''
  try {
    const j = JSON.parse(text)
    reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
  } catch {
    /* ignore */
  }
  return { ok: true, latencyMs: Date.now() - started, model: t.model, reply: String(reply).slice(0, 50) }
}

/** 流式深度分析 */
export async function streamAnalysis(req, res, body, log = console) {
  const t = await resolveTarget(body)
  const news = body.news || {}
  if (!news.content_text && !news.title) throw httpError(400, '快讯内容为空')
  const watchlist = normalizeWatchlist(body.watchlist)
  const messages = buildMessages(news, body.systemPrompt, watchlist, { webSearch: t.searchOn })
  return streamCompletion(res, t, messages, { temperature: 0.5 }, { watch: watchlist.length }, log)
}

/** 流式追问：基于快讯 + 已有分析 + 历史对话继续回答 */
export async function streamChat(req, res, body, log = console) {
  const t = await resolveTarget(body)
  const news = body.news || {}
  if (!news.content_text && !news.title) throw httpError(400, '快讯内容为空')
  if (!String(body.analysis || '').trim()) throw httpError(400, '请先完成这条快讯的深度分析，再继续追问')
  const question = String(body.question || '').trim()
  if (!question) throw httpError(400, '请输入问题')
  if (question.length > CHAT_MAX_QUESTION) throw httpError(400, `问题太长了，请控制在 ${CHAT_MAX_QUESTION} 字以内`)
  const { messages, dropped } = buildChatMessages({
    news,
    analysis: body.analysis,
    history: body.history,
    question,
    watchlist: normalizeWatchlist(body.watchlist),
    webSearch: t.searchOn,
  })
  return streamCompletion(res, t, messages, { temperature: 0.6 }, { dropped }, log)
}

/**
 * 调用上游并把 OpenAI 兼容 SSE 归一为
 *   event: meta | reasoning | content | usage | error | done
 */
async function streamCompletion(res, t, messages, { temperature = 0.5 } = {}, metaExtra = {}, log = console) {
  const payload = {
    model: t.model,
    messages,
    stream: true,
    // 「按模型默认」的模型可能自带思考，同样留足输出长度，也不传 temperature
    max_tokens: t.thinkingOn || t.thinkingMode === 'auto' ? 8192 : 4096,
    ...t.payloadExtra,
  }
  if (!t.thinkingOn && t.thinkingMode !== 'auto') payload.temperature = temperature
  if (t.provider.id !== 'custom') payload.stream_options = { include_usage: true }

  const ac = new AbortController()
  const onClose = () => ac.abort()
  res.on('close', onClose)
  const idle = { timer: null }
  const kick = () => {
    clearTimeout(idle.timer)
    idle.timer = setTimeout(() => ac.abort(new Error('idle timeout')), 120_000)
  }
  kick()

  const post = (body) =>
    fetch(`${t.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${t.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  const fail = (err) => {
    clearTimeout(idle.timer)
    res.off('close', onClose)
    throw err
  }

  let body = payload
  let searchOn = t.searchOn
  let thinkingOn = t.thinkingOn
  let searchError = null
  let upstream
  try {
    upstream = await post(body)
    // 可选参数被拒时去掉重试（最多两次）：
    //   · 联网搜索未开通 / 资源包用完 → 去掉 web_search_options，并告知前端
    //   · 手动填写的未收录模型不认 thinking 参数 → 去掉 thinking，按模型默认行为
    for (let i = 0; i < 2 && !upstream.ok && [400, 402, 403, 404, 422].includes(upstream.status); i++) {
      const text = await upstream.text().catch(() => '')
      if (searchOn && SEARCH_ERR_RE.test(text)) {
        searchError = `联网搜索不可用（${upstreamDetail(upstream.status, text)}），本次已改为不联网分析。请在 TokenHub 控制台「启用管理 → 应用工具」领取联网搜索免费资源包或开通后付费，或在设置里关闭联网搜索`
        log.warn(`[llm] web search rejected (${upstream.status}), retry without search`)
        const { web_search_options, ...rest } = body
        body = rest
        searchOn = false
      } else if (body.thinking && t.thinkingMode === 'unknown' && [400, 422].includes(upstream.status) && THINK_ERR_RE.test(text)) {
        log.warn(`[llm] thinking param rejected by ${t.model} (${upstream.status}), retry without it`)
        const { thinking, ...rest } = body
        body = rest
        thinkingOn = false
      } else {
        fail(httpError(502, upstreamErrorMessage(upstream.status, text)))
      }
      upstream = await post(body)
    }
  } catch (err) {
    if (err.status) throw err
    fail(httpError(502, `无法连接模型服务：${err.message}`))
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    fail(httpError(502, upstreamErrorMessage(upstream.status, text)))
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event, data) => {
    if (res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  send('meta', { provider: t.provider.id, model: t.model, thinking: thinkingOn, webSearch: searchOn, searchError, ...metaExtra })
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000)

  const decoder = new TextDecoder()
  let buffer = ''
  let gotContent = false
  // 引用来源：多个 chunk 可能重复携带，按 url 去重，有新增时下发完整列表
  const sources = new Map()
  const addSources = (list) => {
    let added = false
    for (const raw of list) {
      if (sources.size >= MAX_SOURCES) break
      const s = normSource(raw, sources.size + 1)
      if (!s || sources.has(s.url)) continue
      sources.set(s.url, s)
      added = true
    }
    if (added) send('sources', { items: [...sources.values()].sort((a, b) => a.index - b.index) })
  }
  try {
    for await (const chunk of upstream.body) {
      kick()
      buffer += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let j
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (j.error) {
          send('error', { message: upstreamErrorMessage(Number(j.error.code) || 500, JSON.stringify(j)) })
          continue
        }
        if (searchOn) {
          const found = extractSources(j)
          if (found.length) addSources(found)
        }
        const choice = j.choices && j.choices[0]
        const delta = (choice && (choice.delta || choice.message)) || {}
        const reasoning = delta.reasoning_content || delta.reasoning
        if (reasoning) send('reasoning', { delta: reasoning })
        if (delta.content) {
          gotContent = true
          send('content', { delta: delta.content })
        }
        if (j.usage) send('usage', j.usage)
      }
    }
    if (!gotContent) send('error', { message: '模型没有返回正文内容，请重试或更换模型' })
    send('done', {})
  } catch (err) {
    if (!ac.signal.aborted || !res.destroyed) {
      log.warn(`[llm] stream interrupted: ${err && err.message}`)
      send('error', { message: '与模型服务的连接中断，请重试' })
    }
  } finally {
    clearInterval(heartbeat)
    clearTimeout(idle.timer)
    res.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

export function publicProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    baseUrls: p.baseUrls,
    defaultModel: p.defaultModel,
    models: p.models,
    supportsThinking: p.thinking === 'param',
    webSearch: p.webSearch ? { models: p.webSearch.models, baseUrls: p.webSearch.baseUrls, consoleUrl: p.webSearch.consoleUrl, source: p.webSearch.source } : null,
    keyHint: p.keyHint,
    keyUrl: p.keyUrl,
  }))
}
