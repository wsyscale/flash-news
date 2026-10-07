// 服务端云 SDK 客户端（Node 运行时）
// - Node 没有 localStorage：注入内存存储
// - 数据面按 Origin 精确匹配：服务端请求补上本应用发布域名作为 Origin
// - 需要以某个终端用户身份发请求时（校验 token），通过自定义 fetch 带上该用户的 Bearer
import { createWorkBuddyCloud, createMemoryStorage } from '@tencent-ai/workbuddy-cloud-sdk'

export function createServerCloud(publicConfig, { userToken, timeoutMs = 20000 } = {}) {
  const origin = new URL(publicConfig.endpoint).origin
  const serverFetch = (input, init = {}) => {
    const headers = new Headers(init.headers)
    if (!headers.has('origin')) headers.set('Origin', origin)
    if (userToken) headers.set('Authorization', `Bearer ${userToken}`)
    return fetch(input, {
      ...init,
      headers,
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    })
  }
  return createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
    publishableKey: publicConfig.publishableKey,
    storage: createMemoryStorage(),
    fetch: serverFetch,
  })
}

export function describeDbError(error) {
  if (!error) return ''
  const code = error.code ? `[${error.code}] ` : ''
  // 网络层错误把底层原因（ENOTFOUND / ECONNREFUSED / 证书错误等）带出来，便于排查
  let root = error.cause
  const reasons = []
  for (let i = 0; root && i < 4; i++) {
    const r = root.code || root.errno || (root.message && root.message !== error.message ? root.message : '')
    if (r) reasons.push(String(r))
    root = root.cause
  }
  return `${code}${error.message || 'unknown error'}${reasons.length ? ` (${reasons.join(' / ')})` : ''}`
}
