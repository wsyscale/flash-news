// 设置弹窗：模型配置（云端私有保存）/ 抓取设置（管理员可改间隔）/ 账号
import { cloud, apiJson, clearTicket } from './cloud.js'
import { state, providerById, searchSupport, findModel, sourceById, getDedupX, setDedupX } from './state.js'
import { loadFirst } from './feed.js'
import { $, $$, escapeHtml, fmtDateTime, relTime, toast, withBusy, cloudErrorText, maskEmail, maskPhone, debounce } from './utils.js'
import { MAX_WATCH, QUICK_SECTORS, WATCH_TYPE_LABEL, watchKey, keywordsOf } from './watch.js'

let draft = null // { provider, configs, thinking, system_prompt, watchlist }
let hooks = { onLlmSaved: () => {}, onStatus: () => {}, onLogout: () => {}, refreshMe: async () => {}, onRetention: () => {} }

const TRIGGER = { schedule: '定时', startup: '启动', manual: '手动', gap: '补缺口', cli: '命令行' }

function inlineMsg(id, text, type = '') {
  const el = $(id)
  el.textContent = text || ''
  el.className = `inline-msg ${type}`
}

// ---------------- 模型配置 ----------------
function makeDraft() {
  const row = state.llm || {}
  return {
    provider: row.provider || 'deepseek',
    configs: JSON.parse(JSON.stringify(row.configs || {})),
    thinking: row.thinking ?? true,
    web_search: row.web_search ?? true,
    system_prompt: row.system_prompt || '',
    watchlist: JSON.parse(JSON.stringify(Array.isArray(row.watchlist) ? row.watchlist : [])),
  }
}

// ---------------- 关注的板块 / 标的 ----------------
const watchUi = { items: [], active: -1, seq: 0, query: '' }

function renderWatch() {
  if (!draft) return
  const list = draft.watchlist
  $('#watchCount').textContent = `（${list.length}/${MAX_WATCH}）`
  $('#watchChips').innerHTML = list
    .map((it, i) => {
      const sub = [it.code, it.market || (it.type !== 'custom' ? WATCH_TYPE_LABEL[it.type] : '')].filter(Boolean).join(' · ')
      return `<span class="watch-chip" title="匹配快讯的关键词：${escapeHtml(keywordsOf(it).join('、') || it.name)}">${escapeHtml(it.name)}${
        sub ? ` <small>${escapeHtml(sub)}</small>` : ''
      }<button type="button" data-watch-del="${i}" aria-label="移除">×</button></span>`
    })
    .join('')
  const added = new Set(list.map((it) => it.name))
  $('#watchQuick').innerHTML = QUICK_SECTORS.filter((s) => !added.has(s))
    .slice(0, 12)
    .map((s) => `<button type="button" class="chip" data-watch-quick="${escapeHtml(s)}">+ ${escapeHtml(s)}</button>`)
    .join('')
  $('#watchInput').placeholder = list.length >= MAX_WATCH ? `最多 ${MAX_WATCH} 项，可先删除再添加` : '输入名称或代码搜索，如 贵州茅台、510300、新能源车'
}

function addWatch(item) {
  const name = String(item.name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!name) return
  const it = { name, code: String(item.code || '').trim().slice(0, 20), market: String(item.market || '').slice(0, 20), type: item.type || 'custom' }
  if (draft.watchlist.some((x) => watchKey(x) === watchKey(it))) return inlineMsg('#llmMsg', `「${name}」已在关注列表中`)
  if (draft.watchlist.length >= MAX_WATCH) return inlineMsg('#llmMsg', `关注列表最多 ${MAX_WATCH} 项`, 'err')
  draft.watchlist.push(it)
  $('#watchInput').value = ''
  hideSuggest()
  renderWatch()
  inlineMsg('#llmMsg', '已添加，记得点「保存」')
}

function hideSuggest() {
  watchUi.items = []
  watchUi.active = -1
  watchUi.seq++
  $('#watchSuggest').hidden = true
}

function renderSuggest(tip = '') {
  const box = $('#watchSuggest')
  const q = watchUi.query
  const keys = new Set(draft.watchlist.map(watchKey))
  const opts = watchUi.items.map((it, i) => {
    const added = keys.has(watchKey(it))
    return `<button type="button" class="watch-opt${i === watchUi.active ? ' is-active' : ''}${added ? ' added' : ''}" data-watch-pick="${i}">
      <b>${escapeHtml(it.name)}</b><span class="code">${escapeHtml(it.code)}</span><span class="mkt">${added ? '已添加' : escapeHtml(it.market || WATCH_TYPE_LABEL[it.type])}</span></button>`
  })
  const freeIdx = watchUi.items.length
  opts.push(
    `<button type="button" class="watch-opt${watchUi.active === freeIdx ? ' is-active' : ''}" data-watch-pick="free">直接添加「<b>${escapeHtml(q)}</b>」<span class="mkt">自定义</span></button>`,
  )
  box.innerHTML = (tip ? `<div class="watch-tip">${escapeHtml(tip)}</div>` : '') + opts.join('')
  box.hidden = false
}

const searchWatch = debounce(async () => {
  const q = $('#watchInput').value.trim()
  if (!q) return hideSuggest()
  const seq = ++watchUi.seq
  watchUi.query = q
  try {
    const r = await apiJson(`/api/symbols?q=${encodeURIComponent(q)}`)
    if (seq !== watchUi.seq) return
    watchUi.items = (r.items || []).slice(0, 8)
    watchUi.active = watchUi.items.length ? 0 : -1
    renderSuggest(watchUi.items.length ? '' : '没有找到匹配的证券 / 板块')
  } catch (err) {
    if (seq !== watchUi.seq) return
    watchUi.items = []
    watchUi.active = -1
    renderSuggest(err.message || '搜索暂不可用，可直接添加文字')
  }
}, 250)

function pickSuggest(which) {
  if (which === 'free' || which === watchUi.items.length || which < 0) {
    const q = $('#watchInput').value.trim()
    if (q) addWatch({ name: q, type: 'custom' })
    return
  }
  const it = watchUi.items[which]
  if (it) addWatch(it)
}

function initWatchEditor() {
  const input = $('#watchInput')
  $('#watchBox').addEventListener('click', (e) => {
    const del = e.target.closest('[data-watch-del]')
    if (del) {
      draft.watchlist.splice(Number(del.dataset.watchDel), 1)
      renderWatch()
      inlineMsg('#llmMsg', '已移除，记得点「保存」')
      return
    }
    input.focus()
  })
  input.addEventListener('input', () => {
    watchUi.query = input.value.trim()
    if (!watchUi.query) return hideSuggest()
    // 先立即给出「直接添加」选项，搜索结果回来后再补全
    if ($('#watchSuggest').hidden) {
      watchUi.items = []
      watchUi.active = 0
      renderSuggest('搜索中…')
    }
    searchWatch()
  })
  input.addEventListener('keydown', (e) => {
    const total = watchUi.items.length + 1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if ($('#watchSuggest').hidden) return
      e.preventDefault()
      watchUi.active = (watchUi.active + (e.key === 'ArrowDown' ? 1 : total - 1)) % total
      renderSuggest()
    } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      if (!input.value.trim()) return
      pickSuggest($('#watchSuggest').hidden ? 'free' : watchUi.active)
    } else if (e.key === 'Escape' && !$('#watchSuggest').hidden) {
      e.stopPropagation()
      hideSuggest()
    } else if (e.key === 'Backspace' && !input.value && draft.watchlist.length) {
      draft.watchlist.pop()
      renderWatch()
    }
  })
  $('#watchSuggest').addEventListener('mousedown', (e) => e.preventDefault()) // 防止点击候选时输入框失焦
  $('#watchSuggest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-watch-pick]')
    if (!b || b.classList.contains('added')) return
    pickSuggest(b.dataset.watchPick === 'free' ? 'free' : Number(b.dataset.watchPick))
  })
  input.addEventListener('blur', () => setTimeout(hideSuggest, 150))
  $('#watchQuick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-watch-quick]')
    if (b) addWatch({ name: b.dataset.watchQuick, type: 'sector' })
  })
}

function collectFields() {
  if (!draft) return
  const p = providerById(draft.provider)
  const cfg = draft.configs[draft.provider] || (draft.configs[draft.provider] = {})
  cfg.apiKey = $('#llmKey').value.trim()
  cfg.model = currentModel()
  if (p && p.id === 'custom') cfg.baseUrl = $('#llmBaseInput').value.trim()
  else cfg.baseUrl = $('#llmBaseSelect').value
  if (!$('#llmThinking').disabled) draft.thinking = $('#llmThinking').checked
  if (!$('#llmSearch').disabled) draft.web_search = $('#llmSearch').checked
  draft.system_prompt = $('#llmPrompt').value.trim()
}

// ---------------- 模型选择：分组下拉框 + 手动填写 ----------------
const MANUAL = '__manual__'
const REGION_TEXT = { cn: '仅广州', intl: '仅新加坡 / 硅谷' }
const GZ_HOSTS = ['tokenhub.tencentmaas.com', 'tokenhub.tencentcloudmaas.com']

/** 当前选中的模型名：下拉框里的模型，或手动填写的名称 */
function currentModel() {
  const sel = $('#llmModelSelect')
  if (sel.hidden || sel.value === MANUAL) return $('#llmModel').value.trim()
  return sel.value
}

function currentBaseUrl(p) {
  return p && p.id === 'custom' ? $('#llmBaseInput').value.trim() : $('#llmBaseSelect').value
}

function modelTags(p, m) {
  const tags = []
  if (p.webSearch && p.webSearch.models.includes(m.id)) tags.push('可联网')
  if (m.thinking === 'always') tags.push('思考常开')
  if (m.note) tags.push(m.note.replace(/模型$/, ''))
  if (m.region) tags.push(REGION_TEXT[m.region])
  if (m.deprecated) tags.push('即将下线')
  return tags
}

function renderModelSelect(p, model) {
  const sel = $('#llmModelSelect')
  const inp = $('#llmModel')
  if (!p.models.length) {
    // 自定义服务没有预置模型：只显示输入框
    sel.hidden = true
    inp.hidden = false
    inp.value = model || ''
    inp.placeholder = '填写模型名称，如 gpt-4o-mini、qwen-plus'
    $('#modelCount').textContent = ''
    return
  }
  const groups = new Map()
  for (const m of p.models) {
    if (!groups.has(m.group)) groups.set(m.group, [])
    groups.get(m.group).push(m)
  }
  const opt = (m) => {
    const tags = modelTags(p, m)
    return `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}（${escapeHtml(m.id)}）${tags.length ? ` · ${escapeHtml(tags.join(' · '))}` : ''}</option>`
  }
  const multi = groups.size > 1
  sel.innerHTML =
    [...groups.entries()]
      .map(([g, list]) => (multi ? `<optgroup label="${escapeHtml(g)}">${list.map(opt).join('')}</optgroup>` : list.map(opt).join('')))
      .join('') + `<optgroup label="其他"><option value="${MANUAL}">✏️ 手动填写模型名称…</option></optgroup>`
  sel.hidden = false
  $('#modelCount').textContent = `（预置 ${p.models.length} 个）`
  inp.placeholder = '填写模型名称（model 参数值），如 deepseek-v4-flash'
  // 只有完全等于预置 id 才选中下拉项；别名或未收录的名称放进输入框，保持原样
  const exact = p.models.some((m) => m.id === model)
  sel.value = exact ? model : MANUAL
  inp.hidden = exact
  inp.value = model || '' // 切到「手动填写」时，输入框里预填当前模型名，方便改
}

/** 模型下方的说明：model 参数、用途、思考、地域、未收录提示 */
function renderModelHint() {
  const p = providerById(draft.provider)
  const hint = $('#modelHint')
  if (!p) return (hint.textContent = '')
  const model = currentModel()
  if (p.id === 'custom') return (hint.textContent = '自定义服务不传思考参数，以模型默认行为为准')
  if (!model) return (hint.textContent = '请填写模型名称，需与服务商控制台里的 model 参数值完全一致')
  const m = findModel(p, model)
  const parts = []
  if (!m) {
    parts.push(
      `未收录的模型：会按「深度思考」开关传参，模型不认这个参数时自动去掉重试。请确认名称拼写正确，并已在${p.id === 'tokenhub' ? ' TokenHub 控制台' : '服务商控制台'}开通该模型`,
    )
  } else {
    if (m.id !== model) parts.push(`${model} 是「${m.name}」（${m.id}）的另一个参数名`)
    if (m.special) parts.push(`${m.note}，不太适合做财经分析`)
    if (m.thinking === 'always') parts.push('该模型的深度思考不支持关闭')
    if (m.thinking === 'auto') parts.push('该模型不支持开关深度思考，按模型默认行为（可能会显示思考过程）')
    if (m.deprecated) parts.push('官方标注即将下线，建议换用新版本')
    let host = ''
    try {
      host = new URL(currentBaseUrl(p)).hostname
    } catch {
      /* ignore */
    }
    const gz = GZ_HOSTS.includes(host)
    if (m.region === 'cn' && host && !gz) parts.push('该模型只在广州地域提供，请把接入地址切到广州')
    if (m.region === 'intl' && gz) parts.push('该模型只在新加坡 / 硅谷站点提供，广州地址调不通；注意两个站点的 API Key 不互通')
  }
  hint.textContent = parts.join('；')
}

function onModelChanged() {
  updateThinkingRow()
  updateSearchRow()
}

function updateSearchRow() {
  if (!draft) return
  const p = providerById(draft.provider)
  const model = currentModel()
  const baseUrl = currentBaseUrl(p)
  const sup = searchSupport(draft.provider, model, baseUrl)
  const row = $('#searchRow')
  const box = $('#llmSearch')
  row.classList.toggle('is-disabled', !sup.ok)
  box.disabled = !sup.ok
  box.checked = sup.ok && draft.web_search
  const ws = p && p.webSearch
  const hint = $('#searchHint')
  if (sup.ok) {
    hint.innerHTML = `腾讯云 TokenHub 轻量版搜索，按实际搜索次数计费（约 7 元/千次）。首次使用请先在 <a href="${escapeHtml(ws.consoleUrl)}" target="_blank" rel="noopener">TokenHub 控制台「启用管理 → 应用工具」</a>领取联网搜索免费资源包或开通后付费。`
  } else if (sup.reason === 'provider') {
    hint.textContent = '联网搜索目前仅支持腾讯云 TokenHub（DeepSeek 官方 API 没有内置搜索）。'
  } else if (sup.reason === 'model') {
    hint.textContent = '当前模型不支持联网搜索，可换成 deepseek-v4-flash、deepseek-v4-pro 或 hy3。'
  } else {
    hint.textContent = '联网搜索仅支持广州地域接入地址（tokenhub.tencentmaas.com）。'
  }
}

function updateThinkingRow() {
  const p = providerById(draft.provider)
  const m = findModel(p, currentModel())
  const row = $('#thinkingRow')
  const box = $('#llmThinking')
  // lock：on = 常开不可关；off = 不能开关（不传参）；null = 用户可选
  let lock = null
  if (!p || !p.supportsThinking) lock = 'off'
  else if (m && m.thinking === 'always') lock = 'on'
  else if (m && m.thinking === 'auto') lock = 'off'
  row.classList.toggle('is-disabled', !!lock)
  box.disabled = !!lock
  box.checked = lock ? lock === 'on' : draft.thinking
  renderModelHint()
}

function renderProviderFields() {
  const p = providerById(draft.provider)
  if (!p) return
  $$('#providerSeg .seg-item').forEach((b) => b.classList.toggle('is-active', b.dataset.provider === p.id))
  const cfg = draft.configs[p.id] || {}
  $('#llmKey').value = cfg.apiKey || ''
  $('#llmKey').type = 'password'
  $('#toggleKey').textContent = '显示'
  $('#keyHint').textContent = p.keyHint || ''
  const link = $('#keyLink')
  link.hidden = !p.keyUrl
  if (p.keyUrl) link.href = p.keyUrl

  const sel = $('#llmBaseSelect')
  const inp = $('#llmBaseInput')
  if (p.id === 'custom') {
    sel.hidden = true
    inp.hidden = false
    inp.value = cfg.baseUrl || ''
  } else {
    inp.hidden = true
    sel.hidden = false
    sel.innerHTML = p.baseUrls.map((b) => `<option value="${escapeHtml(b.url)}">${escapeHtml(b.label)} · ${escapeHtml(b.url)}</option>`).join('')
    sel.value = p.baseUrls.some((b) => b.url === cfg.baseUrl) ? cfg.baseUrl : p.baseUrls[0].url
  }
  $('#baseUrlField').hidden = p.id !== 'custom' && p.baseUrls.length <= 1

  renderModelSelect(p, cfg.model || p.defaultModel || '')
  updateThinkingRow()
  updateSearchRow()
}

function renderLlmPane() {
  draft = makeDraft()
  $('#providerSeg').innerHTML = state.providers
    .map((p) => `<button type="button" class="seg-item" data-provider="${p.id}">${escapeHtml(p.name)}</button>`)
    .join('')
  $('#llmPrompt').value = draft.system_prompt
  renderProviderFields()
  $('#watchInput').value = ''
  hideSuggest()
  renderWatch()
  inlineMsg('#llmMsg', '')
}

async function saveLlm() {
  collectFields()
  const cfg = draft.configs[draft.provider] || {}
  const p = providerById(draft.provider)
  // 只保存关注列表时允许暂不填 Key
  if (!cfg.apiKey && !draft.watchlist.length) return inlineMsg('#llmMsg', '请填写 API Key', 'err')
  if (cfg.apiKey && !cfg.model) return inlineMsg('#llmMsg', '请选择模型，或填写模型名称', 'err')
  if (cfg.model && !/^[A-Za-z0-9._:/@+\-]{1,120}$/.test(cfg.model)) {
    return inlineMsg('#llmMsg', '模型名称只能包含字母、数字和 . _ - / : @ +，不能有空格或中文', 'err')
  }
  if (cfg.apiKey && p.id === 'custom' && !/^https:\/\//.test(cfg.baseUrl || '')) return inlineMsg('#llmMsg', '自定义服务需填写 https 开头的 Base URL', 'err')
  const prevWatch = (state.llm && state.llm.watchlist) || []
  const payload = {
    provider: draft.provider,
    configs: draft.configs,
    thinking: draft.thinking,
    web_search: draft.web_search,
    system_prompt: draft.system_prompt || null,
    watchlist: draft.watchlist,
    updated_at: new Date().toISOString(),
  }
  await withBusy($('#saveLlm'), async () => {
    let res
    if (state.llm && state.llm.id) {
      res = await cloud.database.from('user_llm_settings').update(payload).eq('id', state.llm.id).select()
    } else {
      res = await cloud.database.from('user_llm_settings').insert(payload).select()
      if (res.error && String(res.error.code || '').includes('23505')) {
        const again = await cloud.database.from('user_llm_settings').select('id').maybeSingle()
        if (again.data) res = await cloud.database.from('user_llm_settings').update(payload).eq('id', again.data.id).select()
      }
    }
    if (res.error) return inlineMsg('#llmMsg', `保存失败：${cloudErrorText(res.error)}`, 'err')
    if (!res.data || !res.data.length) return inlineMsg('#llmMsg', '保存失败：没有写入权限，请重新登录后再试', 'err')
    state.llm = res.data[0]
    inlineMsg('#llmMsg', cfg.apiKey ? '已保存' : '已保存（尚未填写 API Key，暂时无法分析）', 'ok')
    toast('模型配置已保存', 'success')
    hooks.onLlmSaved({ prevWatch })
  }, '保存中…')
}

async function testLlm() {
  collectFields()
  const cfg = draft.configs[draft.provider] || {}
  if (!cfg.apiKey) return inlineMsg('#llmMsg', '请先填写 API Key', 'err')
  inlineMsg('#llmMsg', '正在测试…')
  await withBusy($('#testLlm'), async () => {
    try {
      const r = await apiJson('/api/llm/test', {
        method: 'POST',
        body: { provider: draft.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl, thinking: false },
      })
      inlineMsg('#llmMsg', `连接成功 · ${r.model} · ${r.latencyMs} ms`, 'ok')
    } catch (err) {
      inlineMsg('#llmMsg', err.message, 'err')
    }
  }, '测试中…')
}

// ---------------- 抓取设置 ----------------
function renderCrawlDetail(st, cs) {
  const days = (cs && cs.retention_days) || state.retentionDays
  const purge = cs && cs.last_purge_at
    ? `${fmtDateTime(cs.last_purge_at)}（${relTime(cs.last_purge_at)}），删除 ${cs.last_purge_deleted ?? 0} 条`
    : '等待首次执行'
  const retentionRows = `
    <dt>数据保留</dt><dd>近 <b>${days}</b> 天 <span class="muted">（超过 ${days} 天的快讯连同其分析、追问记录每小时自动清理）</span></dd>
    <dt>上次清理</dt><dd>${purge}</dd>`
  if (!st) {
    $('#crawlDetail').innerHTML = `<dt>状态</dt><dd>读取失败</dd>${retentionRows}`
    return
  }
  const src = { database: '网站设置', env: '环境变量（优先）', default: '默认值' }[st.settingsSource] || st.settingsSource
  const sources = Array.isArray(st.sources) && st.sources.length ? st.sources : [{ id: 'wscn', name: '华尔街见闻', lastRun: st.lastRun, pending: st.pending }]
  const perSource = sources
    .map((s) => {
      const last = s.lastRun
      const result = s.enabled === false
        ? '<span class="muted">已在配置中关闭</span>'
        : !last
          ? '尚未抓取'
          : last.status === 'ok'
            ? `<span class="st-ok">成功</span> · ${relTime(last.finished_at || last.started_at)} · 抓取 ${last.fetched} 条，新增 ${last.new_items ?? last.inserted ?? 0} 条`
            : `<span class="st-err">失败</span> · ${relTime(last.finished_at || last.started_at)}：${escapeHtml(last.message || '')}`
      return `<dt>${escapeHtml(s.name || s.id)}</dt><dd>${result}${s.pending ? ` <span class="muted">（待入库 ${s.pending} 条）</span>` : ''}</dd>`
    })
    .join('')
  $('#crawlDetail').innerHTML = `
    <dt>抓取间隔</dt><dd>每 <b>${st.intervalMinutes}</b> 分钟 <span class="muted">（来源：${src}）</span></dd>
    <dt>运行状态</dt><dd>${st.running ? '抓取中…' : st.enabled ? '<span class="st-ok">运行中</span>' : '<span class="st-err">已暂停</span>'}</dd>
    ${perSource}
    <dt>待入库</dt><dd>${st.pending || 0} 条 <span class="muted">（已登录用户访问时自动写入云数据库）</span></dd>
    <dt>下次抓取</dt><dd>${st.nextRunAt ? `${fmtDateTime(st.nextRunAt)}（${relTime(st.nextRunAt)}）` : '—'}</dd>
    <dt>每次回补</dt><dd>每个来源最多 ${st.backfillPages} 页（华尔街见闻 20 条/页，财联社 50 条/页；距上次抓取新增过多时自动翻页补齐）</dd>${retentionRows}`
}

function renderAdminBox(st, cs) {
  const box = $('#adminBox')
  const days = (cs && cs.retention_days) || state.retentionDays
  if (state.me.isAdmin) {
    box.innerHTML = `
      <div class="card-title">管理员设置</div>
      <div class="admin-grid">
        <label class="field"><span class="field-label">抓取间隔（分钟，1–1440）</span><input id="admInterval" type="number" min="1" max="1440" step="1" value="${st ? st.intervalMinutes : 20}" /></label>
        <label class="field"><span class="field-label">每次最多回补页数（1–20）</span><input id="admBackfill" type="number" min="1" max="20" step="1" value="${st ? st.backfillPages : 5}" /></label>
        <label class="field"><span class="field-label">数据保留天数（1–14）</span><input id="admRetention" type="number" min="1" max="14" step="1" value="${days}" /></label>
      </div>
      <label class="switch-row"><input type="checkbox" id="admEnabled" ${!st || st.enabled ? 'checked' : ''} /><span class="switch"></span><span>启用定时抓取</span></label>
      ${st && st.settingsSource === 'env' ? '<p class="admin-note">当前服务端设置了环境变量 CRAWL_INTERVAL_MINUTES，间隔以环境变量为准；这里的修改会在移除该变量后生效。</p>' : ''}
      <div class="modal-actions">
        <span class="inline-msg" id="admMsg"></span>
        <button type="button" class="btn btn-ghost" id="crawlNow">立即抓取一次</button>
        <button type="button" class="btn btn-primary" id="saveCrawl">保存设置</button>
      </div>`
    $('#saveCrawl').addEventListener('click', saveCrawl)
    $('#crawlNow').addEventListener('click', crawlNow)
  } else if (!state.me.hasAdmin) {
    box.innerHTML = `
      <p class="admin-note">本站还没有管理员。站点创建者请点击下方按钮认领管理员（仅第一位可认领），之后可在这里修改抓取间隔、手动触发抓取。</p>
      <div class="modal-actions"><span class="inline-msg" id="admMsg"></span><button type="button" class="btn btn-primary" id="claimAdmin">认领管理员</button></div>`
    $('#claimAdmin').addEventListener('click', claimAdmin)
  } else {
    box.innerHTML = '<p class="card-note">抓取间隔由站点管理员设置，如需调整请联系管理员。</p>'
  }
}

async function renderRuns() {
  const { data, error } = await cloud.database
    .from('crawl_runs')
    .select('source, started_at, finished_at, status, trigger, pages, fetched, inserted, duration_ms, message')
    .order('started_at', { ascending: false })
    .limit(20)
  const body = $('#runsBody')
  if (error) {
    body.innerHTML = `<tr><td colspan="7" class="st-err">读取失败：${escapeHtml(cloudErrorText(error))}</td></tr>`
    return
  }
  if (!data || !data.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">暂无记录</td></tr>'
    return
  }
  body.innerHTML = data
    .map(
      (r) => `<tr>
      <td>${fmtDateTime(r.started_at)}</td>
      <td>${escapeHtml(sourceById(r.source || 'wscn').shortName || r.source)}</td>
      <td>${TRIGGER[r.trigger] || escapeHtml(r.trigger)}</td>
      <td>${r.status === 'ok' ? '<span class="st-ok">成功</span>' : `<span class="st-err" title="${escapeHtml(r.message || '')}">失败</span>`}</td>
      <td>${r.fetched}（${r.pages} 页）</td>
      <td><b>${r.inserted}</b></td>
      <td>${(r.duration_ms / 1000).toFixed(1)}s</td>
    </tr>`,
    )
    .join('')
}

async function loadCrawlerSettings() {
  const { data, error } = await cloud.database
    .from('crawler_settings')
    .select('retention_days, last_purge_at, last_purge_deleted')
    .eq('id', 1)
    .maybeSingle()
  if (error || !data) return null
  if (data.retention_days && data.retention_days !== state.retentionDays) hooks.onRetention(data.retention_days)
  return data
}

async function renderCrawlPane() {
  const [stRes, cs] = await Promise.all([
    apiJson('/api/status', { auth: false }).catch(() => null),
    loadCrawlerSettings().catch(() => null),
  ])
  const st = stRes
  if (st) {
    state.status = st
    hooks.onStatus(st)
  }
  renderCrawlDetail(st, cs)
  renderAdminBox(st, cs)
  renderRuns()
}

async function saveCrawl() {
  const interval = Number.parseInt($('#admInterval').value, 10)
  const backfill = Number.parseInt($('#admBackfill').value, 10)
  const retention = Number.parseInt($('#admRetention').value, 10)
  const enabled = $('#admEnabled').checked
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) return inlineMsg('#admMsg', '抓取间隔需为 1–1440 的整数', 'err')
  if (!Number.isInteger(backfill) || backfill < 1 || backfill > 20) return inlineMsg('#admMsg', '回补页数需为 1–20 的整数', 'err')
  if (!Number.isInteger(retention) || retention < 1 || retention > 14) return inlineMsg('#admMsg', '保留天数需为 1–14 的整数', 'err')
  if (
    retention < state.retentionDays &&
    !confirm(`保留天数将从 ${state.retentionDays} 天缩短为 ${retention} 天，超过 ${retention} 天的快讯及所有用户对其的分析、追问记录会被立即删除，确定吗？`)
  ) {
    return
  }
  await withBusy($('#saveCrawl'), async () => {
    const { error } = await cloud.database.rpc('admin_update_crawler_settings', {
      p_interval_minutes: interval,
      p_enabled: enabled,
      p_backfill_pages: backfill,
      p_retention_days: retention,
    })
    if (error) return inlineMsg('#admMsg', `保存失败：${cloudErrorText(error)}`, 'err')
    if (retention !== state.retentionDays) hooks.onRetention(retention)
    // 新票据里带着最新设置，服务端验签后立即生效
    clearTicket()
    try {
      await apiJson('/api/settings/reload', { method: 'POST', forceTicket: true })
    } catch (err) {
      toast(`设置已保存，但同步到服务端失败：${err.message}`, 'error')
    }
    toast(`已保存：每 ${interval} 分钟抓取一次，数据保留 ${retention} 天`, 'success')
    renderCrawlPane()
  }, '保存中…')
}

async function crawlNow() {
  inlineMsg('#admMsg', '正在抓取…')
  await withBusy($('#crawlNow'), async () => {
    try {
      const r = await apiJson('/api/crawl/run', { method: 'POST' })
      const run = r.run || {}
      // 新版服务端返回 { runs: [每个来源一条], status }；旧版直接返回一条
      const runs = Array.isArray(run.runs) ? run.runs : run.status ? [run] : []
      const summary = runs
        .map((x) => `${sourceById(x.source || 'wscn').shortName}${x.status === 'ok' ? ` 抓取 ${x.fetched} 条、新增 ${x.new_items ?? 0} 条` : ` 失败：${x.message || ''}`}`)
        .join('；')
      if (run.skipped) inlineMsg('#admMsg', '已有抓取任务在进行中', '')
      else if (runs.some((x) => x.status === 'ok')) {
        inlineMsg('#admMsg', `${summary}，正在写入数据库…`, runs.every((x) => x.status === 'ok') ? 'ok' : 'err')
        await hooks.onCrawled?.()
        inlineMsg('#admMsg', summary, runs.every((x) => x.status === 'ok') ? 'ok' : 'err')
      } else inlineMsg('#admMsg', `抓取失败：${summary}`, 'err')
      if (r.status) hooks.onStatus(r.status)
      renderRuns()
    } catch (err) {
      inlineMsg('#admMsg', err.message, 'err')
    }
  }, '抓取中…')
}

async function claimAdmin() {
  await withBusy($('#claimAdmin'), async () => {
    const { data, error } = await cloud.database.rpc('claim_admin')
    if (error) return inlineMsg('#admMsg', `认领失败：${cloudErrorText(error)}`, 'err')
    await hooks.refreshMe()
    clearTicket()
    if (data) toast('你已成为本站管理员', 'success')
    else toast('管理员已被他人认领', 'error')
    renderCrawlPane()
  }, '处理中…')
}

// ---------------- 账号 ----------------
function renderAccountPane() {
  const u = (state.session && state.session.user) || {}
  const rows = []
  if (u.phone) rows.push(`<dt>手机号</dt><dd>${escapeHtml(maskPhone(u.phone))}</dd>`)
  if (u.email) rows.push(`<dt>邮箱</dt><dd>${escapeHtml(maskEmail(u.email))}</dd>`)
  rows.push(`<dt>用户 ID</dt><dd><code>${escapeHtml(u.id || state.me.uid || '')}</code></dd>`)
  rows.push(`<dt>角色</dt><dd>${state.me.isAdmin ? '管理员' : '普通用户'}</dd>`)
  $('#accountKv').innerHTML = rows.join('')
  $('#changePwdForm').hidden = !u.email
  inlineMsg('#pwdMsg', '')
  const dx = $('#dedupX')
  if (dx && document.activeElement !== dx) dx.value = String(getDedupX())
  inlineMsg('#dedupMsg', '')
}

async function changePassword(e) {
  e.preventDefault()
  const oldPassword = $('#oldPwd').value
  const newPassword = $('#newPwd').value
  if (!oldPassword) return inlineMsg('#pwdMsg', '请输入原密码', 'err')
  if (newPassword.length < 8) return inlineMsg('#pwdMsg', '新密码至少 8 位', 'err')
  const res = await cloud.auth.resetPasswordForOld({ oldPassword, newPassword })
  if (res.error) return inlineMsg('#pwdMsg', `修改失败：${cloudErrorText(res.error, '原密码不正确')}`, 'err')
  $('#oldPwd').value = ''
  $('#newPwd').value = ''
  inlineMsg('#pwdMsg', '密码已更新', 'ok')
}

// ---------------- 弹窗 ----------------
function switchSetTab(name) {
  $$('[data-set-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.setTab === name))
  $$('[data-set-pane]').forEach((p) => (p.hidden = p.dataset.setPane !== name))
  if (name === 'llm') renderLlmPane()
  if (name === 'crawl') renderCrawlPane()
  if (name === 'account') renderAccountPane()
}

export function openSettings(tab = 'llm') {
  $('#settingsMask').hidden = false
  switchSetTab(tab)
}

export function closeSettings() {
  $('#settingsMask').hidden = true
}

export function initSettings(h) {
  hooks = { ...hooks, ...h }
  $$('[data-set-tab]').forEach((b) => b.addEventListener('click', () => switchSetTab(b.dataset.setTab)))
  $('#settingsClose').addEventListener('click', closeSettings)
  // 「全部」tab 去重阈值：保存后如果正在看「全部」，立即按新阈值重新去重
  $('#saveDedupX').addEventListener('click', () => {
    const v = Number.parseInt($('#dedupX').value, 10)
    if (!Number.isInteger(v) || v < 0 || v > 50) return inlineMsg('#dedupMsg', '请输入 0–50 的整数', 'err')
    setDedupX(v)
    inlineMsg('#dedupMsg', '已保存', 'ok')
    if (state.source === 'all') loadFirst().catch(() => {})
  })
  $('#settingsMask').addEventListener('click', (e) => {
    if (e.target === $('#settingsMask')) closeSettings()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settingsMask').hidden) closeSettings()
  })
  $('#providerSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-provider]')
    if (!b || !draft) return
    collectFields()
    draft.provider = b.dataset.provider
    renderProviderFields()
    inlineMsg('#llmMsg', '')
  })
  $('#llmModelSelect').addEventListener('change', () => {
    const manual = $('#llmModelSelect').value === MANUAL
    const inp = $('#llmModel')
    inp.hidden = !manual
    if (!manual) inp.value = $('#llmModelSelect').value
    else {
      inp.focus()
      inp.select()
    }
    onModelChanged()
  })
  $('#llmModel').addEventListener('input', onModelChanged)
  $('#llmBaseSelect').addEventListener('change', onModelChanged)
  $('#llmThinking').addEventListener('change', (e) => draft && (draft.thinking = e.target.checked))
  $('#llmSearch').addEventListener('change', (e) => draft && (draft.web_search = e.target.checked))
  $('#toggleKey').addEventListener('click', () => {
    const k = $('#llmKey')
    k.type = k.type === 'password' ? 'text' : 'password'
    $('#toggleKey').textContent = k.type === 'password' ? '显示' : '隐藏'
  })
  $('#fillDefaultPrompt').addEventListener('click', () => ($('#llmPrompt').value = state.defaultPrompt))
  $('#saveLlm').addEventListener('click', saveLlm)
  initWatchEditor()
  $('#testLlm').addEventListener('click', testLlm)
  $('#changePwdForm').addEventListener('submit', changePassword)
  $('#logoutBtn2').addEventListener('click', () => {
    closeSettings()
    hooks.onLogout()
  })
}
