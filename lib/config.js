// 读取配置：config/app.json（公开配置 + 抓取默认值）+ config/secret.json（仅服务端）
// 环境变量可覆盖：
//   PORT                     监听端口（发布环境会注入）
//   CRAWL_INTERVAL_MINUTES   强制覆盖抓取间隔（分钟）。不设置时以数据库 crawler_settings 为准，默认 20
//   CRAWL_BACKFILL_PAGES     强制覆盖最多回补页数
//   CRAWLER_SECRET           覆盖 config/secret.json 中的抓取密钥（仅命令行直连入库使用）
//   SIGNING_KEY              覆盖 config/secret.json 中的签名密钥（需与数据库 crawler_secret.signing_key 一致）
//   DATA_DIR                 暂存区落盘目录，默认 ./data
//   CRAWLER_DISABLED=1       关闭本进程内的定时抓取（只提供网站服务）
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel, fallback) {
  const file = path.join(ROOT, rel)
  if (!existsSync(file)) return fallback
  return JSON.parse(readFileSync(file, 'utf8'))
}

function intEnv(name, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`环境变量 ${name}=${raw} 非法，应为 ${min}-${max} 的整数`)
  }
  return n
}

export function loadConfig() {
  const app = readJson('config/app.json', {})
  const secret = readJson('config/secret.json', {})
  const publicConfig = app.publicConfig || {}
  if (!publicConfig.endpoint || !publicConfig.publishableKey) {
    throw new Error(
      'config/app.json 缺少 publicConfig.endpoint / publishableKey。新账号部署时请先开通云服务，再运行 node scripts/setup.mjs app-config \'<publicConfig JSON>\'（见 DEPLOY.md）',
    )
  }
  // 抓取设置。各来源自己的参数（接口地址、每页条数等）在 lib/sources/*.js 的 defaults 里，
  // 需要覆盖时写在 config/app.json 的 crawler.sources.<来源 id> 下，例如关闭财联社：{ "sources": { "cls": { "enabled": false } } }
  // 旧配置里的 sourceUrl / channel / limit / score 仍然有效，只作用于华尔街见闻。
  const crawler = {
    sources: {},
    defaultIntervalMinutes: 20,
    defaultBackfillPages: 5,
    requestTimeoutMs: 15000,
    checkEverySeconds: 60,
    retryAfterErrorMinutes: 2,
    ...(app.crawler || {}),
  }
  return {
    root: ROOT,
    port: Number.parseInt(process.env.PORT || '3000', 10),
    publicConfig: {
      endpoint: publicConfig.endpoint.replace(/\/+$/, ''),
      oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl || '',
      publishableKey: publicConfig.publishableKey,
    },
    crawler: {
      ...crawler,
      intervalOverride: intEnv('CRAWL_INTERVAL_MINUTES', 1, 1440),
      backfillOverride: intEnv('CRAWL_BACKFILL_PAGES', 1, 20),
      disabled: process.env.CRAWLER_DISABLED === '1',
    },
    crawlerSecret: process.env.CRAWLER_SECRET || secret.crawlerSecret || '',
    // 与数据库 crawler_secret.signing_key 一致，用于票据验签与批次签名
    signingKey: process.env.SIGNING_KEY || secret.signingKey || '',
    dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  }
}
