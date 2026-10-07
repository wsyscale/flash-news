// 关注的板块 / 标的：保存在 user_llm_settings.watchlist（每人私有）
//   · 分析 / 追问时随请求发给模型，评估短期（1 个月内）与中长期（3–12 个月）影响
//   · 快讯列表按名称 / 代码匹配打「关注」标签，并支持「与我相关」筛选
import { state } from './state.js'

export const MAX_WATCH = 20
export const QUICK_SECTORS = ['半导体', '人工智能', '算力', '新能源车', '光伏', '储能', '黄金', '原油', '银行', '券商', '白酒', '医药', '军工', '房地产', '稀土', '电力']
export const WATCH_TYPE_LABEL = { stock: '个股', fund: '基金', sector: '板块', index: '指数', custom: '自定义' }

export function getWatchlist() {
  const w = state.llm && state.llm.watchlist
  return Array.isArray(w) ? w : []
}

export const watchKey = (it) => `${String(it.code || '').toUpperCase()}|${it.name}`

export function sameWatchlist(a, b) {
  const norm = (l) => (Array.isArray(l) ? l : []).map(watchKey).sort().join(';')
  return norm(a) === norm(b)
}

export function watchLabel(it) {
  const extra = [it.code, it.market || (it.type !== 'custom' ? WATCH_TYPE_LABEL[it.type] : '')].filter(Boolean).join(' · ')
  return extra ? `${it.name} ${extra}` : it.name
}

// PostgREST 过滤语法里的保留字符统一替换掉
const clean = (s) => String(s || '').replace(/[,()*%\\:."'`]/g, ' ').replace(/\s+/g, ' ').trim()
const hasWord = (s) => /[\u4e00-\u9fa5A-Za-z]{2,}/.test(s)

/** 一个关注项用于匹配快讯的关键词：名称、去后缀的简称、A 股 6 位代码 / 美股代码 */
export function keywordsOf(it) {
  const out = new Set()
  const name = clean(it.name)
  if (name.length >= 2) out.add(name)
  let core = name
  if (it.type === 'fund') {
    // 中证新能源车ETF → 新能源车：ETF 跟踪的是行业，用行业词匹配快讯
    core = core.replace(/(ETF|LOF|联接|指数|基金).*$/i, '').replace(/^(科创板?|创业板|中证|沪深|国证|上证|深证|恒生|中概)/, '').trim()
  } else {
    // 腾讯控股 → 腾讯、英伟达概念 → 英伟达
    for (let i = 0; i < 2; i++) core = core.replace(/(股份有限公司|有限公司|股份|集团|控股|概念|板块|行业|指数|-[A-Z]{1,2})$/i, '').trim()
  }
  if (core.length >= 2 && hasWord(core)) out.add(core)
  const code = clean(it.code)
  if (/^\d{6}$/.test(code)) out.add(code)
  else if (it.type === 'stock' && /^[A-Z]{3,5}$/i.test(code)) out.add(code.toUpperCase())
  return [...out]
}

let cacheFor = null
let cacheIndex = []
function index() {
  const list = getWatchlist()
  if (list !== cacheFor) {
    cacheFor = list
    cacheIndex = list.map((it) => ({ it, kws: keywordsOf(it).map((k) => k.toLowerCase()) }))
  }
  return cacheIndex
}

/** 快讯命中的关注项 */
export function matchWatch(news) {
  const idx = index()
  if (!idx.length) return []
  const text = `${news.title || ''} ${news.content_text || ''}`.toLowerCase()
  return idx.filter((x) => x.kws.some((k) => text.includes(k))).map((x) => x.it)
}

/** 「与我相关」筛选的 PostgREST or 条件；没有关注项时返回 null */
export function relatedOrFilter() {
  const kws = [...new Set(index().flatMap((x) => x.kws))].slice(0, 40)
  if (!kws.length) return null
  return kws.flatMap((k) => [`title.ilike.*${k.replace(/ /g, '*')}*`, `content_text.ilike.*${k.replace(/ /g, '*')}*`]).join(',')
}
