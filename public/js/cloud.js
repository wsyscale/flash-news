// 云服务客户端：全局只初始化一次，Auth / Database 共用
// endpoint / oauthRelayBaseUrl / publishableKey 来自云服务开通后下发的 publicConfig
// （由服务端从 config/app.json 输出到 /app-config.js）
const pc = (window.APP_CONFIG && window.APP_CONFIG.publicConfig) || {}

if (!window.WorkBuddyCloud) {
  throw new Error('云服务 SDK 加载失败，请检查网络后刷新页面')
}

export const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: pc.endpoint,
  oauthRelayBaseUrl: pc.oauthRelayBaseUrl,
  publishableKey: pc.publishableKey,
})

// ---------- 服务端票据 ----------
// 由数据库函数 issue_ticket() 用共享密钥签发（含用户 ID、是否管理员、数据库最新进度、抓取设置），
// 本站服务端验签后即可确认身份，无需服务端直连云数据面。
let ticketCache = null // { header, exp }

export async function getTicket(force = false) {
  const now = Math.floor(Date.now() / 1000)
  if (!force && ticketCache && ticketCache.exp - now > 60) return ticketCache.header
  const { data, error } = await cloud.database.rpc('issue_ticket')
  if (error || !data || !data.payload) {
    ticketCache = null
    const e = new Error(error ? error.message || '无法获取访问票据' : '无法获取访问票据')
    e.cloudError = error
    throw e
  }
  let exp = now + 600
  try {
    exp = JSON.parse(data.payload).exp || exp
  } catch {
    /* ignore */
  }
  // payload 可能含中文，先转 UTF-8 再 base64
  const bytes = new TextEncoder().encode(JSON.stringify({ payload: data.payload, sig: data.sig }))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  ticketCache = { header: btoa(bin), exp }
  return ticketCache.header
}

export function clearTicket() {
  ticketCache = null
}

/** 带票据调用本站服务端 API；票据失效会自动刷新重试一次 */
export async function api(path, { method = 'GET', body, signal, auth = true, forceTicket = false } = {}) {
  const doFetch = async (force) => {
    const headers = { Accept: 'application/json' }
    if (auth) headers['X-App-Ticket'] = await getTicket(force)
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      return await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      throw new Error('网络异常，无法连接服务器')
    }
  }
  let res = await doFetch(forceTicket)
  if (auth && res.status === 401) res = await doFetch(true)
  return res
}

export async function apiJson(path, opts) {
  const res = await api(path, opts)
  let data = null
  try {
    data = await res.json()
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const e = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`)
    e.status = res.status
    throw e
  }
  return data
}
