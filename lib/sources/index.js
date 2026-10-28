// 快讯来源注册表。新增来源：在本目录加一个模块（id / name / defaults / normalize / fetchPage），再加到下面的列表里。
//   · id 只能是小写字母开头、2–16 位的 [a-z0-9_]（数据库 news_flash.source 有同样的约束）
//   · fetchPage(cfg, cursor) 返回 { items: 已规范化的条目[], rawCount, nextCursor }，按发布时间从新到旧
import * as wscn from './wscn.js'
import * as cls from './cls.js'
import * as jin10 from './jin10.js'

export const SOURCES = [wscn, cls, jin10]
export const SOURCE_IDS = SOURCES.map((s) => s.id)

export function getSource(id) {
  return SOURCES.find((s) => s.id === id) || null
}

/** 给前端的来源列表（只含展示用字段） */
export function publicSources() {
  return SOURCES.map((s) => ({ id: s.id, name: s.name, shortName: s.shortName, homepage: s.homepage }))
}
