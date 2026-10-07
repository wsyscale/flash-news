// 把服务端定时抓取的快讯写入云数据库
// 服务端签名批次 → 本浏览器调用数据库 ingest_signed() → 数据库验签 + 唯一约束去重后入库
import { cloud, apiJson } from './cloud.js'

let syncing = null

/** @returns {Promise<{inserted:number, received:number, status:object|null}>} */
export function syncOnce({ maxRounds = 8 } = {}) {
  if (syncing) return syncing
  syncing = (async () => {
    let inserted = 0
    let received = 0
    let status = null
    for (let round = 0; round < maxRounds; round++) {
      // 每轮强制刷新票据：票据里的「数据库最新 id」决定服务端下发哪些条目
      const r = await apiJson('/api/sync/pull', { method: 'POST', forceTicket: round > 0 })
      status = r.status || status
      if (!r.payload) break
      const { data, error } = await cloud.database.rpc('ingest_signed', { p_payload: r.payload, p_sig: r.sig })
      if (error) throw error
      inserted += Number(data && data.inserted) || 0
      received += Number(data && data.received) || 0
      if (!r.remaining) break
    }
    return { inserted, received, status }
  })()
  syncing.finally(() => {
    syncing = null
  })
  return syncing
}
