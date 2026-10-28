// 跨来源去重（「全部」tab 数据）：与展示规则一致 —— 两条快讯的（标题+正文）存在
// 至少 X 个连续相同的字即判为重复（并查集合并；只统计含汉字的片段，避免纯数字/代码误判）。
//   · 每组保留最早发布的一条作为代表（rep），AI 分析 / 追问都作用在代表条目上；
//   · 组内所有成员记在 refs（来源、source_id、发布时间、原文链接），sources 是去重后的来源列表；
//   · group_key 用最早成员的 source:source_id，稳定且随组成员不变；
//   · 清理：last_time（组内最新一条）早于保留期的组才删；代表条目被清理时由数据库改指组内存活成员。
const CJK = /[\u4e00-\u9fff]/

/** 计算一条快讯的文本（去空白），只用于分片 */
function textOf(it) {
  return (String(it.title || '') + String(it.content_text || '')).replace(/\s+/g, '')
}

/**
 * 把一批快讯按 X 连字规则分组成摘要行。
 * @param {Array} items 已规范化的快讯（含 source / source_id / title / content_text / display_time 秒）
 * @param {number} x 连续相同字数阈值（>=2 才去重；<2 视为不去重）
 * @returns {Array} 摘要行（见文件头注释），按 first_time 升序
 */
export function computeDigests(items, x) {
  if (!Array.isArray(items) || items.length === 0) return []
  if (!Number.isInteger(x) || x < 2) {
    // 不去重：每条快讯自成一个组
    return items.map(singleGroup).sort((a, b) => a.first_time - b.first_time)
  }
  const n = items.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a, b) => {
    a = find(a)
    b = find(b)
    if (a !== b) parent[b] = a
  }
  const gramMap = new Map() // X 连字 -> 第一次出现的行号
  for (let i = 0; i < n; i++) {
    const text = textOf(items[i])
    for (let j = 0; j + x <= text.length; j++) {
      const g = text.slice(j, j + x)
      if (!CJK.test(g)) continue
      const first = gramMap.get(g)
      if (first === undefined) gramMap.set(g, i)
      else if (first !== i) union(first, i)
    }
  }
  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(items[i])
  }
  const rows = []
  for (const g of groups.values()) rows.push(groupRow(g))
  return rows.sort((a, b) => a.first_time - b.first_time)
}

function singleGroup(it) {
  return groupRow([it])
}

function groupRow(members) {
  // 按发布时间升序：最早的当代表
  const g = [...members].sort((a, b) => Number(a.display_time) - Number(b.display_time))
  const rep = g[0]
  const refs = g
    .slice(0, 50)
    .map((m) => ({
      source: m.source,
      source_id: String(m.source_id),
      display_time: Number(m.display_time),
      uri: String(m.uri || '').slice(0, 500),
    }))
  const mergeArr = (field, max) => {
    const seen = new Set()
    const out = []
    for (const m of g) {
      for (const v of Array.isArray(m[field]) ? m[field] : []) {
        const s = JSON.stringify(v)
        if (!seen.has(s)) {
          seen.add(s)
          out.push(v)
        }
      }
    }
    return out.slice(0, max)
  }
  return {
    group_key: `${rep.source}:${rep.source_id}`,
    rep_source: rep.source,
    rep_source_id: String(rep.source_id),
    title: String(rep.title || '').slice(0, 500),
    content_text: String(rep.content_text || '').slice(0, 20000),
    score: Math.max(...g.map((m) => Number(m.score) || 0)),
    channels: mergeArr('channels', 20),
    uri: String(rep.uri || '').slice(0, 500),
    images: mergeArr('images', 9),
    symbols: mergeArr('symbols', 20),
    tags: mergeArr('tags', 10),
    sources: [...new Set(g.map((m) => m.source))],
    refs,
    first_time: Number(rep.display_time),
    last_time: Number(g[g.length - 1].display_time),
    members: g.length,
  }
}
