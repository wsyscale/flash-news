// 来源模块共用的小工具
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

export function str(v, max) {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return max ? s.slice(0, max) : s
}
