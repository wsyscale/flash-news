// 来源：财联社电报（https://www.cls.cn/telegraph）
//
// 接口：财联社网页「电报」页使用的 /v1/roll/get_roll_list，按 last_time 往前翻页，每页最多 50 条。
//   用户最初提供的 /api/cache?name=refreshTenTelegraph 只返回「某时刻之后的新增」，不能往前翻，漏抓后补不回来，所以不用它。
// 签名：sign = md5(sha1(按参数名排序拼成的 query))，与财联社网页前端一致；签错接口返回 errno=10012。
// 等级：level B = 网站上的「加红」电报，记为 score 3（重要）；其余 level C 记为 score 2。
// 过滤：type != -1 的是付费栏目（盘中宝、电报解读、风口研报等，正文把公司名藏成「这家公司」），不收录。
import { createHash } from 'node:crypto'
import { str, UA } from './util.js'

export const id = 'cls'
export const name = '财联社电报'
export const shortName = '财联社'
export const homepage = 'https://www.cls.cn/telegraph'

export const defaults = {
  url: 'https://www.cls.cn/v1/roll/get_roll_list',
  pageSize: 50,
  app: 'CailianpressWeb',
  os: 'web',
  sv: '8.7.9',
}

/** 财联社网页前端的参数签名 */
export function sign(params) {
  const q = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  const sha1 = createHash('sha1').update(q, 'utf8').digest('hex')
  return createHash('md5').update(sha1, 'utf8').digest('hex')
}

const MARKET = { sh: '沪A', sz: '深A', bj: '北交所', hk: '港股', us: '美股' }

function stockOf(s) {
  const key = str(s && s.StockID, 20).toLowerCase()
  const name = str(s && s.name, 40).trim()
  if (!key || !name) return null
  const m = /^([a-z]{2})(\d+)/.exec(key)
  // sh600519 → 600519；92xxxx 这类无前缀代码保持原样
  return { key, code: m ? m[2] : key, name, market: (m && MARKET[m[1]]) || '' }
}

/** 正文去掉开头重复的【标题】；没有标题时尝试从【…】里取 */
function splitTitle(title, content) {
  let t = str(title, 500).trim()
  let c = str(content, 20000).trim()
  const m = /^【([^】]{1,120})】\s*/.exec(c)
  if (m) {
    if (!t) t = m[1].trim()
    if (m[1].trim() === t) c = c.slice(m[0].length).trim()
  }
  return { title: t, content: c }
}

export function normalize(it) {
  if (!it || !Number.isFinite(Number(it.id)) || !Number.isFinite(Number(it.ctime))) return null
  if (Number(it.type) !== -1) return null // 付费栏目
  if (it.is_ad) return null
  const { title, content } = splitTitle(it.title, it.content || it.brief)
  if (!content && !title) return null
  const images = (Array.isArray(it.images) ? it.images : [])
    .filter((u) => typeof u === 'string' && /^https:\/\/[a-z0-9.-]*cls\.cn\//i.test(u))
    .slice(0, 9)
  const symbols = (Array.isArray(it.stock_list) ? it.stock_list : []).map(stockOf).filter(Boolean).slice(0, 20)
  const tags = [...new Set((Array.isArray(it.subjects) ? it.subjects : []).map((s) => str(s && s.subject_name, 40).trim()).filter(Boolean))].slice(0, 10)
  return {
    source: id,
    source_id: String(it.id),
    title,
    content_text: content,
    content_html: '',
    content_more: '',
    score: it.level === 'A' || it.level === 'B' ? 3 : 2,
    channels: [],
    uri: `https://www.cls.cn/detail/${Number(it.id)}`,
    article: null,
    images,
    symbols,
    tags,
    display_time: String(it.ctime),
  }
}

/**
 * 取一页；cursor 为「只要早于这个时间（秒）」的条目，首页传 null（= 当前时间）。
 * 接口的 last_time 是「早于且不含」，同一秒发了多条时，用 +1 再按 id 去重，避免翻页时漏掉。
 */
export async function fetchPage(cfg, cursor, { timeoutMs = 15000 } = {}) {
  const lastTime = cursor ? Number(cursor) : Math.floor(Date.now() / 1000)
  const params = {
    app: cfg.app,
    category: '',
    last_time: String(lastTime),
    os: cfg.os,
    refresh_type: '1',
    rn: String(Math.min(Math.max(Number(cfg.pageSize) || 50, 1), 50)),
    sv: cfg.sv,
  }
  const url = new URL(cfg.url)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('sign', sign(params))
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.cls.cn/telegraph' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`财联社接口 HTTP ${res.status}`)
  const body = await res.json()
  if (body.errno !== 0 || !body.data) throw new Error(`财联社接口返回异常 errno=${body.errno} ${body.msg || body.error || ''}`.trim())
  const raw = Array.isArray(body.data.roll_data) ? body.data.roll_data : []
  const oldest = raw.reduce((m, x) => Math.min(m, Number(x.ctime) || m), Infinity)
  // 再往前一页：从这一页最早的那一秒开始（+1 → 含这一秒），重复的条目由 id 去重
  const nextCursor = raw.length && Number.isFinite(oldest) && oldest + 1 < lastTime ? oldest + 1 : null
  return { items: raw.map(normalize).filter(Boolean), rawCount: raw.length, nextCursor }
}
