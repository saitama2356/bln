import { startGame, p2Keys, remoteKeys, validKeys } from './engine.js'
import { capVideo, frameLink, socketFor, streamJpeg } from './media.js'

const $ = id => document.getElementById(id)
const held = new Set()
const log = []
let socket, role, room, frameChannel, engine, peer, relay
let pending = false, reconnectUntil = 0, reconnectTimer
let signalPing, serverRtt, peerRtt, inputSequence = 0, engineState
let lastInput = 0
const applyRemote = remoteKeys(() => engine, p2Keys)
const video = $('remote')
const canvas = $('relay-screen')
const engineLabels = {
  ready: 'Đang chạy', running: 'Đang chạy', suspect: 'Nghi bị treo',
  renderer: 'Bộ dựng hình gặp lỗi', error: 'Game gặp lỗi Ruffle', paused: 'Ruffle tạm dừng',
}
const profile = () => $('profile').value
const central = () => room?.mode === 'central'
const viewer = () => central() || role === 'guest'
const send = message => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const match = (type, data = {}) => {
  if (room) send({ type, round: room.round, ...data })
}
function record(event, detail = '') {
  log.push({ at: new Date().toISOString(), mode: room?.mode, event, detail: String(detail).slice(0, 300) })
  if (log.length > 150) log.shift()
}
function status(message, tone = '') {
  $('status').textContent = message
  $('status').dataset.tone = tone
  record('trạng thái', message)
}
function busy(value) {
  pending = value
  $('create').disabled = value
  $('join').querySelector('button').disabled = value
}
function view() {
  $('placeholder').hidden = Boolean(role)
  $('engine').hidden = !role || viewer()
  video.hidden = !role || !viewer() || Boolean(relay)
  canvas.hidden = !role || !viewer() || !relay
  $('sound-row').hidden = role !== 'host' || viewer()
}
function networkInfo() {
  $('network-info').hidden = !role
  $('repair').hidden = !viewer() || (!peer && !relay)
  if (!role) return
  const direct = peer?.pc?.connectionState === 'connected' && peer?.input?.readyState === 'open'
  const mode = relay ? 'JPEG qua Render' : direct ? 'WebRTC' : peer ? 'Đang kết nối' : 'Chưa có luồng online'
  $('network-mode').textContent = (central() ? 'Máy chạy trận · ' : '') + mode
  $('network-info').dataset.mode = relay ? 'relay' : direct ? 'direct' : 'connecting'
  const rtt = direct ? peerRtt : serverRtt
  $('network-ping').textContent = rtt == null ? 'Chưa đo' : Math.round(rtt) + ' ms' + (direct ? '' : ' tới Render')
  $('engine-status').textContent = engineLabels[engineState] || 'Chưa có tín hiệu từ game'
}
function reportEngine(state, detail) {
  engineState = state
  record('engine ' + state, detail)
  networkInfo()
  if (['suspect', 'renderer', 'error'].includes(state)) {
    status(engineLabels[state] + '. Có thể dùng nút Khởi động lại trận.', 'error')
  }
}
function launchEngine() {
  engine?.stop()
  engineState = undefined
  const game = startGame($('engine'), (state, detail) => {
    reportEngine(state, detail)
    match('engine-status', { state })
    if (state === 'ready') {
      game.mute($('mute-game').checked)
      if (!peer && !relay) status('Game đã sẵn sàng. Đang chờ P2 vào phòng.')
    }
  })
  engine = game
}
function sendKeys() {
  if (!viewer() || !room) return
  const payload = { seq: ++inputSequence, keys: [...held] }
  if (relay) match('input', payload)
  else if (peer?.input?.readyState === 'open') {
    if (peer.input.bufferedAmount < 16384) peer.input.send(JSON.stringify({ type: 'keys', ...payload }))
    else pairFailed(peer, 'Kênh phím bị nghẽn')
  }
}
function releaseLocal() {
  if (!held.size) return
  held.clear()
  sendKeys()
}
function receiveKeys(message, current) {
  if (!Number.isSafeInteger(message.seq) || message.seq <= (current.lastSeq || 0) || !validKeys(message.keys)) return
  current.lastSeq = message.seq
  lastInput = performance.now()
  applyRemote(message.keys)
}
function closePeer() {
  const old = peer
  peer = null
  clearTimeout(old?.timeout)
  if (old?.videoCallback != null) video.cancelVideoFrameCallback(old.videoCallback)
  old?.pc?.close()
  old?.media?.getTracks().forEach(track => track.stop())
  video.srcObject = null
  peerRtt = null
}
function closeMedia() {
  releaseLocal()
  applyRemote([])
  closePeer()
  relay?.stop?.()
  relay = null
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  view()
  networkInfo()
}
function saved(value) {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem('bvn-seat'))
    if (value === null) sessionStorage.removeItem('bvn-seat')
    else sessionStorage.setItem('bvn-seat', JSON.stringify(value))
  } catch { /* Storage may be unavailable in privacy mode. */ }
}
function exitRoom(message, tone) {
  clearTimeout(reconnectTimer)
  reconnectUntil = 0
  closeMedia()
  frameChannel?.stop()
  frameChannel = null
  role = room = engineState = null
  engine?.stop()
  engine = null
  saved(null)
  $('entry').hidden = false
  $('room').hidden = true
  $('reset').disabled = false
  $('retry-worker').hidden = true
  view()
  busy(false)
  status(message, tone)
  networkInfo()
}
function pairFailed(current, reason) {
  if (peer !== current || current.fallbackRequested) return
  current.fallbackRequested = true
  clearTimeout(current.timeout)
  applyRemote([])
  record('WebRTC → JPEG', reason)
  match('relay')
  status('Đang chuyển sang truyền hình dự phòng…')
}
function pairReady(current) {
  if (peer !== current || current.input?.readyState !== 'open' ||
      current.pc.connectionState !== 'connected') return
  clearTimeout(current.timeout)
  if (!current.connected) {
    current.connected = true
    status('Đã kết nối WebRTC. P1 chọn Đấu đơn → Đấu 1v1.', 'ok')
    if (!viewer()) capVideo(current.sender, profile() === 'smooth').catch(error => record('giới hạn video', error.name))
  }
  networkInfo()
}
function wireInput(current, input) {
  current.input = input
  input.onopen = () => pairReady(current)
  input.onclose = () => pairFailed(current, 'Kênh phím đã ngắt')
  input.onmessage = ({ data }) => {
    if (peer !== current || typeof data !== 'string' || data.length > 220) return
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg?.type === 'ping' && Number.isFinite(msg.t) && input.readyState === 'open') {
      if (input.bufferedAmount < 4096) input.send(JSON.stringify({ type: 'pong', t: msg.t }))
    } else if (msg?.type === 'pong' && Number.isFinite(msg.t) && performance.now() - msg.t < 60000) {
      peerRtt = Math.max(0, performance.now() - msg.t)
      networkInfo()
    } else if (!viewer() && msg?.type === 'keys') receiveKeys(msg, current)
  }
}
function startDeadline(current, ms = 25000) {
  clearTimeout(current.timeout)
  current.timeout = setTimeout(() => pairFailed(current, 'Hết thời gian chờ WebRTC'), ms)
}
async function startPair({ round, iceServers }) {
  closeMedia()
  room.round = round
  inputSequence = 0
  const current = { round, candidates: [], messages: Promise.resolve() }
  peer = current
  $('retry-worker').hidden = true
  status(central() ? 'Đang chờ máy chạy trận và kết nối hình ảnh…' : 'Đang kết nối hình ảnh và điều khiển…')
  networkInfo()
  try {
    const pc = new RTCPeerConnection({ iceServers })
    current.pc = pc
    pc.onicecandidate = ({ candidate }) => {
      if (peer === current && candidate) match('signal', { candidate: candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (peer !== current) return
      if (pc.connectionState === 'failed') pairFailed(current, 'ICE thất bại')
      if (pc.connectionState === 'disconnected') {
        releaseLocal()
        applyRemote([])
        current.connected = false
        status('Kết nối gián đoạn. Đang chờ WebRTC khôi phục…')
        startDeadline(current, 8000)
      }
      pairReady(current)
      networkInfo()
    }
    if (viewer()) {
      startDeadline(current, 60000)
      pc.ondatachannel = ({ channel }) => wireInput(current, channel)
      pc.ontrack = ({ streams }) => {
        if (peer !== current) return
        video.srcObject = streams[0]
        current.presented = 0
        const countFrame = () => {
          if (peer !== current) return
          current.presented++
          current.videoCallback = video.requestVideoFrameCallback(countFrame)
        }
        if (video.requestVideoFrameCallback) current.videoCallback = video.requestVideoFrameCallback(countFrame)
        video.play().catch(() => { if (peer === current) status('Bấm vào khung game để phát hình.') })
      }
      return
    }
    const source = await engine.ready
    if (peer !== current) return
    current.media = source.captureStream(30)
    current.sender = pc.addTrack(current.media.getVideoTracks()[0], current.media)
    wireInput(current, pc.createDataChannel('controls'))
    await pc.setLocalDescription(await pc.createOffer())
    if (peer !== current) return
    match('signal', { description: pc.localDescription })
    startDeadline(current)
  } catch (error) {
    pairFailed(current, error.message)
  }
}
function receiveSignal(message) {
  const current = peer
  if (!current?.pc || current.round !== message.round) return
  const { pc } = current
  current.messages = current.messages.then(async () => {
    if (peer !== current) return
    if (message.description) {
      await pc.setRemoteDescription(message.description)
      for (const candidate of current.candidates.splice(0)) await pc.addIceCandidate(candidate)
      if (message.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer())
        if (peer !== current) return
        match('signal', { description: pc.localDescription })
        startDeadline(current)
      }
    } else if (message.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(message.candidate)
      else if (current.candidates.length < 64) current.candidates.push(message.candidate)
    }
  }).catch(error => pairFailed(current, error.message))
}
async function startRelay(round) {
  if (room?.round !== round || relay?.round === round) return
  closeMedia()
  const current = { round, since: performance.now(), sent: 0, received: 0 }
  relay = current
  view()
  networkInfo()
  status('Đang dùng hình JPEG qua Render.', 'ok')
  if (viewer()) return
  try {
    const source = await engine.ready
    if (relay !== current) return
    current.stop = streamJpeg(source, round, () => frameChannel, profile, (width, height, elapsed) => {
      current.sent++
      Object.assign(current, { width, height, encodeMs: elapsed })
    })
  } catch (error) {
    if (relay === current) status(error.message, 'error')
  }
}
async function paintFrame(round, blob) {
  const current = relay
  if (!viewer() || !current || current.round !== round) return
  current.next = blob
  if (current.drawing) return
  current.drawing = true
  while (relay === current && current.next) {
    const frame = current.next
    current.next = null
    try {
      const image = await createImageBitmap(frame)
      if (relay === current) {
        if (canvas.width !== image.width || canvas.height !== image.height) {
          canvas.width = image.width
          canvas.height = image.height
        }
        canvas.getContext('2d').drawImage(image, 0, 0)
        current.received++
        current.lastFrame = performance.now()
      }
      image.close()
    } catch (error) { record('giải mã JPEG', error.name) }
  }
  current.drawing = false
}
function receive({ data }) {
  let message
  try { message = JSON.parse(data) } catch { return }
  if (!message || typeof message !== 'object') return
  const { round } = message
  if (round != null && room && round < room.round) return
  switch (message.type) {
    case 'pong':
      if (Number.isFinite(message.t)) serverRtt = performance.now() - message.t
      return networkInfo()
    case 'room': {
      clearTimeout(reconnectTimer)
      reconnectUntil = 0
      const same = room?.id === message.id && role === message.role
      room = { id: message.id, round, mode: message.mode }
      role = message.role
      saved({ type: 'resume', id: message.id, token: message.resume })
      frameChannel?.stop()
      frameChannel = frameLink(message.frames, paintFrame, ready => record('WebSocket hình', ready ? 'sẵn sàng' : 'gián đoạn'))
      $('entry').hidden = true
      $('room').hidden = false
      $('role').textContent = role === 'host' ? 'P1 · CHỦ PHÒNG' : 'P2 · KHÁCH'
      $('room-code').textContent = message.id
      $('profile-row').hidden = viewer()
      busy(false)
      view()
      if (!viewer() && (!same || !engine)) {
        status('Đang mở game. Gửi ID Room cho bạn của bạn.')
        launchEngine()
      } else status('Đang chờ hai ghế và kết nối trận.')
      return networkInfo()
    }
    case 'paired': return startPair(message)
    case 'signal': return receiveSignal(message)
    case 'relay': return startRelay(round)
    case 'input':
      if (!viewer() && relay?.round === round) receiveKeys(message, relay)
      return
    case 'engine-status':
      if (room?.round === round && viewer()) reportEngine(message.state)
      return
    case 'reset':
      room.round = round
      closeMedia()
      $('reset').disabled = false
      engineState = undefined
      status('Đang khởi động lại trận với cùng ID Room.')
      if (!viewer()) launchEngine()
      return
    case 'interrupted':
    case 'vacant':
      closeMedia()
      status(message.type === 'vacant' ? 'P2 đã rời phòng. Có thể gửi lại cùng mã.' :
        'Một người mất kết nối. Ghế được giữ tối đa 45 giây.')
      return
    case 'worker-unavailable':
      room.round = round
      closeMedia()
      $('retry-worker').hidden = false
      status('Máy chạy trận chưa sẵn sàng. Hãy thử lại khi worker đã kết nối.', 'error')
      return
    case 'closed': return exitRoom('P1 đã đóng phòng.', 'error')
    case 'error':
      if (reconnectUntil > Date.now()) {
        if (message.message.includes('chưa sẵn sàng')) return retry()
        return exitRoom(message.message, 'error')
      }
      busy(false)
      status(message.message, 'error')
  }
}
function retry() {
  clearTimeout(reconnectTimer)
  const seat = saved()
  if (!seat || Date.now() >= reconnectUntil) return exitRoom('Mất kết nối phòng. Hãy tạo hoặc vào phòng lại.', 'error')
  reconnectTimer = setTimeout(() => request(seat), 1000)
}
function request(message) {
  if (pending && message.type !== 'resume') return
  busy(true)
  if (socket?.readyState === WebSocket.OPEN) return send(message)
  if (socket?.readyState === WebSocket.CONNECTING) return
  status(message.type === 'resume' ? 'Đang kết nối lại đúng ghế…' : 'Đang kết nối máy chủ phòng…')
  const connection = socketFor('/rooms')
  socket = connection
  connection.onmessage = event => { if (connection === socket) receive(event) }
  connection.onopen = () => {
    if (connection !== socket) return
    send(message)
    const ping = () => send({ type: 'ping', t: performance.now() })
    ping()
    signalPing = setInterval(ping, 3000)
  }
  connection.onclose = () => {
    if (connection !== socket) return
    clearInterval(signalPing)
    serverRtt = socket = null
    closeMedia()
    frameChannel?.stop()
    if (room && !reconnectUntil) reconnectUntil = Date.now() + 43000
    retry()
  }
}

$('create').onclick = () => request({ type: 'create', mode: $('room-mode').value })
$('join').onsubmit = event => {
  event.preventDefault()
  request({ type: 'join', id: $('room-input').value.trim().toUpperCase() })
}
$('leave').onclick = () => {
  send({ type: 'leave' })
  exitRoom('Đã rời phòng.')
}
$('reset').onclick = () => {
  if (socket?.readyState !== WebSocket.OPEN || !room) return
  const last = room.round
  if (!confirm('Khởi động lại game cho cả phòng? Trận hiện tại sẽ bắt đầu lại từ menu.')) return
  if (room?.round !== last) return
  $('reset').disabled = true
  match('reset', { round: last })
  setTimeout(() => { if (room?.round === last) $('reset').disabled = false }, 2500)
}
$('retry-worker').onclick = () => match('retry')
$('repair').onclick = () => match('repair')
$('mute-game').onchange = () => engine?.mute($('mute-game').checked)
$('profile').onchange = () => {
  if (peer?.sender) capVideo(peer.sender, profile() === 'smooth').catch(error => record('giới hạn video', error.name))
}
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('room-code').textContent)
    $('copy').textContent = 'Đã sao chép'
    setTimeout(() => { $('copy').textContent = 'Sao chép ID' }, 1400)
  } catch { status('Hãy bôi đen và sao chép ID Room.') }
}
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await $('screen').requestFullscreen()
  } catch { status('Trình duyệt chưa mở được toàn màn hình.') }
}
video.onclick = () => { video.play().catch(() => {}) }
$('download-log').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'bvn-debug.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function keyEvent(event) {
  if (!role || !viewer() || !Object.hasOwn(p2Keys, event.code) ||
      event.ctrlKey || event.metaKey || event.altKey ||
      event.target.closest?.('input, select, button, summary, textarea, [contenteditable]')) return
  if (!relay && peer?.input?.readyState !== 'open') return
  event.preventDefault()
  if (event.type === 'keydown') {
    if (held.has(event.code)) return
    held.add(event.code)
  } else if (!held.delete(event.code)) return
  sendKeys()
}
window.addEventListener('keydown', keyEvent, true)
window.addEventListener('keyup', keyEvent, true)
window.addEventListener('blur', releaseLocal)
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseLocal() })
window.addEventListener('pagehide', () => { releaseLocal(); socket?.close() })
window.addEventListener('error', event => record('lỗi JavaScript', event.message))
window.addEventListener('unhandledrejection', event => record('promise lỗi', event.reason?.message))

setInterval(() => {
  if (role && viewer() && held.size) sendKeys()
  if (performance.now() - lastInput > 1000) applyRemote([])
}, 250)
let statsAt = performance.now()
setInterval(async () => {
  const now = performance.now()
  const elapsed = (now - statsAt) / 1000
  statsAt = now
  if (!role) return
  const current = peer
  let metrics = 'Chưa đo được FPS hoặc độ phân giải của luồng.'
  if (relay) {
    const { sent, received, lastFrame, since, width, height, encodeMs } = relay
    if (viewer()) {
      const stalled = now - (lastFrame || since) > 4000
      metrics = stalled ? 'Luồng JPEG chưa có khung mới. Đang thử nhận lại.' :
        `Hiển thị ${(received / elapsed).toFixed(1)} FPS · ${canvas.width} × ${canvas.height}`
    } else if (width) metrics = `Gửi ${(sent / elapsed).toFixed(1)} FPS · ${width} × ${height} · mã hoá ${Math.round(encodeMs)} ms/khung gần nhất`
    relay.sent = relay.received = 0
  } else if (current?.pc?.connectionState === 'connected') {
    if (current.input?.readyState === 'open' && current.input.bufferedAmount < 4096) {
      current.input.send(JSON.stringify({ type: 'ping', t: now }))
    }
    try {
      const stats = await current.pc.getStats()
      if (peer !== current) return
      for (const stat of stats.values()) {
        if (stat.kind !== 'video' || stat.type !== (viewer() ? 'inbound-rtp' : 'outbound-rtp')) continue
        const count = viewer() ? stat.framesDecoded : stat.framesEncoded
        const fps = stat.framesPerSecond ?? ((count ?? 0) - (current.frames ?? count ?? 0)) / elapsed
        if (stat.frameWidth) metrics = `${viewer() ? 'Giải mã' : 'Mã hoá'} ${fps.toFixed(1)} FPS · ${stat.frameWidth} × ${stat.frameHeight}`
        if (viewer() && count === current.frames && !document.hidden) {
          current.stalled = (current.stalled || 0) + elapsed
          if (current.stalled > 9) {
            metrics += ' · Chưa nhận thêm khung. Có thể thử kết nối lại hình.'
            if (!count) pairFailed(current, 'Video WebRTC chưa giải mã khung đầu tiên')
          }
        } else current.stalled = 0
        if (viewer() && current.presented != null) {
          metrics += ` · Hiển thị ${(current.presented / elapsed).toFixed(1)} FPS`
          current.presented = 0
        }
        current.frames = count
      }
    } catch (error) { record('thống kê WebRTC', error.name) }
  }
  $('stream-stats').textContent = metrics
  if ($('debug').open) record('số liệu luồng', metrics)
}, 2000)
if (saved()) {
  reconnectUntil = Date.now() + 6000
  request(saved())
}
