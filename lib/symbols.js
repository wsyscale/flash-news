// 证券联想搜索（关注列表用）。浏览器不能直连这些接口（无 CORS），由本站服务端代理。
//   主源：东方财富网页端公开搜索联想（含 A 股 / 港股 / 美股 / 基金 / 板块 / 指数）
//   备源：腾讯行情 smartbox（A 股 / 港股 / 美股 / ETF / 指数，不含板块）
// 两个源都不可用时前端仍可直接输入文字标签。
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const EM_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8' // 东方财富网页端公开 token

const cache = new Map() // q -> { at, items, source }
const TTL = 10 * 60_000

function emType(securityTypeName, classify) {
  const s = String(securityTypeName || '')
  if (s.includes('板块') || classify === 'BK') return 'sector'
  if (s.includes('指数') || classify === 'Index') return 'index'
  if (s.includes('基金') || classify === 'Fund') return 'fund'
  return 'stock'
}

async function fromEastmoney(q) {
  const url = new URL('https://searchapi.eastmoney.com/api/suggest/get')
  url.searchParams.set('input', q)
  url.searchParams.set('type', '14')
  url.searchParams.set('token', EM_TOKEN)
  url.searchParams.set('count', '10')
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.eastmoney.com/' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`eastmoney HTTP ${res.status}`)
  const body = await res.json()
  const rows = (body && body.QuotationCodeTable && body.QuotationCodeTable.Data) || []
  return rows.map((r) => ({
    code: String(r.Code || ''),
    name: String(r.Name || '').trim(),
    market: String(r.SecurityTypeName || ''),
    type: emType(r.SecurityTypeName, r.Classify),
  }))
}

const QQ_MARKET = { sh: '沪A', sz: '深A', bj: '京A', hk: '港股', us: '美股' }
const QQ_FUND = new Set(['ETF', 'LOF', 'FJ', 'JJ', 'KJ', 'QDII'])

async function fromTencent(q) {
  const url = new URL('https://smartbox.gtimg.cn/s3/')
  url.searchParams.set('v', '2')
  url.searchParams.set('t', 'all')
  url.searchParams.set('c', '1')
  url.searchParams.set('q', q)
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`tencent HTTP ${res.status}`)
  const text = await res.text()
  const m = /v_hint="([^"]*)"/.exec(text)
  if (!m || m[1] === 'N') return []
  const raw = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  const out = []
  for (const seg of raw.split('^')) {
    const [mkt, code, name, , kind = ''] = seg.split('~')
    if (!code || !name || kind === 'QZ') continue // 跳过权证
    const isFund = QQ_FUND.has(kind)
    const isIndex = kind === 'ZS'
    out.push({
      code: mkt === 'us' ? code.replace(/\..*$/, '').toUpperCase() : code,
      name,
      market: isFund ? '基金' : isIndex ? '指数' : QQ_MARKET[mkt] || mkt,
      type: isFund ? 'fund' : isIndex ? 'index' : 'stock',
    })
  }
  return out
}

function tidy(rows) {
  const seen = new Set()
  const items = []
  for (const r of rows) {
    const code = String(r.code || '').slice(0, 20)
    const name = String(r.name || '').trim().slice(0, 40)
    if (!code || !name) continue
    const k = `${code}|${name}`
    if (seen.has(k)) continue
    seen.add(k)
    items.push({ code, name, market: String(r.market || '').slice(0, 20), type: r.type })
    if (items.length >= 10) break
  }
  return items
}

/** 返回 { items, source }；两个源都失败时抛出包含原因的错误 */
export async function searchSymbols(q) {
  const key = String(q || '').trim().slice(0, 30)
  if (!key) return { items: [], source: null }
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return { items: hit.items, source: hit.source }

  const errors = []
  for (const [source, fn] of [
    ['eastmoney', fromEastmoney],
    ['tencent', fromTencent],
  ]) {
    try {
      const items = tidy(await fn(key))
      cache.set(key, { at: Date.now(), items, source })
      if (cache.size > 500) cache.delete(cache.keys().next().value)
      return { items, source }
    } catch (err) {
      const c = err && err.cause
      errors.push(`${source}: ${err && err.message}${c && c.code ? ` (${c.code})` : ''}`)
    }
  }
  throw new Error(errors.join('; '))
}
