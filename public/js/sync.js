// 把服务端定时抓取的快讯写入云数据库
// 服务端签名批次 → 本浏览器调用数据库 ingest_signed() → 数据库验签 + 唯一约束去重后入库，返回签名收据
// → 下次拉取时把收据交回服务端，服务端确认这批已处理，才把它们移出暂存区（浏览器中途关闭也不会丢数据）
// 另：首次同步完成后做一次「摘要历史回填」——把数据库里已有的快讯分批回传给服务端，
//     供服务端对历史数据做跨来源分组（news_digest），分组结果再随正常同步写回数据库。
import { cloud, apiJson } from './cloud.js'

let syncing = null
let carry = [] // 上一轮没来得及交回的收据（例如最后一批）
let backfilling = null

const BACKFILL_PAGE = 500
const BACKFILL_KEY = 'flash-news.digestBackfill'

function backfillDoneLocally() {
  try {
    return localStorage.getItem(BACKFILL_KEY) === '1'
  } catch {
    return false
  }
}

function markBackfillDoneLocally() {
  try {
    localStorage.setItem(BACKFILL_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** 把数据库里保留期内的快讯分批回传给服务端做历史摘要分组（每账号只做一次，失败下次再试） */
function backfillDigestHistory() {
  if (backfilling) return backfilling
  backfilling = (async () => {
    // 服务端重启会重置内存状态但 local 标记还在；改为每次启动后由服务端状态判断——
    // 简化：local 标记只代表「本浏览器做过」，服务端收到的 done 会持久化，两端都幂等
    if (backfillDoneLocally()) return
    try {
      // 上限防御：最多 40 页（2 万条），避免分页异常时无限循环
      for (let offset = 0, page = 0; page < 40; offset += BACKFILL_PAGE, page++) {
        const { data, error } = await cloud.database
          .from('news_flash')
          .select('source, source_id, title, content_text, score, channels, uri, images, symbols, tags, display_time')
          .order('display_time', { ascending: false })
          .range(offset, offset + BACKFILL_PAGE - 1)
        if (error) throw error
        const rows = data || []
        if (!rows.length) {
          // 正好整除：最后一页为空，也要告诉服务端「回填结束」，触发它对已收数据做最终分组
          await apiJson('/api/digest/backfill', { method: 'POST', body: { items: [], done: true } })
          break
        }
        const isDone = rows.length < BACKFILL_PAGE
        await apiJson('/api/digest/backfill', { method: 'POST', body: { items: rows, done: isDone } })
        if (isDone) break
      }
      markBackfillDoneLocally()
    } catch {
      // 静默失败：下次同步再试（服务端分组是幂等的）
    }
  })()
  backfilling.finally(() => {
    backfilling = null
  })
  return backfilling
}

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
    // 同步完成后做一次历史回填（不阻塞返回值；失败静默，下次再试）
    backfillDigestHistory()
    return { inserted, received, status }
  })()
  syncing.finally(() => {
    syncing = null
  })
  return syncing
}
