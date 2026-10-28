// 跨模块共享的前端状态
export const state = {
  session: null,
  me: { uid: null, isAdmin: false, hasAdmin: false },
  providers: [],
  defaultPrompt: '',
  /** user_llm_settings 行：{ id, provider, configs, thinking, system_prompt } */
  llm: null,
  /** news_id -> { id, sentiment, updated_at } */
  analyses: new Map(),
  /** news_id -> news row */
  news: new Map(),
  status: null,
  /** 数据库保留天数（crawler_settings.retention_days，1–14，默认 14） */
  retentionDays: 14,
  /** 快讯来源（来自 /api/providers 的 sources，最前面是虚拟的「全部」tab）与当前 tab */
  sources: [
    { id: 'all', name: '全部', shortName: '全部' },
    { id: 'wscn', name: '华尔街见闻', shortName: '见闻', homepage: 'https://wallstreetcn.com/live/global' },
    { id: 'cls', name: '财联社电报', shortName: '财联社', homepage: 'https://www.cls.cn/telegraph' },
    { id: 'jin10', name: '金十数据', shortName: '金十', homepage: 'https://www.jin10.com' },
  ],
  source: 'wscn',
}

export const SENTIMENT = {
  pos: { text: '利好', cls: 'pos' },
  neg: { text: '利空', cls: 'neg' },
  neu: { text: '中性', cls: 'neu' },
}

export function parseSentiment(text) {
  const m = /综合判断[^\n]{0,12}?(利好|利空|中性)/.exec(String(text || '').slice(0, 400))
  if (!m) return null
  return { 利好: 'pos', 利空: 'neg', 中性: 'neu' }[m[1]]
}

export function activeLlmConfig() {
  const row = state.llm
  if (!row) return null
  const provider = row.provider || 'deepseek'
  const cfg = (row.configs && row.configs[provider]) || {}
  return {
    provider,
    apiKey: cfg.apiKey || '',
    model: cfg.model || '',
    baseUrl: cfg.baseUrl || '',
    thinking: !!row.thinking,
    webSearch: row.web_search !== false,
    systemPrompt: row.system_prompt || '',
  }
}

/** 联网搜索是否可用：{ ok, reason }，reason = provider | model | region */
export function searchSupport(providerId, model, baseUrl) {
  const p = providerById(providerId)
  const ws = p && p.webSearch
  if (!ws) return { ok: false, reason: 'provider' }
  if (!ws.models.includes(model || p.defaultModel)) return { ok: false, reason: 'model' }
  if (!ws.baseUrls.includes(baseUrl || p.baseUrls[0].url)) return { ok: false, reason: 'region' }
  return { ok: true }
}

export function providerById(id) {
  return state.providers.find((p) => p.id === id)
}

/** 在服务商模型表里查找模型（含别名），找不到返回 null；与服务端 lib/llm.js findModel 一致 */
export function findModel(provider, model) {
  if (!provider || !model) return null
  return (provider.models || []).find((m) => m.id === model || (m.aliases || []).includes(model)) || null
}

/** 来源信息；未知来源返回一个兜底对象 */
export function sourceById(id) {
  return state.sources.find((s) => s.id === id) || { id, name: id || '未知来源', shortName: id || '未知' }
}

// 「全部」tab 的跨来源去重阈值：两条快讯存在至少 X 个连续相同的字判为重复
//   存在本浏览器（localStorage），默认 5；0 = 不去重；范围 0–50
const DEDUP_KEY = 'flash-news.dedupX'

export function getDedupX() {
  try {
    const v = Number.parseInt(localStorage.getItem(DEDUP_KEY), 10)
    return Number.isInteger(v) && v >= 0 && v <= 50 ? v : 5
  } catch {
    return 5
  }
}

export function setDedupX(v) {
  try {
    localStorage.setItem(DEDUP_KEY, String(v))
  } catch {
    /* ignore */
  }
}
