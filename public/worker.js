import { validKeys } from './engine.js'
import { capVideo, frameLink, socketFor, streamJpeg } from './media.js'

const $ = id => document.getElementById(id)
const seats = ['host', 'guest']
let socket, frameChannel, room, media, jpeg, capture
const peers = new Map()
const fallback = new Set()
const preview = $('worker-video')
let nativeSequence = 0
const apply = (seat, keys) => send('native-keys', { seat, keys, seq: ++nativeSequence })
const status = text => { $('worker-status').textContent = text }
function send(type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, round: room?.round, ...payload }))
}
function drop(seat) {
  const peer = peers.get(seat)
  if (peer) {
    peers.delete(seat)
    clearTimeout(peer.timeout)
    peer.pc?.close()
  }
  apply(seat, [])
  if (media && !Array.from(peers.values()).some(peer => peer.pc)) {
    media.getTracks().forEach(track => track.stop())
    media = null
  }
  fallback.delete(seat)
  if (!fallback.size) {
    jpeg?.()
    jpeg = null
  }
}
function closeTransport() {
  for (const seat of seats) drop(seat)
  media?.getTracks().forEach(track => track.stop())
  media = null
}
function stopGame() {
  closeTransport()
  room = null
}
function keys(peer, message) {
  if (!Number.isSafeInteger(message.seq) || message.seq <= peer.seq || !validKeys(message.keys)) return
  peer.seq = message.seq
  peer.lastInput = performance.now()
  apply(peer.seat, message.keys)
}
function fail(peer) {
  if (peers.get(peer.seat) !== peer || peer.failed) return
  peer.failed = true
  clearTimeout(peer.timeout)
  apply(peer.seat, [])
  send('relay', { seat: peer.seat })
}
async function relay(seat) {
  if (fallback.has(seat) || !room || !capture) return
  drop(seat)
  const current = room
  fallback.add(seat)
  peers.set(seat, { seat, seq: 0, lastInput: 0 })
  try {
    const canvas = preview
    if (room !== current || !fallback.size || jpeg) return
    jpeg = streamJpeg(canvas, current.round, () => frameChannel, () => 'balanced', () => {})
  } catch { /* Engine errors are sent by startGame. */ }
}
function newPeer(seat, iceServers) {
  const peer = { seat, candidates: [], messages: Promise.resolve(), seq: 0, lastInput: 0 }
  peers.set(seat, peer)
  try {
    const pc = new RTCPeerConnection({ iceServers })
    peer.pc = pc
    const input = pc.createDataChannel('controls')
    peer.input = input
    const ready = () => {
      if (peers.get(seat) !== peer || pc.connectionState !== 'connected' || input.readyState !== 'open') return
      clearTimeout(peer.timeout)
      if (!peer.connected) {
        peer.connected = true
        capVideo(peer.sender, false).catch(() => {})
      }
    }
    pc.onicecandidate = ({ candidate }) => {
      if (peers.get(seat) === peer && candidate) send('signal', { seat, candidate: candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (peers.get(seat) !== peer) return
      if (pc.connectionState === 'disconnected') {
        apply(seat, [])
        clearTimeout(peer.timeout)
        peer.timeout = setTimeout(() => fail(peer), 8000)
      } else if (pc.connectionState === 'failed') fail(peer)
      ready()
    }
    input.onopen = ready
    input.onclose = () => fail(peer)
    input.onmessage = ({ data }) => {
      if (peers.get(seat) !== peer || typeof data !== 'string' || data.length > 220) return
      let message
      try { message = JSON.parse(data) } catch { return }
      if (message?.type === 'keys') keys(peer, message)
      if (message?.type === 'ping' && Number.isFinite(message.t) && input.bufferedAmount < 4096) {
        input.send(JSON.stringify({ type: 'pong', t: message.t }))
      }
    }
  } catch { fail(peer) }
  return peer
}
async function offer(peer, current) {
  if (room !== current || peers.get(peer.seat) !== peer || !peer.pc) return
  try {
    media ??= new MediaStream(capture.getVideoTracks().map(track => track.clone()))
    const pc = peer.pc
    peer.sender = pc.addTrack(media.getVideoTracks()[0], media)
    await pc.setLocalDescription(await pc.createOffer())
    if (room !== current || peers.get(peer.seat) !== peer) return
    send('signal', { seat: peer.seat, description: pc.localDescription })
    peer.timeout = setTimeout(() => fail(peer), 25000)
  } catch { fail(peer) }
}
async function start(message) {
  if (message.id !== room?.id || message.restart) stopGame()
  else closeTransport()
  room = { id: message.id, round: message.round }
  const current = room
  status('Đang chạy phòng ' + room.id + '.')
  const targets = seats.map(seat => newPeer(seat, message.iceServers))
  try {
    if (!capture?.active || !preview.videoWidth) throw new Error('Mất luồng cửa sổ game')
    send('engine-status', { state: 'running' })
    await Promise.all(targets.map(peer => offer(peer, current)))
  } catch {
    if (room === current) for (const peer of targets) fail(peer)
  }
}
function signal(msg) {
  const peer = peers.get(msg.seat)
  if (!peer?.pc) return
  peer.messages = peer.messages.then(async () => {
    if (peers.get(msg.seat) !== peer) return
    if (msg.description) {
      await peer.pc.setRemoteDescription(msg.description)
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate)
    } else if (msg.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.candidate)
      else if (peer.candidates.length < 64) peer.candidates.push(msg.candidate)
    }
  }).catch(() => fail(peer))
}
function receive({ data }) {
  let msg
  try { msg = JSON.parse(data) } catch { return }
  if (msg.type === 'worker-registered') {
    frameChannel?.stop()
    frameChannel = frameLink(msg.frames, () => {})
    return status('Đã kết nối. Đang chờ phòng.')
  }
  if (msg.type === 'worker-start') return start(msg)
  if (msg.type === 'worker-stop' && msg.id === room?.id) {
    stopGame()
    return status('Đã đóng trận. Đang chờ phòng.')
  }
  if (!room || msg.round !== room.round || !seats.includes(msg.seat)) return
  if (msg.type === 'signal') signal(msg)
  if (msg.type === 'relay') relay(msg.seat)
  if (msg.type === 'worker-drop') drop(msg.seat)
  if (msg.type === 'input' && fallback.has(msg.seat)) keys(peers.get(msg.seat), msg)
}
function disconnect() {
  socket?.close()
  socket = null
  stopGame()
  frameChannel?.stop()
  frameChannel = null
  const stopped = capture
  capture = null
  preview.srcObject = null
  stopped?.getTracks().forEach(track => track.stop())
  status('Đã ngắt kết nối.')
}
$('worker-connect').onsubmit = async event => {
  event.preventDefault()
  disconnect()
  let token = $('worker-token').value
  $('worker-token').value = ''
  try {
    capture = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'window', frameRate: { ideal: 30, max: 30 } },
      audio: false, monitorTypeSurfaces: 'exclude', selfBrowserSurface: 'exclude',
    })
    const [track] = capture.getVideoTracks()
    const surface = track.getSettings().displaySurface
    if (surface !== 'window') throw new Error('Hãy chọn đúng cửa sổ game, không chia sẻ toàn màn hình.')
    track.addEventListener('ended', disconnect, { once: true })
    preview.srcObject = capture
    await preview.play()
  } catch (error) {
    disconnect()
    return status('Chưa chia sẻ được cửa sổ game. ' + error.message)
  }
  status('Đang xác thực máy chạy game…')
  const connection = socketFor('/rooms')
  socket = connection
  connection.onopen = () => {
    if (connection === socket) send('worker-register', { token })
    token = ''
  }
  connection.onmessage = event => { if (connection === socket) receive(event) }
  connection.onclose = event => {
    token = ''
    if (connection !== socket) return
    disconnect()
    status(event.code === 1008 ? 'Không thể đăng ký. Kiểm tra khóa và worker khác đang kết nối.' :
      'Mất kết nối. Hãy kết nối lại worker.')
  }
}
$('worker-stop').onclick = disconnect
window.addEventListener('pagehide', disconnect)
setInterval(() => {
  for (const [seat, peer] of peers) if (performance.now() - peer.lastInput > 1000) apply(seat, [])
}, 250)
