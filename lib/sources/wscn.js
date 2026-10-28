// 来源：华尔街见闻 7x24 快讯（https://wallstreetcn.com/live/global）
//   默认抓全部快讯（不带 score 参数）；接口的 score 1=普通、2/3=重要，
//   统一归一化存储：原始 score >= 2 记 3（重要），否则记 2，与财联社/金十的重要语义一致。
//   config 里仍可用 crawler.sources.wscn.score 只抓某级别及以上（如 2 = 只抓重要）。
import { str, UA } from './util.js'

export const id = 'wscn'
export const name = '华尔街见闻'
export const shortName = '见闻'
export const homepage = 'https://wallstreetcn.com/live/global'

export const defaults = {
  url: 'https://api-one-wscn.awtmt.com/apiv1/search/live',
  channel: 'global-channel',
  limit: 20,
}

export function normalize(it) {
  if (!it || !Number.isFinite(Number(it.id)) || !Number.isFinite(Number(it.display_time))) return null
  const article =
    it.article && typeof it.article === 'object'
      ? { id: it.article.id ?? null, title: str(it.article.title, 300), uri: str(it.article.uri, 500) }
      : null
  const images = Array.isArray(it.images)
    ? it.images
        .map((img) => (typeof img === 'string' ? img : img && img.uri))
        .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
        .slice(0, 9)
    : []
  const symbols = Array.isArray(it.symbols)
    ? it.symbols.slice(0, 20).map((s) => ({
        key: str(s.key || s.symbol || s.code, 40),
        name: str(s.name || s.title, 60),
        market: str(s.market || s.type, 20),
      }))
    : []
  const tags = Array.isArray(it.tags)
    ? it.tags.slice(0, 20).map((t) => (typeof t === 'string' ? t : str(t && (t.name || t.title), 40))).filter(Boolean)
    : []
  return {
    source: id,
    source_id: String(it.id),
    title: str(it.title, 500).trim(),
    content_text: str(it.content_text, 20000).trim(),
    content_html: str(it.content, 40000),
    content_more: str(it.content_more, 40000),
    // 接口原始 score：1=普通，2/3=重要；归一化成 2/3 与其他来源对齐（>=3 视为「重要」）
    score: Number.parseInt(it.score, 10) >= 2 ? 3 : 2,
    channels: Array.isArray(it.channels) ? it.channels.map((c) => str(c, 40)).slice(0, 20) : [],
    uri: str(it.uri, 500),
    article,
    images,
    symbols,
    tags,
    display_time: String(it.display_time),
  }
}

/** 取一页；cursor 为上一页返回的 next_cursor（首页传 null） */
export async function fetchPage(cfg, cursor, { timeoutMs = 15000 } = {}) {
  const url = new URL(cfg.url)
  url.searchParams.set('channel', cfg.channel)
  url.searchParams.set('limit', String(cfg.limit))
  if (cfg.score !== undefined && cfg.score !== null && cfg.score !== '') url.searchParams.set('score', String(cfg.score))
  if (cursor) url.searchParams.set('cursor', String(cursor))
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://wallstreetcn.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`华尔街见闻接口 HTTP ${res.status}`)
  const body = await res.json()
  if (body.code !== 20000 || !body.data) throw new Error(`华尔街见闻接口返回异常 code=${body.code} ${body.message || ''}`)
  const raw = Array.isArray(body.data.items) ? body.data.items : []
  return { items: raw.map(normalize).filter(Boolean), rawCount: raw.length, nextCursor: body.data.next_cursor || null }
}
