// 跨来源去重（「全部」tab 数据）：与展示规则一致 —— 两条快讯的（标题+正文）存在
// 至少 X 个连续相同的字即判为重复（并查集合并；只统计含汉字的片段，避免纯数字/代码误判）。
//   · 每组保留最早发布的一条作为代表（rep），AI 分析 / 追问都作用在代表条目上；
//   · 组内所有成员记在 refs（来源、source_id、发布时间、原文链接），sources 是去重后的来源列表；
//   · group_key 用最早成员的 source:source_id，稳定且随组成员不变；
//   · 清理：last_time（组内最新一条）早于保留期的组才删；代表条目被清理时由数据库改指组内存活成员。
const CJK = /[\u4e00-\u9fff]/

// 各来源正文里与「内容主体」无关的模板化前缀，去重比较前剥掉，
// 否则「财联社10月28日电」「《科创板日报》27日讯」这类固定前缀会让
// 同一来源的无关快讯全部被 X 连字误合并成一坨。
const PREFIX_PATTERNS = [
  /^财联社\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*电[，,：:、]?/,
  /^《科创板日报》\s*\d{1,2}\s*日\s*讯[，,：:、]?/,
  /^\d{1,2}\s*月\s*\d{1,2}\s*日\s*(下午|上午|晚间|早间|午间)?\s*[，,：:、]?/,
  /^【?金十(数据)?(整理|快讯|报道)[】:]?/,
  /^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[，,：:、]?/,
]

/** 计算一条快讯的文本（去空白、剥模板前缀），只用于分片 */
function textOf(it) {
  let t = String(it.title || '') + String(it.content_text || '')
  t = t.replace(/\s+/g, '')
  for (const re of PREFIX_PATTERNS) t = t.replace(re, '')
  return t
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
  // 星形聚类：只有「代表」（组内最早发布的条目）登记自己的 X 连字，后续条目只与代表比对。
  // 不用并查集做传递闭包——A~B 相似、B~C 相似就合并 A/B/C，即使 A 与 C 毫无关系，
  // 连续多天滚下来会把几十条无关快讯粘成一个雪球组，新成员被 refs 截断后彻底消失。
  const sorted = [...items].sort((a, b) => Number(a.display_time) - Number(b.display_time))
  const gramOwner = new Map() // X 连字 -> 代表在 sorted 中的下标（只登记代表的连字）
  const groups = new Map() // 代表下标 -> 成员数组
  const gramsOf = (text) => {
    const out = []
    for (let j = 0; j + x <= text.length; j++) {
      const g = text.slice(j, j + x)
      if (CJK.test(g)) out.push(g)
    }
    return out
  }
  for (let i = 0; i < sorted.length; i++) {
    const grams = gramsOf(textOf(sorted[i]))
    let owner = null
    for (const g of grams) {
      const o = gramOwner.get(g)
      if (o !== undefined) {
        owner = o
        break
      }
    }
    if (owner === null) {
      // 自成一组：登记自己的连字，后续相似条目归到它名下
      owner = i
      for (const g of grams) gramOwner.set(g, i)
    }
    const arr = groups.get(owner)
    if (arr) arr.push(sorted[i])
    else groups.set(owner, [sorted[i]])
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
