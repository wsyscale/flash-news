// HMAC-SHA256 签名，与数据库 pgcrypto 的 hmac(text, key, 'sha256') 完全一致
//
// 为什么需要它：发布沙箱出于平台安全策略，不能直连本应用的云数据面（访问自身域名被拒）。
// 因此采用「服务端签名、浏览器转交」的方式：
//   · 票据（ticket）：登录用户调用数据库函数 issue_ticket()，由数据库用共享密钥签出
//     { uid, adm, exp, latest, cs }，服务端验签即可确认用户身份 / 管理员 / 最新抓取设置；
//   · 批次（batch）：服务端把抓到的快讯签名后交给浏览器，浏览器调用 ingest_signed() 入库，
//     数据库验签通过才写入（防止有人伪造快讯）。
import { createHmac, timingSafeEqual } from 'node:crypto'

export function hmacHex(key, payload) {
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex')
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b.toLowerCase(), 'hex'))
}

/** 解析并校验请求头 X-App-Ticket（base64(JSON{payload, sig})），返回票据内容或 null */
export function verifyTicket(key, header) {
  if (!key || !header || header.length > 16384) return null
  let wrapper
  try {
    wrapper = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return null
  }
  const { payload, sig } = wrapper || {}
  if (typeof payload !== 'string' || !safeEqualHex(hmacHex(key, payload), sig)) return null
  let t
  try {
    t = JSON.parse(payload)
  } catch {
    return null
  }
  if (!t || t.typ !== 'ticket' || !t.uid || t.uid === 'anon') return null
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(t.exp) || t.exp < now || t.iat > now + 300) return null
  return t
}

/** 生成交给浏览器转交入库的批次（快讯 / 抓取记录 / 跨来源摘要）；bid 用于数据库回执（收据）对账 */
export function signBatch(key, { bid, items, runs, digests }) {
  const payload = JSON.stringify({ typ: 'batch', bid, iat: Math.floor(Date.now() / 1000), items, runs, digests })
  return { payload, sig: hmacHex(key, payload) }
}

/**
 * 校验数据库 ingest_signed() 返回的收据 { payload, sig }，返回批次号 bid 或 null。
 * 收据由数据库用同一把签名密钥签出，浏览器无法伪造，所以服务端可以放心地把这批条目移出暂存区。
 */
export function verifyReceipt(key, receipt) {
  if (!key || !receipt || typeof receipt.payload !== 'string' || receipt.payload.length > 1000) return null
  if (!safeEqualHex(hmacHex(key, receipt.payload), receipt.sig)) return null
  try {
    const r = JSON.parse(receipt.payload)
    if (!r || r.typ !== 'receipt' || typeof r.bid !== 'string') return null
    const now = Math.floor(Date.now() / 1000)
    if (!Number.isFinite(r.iat) || r.iat < now - 3600 || r.iat > now + 300) return null
    return r.bid
  } catch {
    return null
  }
}
