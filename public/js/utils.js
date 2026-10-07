export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function toast(message, type = 'info', ms = 3200) {
  const wrap = $('#toastWrap')
  if (!wrap) return
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  wrap.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

export function debounce(fn, ms) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

const pad = (n) => String(n).padStart(2, '0')
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function fmtTime(d) {
  const x = new Date(d)
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`
}
export function fmtDateTime(d) {
  if (!d) return '—'
  const x = new Date(d)
  if (Number.isNaN(x.getTime())) return '—'
  return `${x.getMonth() + 1}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`
}
export function dayKey(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
}
export function dayLabel(d) {
  const x = new Date(d)
  const today = new Date()
  const yest = new Date(Date.now() - 86400000)
  const base = `${x.getMonth() + 1}月${x.getDate()}日 ${WEEK[x.getDay()]}`
  if (dayKey(x) === dayKey(today)) return { text: base, badge: '今天' }
  if (dayKey(x) === dayKey(yest)) return { text: base, badge: '昨天' }
  return { text: base, badge: '' }
}
export function relTime(d) {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  if (abs < 60_000) return future ? '1 分钟内' : '刚刚'
  const m = Math.round(abs / 60_000)
  if (m < 60) return future ? `${m} 分钟后` : `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return future ? `${h} 小时后` : `${h} 小时前`
  return fmtDateTime(d)
}

export function maskPhone(p) {
  const s = String(p || '').replace(/^\+86\s*/, '')
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s
}
export function maskEmail(e) {
  const s = String(e || '')
  const [u, d] = s.split('@')
  if (!d) return s
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(4, u.length - 2)))}@${d}`
}

/** 统一的「按钮忙碌」包装，防重复提交 */
export async function withBusy(btn, fn, busyText) {
  if (!btn || btn.disabled) return
  const old = btn.textContent
  btn.disabled = true
  if (busyText) btn.textContent = busyText
  try {
    return await fn()
  } finally {
    btn.disabled = false
    if (busyText) btn.textContent = old
  }
}

/** 云 SDK 错误 → 中文提示 */
export function cloudErrorText(error, fallback = '操作失败，请稍后重试') {
  if (!error) return fallback
  const kind = error.kind
  const map = {
    network: '网络异常，请检查网络后重试',
    unauthenticated: '登录已失效，请重新登录',
    'permission-denied': '没有权限执行该操作',
    'rate-limited': '操作过于频繁，请稍后再试',
    'credits-exhausted': '云服务额度已用尽，请联系站点管理员',
    'backend-unavailable': '服务暂时不可用，请稍后再试',
  }
  if (map[kind]) return map[kind]
  const msg = error.message || ''
  if (/verification|code|otp|验证码/i.test(msg) && /invalid|expired|wrong|错误|过期/i.test(msg)) return '验证码错误或已过期'
  if (/password/i.test(msg) && /invalid|wrong|incorrect/i.test(msg)) return '账号或密码错误'
  return msg || fallback
}

/** 倒计时按钮 */
export function startCountdown(btn, seconds = 60, label = '获取验证码') {
  let left = seconds
  btn.disabled = true
  btn.dataset.counting = '1'
  btn.textContent = `${left}s 后重发`
  const t = setInterval(() => {
    left -= 1
    if (left <= 0) {
      clearInterval(t)
      btn.disabled = false
      delete btn.dataset.counting
      btn.textContent = label === '获取验证码' ? '重新获取' : label
      return
    }
    btn.textContent = `${left}s 后重发`
  }, 1000)
}
