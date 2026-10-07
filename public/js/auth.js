// 登录 / 注册：手机号短信验证码、邮箱密码、邮箱验证码注册、找回密码
import { cloud } from './cloud.js'
import { $, $$, cloudErrorText, startCountdown, withBusy } from './utils.js'

const PHONE_RE = /^1\d{10}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// 发码结果保存在事件处理函数之外：「获取验证码」只发码，「登录」只验码
let pendingPhone = null // { phone, verificationId, isExistingUser }
let pendingEmail = null // { email, verificationId, isExistingUser }
let pendingReset = null // { email, challenge }

let onSignedInCb = () => {}

function msg(text, ok = false) {
  const el = $('#authMsg')
  el.textContent = text || ''
  el.classList.toggle('ok', !!ok)
}

function switchTab(name) {
  $$('[data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.authTab === name))
  $$('[data-auth-pane]').forEach((p) => (p.hidden = p.dataset.authPane !== name))
  msg('')
}

function switchEmailMode(mode) {
  $$('[data-email-mode]').forEach((b) => b.classList.toggle('is-active', b.dataset.emailMode === mode))
  $$('[data-email-pane]').forEach((p) => (p.hidden = p.dataset.emailPane !== mode))
  $('.auth-form[data-auth-pane="email"] .seg').hidden = mode === 'forgot'
  msg('')
}

function done(session) {
  pendingPhone = null
  pendingEmail = null
  pendingReset = null
  msg('登录成功，正在进入…', true)
  onSignedInCb(session)
}

// ---------- 手机号 ----------
async function sendPhoneCode() {
  const phone = $('#phoneInput').value.trim()
  if (!PHONE_RE.test(phone)) {
    $('#phoneError').textContent = '请输入正确的 11 位手机号'
    return
  }
  $('#phoneError').textContent = ''
  const btn = $('#phoneSendBtn')
  let ok = false
  await withBusy(btn, async () => {
    const sent = await cloud.auth.sendOtp({ phone })
    if (sent.error) {
      msg(cloudErrorText(sent.error, '验证码发送失败'))
      return
    }
    pendingPhone = { phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
    ok = true
    msg('验证码已发送，请查收短信', true)
    $('#phoneCode').focus()
  }, '发送中…')
  if (ok) startCountdown(btn, 60)
}

async function submitPhone(e) {
  e.preventDefault()
  const phone = $('#phoneInput').value.trim()
  const token = $('#phoneCode').value.trim()
  if (!PHONE_RE.test(phone)) {
    $('#phoneError').textContent = '请输入正确的 11 位手机号'
    return
  }
  if (!pendingPhone || pendingPhone.phone !== phone) return msg('请先获取当前手机号的验证码')
  if (!/^\d{4,8}$/.test(token)) return msg('请输入短信验证码')
  await withBusy($('#phoneSubmitBtn'), async () => {
    const res = await cloud.auth.verifyOtp({
      phone: pendingPhone.phone,
      verificationId: pendingPhone.verificationId,
      isExistingUser: pendingPhone.isExistingUser,
      token,
    })
    if (res.error) return msg(cloudErrorText(res.error, '验证码错误或已过期'))
    done(res.data)
  }, '验证中…')
}

// ---------- 邮箱密码 ----------
async function submitEmailPwd(e) {
  e.preventDefault()
  const email = $('#emailPwdEmail').value.trim()
  const password = $('#emailPwdPassword').value
  if (!EMAIL_RE.test(email)) return msg('请输入正确的邮箱地址')
  if (!password) return msg('请输入密码')
  await withBusy($('#emailPwdSubmit'), async () => {
    const res = await cloud.auth.signInWithPassword({ email, password })
    if (res.error) {
      return msg(res.error.kind === 'network' ? cloudErrorText(res.error) : '邮箱或密码错误；未设置过密码请用「验证码登录」')
    }
    done(res.data)
  }, '登录中…')
}

// ---------- 邮箱验证码登录 / 注册 ----------
async function sendEmailCode() {
  const email = $('#emailOtpEmail').value.trim()
  if (!EMAIL_RE.test(email)) return msg('请输入正确的邮箱地址')
  const btn = $('#emailOtpSend')
  let ok = false
  await withBusy(btn, async () => {
    const sent = await cloud.auth.sendOtp({ email })
    if (sent.error) return msg(cloudErrorText(sent.error, '验证码发送失败'))
    pendingEmail = { email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
    ok = true
    msg('验证码已发送，请查收邮件（可能在垃圾箱）', true)
    $('#emailOtpCode').focus()
  }, '发送中…')
  if (ok) startCountdown(btn, 60)
}

async function submitEmailOtp(e) {
  e.preventDefault()
  const email = $('#emailOtpEmail').value.trim()
  const token = $('#emailOtpCode').value.trim()
  const password = $('#emailOtpPassword').value
  if (!EMAIL_RE.test(email)) return msg('请输入正确的邮箱地址')
  if (!pendingEmail || pendingEmail.email !== email) return msg('请先获取当前邮箱的验证码')
  if (!/^\d{4,8}$/.test(token)) return msg('请输入邮箱验证码')
  if (password && password.length < 8) return msg('密码至少 8 位')
  if (!pendingEmail.isExistingUser && !password) return msg('请设置登录密码（至少 8 位）')
  await withBusy($('#emailOtpSubmit'), async () => {
    const res = await cloud.auth.verifyOtp({
      email: pendingEmail.email,
      verificationId: pendingEmail.verificationId,
      isExistingUser: pendingEmail.isExistingUser,
      token,
      password: pendingEmail.isExistingUser ? undefined : password,
    })
    if (res.error) return msg(cloudErrorText(res.error, '验证码错误或已过期'))
    done(res.data)
  }, '验证中…')
}

// ---------- 找回密码 ----------
async function sendResetCode() {
  const email = $('#forgotEmail').value.trim()
  if (!EMAIL_RE.test(email)) return msg('请输入正确的邮箱地址')
  const btn = $('#forgotSend')
  let ok = false
  await withBusy(btn, async () => {
    const started = await cloud.auth.resetPasswordForEmail(email)
    if (started.error) return msg(cloudErrorText(started.error, '验证码发送失败'))
    pendingReset = { email, challenge: started.data }
    ok = true
    msg('如果该邮箱已注册，你将收到一封验证码邮件', true)
  }, '发送中…')
  if (ok) startCountdown(btn, 60)
}

async function submitReset(e) {
  e.preventDefault()
  const email = $('#forgotEmail').value.trim()
  const code = $('#forgotCode').value.trim()
  const password = $('#forgotPassword').value
  if (!pendingReset || pendingReset.email !== email) return msg('请先获取当前邮箱的验证码')
  if (!code) return msg('请输入验证码')
  if (password.length < 8) return msg('新密码至少 8 位')
  await withBusy($('#forgotSubmit'), async () => {
    const res = await pendingReset.challenge.updateUser({ nonce: code, password })
    if (res.error) return msg(cloudErrorText(res.error, '重置失败，请检查验证码'))
    done(res.data)
  }, '提交中…')
}

export function initAuth(onSignedIn) {
  onSignedInCb = onSignedIn
  $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.authTab)))
  $$('[data-email-mode]').forEach((b) => b.addEventListener('click', () => switchEmailMode(b.dataset.emailMode)))
  $('#toForgot').addEventListener('click', (e) => {
    e.preventDefault()
    $('#forgotEmail').value = $('#emailPwdEmail').value
    switchEmailMode('forgot')
  })
  $('#backToLogin').addEventListener('click', (e) => {
    e.preventDefault()
    switchEmailMode('password')
  })

  $('#phoneInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 11)
    $('#phoneError').textContent = ''
  })
  $('#phoneSendBtn').addEventListener('click', sendPhoneCode)
  $('#phoneForm').addEventListener('submit', submitPhone)

  $('#emailPwdForm').addEventListener('submit', submitEmailPwd)
  $('#emailOtpSend').addEventListener('click', sendEmailCode)
  $('#emailOtpForm').addEventListener('submit', submitEmailOtp)
  $('#forgotSend').addEventListener('click', sendResetCode)
  $('#forgotForm').addEventListener('submit', submitReset)
}

export function resetAuthView() {
  msg('')
  ;['#phoneCode', '#emailPwdPassword', '#emailOtpCode', '#emailOtpPassword', '#forgotCode', '#forgotPassword'].forEach(
    (s) => ($(s).value = ''),
  )
}
