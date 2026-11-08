const $ = id => document.getElementById(id)
const guestKeys = {
  KeyW: ['ArrowUp', 'ArrowUp', 38], KeyA: ['ArrowLeft', 'ArrowLeft', 37],
  KeyS: ['ArrowDown', 'ArrowDown', 40], KeyD: ['ArrowRight', 'ArrowRight', 39],
  KeyJ: ['Numpad1', '1', 97], KeyK: ['Numpad2', '2', 98], KeyL: ['Numpad3', '3', 99],
  KeyU: ['Numpad4', '4', 100], KeyI: ['Numpad5', '5', 101], KeyO: ['Numpad6', '6', 102],
}
const held = new Set()
const remoteHeld = new Set()
let socket, role, player, enginePromise, rufflePromise, peer, pending = false
let relay = null
let engineLaunch = 0
let serverRtt = null
let peerRtt = null
let signalPingTimer = null
let inputSequence = 0

// Video is streamed from P1's Ruffle canvas; the game simulation itself runs only on P1.
// Prefer WebRTC. JPEG relay is a bandwidth-conscious last resort on Render Free.
const DIRECT_TIMEOUT_MS = 25000
const SIGNAL_PING_MS = 3000
const INPUT_RESYNC_MS = 250

function networkInfo() {
  const panel = $('network-info')
  if (!role || (!peer && !relay)) {
    panel.hidden = true
    return
  }
  panel.hidden = false
  const direct = Boolean(peer?.input?.readyState === 'open' &&
    peer?.pc?.connectionState === 'connected')
  const mode = relay ? 'Dự phòng qua Render' : direct ? 'WebRTC trực tiếp' : 'Đang thiết lập…'
  $('network-mode').textContent = mode
  const rtt = relay ? serverRtt : direct ? peerRtt : null
  $('network-ping').textContent = rtt == null ? 'Đang đo' : `${Math.round(rtt)} ms`
  $('network-info').dataset.mode = relay ? 'relay' : direct ? 'direct' : 'connecting'
}

function startSignalPing(connection) {
  clearInterval(signalPingTimer)
  serverRtt = null
  signalPingTimer = setInterval(() => {
    if (socket === connection && connection.readyState === WebSocket.OPEN) {
      send({ type: 'ping', t: performance.now() })
    }
  }, SIGNAL_PING_MS)
  if (connection.readyState === WebSocket.OPEN) send({ type: 'ping', t: performance.now() })
}

// Periodic snapshots repair rare lost/out-of-order input messages on the fast DataChannel.
// They also prevent stuck keys after a short connection disturbance.
setInterval(() => {
  if (role === 'guest') sendKeys()
}, INPUT_RESYNC_MS)

function status(message, tone = '') {
  $('status').textContent = message
  $('status').dataset.tone = tone
}
function busy(value) {
  pending = value
  $('create').disabled = value
  $('join').querySelector('button').disabled = value
}
function view(next) {
  $('placeholder').hidden = Boolean(next)
  $('engine').hidden = next !== 'host'
  $('remote').hidden = next !== 'guest'
}
function scriptRuffle() {
  if (window.RufflePlayer?.newest) return Promise.resolve()
  return rufflePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/ruffle/ruffle.js'
    script.onload = resolve
    script.onerror = () => {
      script.remove()
      rufflePromise = null
      reject(new Error('Chưa tải được Ruffle. Trên máy chủ, hãy chạy npm run setup.'))
    }
    document.head.append(script)
  })
}

async function startEngine() {
  const launch = ++engineLaunch
  await scriptRuffle()
  if (role !== 'host' || launch !== engineLaunch) return
  const instance = window.RufflePlayer.newest().createPlayer()
  player = instance
  instance.config = {
    autoplay: 'on', unmuteOverlay: 'hidden', splashScreen: false,
    preferredRenderer: 'canvas', allowScriptAccess: false,
    backgroundExecutionMode: 'mainThread',
    fontSources: ['/fonts/DejaVuSans.ttf', '/fonts/DejaVuSans-Bold.ttf'],
    defaultFonts: { sans: ['DejaVu Sans'] },
  }
  $('engine').replaceChildren(instance)
  await instance.ruffle().load({ url: '/game.swf' })
  for (let step = 0; step < 100 && instance === player; step++) {
    const canvas = instance.shadowRoot?.querySelector('canvas')
    if (canvas) return canvas
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (instance === player) throw new Error('Ruffle chưa mở được màn hình game.')
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
function closePeer() {
  releaseLocal()
  applyRemote([])
  if (relay) clearTimeout(relay.timer)
  relay = null
  peerRtt = null
  const screen = $('relay-screen')
  screen.getContext('2d').clearRect(0, 0, screen.width, screen.height)
  screen.hidden = true
  if (peer) {
    const old = peer
    peer = null
    clearTimeout(old.timeout)
    clearInterval(old.pingTimer)
    old.pc?.close()
    old.media?.getTracks().forEach(track => track.stop())
  }
  $('remote').srcObject = null
  networkInfo()
}
function exitRoom(message, tone) {
  closePeer()
  role = null
  player = null
  engineLaunch += 1
  enginePromise = null
  $('engine').replaceChildren()
  $('entry').hidden = false
  $('room').hidden = true
  view(null)
  busy(false)
  status(message, tone)
  networkInfo()
}

function changeGameKey(code, down) {
  const [flashCode, key, keyCode] = guestKeys[code]
  const canvas = player?.shadowRoot?.querySelector('canvas')
  if (!canvas) return
  const event = new KeyboardEvent(down ? 'keydown' : 'keyup', {
    code: flashCode, key, location: flashCode.startsWith('Numpad') ? 3 : 0,
    bubbles: true, cancelable: true, composed: true,
  })
  Object.defineProperties(event, { keyCode: { value: keyCode }, which: { value: keyCode } })
  canvas.dispatchEvent(event)
}
function applyRemote(keys) {
  const next = new Set(keys.filter(key => Object.hasOwn(guestKeys, key)))
  for (const key of remoteHeld) if (!next.has(key)) changeGameKey(key, false)
  for (const key of next) if (!remoteHeld.has(key)) changeGameKey(key, true)
  remoteHeld.clear()
  next.forEach(key => remoteHeld.add(key))
}
function sendKeys() {
  if (relay) {
    send({ type: 'input', round: relay.round, keys: [...held] })
  } else if (peer?.input?.readyState === 'open' && peer.input.bufferedAmount < 4096) {
    // Unreliable/unordered DataChannel: snapshots + a sequence number ensure the
    // newest input wins, instead of being delayed behind retransmissions.
    peer.input.send(JSON.stringify({ type: 'keys', seq: ++inputSequence, keys: [...held] }))
  }
}
function releaseLocal() {
  if (!held.size) return
  held.clear()
  sendKeys()
}

function updatePair(current) {
  if (peer !== current || current.input?.readyState !== 'open' ||
      current.pc.connectionState !== 'connected') return
  clearTimeout(current.timeout)
  current.timeout = null
  status(role === 'host' ? 'P2 đã kết nối trực tiếp. Bấm vào game rồi chọn Đấu đơn → Đấu 1v1.' :
    'Đã kết nối trực tiếp. Chờ P1 chọn Đấu đơn → Đấu 1v1 rồi dùng bộ phím ở dưới.', 'ok')
  networkInfo()
}
function wireInput(current, input) {
  current.input = input
  input.onopen = () => {
    updatePair(current)
    current.pingTimer = setInterval(() => {
      if (peer === current && input.readyState === 'open' && input.bufferedAmount < 4096) {
        input.send(JSON.stringify({ type: 'ping', t: performance.now() }))
      }
    }, SIGNAL_PING_MS)
  }
  input.onclose = () => {
    if (peer !== current) return
    applyRemote([])
    held.clear()
    pairFailed(current, new Error('Kênh điều khiển đã ngắt'))
  }
  input.onmessage = ({ data }) => {
    if (peer !== current || typeof data !== 'string' || data.length > 180) return
    let message
    try { message = JSON.parse(data) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.type === 'ping' && Number.isFinite(message.t) && input.readyState === 'open') {
      if (input.bufferedAmount < 4096) input.send(JSON.stringify({ type: 'pong', t: message.t }))
      return
    }
    if (message.type === 'pong' && Number.isFinite(message.t)) {
      const elapsed = performance.now() - message.t
      if (elapsed >= 0 && elapsed < 60000) {
        peerRtt = elapsed
        networkInfo()
      }
      return
    }
    if (role !== 'host' || message.type !== 'keys' || !Number.isSafeInteger(message.seq) ||
        message.seq <= (current.lastSeq || 0) || !Array.isArray(message.keys) ||
        message.keys.length > 10 || !message.keys.every(key => Object.hasOwn(guestKeys, key))) return
    current.lastSeq = message.seq
    applyRemote(message.keys)
  }
}
function pairFailed(current, error) {
  if (peer !== current || current.fallbackRequested) return
  current.fallbackRequested = true
  clearTimeout(current.timeout)
  console.info('WebRTC unavailable:', error.message)
  // Either side can request relay; otherwise P2 could wait forever if P1
  // established ICE but P2's media/data channel did not come up.
  send({ type: 'relay', round: current.round })
  status('Đang chuyển sang kết nối dự phòng qua Render…')
  networkInfo()
}
function sendSignal(current, payload) {
  if (peer === current) send({ type: 'signal', round: current.round, ...payload })
}
async function startPair({ round, iceServers }) {
  closePeer()
  status('Đang kết nối hình ảnh và điều khiển…')
  const current = { round, candidates: [], messages: Promise.resolve(), lastSeq: 0 }
  peer = current
  inputSequence = 0
  peerRtt = null
  networkInfo()
  let pc
  try {
    pc = new RTCPeerConnection({ iceServers })
    current.pc = pc
  } catch (error) {
    pairFailed(current, error)
    return
  }
  // The original 8s limit caused premature JPEG relay while Ruffle was loading.
  // Both peers now have a timeout; the offer gets its own timer after loading.
  if (role === 'guest') {
    current.timeout = setTimeout(() => pairFailed(current, new Error('Hết thời gian chờ WebRTC')), DIRECT_TIMEOUT_MS + 10000)
  }
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(current, { candidate: candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => {
    if (peer !== current) return
    if (pc.connectionState === 'failed') pairFailed(current, new Error('WebRTC kết nối thất bại'))
    if (pc.connectionState === 'disconnected') {
      releaseLocal()
      applyRemote([])
      status('Kết nối gián đoạn. Đang chờ khôi phục…')
      clearTimeout(current.timeout)
      current.timeout = setTimeout(() => pairFailed(current, new Error('Mất kết nối WebRTC')), 8000)
    }
    if (pc.connectionState === 'connected') updatePair(current)
    networkInfo()
    updatePair(current)
  }
  if (role === 'guest') {
    pc.ondatachannel = ({ channel }) => wireInput(current, channel)
    pc.ontrack = ({ streams }) => {
      if (peer !== current) return
      $('remote').srcObject = streams[0]
      $('remote').play().catch(() => {
        if (peer === current) status('Bấm vào khung game để phát hình.')
      })
    }
    return
  }

  try {
    const canvas = await enginePromise
    if (peer !== current) return
    // 30 fps relieves CPU/GPU pressure compared with the original 60 fps.
    // The Ruffle game still updates locally at its normal speed.
    current.media = canvas.captureStream(30)
    for (const track of current.media.getTracks()) {
      const sender = pc.addTrack(track, current.media)
      if (track.kind === 'video') {
        try {
          const params = sender.getParameters()
          if (params.encodings?.length) {
            params.encodings[0].maxBitrate = 1_600_000
            params.encodings[0].maxFramerate = 30
            await sender.setParameters(params)
          }
        } catch (error) { console.info('Optional video bitrate limit unavailable:', error.message) }
      }
    }
    wireInput(current, pc.createDataChannel('p2-controls', { ordered: false, maxRetransmits: 0 }))
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendSignal(current, { description: pc.localDescription })
    current.timeout = setTimeout(() => pairFailed(current, new Error('Hết thời gian kết nối trực tiếp')), DIRECT_TIMEOUT_MS)
  } catch (error) {
    pairFailed(current, error)
  }
}

async function startRelay(round) {
  if (peer?.round !== round) return
  closePeer()
  const current = { round, working: false, delay: 65, stable: 0 }
  relay = current
  networkInfo()
  if (role === 'guest') {
    $('remote').hidden = true
    $('relay-screen').hidden = false
  } else {
    const source = await enginePromise
    if (relay !== current) return
    const frame = document.createElement('canvas')
    const context = frame.getContext('2d', { alpha: false })
    const tick = () => {
      if (relay !== current) return
      const ws = socket
      // Never build a queue of stale video frames. Input/control messages
      // should remain responsive while using the server fallback.
      if (!source?.width || !source?.height || ws?.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > 96 * 1024) {
        current.delay = Math.min(105, current.delay + 5)
        current.stable = 0
        current.timer = setTimeout(tick, current.delay)
        return
      }
      const begin = performance.now()
      const scale = Math.min(1, 640 / source.width, 480 / source.height)
      const width = Math.max(1, Math.round(source.width * scale))
      const height = Math.max(1, Math.round(source.height * scale))
      if (frame.width !== width || frame.height !== height) {
        frame.width = width
        frame.height = height
      }
      context.drawImage(source, 0, 0, width, height)
      frame.toBlob(blob => {
        if (relay !== current) return
        const slowEncode = performance.now() - begin > 55
        if (blob && blob.size < 160 * 1024 && ws === socket &&
            ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 96 * 1024) {
          ws.send(blob)
        }
        if (slowEncode || ws.bufferedAmount > 64 * 1024) {
          current.delay = Math.min(105, current.delay + 8)
          current.stable = 0
        } else if (++current.stable >= 16) {
          // Gradually return towards 20 fps when the connection is healthy.
          current.delay = Math.max(50, current.delay - 4)
          current.stable = 0
        }
        current.timer = setTimeout(tick, Math.max(8, current.delay - (performance.now() - begin)))
      }, 'image/jpeg', 0.46)
    }
    tick()
  }
  status(role === 'host' ? 'Đang dùng chế độ dự phòng qua Render. Chất lượng hình đã được tối ưu để giảm khựng.' :
    'Đang dùng chế độ dự phòng qua Render. Nếu hình còn khựng, cần kiểm tra mạng hoặc TURN.', 'ok')
  networkInfo()
}

async function paintFrame(blob) {
  const current = relay
  if (role !== 'guest' || !current || current.working) return
  current.working = true
  try {
    const image = await createImageBitmap(blob)
    if (relay === current) {
      const canvas = $('relay-screen')
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width
        canvas.height = image.height
      }
      canvas.getContext('2d').drawImage(image, 0, 0)
    }
    image.close()
  } catch {
    // The next frame can still be drawn if this frame fails to decode.
  } finally {
    current.working = false
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
        sendSignal(current, { description: pc.localDescription })
      }
    } else if (message.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(message.candidate)
      else current.candidates.push(message.candidate)
    }
  }).catch(error => pairFailed(current, error))
}

function receive({ data }) {
  if (data instanceof Blob) {
    paintFrame(data)
    return
  }
  let message
  try { message = JSON.parse(data) } catch { return }
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case 'pong': {
      if (Number.isFinite(message.t)) {
        const elapsed = performance.now() - message.t
        if (elapsed >= 0 && elapsed < 60000) {
          serverRtt = elapsed
          networkInfo()
        }
      }
      break
    }
    case 'room': {
      role = message.role
      $('entry').hidden = true
      $('room').hidden = false
      $('role').textContent = role === 'host' ? 'P1 · CHỦ PHÒNG' : 'P2 · KHÁCH'
      $('room-code').textContent = message.id
      busy(false)
      view(role)
      networkInfo()
      if (role === 'host') {
        status('Đang mở game. Gửi ID Room cho bạn của bạn.')
        enginePromise = startEngine()
        const loading = enginePromise
        loading.then(() => {
          if (role === 'host' && enginePromise === loading && !peer) {
            status('Game đã sẵn sàng. Đang chờ P2 vào phòng.')
          }
        }).catch(error => {
          if (enginePromise === loading) status(error.message, 'error')
        })
      }
      break
    }
    case 'paired':
      startPair(message).catch(error => {
        console.warn(error)
        status('Trình duyệt chưa mở được WebRTC.', 'error')
      })
      break
    case 'signal':
      receiveSignal(message)
      break
    case 'relay':
      startRelay(message.round).catch(error => status(error.message, 'error'))
      break
    case 'input':
      if (role === 'host' && relay?.round === message.round) applyRemote(message.keys)
      break
    case 'vacant':
      closePeer()
      status('P2 đã rời phòng. Bạn có thể gửi lại cùng ID Room.')
      break
    case 'closed':
      exitRoom('P1 đã đóng phòng.', 'error')
      break
    case 'error':
      busy(false)
      status(message.message, 'error')
      break
  }
}

function request(message) {
  if (pending) return
  busy(true)
  if (socket?.readyState === WebSocket.OPEN) return send(message)
  status('Đang kết nối máy chủ phòng…')
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const connection = new WebSocket(protocol + '//' + location.host + '/rooms')
  socket = connection
  connection.onmessage = receive
  connection.onopen = () => {
    send(message)
    startSignalPing(connection)
  }
  connection.onerror = () => {
    if (connection === socket) status('Lỗi kết nối máy chủ. Kiểm tra mạng và Render.', 'error')
  }
  connection.onclose = () => {
    if (connection !== socket) return
    clearInterval(signalPingTimer)
    signalPingTimer = null
    socket = null
    exitRoom('Mất kết nối máy chủ phòng. Thử tạo hoặc vào phòng lại.', 'error')
  }
}

$('create').onclick = () => request({ type: 'create' })
$('join').onsubmit = event => {
  event.preventDefault()
  request({ type: 'join', id: $('room-input').value.trim().toUpperCase() })
}
$('leave').onclick = () => {
  send({ type: 'leave' })
  exitRoom('Đã rời phòng.')
}
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('room-code').textContent)
    const button = $('copy')
    button.textContent = 'Đã sao chép'
    setTimeout(() => { button.textContent = 'Sao chép ID' }, 1400)
  } catch {
    status('Hãy bôi đen và sao chép ID Room.')
  }
}
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await $('screen').requestFullscreen()
  } catch { status('Trình duyệt chưa mở được toàn màn hình.') }
}
$('remote').onclick = () => { $('remote').play().catch(() => {}) }

function keyEvent(event) {
  if (role !== 'guest' || !Object.hasOwn(guestKeys, event.code) ||
      event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement) return
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
window.addEventListener('pagehide', () => {
  releaseLocal()
  send({ type: 'leave' })
  socket?.close()
})
