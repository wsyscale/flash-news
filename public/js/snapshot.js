// 分析抽屉「长截图」：勾选 快讯 / AI 分析 / 追问消息 → 生成一张 PNG 长图复制到剪贴板
//   · 渲染用 vendor 的 html2canvas-pro（离屏白底容器，宽 = 抽屉正文宽）
//   · 剪贴板走 ClipboardItem(Promise<Blob>) 保持用户手势；不支持时降级为下载 PNG
import { $, toast } from './utils.js'

let active = false

/** 可勾选单元（按文档顺序） */
function units() {
  const list = []
  const news = $('#drawerNews')
  if (news && news.innerHTML.trim()) list.push({ el: news, label: '快讯', withSources: null })
  const body = $('#analysisBody')
  if (body && body.innerHTML.trim()) {
    const src = $('#analysisSources')
    list.push({ el: body, label: 'AI 分析', withSources: src && src.innerHTML.trim() ? src : null })
  }
  document.querySelectorAll('#chatList .msg').forEach((el) => list.push({ el, label: '追问消息', withSources: null }))
  return list
}

export function snapshotMode() {
  return active
}

export function enterSnapshot() {
  if (active) return
  active = true
  const drawer = $('#drawer')
  drawer.classList.add('snapping')
  for (const id of ['stopBtn', 'copyBtn', 'snapBtn', 'reanalyzeBtn']) {
    const el = $(`#${id}`)
    if (el) el.hidden = true
  }
  $('#snapBar').hidden = false
  const us = units()
  for (const u of us) {
    u.el.classList.add('snap-unit')
    const box = document.createElement('label')
    box.className = 'snap-check'
    box.title = u.label
    box.innerHTML = '<input type="checkbox" checked>'
    u.el.appendChild(box)
  }
  updateCount()
}

export function exitSnapshot() {
  if (!active) return
  active = false
  $('#drawer').classList.remove('snapping')
  $('#snapBar').hidden = true
  document.querySelectorAll('.snap-unit').forEach((el) => {
    el.classList.remove('snap-unit', 'snap-on')
    el.querySelector(':scope > .snap-check')?.remove()
  })
  document.dispatchEvent(new CustomEvent('snapshot:exit'))
}

function updateCount() {
  const boxes = document.querySelectorAll('.snap-check input')
  const n = [...boxes].filter((b) => b.checked).length
  $('#snapCount').textContent = `已选 ${n} 项`
  $('#snapGo').textContent = n ? `复制长截图 (${n})` : '复制长截图'
  $('#snapGo').disabled = !n
  boxes.forEach((b) => b.closest('.snap-unit')?.classList.toggle('snap-on', b.checked))
}

/** 把克隆里的 <details> 展平成静态块（html2canvas 对折叠内容渲染会错位） */
function flattenDetails(root) {
  root.querySelectorAll('details').forEach((d) => {
    const div = document.createElement('div')
    div.className = d.className
    const sum = d.querySelector('summary')
    if (sum) {
      const s = document.createElement('div')
      s.className = 'snap-sum'
      s.textContent = sum.textContent
      div.appendChild(s)
    }
    if (d.open) [...d.children].forEach((c) => c.tagName !== 'SUMMARY' && div.appendChild(c))
    d.replaceWith(div)
  })
}

/** 渲染选中内容为一张 PNG 的 Blob（导出供冒烟测试） */
export async function renderBlob() {
  const sel = [...document.querySelectorAll('.snap-check input:checked')].map((b) => b.closest('.snap-unit'))
  if (!sel.length) throw new Error('请先勾选要截图的内容')

  const width = Math.min(720, Math.max(480, $('#drawerBody').clientWidth || 720))
  const stage = document.createElement('div')
  stage.className = 'snap-stage'
  stage.style.width = `${width}px`
  for (const el of sel) {
    const c = el.cloneNode(true)
    c.classList.remove('snap-unit', 'snap-on')
    c.querySelector(':scope > .snap-check')?.remove()
    // 快讯正文在抽屉里限高滚动，截图时展开全文
    c.querySelectorAll('.dn-text').forEach((t) => {
      t.style.maxHeight = 'none'
      t.style.overflow = 'visible'
    })
    flattenDetails(c)
    // 剥掉截图里无意义的交互元素（复制按钮等）
    c.querySelectorAll('.link-btn').forEach((b) => b.remove())
    stage.appendChild(c)
    if (el.id === 'analysisBody') {
      const src = $('#analysisSources')
      if (src && src.innerHTML.trim()) {
        const cs = src.cloneNode(true)
        flattenDetails(cs)
        stage.appendChild(cs)
      }
    }
  }
  const d = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  stage.insertAdjacentHTML(
    'beforeend',
    `<div class="snap-foot">快讯分析台 · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · 以上内容由 AI 生成，仅供参考，不构成投资建议</div>`
  )
  document.body.appendChild(stage)
  try {
    const canvas = await html2canvas(stage, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片生成失败'))), 'image/png'))
    return blob
  } finally {
    stage.remove()
  }
}

function downloadBlob(blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `ai-analysis-${Date.now()}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

async function go() {
  const btn = $('#snapGo')
  btn.disabled = true
  btn.textContent = '生成中…'
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      // 用 Promise 构造 ClipboardItem，保持在用户手势内（Safari 要求）
      const item = new ClipboardItem({ 'image/png': renderBlob() })
      await navigator.clipboard.write([item])
      toast('长截图已复制到剪贴板', 'success')
    } else {
      downloadBlob(await renderBlob())
      toast('浏览器不支持复制图片，已下载 PNG', 'success')
    }
    exitSnapshot()
  } catch (err) {
    // 剪贴板被拒 / 图片跨域污染：降级为下载
    try {
      downloadBlob(await renderBlob())
      toast('无法访问剪贴板，已改为下载 PNG', 'success')
      exitSnapshot()
    } catch (err2) {
      toast(`生成长截图失败：${(err2 && err2.message) || '未知错误'}`, 'error')
      updateCount()
    }
  }
}

export function initSnapshot() {
  $('#snapBtn').addEventListener('click', enterSnapshot)
  $('#snapCancel').addEventListener('click', exitSnapshot)
  $('#snapAll').addEventListener('click', () => {
    const boxes = [...document.querySelectorAll('.snap-check input')]
    const all = boxes.every((b) => b.checked)
    boxes.forEach((b) => (b.checked = !all))
    $('#snapAll').textContent = all ? '全选' : '全不选'
    updateCount()
  })
  document.addEventListener('change', (e) => {
    if (active && e.target.closest && e.target.closest('.snap-check')) updateCount()
  })
  $('#snapGo').addEventListener('click', go)
}
