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
  if (relay) clearInterval(relay.timer)
  relay = null
  const screen = $('relay-screen')
  screen.getContext('2d').clearRect(0, 0, screen.width, screen.height)
  screen.hidden = true
  if (peer) {
    const old = peer
    peer = null
    clearTimeout(old.timeout)
    old.pc?.close()
    old.media?.getTracks().forEach(track => track.stop())
  }
  $('remote').srcObject = null
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
  if (relay) send({ type: 'input', round: relay.round, keys: [...held] })
  else if (peer?.input?.readyState === 'open') peer.input.send(JSON.stringify([...held]))
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
  status(role === 'host' ? 'P2 đã kết nối. Bấm vào game rồi chọn Đấu đơn → Đấu 1v1.' :
    'Đã kết nối. Chờ P1 chọn Đấu đơn → Đấu 1v1 rồi dùng bộ phím ở dưới.', 'ok')
}
function wireInput(current, input) {
  current.input = input
  input.onopen = () => updatePair(current)
  input.onclose = () => {
    if (peer !== current) return
    applyRemote([])
    held.clear()
    pairFailed(current, new Error('Kênh điều khiển đã ngắt'))
  }
  if (role === 'host') input.onmessage = ({ data }) => {
    if (peer !== current || typeof data !== 'string' || data.length > 160) return
    let keys
    try { keys = JSON.parse(data) } catch { return }
    if (Array.isArray(keys) && keys.length <= 10) applyRemote(keys)
  }
}
function pairFailed(current, error) {
  if (peer !== current) return
  console.info(error.message)
  if (role === 'host') send({ type: 'relay', round: current.round })
  status('Đang chuyển sang kết nối qua máy chủ…')
}
function sendSignal(current, payload) {
  if (peer === current) send({ type: 'signal', round: current.round, ...payload })
}
async function startPair({ round, iceServers }) {
  closePeer()
  status('Đang kết nối hình ảnh và điều khiển…')
  const current = { round, candidates: [], messages: Promise.resolve() }
  peer = current
  let pc
  try {
    pc = new RTCPeerConnection({ iceServers })
    current.pc = pc
  } catch (error) {
    pairFailed(current, error)
    return
  }
  if (role === 'host') {
    current.timeout = setTimeout(() => pairFailed(current, new Error('Hết thời gian kết nối trực tiếp')), 8000)
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
      current.timeout = setTimeout(() => pairFailed(current, new Error('Mất kết nối WebRTC')), 4000)
    }
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
    current.media = canvas.captureStream(60)
    for (const track of current.media.getTracks()) pc.addTrack(track, current.media)
    wireInput(current, pc.createDataChannel('p2-controls'))
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendSignal(current, { description: pc.localDescription })
  } catch (error) {
    pairFailed(current, error)
  }
}

async function startRelay(round) {
  if (peer?.round !== round) return
  closePeer()
  const current = { round, working: false }
  relay = current
  if (role === 'guest') {
    $('remote').hidden = true
    $('relay-screen').hidden = false
  } else {
    const source = await enginePromise
    if (relay !== current) return
    const frame = document.createElement('canvas')
    const context = frame.getContext('2d', { alpha: false })
    current.timer = setInterval(() => {
      if (current.working || !source.width || !source.height ||
          socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) return
      const scale = Math.min(1, 800 / source.width, 600 / source.height)
      const width = Math.max(1, Math.round(source.width * scale))
      const height = Math.max(1, Math.round(source.height * scale))
      if (frame.width !== width || frame.height !== height) {
        frame.width = width
        frame.height = height
      }
      context.drawImage(source, 0, 0, width, height)
      current.working = true
      frame.toBlob(blob => {
        current.working = false
        if (relay === current && blob && blob.size <= 256 * 1024 &&
            socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024) socket.send(blob)
      }, 'image/jpeg', 0.56)
    }, 50)
  }
  status(role === 'host' ? 'P2 đã kết nối qua máy chủ. Bấm vào game rồi chọn Đấu đơn → Đấu 1v1.' :
    'Đã kết nối qua máy chủ. Chờ P1 chọn Đấu đơn → Đấu 1v1.', 'ok')
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
  const message = JSON.parse(data)
  switch (message.type) {
    case 'room': {
      role = message.role
      $('entry').hidden = true
      $('room').hidden = false
      $('role').textContent = role === 'host' ? 'P1 · CHỦ PHÒNG' : 'P2 · KHÁCH'
      $('room-code').textContent = message.id
      busy(false)
      view(role)
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
  connection.onopen = () => send(message)
  connection.onclose = () => {
    if (connection !== socket) return
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
