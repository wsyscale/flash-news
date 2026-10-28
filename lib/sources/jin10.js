// 来源：金十数据 7×24 快讯（https://www.jin10.com/）
//
// 接口：flash-api.jin10.com/get_flash_list（金十网页「快讯」页使用），需要 x-app-id / x-version 请求头。
//   用户最初给的 cdn.jin10.com/json/index/flir.json 是首页「要闻精选」轮播（每天约 15 条编辑文章），
//   经确认改用全量 7×24 电报流：分钟级更新、有 important 标记、量级与财联社电报相当。
// 翻页：max_time = "YYYY-MM-DD HH:MM:SS"（北京时间），返回该时刻及之前的约 20 条；边界含本秒，靠 id 去重。
// 过滤：data.lock === true 是 VIP 专享快讯（正文锁定），不收录。
//   important === 1 = 网站上的「重要」标红，记为 score 3；其余记为 score 2。
// id：接口返回 20 位字符串（如 20261028133644661800），超出数据库 BIGINT/18 位限制，去掉前两位世纪位
//   （"26…"）作为 source_id，同一世纪内不会冲突。
import { str, UA } from './util.js'

export const id = 'jin10'
export const name = '金十数据'
export const shortName = '金十'
export const homepage = 'https://www.jin10.com'

export const defaults = {
  url: 'https://flash-api.jin10.com/get_flash_list',
  appId: 'bVBF4FyRTn5NJF5n',
  version: '1.0.0',
  channel: '-8200',
  vip: 1,
}

/** "2026-10-28 13:36:02"（北京时间）→ Unix 秒 */
export function parseTime(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&hellip;': '…' }

/** 快讯正文里带少量 HTML（<br/>、<span> 等），压成纯文本 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] || ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 正文开头常带【标题】，取出来当标题并从正文去掉 */
function splitTitle(content) {
  const m = /^【([^】]{1,120})】\s*/.exec(content)
  if (!m) return { title: '', content }
  return { title: m[1].trim(), content: content.slice(m[0].length).trim() }
}

export function normalize(it) {
  const raw = it && it.data
  if (!raw || typeof it.id !== 'string' || !/^\d{20}$/.test(it.id)) return null
  if (raw.lock === true) return null // VIP 专享（正文锁定）
  const text = htmlToText(raw.content)
  if (!text) return null
  const displayTime = parseTime(it.time)
  if (!Number.isFinite(displayTime)) return null
  const { title, content } = splitTitle(text)
  if (!title && !content) return null
  const pic = str(raw.pic, 500)
  const images = /^https?:\/\//.test(pic) ? [pic] : []
  const tags = (Array.isArray(it.tags) ? it.tags : [])
    .map((t) => str(typeof t === 'string' ? t : t && t.name, 40).trim())
    .filter(Boolean)
    .slice(0, 10)
  return {
    source: id,
    source_id: it.id.slice(2), // 20 位 → 18 位，去世纪位
    title,
    content_text: content || title, // 没有正文的极短快讯至少留标题
    content_html: '',
    content_more: '',
    score: it.important === 1 ? 3 : 2,
    channels: (Array.isArray(it.channel) ? it.channel : []).map((c) => str(c, 20)).slice(0, 10),
    uri: `https://flash.jin10.com/detail/${it.id}`,
    article: null,
    images,
    symbols: [],
    tags,
    display_time: String(displayTime),
  }
}

/** 北京时间现在 / 指定 epoch 的 "YYYY-MM-DD HH:MM:SS"（接口要的 max_time 格式） */
function fmtCST(epochSec) {
  // sv-SE 区域恰好输出 "YYYY-MM-DD HH:MM:SS"
  return new Date(epochSec * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })
}

/**
 * 取一页；cursor 为上一页最旧一条的 "YYYY-MM-DD HH:MM:SS"（首页传 null = 当前时间）。
 * 接口返回约 20 条、按时间从新到旧；边界含 max_time 本秒，重复条目由 id 去重。
 */
export async function fetchPage(cfg, cursor, { timeoutMs = 15000 } = {}) {
  const maxTime = cursor || fmtCST(Math.floor(Date.now() / 1000))
  const url = new URL(cfg.url)
  url.searchParams.set('channel', String(cfg.channel))
  url.searchParams.set('vip', String(cfg.vip))
  url.searchParams.set('max_time', maxTime)
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'x-app-id': String(cfg.appId),
      'x-version': String(cfg.version),
      Origin: 'https://www.jin10.com',
      Referer: 'https://www.jin10.com/',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`金十接口 HTTP ${res.status}`)
  const body = await res.json()
  if (body.status !== 200 || !Array.isArray(body.data)) throw new Error(`金十接口返回异常 status=${body.status} ${body.message || ''}`)
  const raw = body.data
  // 接口偶尔不按时间排序，先按发布时间从新到旧整理，保证「最旧一条」取值正确
  raw.sort((a, b) => parseTime(b.time) - parseTime(a.time))
  const oldest = raw.length ? raw[raw.length - 1].time : null
  const nextCursor = oldest && oldest !== maxTime ? oldest : null
  return { items: raw.map(normalize).filter(Boolean), rawCount: raw.length, nextCursor }
}
