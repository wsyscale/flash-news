// 把服务端定时抓取的快讯写入云数据库
// 服务端签名批次 → 本浏览器调用数据库 ingest_signed() → 数据库验签 + 唯一约束去重后入库，返回签名收据
// → 下次拉取时把收据交回服务端，服务端确认这批已处理，才把它们移出暂存区（浏览器中途关闭也不会丢数据）
import { cloud, apiJson } from './cloud.js'

let syncing = null
let carry = [] // 上一轮没来得及交回的收据（例如最后一批）

/** @returns {Promise<{inserted:number, received:number, status:object|null}>} */
export function syncOnce({ maxRounds = 8 } = {}) {
  if (syncing) return syncing
  syncing = (async () => {
    let inserted = 0
    let received = 0
    let status = null
    let receipts = carry
    carry = []
    for (let round = 0; round < maxRounds; round++) {
      // 每轮强制刷新票据：票据里的「数据库各来源最新进度」决定服务端下发哪些条目
      const r = await apiJson('/api/sync/pull', { method: 'POST', forceTicket: round > 0, body: { receipts } })
      receipts = []
      status = r.status || status
      if (!r.payload) break
      const { data, error } = await cloud.database.rpc('ingest_signed', { p_payload: r.payload, p_sig: r.sig })
      if (error) throw error
      inserted += Number(data && data.inserted) || 0
      received += Number(data && data.received) || 0
      if (data && data.receipt) receipts.push(data.receipt)
      if (!r.remaining) break
    }
    // 最后一批的收据：立即交回（不再领新批次），失败就留到下一次同步
    if (receipts.length) {
      try {
        const r = await apiJson('/api/sync/pull', { method: 'POST', body: { receipts, peek: true } })
        status = r.status || status
      } catch {
        carry = receipts
      }
    }
    return { inserted, received, status }
  })()
  syncing.finally(() => {
    syncing = null
  })
  return syncing
}
