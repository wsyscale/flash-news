-- 快讯分析台：完整建库脚本（从线上数据库导出整理，2026-10-07）
--
-- 用法：在新账号开通云服务后，按顺序【逐条、串行】执行下面的每一步。
--   · 云数据库执行接口一次只接受一条语句，所以每一步前都有一行标记：
--       -- @step <mode> <说明>
--     mode 是执行时要用的模式：migrate（建表 / 改结构 / 权限）或 write（写数据 / 定时任务）。
--     同类的简单语句合并在一个 DO 块里（算一条语句，整块要么全部成功、要么全部回滚）。
--   · 不要并行执行：后面的步骤依赖前面的表 / 函数已经提交，并行会报 42P01。
--   · 整个脚本可以重复执行（IF NOT EXISTS / CREATE OR REPLACE / 先删后建策略），中途失败修好后从失败那步继续即可。
--   · 推荐用 `node scripts/setup.mjs step <序号>` 取出某一步的 sqlBase64 再执行，避免引号 / 换行被转义。
--   · 抓取密钥那一步需要参数，由 `node scripts/setup.mjs step <序号>` 自动从 config/secret.json 生成。
--
-- 依赖平台提供：auth.uid()（当前登录用户 ID，匿名为 'anon'）、角色 anon / authenticated、扩展 pgcrypto 与 pg_cron。

-- ======================================================================
-- 一、扩展
-- ======================================================================

-- @step migrate 启用 pgcrypto（HMAC 签名、sha256）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- @step migrate 启用 pg_cron（每小时清理过期快讯）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ======================================================================
-- 二、数据表
-- ======================================================================

-- @step migrate 建表 news_flash（快讯）
CREATE TABLE IF NOT EXISTS public.news_flash (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wscn_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  content_html TEXT,
  content_more TEXT,
  score INT NOT NULL DEFAULT 0,
  channels TEXT[] NOT NULL DEFAULT '{}',
  uri TEXT,
  article JSONB,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash TEXT NOT NULL,
  display_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT news_flash_wscn_id_key UNIQUE (wscn_id),
  CONSTRAINT news_flash_content_hash_key UNIQUE (content_hash)
);

-- @step migrate 建表 crawl_runs（抓取记录）
CREATE TABLE IF NOT EXISTS public.crawl_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'ok',
  trigger TEXT NOT NULL DEFAULT 'schedule',
  pages INT NOT NULL DEFAULT 0,
  fetched INT NOT NULL DEFAULT 0,
  inserted INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  message TEXT,
  run_key TEXT
);

-- @step migrate 建表 crawler_settings（抓取设置，单行 id=1）
CREATE TABLE IF NOT EXISTS public.crawler_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  interval_minutes INT NOT NULL DEFAULT 20 CHECK (interval_minutes BETWEEN 1 AND 1440),
  enabled BOOLEAN NOT NULL DEFAULT true,
  backfill_pages INT NOT NULL DEFAULT 5 CHECK (backfill_pages BETWEEN 1 AND 20),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  retention_days INT NOT NULL DEFAULT 14 CHECK (retention_days BETWEEN 1 AND 14),
  last_purge_at TIMESTAMPTZ,
  last_purge_deleted INT
);

-- @step migrate 建表 crawler_secret（抓取密钥哈希 + 签名密钥，单行 id=1）
CREATE TABLE IF NOT EXISTS public.crawler_secret (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signing_key TEXT
);

-- @step migrate 建表 app_admins（网站管理员）
CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @step migrate 建表 user_llm_settings（每人的模型配置、关注列表、联网开关）
CREATE TABLE IF NOT EXISTS public.user_llm_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  provider TEXT NOT NULL DEFAULT 'deepseek',
  configs JSONB NOT NULL DEFAULT '{}'::jsonb,
  thinking BOOLEAN NOT NULL DEFAULT true,
  system_prompt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  watchlist JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(watchlist) = 'array' AND jsonb_array_length(watchlist) <= 30),
  web_search BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT user_llm_settings_owner_key UNIQUE (owner_id)
);

-- @step migrate 建表 news_analysis（每人的分析结果）
CREATE TABLE IF NOT EXISTS public.news_analysis (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  news_id BIGINT NOT NULL REFERENCES public.news_flash(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  sentiment TEXT,
  usage JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  watchlist JSONB CHECK (watchlist IS NULL OR (jsonb_typeof(watchlist) = 'array' AND jsonb_array_length(watchlist) <= 30)),
  sources JSONB CHECK (sources IS NULL OR (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 50)),
  CONSTRAINT news_analysis_owner_news_key UNIQUE (owner_id, news_id)
);

-- @step migrate 建表 news_chat（每人的追问对话）
CREATE TABLE IF NOT EXISTS public.news_chat (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  news_id BIGINT NOT NULL REFERENCES public.news_flash(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 60000),
  reasoning TEXT CHECK (reasoning IS NULL OR length(reasoning) <= 120000),
  provider TEXT,
  model TEXT,
  usage JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sources JSONB CHECK (sources IS NULL OR (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 50))
);

-- ======================================================================
-- 三、索引、说明与 RLS 开关
-- ======================================================================

-- @step migrate 索引（6 个）
DO $$
BEGIN
  -- 快讯按时间倒序
  CREATE INDEX IF NOT EXISTS news_flash_display_time_idx ON public.news_flash (display_time DESC, id DESC);
  -- 抓取记录按时间
  CREATE INDEX IF NOT EXISTS crawl_runs_started_idx ON public.crawl_runs (started_at DESC);
  -- 抓取记录去重键
  CREATE UNIQUE INDEX IF NOT EXISTS crawl_runs_run_key_key ON public.crawl_runs (run_key);
  -- 分析按快讯（级联删除用）
  CREATE INDEX IF NOT EXISTS news_analysis_news_idx ON public.news_analysis (news_id);
  -- 追问按用户 + 快讯
  CREATE INDEX IF NOT EXISTS news_chat_owner_news_idx ON public.news_chat (owner_id, news_id, id);
  -- 追问按快讯（级联删除用）
  CREATE INDEX IF NOT EXISTS news_chat_news_idx ON public.news_chat (news_id);
END
$$;

-- @step migrate 表说明（3 张表）
DO $$
BEGIN
  -- news_flash
  COMMENT ON TABLE public.news_flash IS '华尔街见闻 7x24 快讯（score>=2），wscn_id + 内容哈希双重去重；超过保留天数由 purge_expired_news() 每小时清理';
  -- crawler_settings
  COMMENT ON TABLE public.crawler_settings IS '抓取设置（单行 id=1）：interval_minutes 抓取间隔分钟数（默认20）、enabled 是否启用、backfill_pages 最多回补页数、retention_days 数据保留天数（1-14，默认14）';
  -- news_chat
  COMMENT ON TABLE public.news_chat IS '用户在 AI 深度分析后的追问对话（每人私有），随快讯过期一并清理';
END
$$;

-- @step migrate 开启行级安全 RLS（8 张表；crawler_secret 不建任何策略 = 客户端完全不可读写）
DO $$
BEGIN
  -- news_flash
  ALTER TABLE public.news_flash ENABLE ROW LEVEL SECURITY;
  -- crawl_runs
  ALTER TABLE public.crawl_runs ENABLE ROW LEVEL SECURITY;
  -- crawler_settings
  ALTER TABLE public.crawler_settings ENABLE ROW LEVEL SECURITY;
  -- crawler_secret（不建任何策略 = 客户端完全不可读写）
  ALTER TABLE public.crawler_secret ENABLE ROW LEVEL SECURITY;
  -- app_admins
  ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;
  -- user_llm_settings
  ALTER TABLE public.user_llm_settings ENABLE ROW LEVEL SECURITY;
  -- news_analysis
  ALTER TABLE public.news_analysis ENABLE ROW LEVEL SECURITY;
  -- news_chat
  ALTER TABLE public.news_chat ENABLE ROW LEVEL SECURITY;
END
$$;

-- ======================================================================
-- 四、函数
-- ======================================================================

-- @step migrate 函数 retention_cutoff()：保留期起点
CREATE OR REPLACE FUNCTION public.retention_cutoff()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT now() - make_interval(days => least(greatest(coalesce((SELECT retention_days FROM crawler_settings WHERE id = 1), 14), 1), 14))
$$;

-- @step migrate 函数 whoami()：当前用户与管理员状态
CREATE OR REPLACE FUNCTION public.whoami()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'uid', NULLIF(auth.uid(), 'anon'),
    'is_admin', coalesce(auth.uid(), 'anon') <> 'anon' AND EXISTS (SELECT 1 FROM app_admins WHERE user_id = auth.uid()),
    'has_admin', EXISTS (SELECT 1 FROM app_admins)
  )
$$;

-- @step migrate 函数 ingest_items_internal()：快讯去重入库（仅供其他函数内部调用）
CREATE OR REPLACE FUNCTION public.ingest_items_internal(p_items jsonb)
RETURNS int
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_inserted int := 0;
  v_cutoff timestamptz := retention_cutoff();
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN 0;
  END IF;
  IF jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'too many items in one batch';
  END IF;
  WITH src AS (
    SELECT e FROM jsonb_array_elements(p_items) AS e
    WHERE (e->>'wscn_id') ~ '^[0-9]+$'
      AND CASE WHEN (e->>'display_time') ~ '^[0-9]+(\.[0-9]+)?$'
               THEN to_timestamp((e->>'display_time')::double precision) >= v_cutoff
               ELSE false END
  ), ins AS (
    INSERT INTO news_flash (wscn_id, title, content_text, content_html, content_more, score, channels, uri, article, images, symbols, tags, content_hash, display_time)
    SELECT
      (e->>'wscn_id')::bigint,
      left(coalesce(e->>'title', ''), 500),
      left(coalesce(e->>'content_text', ''), 20000),
      left(coalesce(e->>'content_html', ''), 40000),
      left(coalesce(e->>'content_more', ''), 40000),
      CASE WHEN (e->>'score') ~ '^-?[0-9]+$' THEN (e->>'score')::int ELSE 0 END,
      CASE WHEN jsonb_typeof(e->'channels') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(e->'channels')) ELSE '{}'::text[] END,
      left(e->>'uri', 500),
      CASE WHEN jsonb_typeof(e->'article') = 'object' THEN e->'article' ELSE NULL END,
      CASE WHEN jsonb_typeof(e->'images') = 'array' THEN e->'images' ELSE '[]'::jsonb END,
      CASE WHEN jsonb_typeof(e->'symbols') = 'array' THEN e->'symbols' ELSE '[]'::jsonb END,
      CASE WHEN jsonb_typeof(e->'tags') = 'array' THEN e->'tags' ELSE '[]'::jsonb END,
      md5(coalesce(e->>'title', '') || '|' || coalesce(e->>'content_text', '')),
      to_timestamp((e->>'display_time')::double precision)
    FROM src
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

-- @step migrate 函数 purge_expired_news()：清理过期快讯（分析 / 追问级联删除）
CREATE OR REPLACE FUNCTION public.purge_expired_news()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted int := 0;
BEGIN
  -- 快讯删除时，news_analysis / news_chat 通过外键 ON DELETE CASCADE 一并删除
  DELETE FROM news_flash WHERE display_time < retention_cutoff();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE crawler_settings SET last_purge_at = now(), last_purge_deleted = v_deleted WHERE id = 1;
  RETURN v_deleted;
END;
$$;

-- @step migrate 函数 crawler_report()：本机命令行直连入库（凭抓取密钥）
CREATE OR REPLACE FUNCTION public.crawler_report(p_secret text, p_items jsonb DEFAULT '[]'::jsonb, p_run jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_received int := 0;
  v_inserted int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crawler_secret
    WHERE id = 1
      AND secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'invalid crawler secret' USING ERRCODE = '42501';
  END IF;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    v_received := jsonb_array_length(p_items);
    IF v_received > 200 THEN
      RAISE EXCEPTION 'too many items in one batch: %', v_received;
    END IF;

    v_inserted := ingest_items_internal(p_items);
  END IF;

  IF p_run IS NOT NULL AND jsonb_typeof(p_run) = 'object' THEN
    INSERT INTO crawl_runs (started_at, finished_at, status, trigger, pages, fetched, inserted, duration_ms, message)
    VALUES (
      coalesce((p_run->>'started_at')::timestamptz, now()),
      now(),
      left(coalesce(p_run->>'status', 'ok'), 20),
      left(coalesce(p_run->>'trigger', 'schedule'), 20),
      coalesce((p_run->>'pages')::int, 0),
      coalesce((p_run->>'fetched')::int, 0),
      coalesce((p_run->>'inserted')::int, 0),
      coalesce((p_run->>'duration_ms')::int, 0),
      left(p_run->>'message', 1000)
    );
    DELETE FROM crawl_runs WHERE id <= (SELECT id FROM crawl_runs ORDER BY id DESC OFFSET 1000 LIMIT 1);
  END IF;

  RETURN jsonb_build_object('received', v_received, 'inserted', v_inserted);
END;
$$;

-- @step migrate 函数 claim_admin()：首位登录用户认领管理员
CREATE OR REPLACE FUNCTION public.claim_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL OR v_uid = 'anon' THEN
    RAISE EXCEPTION 'login required' USING ERRCODE = '42501';
  END IF;
  LOCK TABLE app_admins IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM app_admins) THEN
    RETURN EXISTS (SELECT 1 FROM app_admins WHERE user_id = v_uid);
  END IF;
  INSERT INTO app_admins (user_id) VALUES (v_uid);
  RETURN true;
END;
$$;

-- @step migrate 函数 admin_update_crawler_settings()：管理员修改抓取设置
CREATE OR REPLACE FUNCTION public.admin_update_crawler_settings(p_interval_minutes int, p_enabled boolean DEFAULT NULL, p_backfill_pages int DEFAULT NULL, p_retention_days int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_row jsonb;
  v_old_retention int;
BEGIN
  IF v_uid IS NULL OR v_uid = 'anon' OR NOT EXISTS (SELECT 1 FROM app_admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  IF p_interval_minutes IS NULL OR p_interval_minutes < 1 OR p_interval_minutes > 1440 THEN
    RAISE EXCEPTION 'interval_minutes must be between 1 and 1440' USING ERRCODE = '22023';
  END IF;
  IF p_backfill_pages IS NOT NULL AND (p_backfill_pages < 1 OR p_backfill_pages > 20) THEN
    RAISE EXCEPTION 'backfill_pages must be between 1 and 20' USING ERRCODE = '22023';
  END IF;
  IF p_retention_days IS NOT NULL AND (p_retention_days < 1 OR p_retention_days > 14) THEN
    RAISE EXCEPTION 'retention_days must be between 1 and 14' USING ERRCODE = '22023';
  END IF;
  SELECT retention_days INTO v_old_retention FROM crawler_settings WHERE id = 1;
  INSERT INTO crawler_settings (id, interval_minutes, enabled, backfill_pages, retention_days, updated_at, updated_by)
  VALUES (1, p_interval_minutes, coalesce(p_enabled, true), coalesce(p_backfill_pages, 5), coalesce(p_retention_days, 14), now(), v_uid)
  ON CONFLICT (id) DO UPDATE SET
    interval_minutes = EXCLUDED.interval_minutes,
    enabled = coalesce(p_enabled, crawler_settings.enabled),
    backfill_pages = coalesce(p_backfill_pages, crawler_settings.backfill_pages),
    retention_days = coalesce(p_retention_days, crawler_settings.retention_days),
    updated_at = now(),
    updated_by = v_uid;
  -- 缩短保留期后立即清理一次
  IF p_retention_days IS NOT NULL AND p_retention_days < coalesce(v_old_retention, 14) THEN
    PERFORM purge_expired_news();
  END IF;
  SELECT to_jsonb(s) INTO v_row FROM crawler_settings s WHERE id = 1;
  RETURN v_row;
END;
$$;

-- @step migrate 函数 issue_ticket()：给登录用户签发服务端票据
CREATE OR REPLACE FUNCTION public.issue_ticket()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_key text;
  v_payload text;
BEGIN
  IF v_uid IS NULL OR v_uid = 'anon' THEN
    RAISE EXCEPTION 'login required' USING ERRCODE = '42501';
  END IF;
  SELECT signing_key INTO v_key FROM crawler_secret WHERE id = 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'signing key not configured';
  END IF;
  SELECT jsonb_build_object(
    'typ', 'ticket',
    'uid', v_uid,
    'adm', EXISTS (SELECT 1 FROM app_admins WHERE user_id = v_uid),
    'iat', extract(epoch FROM now())::bigint,
    'exp', extract(epoch FROM now())::bigint + 900,
    'latest', (SELECT max(wscn_id) FROM news_flash),
    'lr', (SELECT extract(epoch FROM max(started_at))::bigint FROM crawl_runs),
    'cs', (SELECT jsonb_build_object('interval', interval_minutes, 'enabled', enabled, 'backfill', backfill_pages, 'retention', retention_days, 'ts', extract(epoch FROM updated_at)::bigint) FROM crawler_settings WHERE id = 1)
  )::text INTO v_payload;
  RETURN jsonb_build_object('payload', v_payload, 'sig', encode(hmac(v_payload, v_key, 'sha256'), 'hex'));
END;
$$;

-- @step migrate 函数 ingest_signed()：浏览器转交服务端签名的快讯批次入库
CREATE OR REPLACE FUNCTION public.ingest_signed(p_payload text, p_sig text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := auth.uid();
  v_key text;
  v jsonb;
  v_received int := 0;
  v_inserted int := 0;
  v_runs int := 0;
BEGIN
  IF v_uid IS NULL OR v_uid = 'anon' THEN
    RAISE EXCEPTION 'login required' USING ERRCODE = '42501';
  END IF;
  SELECT signing_key INTO v_key FROM crawler_secret WHERE id = 1;
  IF v_key IS NULL OR p_payload IS NULL OR p_sig IS NULL OR length(p_payload) > 3000000
     OR encode(hmac(p_payload, v_key, 'sha256'), 'hex') <> lower(p_sig) THEN
    RAISE EXCEPTION 'invalid signature' USING ERRCODE = '42501';
  END IF;
  v := p_payload::jsonb;
  IF coalesce(v->>'typ', '') <> 'batch' THEN
    RAISE EXCEPTION 'invalid payload type' USING ERRCODE = '22023';
  END IF;
  IF coalesce((v->>'iat')::bigint, 0) < extract(epoch FROM now())::bigint - 3600 THEN
    RAISE EXCEPTION 'batch expired' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v->'items') = 'array' THEN
    v_received := jsonb_array_length(v->'items');
    v_inserted := ingest_items_internal(v->'items');
  END IF;
  IF jsonb_typeof(v->'runs') = 'array' AND jsonb_array_length(v->'runs') > 0 THEN
    WITH ins AS (
      INSERT INTO crawl_runs (run_key, started_at, finished_at, status, trigger, pages, fetched, inserted, duration_ms, message)
      SELECT left(r->>'run_key', 80),
             (r->>'started_at')::timestamptz,
             coalesce((r->>'finished_at')::timestamptz, (r->>'started_at')::timestamptz),
             left(coalesce(r->>'status', 'ok'), 20),
             left(coalesce(r->>'trigger', 'schedule'), 20),
             coalesce((r->>'pages')::int, 0),
             coalesce((r->>'fetched')::int, 0),
             coalesce((r->>'new_items')::int, 0),
             coalesce((r->>'duration_ms')::int, 0),
             left(r->>'message', 1000)
      FROM jsonb_array_elements(v->'runs') AS r
      WHERE r->>'run_key' IS NOT NULL AND r->>'started_at' IS NOT NULL
      ON CONFLICT (run_key) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_runs FROM ins;
    DELETE FROM crawl_runs WHERE id <= (SELECT id FROM crawl_runs ORDER BY id DESC OFFSET 1000 LIMIT 1);
  END IF;
  RETURN jsonb_build_object('received', v_received, 'inserted', v_inserted, 'runs', v_runs, 'latest', (SELECT max(wscn_id) FROM news_flash));
END;
$$;

-- ======================================================================
-- 五、权限与行级安全策略
-- ======================================================================

-- @step migrate 函数执行权限（平台默认会把新函数显式授权给 anon / authenticated，必须一并撤销再按需授予）
DO $$
BEGIN
  -- ingest_items_internal 仅内部可用
  REVOKE EXECUTE ON FUNCTION public.ingest_items_internal(jsonb) FROM PUBLIC, anon, authenticated;
  -- purge_expired_news 仅定时任务可用
  REVOKE EXECUTE ON FUNCTION public.purge_expired_news() FROM PUBLIC, anon, authenticated;
  -- crawler_report 先全部撤销
  REVOKE EXECUTE ON FUNCTION public.crawler_report(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
  -- crawler_report 授予 anon / authenticated（函数内校验抓取密钥）
  GRANT EXECUTE ON FUNCTION public.crawler_report(text, jsonb, jsonb) TO anon, authenticated;
  -- claim_admin 先全部撤销
  REVOKE EXECUTE ON FUNCTION public.claim_admin() FROM PUBLIC, anon, authenticated;
  -- claim_admin 仅登录用户
  GRANT EXECUTE ON FUNCTION public.claim_admin() TO authenticated;
  -- admin_update_crawler_settings 先全部撤销
  REVOKE EXECUTE ON FUNCTION public.admin_update_crawler_settings(int, boolean, int, int) FROM PUBLIC, anon, authenticated;
  -- admin_update_crawler_settings 仅登录用户（函数内校验管理员）
  GRANT EXECUTE ON FUNCTION public.admin_update_crawler_settings(int, boolean, int, int) TO authenticated;
  -- issue_ticket 先全部撤销
  REVOKE EXECUTE ON FUNCTION public.issue_ticket() FROM PUBLIC, anon, authenticated;
  -- issue_ticket 仅登录用户
  GRANT EXECUTE ON FUNCTION public.issue_ticket() TO authenticated;
  -- ingest_signed 先全部撤销
  REVOKE EXECUTE ON FUNCTION public.ingest_signed(text, text) FROM PUBLIC, anon, authenticated;
  -- ingest_signed 仅登录用户（函数内校验签名）
  GRANT EXECUTE ON FUNCTION public.ingest_signed(text, text) TO authenticated;
END
$$;

-- @step migrate 表权限（GRANT 与 RLS 策略是两道独立的门，缺一不可；密钥表对客户端完全收回）
DO $$
BEGIN
  -- 快讯、抓取记录、抓取设置、管理员名单只读
  GRANT SELECT ON TABLE public.news_flash, public.crawl_runs, public.crawler_settings, public.app_admins TO authenticated, anon;
  -- 模型配置、分析结果可读写
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_llm_settings, public.news_analysis TO authenticated, anon;
  -- 追问对话可读、新增、删除
  GRANT SELECT, INSERT, DELETE ON TABLE public.news_chat TO authenticated, anon;
  -- 密钥表对客户端完全收回（加固，RLS 已拦一道）
  REVOKE ALL ON TABLE public.crawler_secret FROM anon, authenticated;
END
$$;

-- @step migrate 行级安全策略（16 条，先删后建，可重复执行）
DO $$
BEGIN
  DROP POLICY IF EXISTS news_flash_read_auth ON public.news_flash;
  -- 登录用户可读保留期内的快讯
  CREATE POLICY news_flash_read_auth ON public.news_flash FOR SELECT TO anon, authenticated USING (coalesce(auth.uid(), 'anon') <> 'anon' AND display_time >= (SELECT public.retention_cutoff()));
  DROP POLICY IF EXISTS crawl_runs_read_all ON public.crawl_runs;
  -- 抓取记录公开可读
  CREATE POLICY crawl_runs_read_all ON public.crawl_runs FOR SELECT TO anon, authenticated USING (true);
  DROP POLICY IF EXISTS crawler_settings_read_all ON public.crawler_settings;
  -- 抓取设置公开可读
  CREATE POLICY crawler_settings_read_all ON public.crawler_settings FOR SELECT TO anon, authenticated USING (true);
  DROP POLICY IF EXISTS app_admins_read_all ON public.app_admins;
  -- 管理员名单公开可读
  CREATE POLICY app_admins_read_all ON public.app_admins FOR SELECT TO anon, authenticated USING (true);
  DROP POLICY IF EXISTS llm_settings_select_own ON public.user_llm_settings;
  -- 模型配置 - 本人可读
  CREATE POLICY llm_settings_select_own ON public.user_llm_settings FOR SELECT TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS llm_settings_insert_own ON public.user_llm_settings;
  -- 模型配置 - 本人可新增
  CREATE POLICY llm_settings_insert_own ON public.user_llm_settings FOR INSERT TO anon, authenticated WITH CHECK (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS llm_settings_update_own ON public.user_llm_settings;
  -- 模型配置 - 本人可修改
  CREATE POLICY llm_settings_update_own ON public.user_llm_settings FOR UPDATE TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon') WITH CHECK (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS llm_settings_delete_own ON public.user_llm_settings;
  -- 模型配置 - 本人可删除
  CREATE POLICY llm_settings_delete_own ON public.user_llm_settings FOR DELETE TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS analysis_select_own ON public.news_analysis;
  -- 分析结果 - 本人可读
  CREATE POLICY analysis_select_own ON public.news_analysis FOR SELECT TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS analysis_insert_own ON public.news_analysis;
  -- 分析结果 - 本人可新增
  CREATE POLICY analysis_insert_own ON public.news_analysis FOR INSERT TO anon, authenticated WITH CHECK (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS analysis_update_own ON public.news_analysis;
  -- 分析结果 - 本人可修改
  CREATE POLICY analysis_update_own ON public.news_analysis FOR UPDATE TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon') WITH CHECK (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS analysis_delete_own ON public.news_analysis;
  -- 分析结果 - 本人可删除
  CREATE POLICY analysis_delete_own ON public.news_analysis FOR DELETE TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS chat_select_own ON public.news_chat;
  -- 追问对话 - 本人可读
  CREATE POLICY chat_select_own ON public.news_chat FOR SELECT TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS chat_insert_own ON public.news_chat;
  -- 追问对话 - 本人可新增
  CREATE POLICY chat_insert_own ON public.news_chat FOR INSERT TO anon, authenticated WITH CHECK (owner_id = auth.uid() AND auth.uid() <> 'anon');
  DROP POLICY IF EXISTS chat_delete_own ON public.news_chat;
  -- 追问对话 - 本人可删除
  CREATE POLICY chat_delete_own ON public.news_chat FOR DELETE TO anon, authenticated USING (owner_id = auth.uid() AND auth.uid() <> 'anon');
END
$$;

-- ======================================================================
-- 六、初始数据与定时任务
-- ======================================================================

-- @step write 初始抓取设置：每 20 分钟、回补 5 页、保留 14 天
INSERT INTO public.crawler_settings (id, interval_minutes, enabled, backfill_pages, retention_days) VALUES (1, 20, true, 5, 14) ON CONFLICT (id) DO NOTHING;

-- @step write 写入抓取密钥哈希与签名密钥（参数 $1 $2 由 setup.mjs 根据 config/secret.json 生成）
-- @params secret
INSERT INTO public.crawler_secret (id, secret_hash, signing_key) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, signing_key = EXCLUDED.signing_key;

-- @step write 定时任务：每小时第 7 分钟清理过期快讯
SELECT cron.schedule('purge_expired_news', '7 * * * *', 'SELECT public.purge_expired_news()');
