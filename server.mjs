import { createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { runNative, keys } from './native.mjs'

const gameRoot = process.argv[2] ? await realpath(resolve(process.argv[2])) : null
const centralEnabled = process.env.ENABLE_CENTRAL_GAME === '1'
const native = centralEnabled ? await runNative(gameRoot) : {
  alive: () => false,
  begin() {}, input() {}, clear() {}, stop() {},
}

const root = await realpath(fileURLToPath(new URL('./public/', import.meta.url)))
const lanAgentFile = await realpath(fileURLToPath(new URL('./lan-agent.mjs', import.meta.url)))
const packageRoot = await realpath(fileURLToPath(new URL('./build/', import.meta.url)))
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash', '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.xml': 'application/xml',
  '.ttf': 'font/ttf',
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end()
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/healthz') return res.writeHead(200).end('ok')
    if (url.pathname === '/lan-agent.mjs') {
      const info = await stat(lanAgentFile)
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': info.size, 'Content-Disposition': 'attachment; filename="lan-agent.mjs"',
        'Cache-Control': 'no-cache' })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(lanAgentFile).pipe(res)
    }
    if (url.pathname.startsWith('/downloads/')) {
      const name = decodeURIComponent(url.pathname.slice('/downloads/'.length))
      if (!['BVNxVH386-Windows.air', 'BVNxVH386-mac-arm64.zip',
        'BVNxVH386-Windows-Online.zip', 'BVNxVH386-Mac-AppleSilicon-Online.zip',
        'BVNxVH386-Ubuntu-Linux.zip'].includes(name)) {
        return res.writeHead(404).end('Không tìm thấy gói tải về.')
      }
      const file = resolve(packageRoot, name)
      const info = await stat(file)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size,
        'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'public, max-age=86400' })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(file).on('error', () => res.destroy()).pipe(res)
    }
    const gamePrefix = ['/game/', '/assets/', '/lang/'].find(prefix => url.pathname.startsWith(prefix))
    if (gamePrefix) {
      if (!gameRoot) return res.writeHead(404).end('Thiếu thư mục game.')
      const relative = decodeURIComponent(url.pathname.slice(gamePrefix.length))
      const parts = relative.split('/')
      const allowed = ['launch-web-online.swf', 'launch-mac-online.swf', 'launch.swf', 'version.json']
      const fromGameRoot = gamePrefix === '/game/' && (allowed.includes(relative) || ['assets', 'lang'].includes(parts[0]))
      const fromSubtree = gamePrefix === '/assets/' || gamePrefix === '/lang/'
      if (!relative || parts.some(part => !part || part.startsWith('.')) || !(fromGameRoot || fromSubtree)) {
        return res.writeHead(404).end('Không tìm thấy tệp')
      }
      const file = await realpath(resolve(gameRoot, gamePrefix === '/game/' ? relative : `${gamePrefix.slice(1)}${relative}`))
      if (!file.startsWith(gameRoot + sep)) return res.writeHead(404).end('Không tìm thấy tệp')
      const info = await stat(file)
      if (!info.isFile()) return res.writeHead(404).end('Không tìm thấy tệp')
      res.writeHead(200, {
        'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400',
      })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(file).on('error', () => res.destroy()).pipe(res)
    }
    const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    if (path === '/worker.html' && (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host) ||
      req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])) return res.writeHead(404).end()
    if (path.split('/').some(part => part.startsWith('.'))) return res.writeHead(404).end()
    const file = await realpath(resolve(root, '.' + path))
    if (!file.startsWith(root + sep)) return res.writeHead(404).end()
    const info = await stat(file)
    if (!info.isFile()) return res.writeHead(404).end()
    res.writeHead(200, {
      'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': path.startsWith('/ruffle/') ? 'public, max-age=86400' : 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch {
    if (!res.headersSent) res.writeHead(404).end('Không tìm thấy tệp')
  }
})

const rooms = new Map()
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const maxFrame = 256 * 1024
const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrame })
const inputCodes = new Set(keys)
const send = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const error = (socket, message) => send(socket, { type: 'error', message })
const stunUrls = (process.env.STUN_URLS ?? 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302')
  .split(',').map(s => s.trim()).filter(Boolean)
const turnUrls = (process.env.TURN_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const turnSecret = process.env.TURN_SECRET
if (turnUrls.length && !turnSecret) throw new Error('TURN_URLS yêu cầu TURN_SECRET.')
function iceServers() {
  const servers = stunUrls.length ? [{ urls: stunUrls }] : []
  if (turnUrls.length) {
    const username = `${Math.floor(Date.now() / 1000) + 14400}:${randomBytes(10).toString('hex')}`
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64')
    servers.push({ urls: turnUrls, username, credential })
  }
  return servers
}

const workerSecret = process.env.ROOM_WORKER_SECRET || randomBytes(24).toString('hex')
if (workerSecret && Buffer.byteLength(workerSecret) < 32) throw new Error('ROOM_WORKER_SECRET cần ít nhất 32 byte.')
const frameOwners = new Map()
const reconnectMs = 45000
let worker, workerRoom

server.on('upgrade', (req, socket, head) => {
  let path
  try { path = new URL(req.url, 'http://localhost').pathname } catch {}
  let sameOrigin = path === '/lan' && !req.headers.origin
  try { sameOrigin ||= new URL(req.headers.origin).host === req.headers.host } catch {}
  if (!['/rooms', '/frames', '/lan'].includes(path) || !sameOrigin || sockets.clients.size >= 250) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req.url))
})

const token = () => randomBytes(24).toString('base64url')
const online = room => [room.host.socket, room.guest?.socket].filter(Boolean)
const broadcast = (room, message) => online(room).forEach(socket => send(socket, message))
const isCentral = room => room.mode === 'central'

function frameToken(socket) {
  socket.frameToken ??= token()
  frameOwners.set(socket.frameToken, socket)
  return socket.frameToken
}
function closeFrames(socket) {
  if (!socket) return
  frameOwners.delete(socket.frameToken)
  socket.frameToken = null
  socket.frameSocket?.close()
  socket.frameSocket = null
}
function closeBridge(room, role) {
  const bridge = room?.bridgeSockets?.[role]
  if (!bridge) return
  room.bridgeSockets[role] = null
  bridge.close(1000, 'Người chơi đã rời phòng')
}
function stopWorker(room) {
  if (workerRoom !== room) return
  send(worker, { type: 'worker-stop', id: room.id })
  workerRoom = null
  native.clear()
}
function announce(room, socket, seat) {
  send(socket, { type: 'room', id: room.id, role: socket.role, mode: room.mode,
    round: room.round, resume: seat.token, frames: frameToken(socket), bridge: seat.bridgeToken })
}

function bridgeConnection(socket, url) {
  socket.alive = true
  socket.signals = 0
  socket.on('pong', () => { socket.alive = true })
  socket.on('error', () => socket.terminate())
  const id = (url.searchParams.get('id') ?? '').toUpperCase()
  const role = url.searchParams.get('seat')
  const room = rooms.get(id)
  const seat = room?.[role]
  const key = url.searchParams.get('token') ?? ''
  if (room?.mode !== 'lan' || !['host', 'guest'].includes(role) || !seat?.socket ||
      key.length < 32 || key !== seat.bridgeToken ||
      (room.bridgeSockets?.[role] && room.bridgeSockets[role].readyState === WebSocket.OPEN)) {
    socket.close(1008, 'Phòng hoặc khóa cầu nối không hợp lệ')
    return
  }
  room.bridgeSockets ??= {}
  room.bridgeSockets[role] = socket
  socket.bridgeRoom = room
  socket.bridgeRole = role
  const counterpart = () => room.bridgeSockets?.[role === 'host' ? 'guest' : 'host']
  const tellPlayers = () => broadcast(room, { type: 'bridge-status', round: room.round,
    host: room.bridgeSockets?.host?.readyState === WebSocket.OPEN,
    guest: room.bridgeSockets?.guest?.readyState === WebSocket.OPEN })
  const other = counterpart()
  if (other?.readyState === WebSocket.OPEN) {
    const relayConfig = { type: 'rtc-paired', id, round: room.round, iceServers: iceServers() }
    send(socket, relayConfig)
    send(other, { ...relayConfig, role: other.bridgeRole })
  } else send(socket, { type: 'lan-waiting', id, role })
  tellPlayers()
  socket.on('message', (data, binary) => {
    if (binary) return socket.close(1003, 'Game data must stay on the peer connection')
    if (++socket.signals > 120) return socket.close(1008, 'Signaling rate exceeded')
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg?.type === 'rtc-signal') {
      const bytes = Buffer.byteLength(JSON.stringify(msg.payload ?? {}))
      if (msg.round !== room.round || !msg.payload || bytes > 64 * 1024) {
        console.warn(`[P2P signaling] rejected room=${id} seat=${role} round=${msg.round}/${room.round} bytes=${bytes}`)
        return socket.close(1008, 'Invalid signaling message')
      }
      const target = counterpart()
      if (target?.readyState === WebSocket.OPEN) {
        console.log(`[P2P signaling] room=${id} ${role} -> ${target.bridgeRole} bytes=${bytes}`)
        return send(target, { type: 'rtc-signal', round: room.round, payload: msg.payload })
      }
      return
    }
    if (msg?.type === 'p2p-state' && msg.round === room.round &&
        ['connecting', 'connected', 'failed', 'closed'].includes(msg.state)) {
      return broadcast(room, { type: 'p2p-status', round: room.round, seat: role, state: msg.state })
    }
    socket.close(1008, 'Unsupported signaling message')
  })
  socket.once('close', () => {
    if (room.bridgeSockets?.[role] === socket) room.bridgeSockets[role] = null
    tellPlayers()
    if (counterpart()?.readyState === WebSocket.OPEN) send(counterpart(), { type: 'rtc-close' })
  })
}

function pair(room, restart = false) {
  room.relay = new Set()
  room.round += 1
  const { round } = room
  if (restart) broadcast(room, { type: 'reset', round })
  if (!room.host.socket || !room.guest?.socket) {
    if (restart) stopWorker(room)
    return
  }
  if (isCentral(room)) {
    if (!worker || (workerRoom && workerRoom !== room)) {
      broadcast(room, { type: 'worker-unavailable', round })
      return
    }
    workerRoom = room
    native.begin()
    send(worker, { type: 'worker-start', id: room.id, round, restart, iceServers: iceServers() })
    broadcast(room, { type: 'paired', round, mode: room.mode, iceServers: iceServers() })
  } else {
    broadcast(room, { type: 'paired', round, mode: room.mode, iceServers: iceServers() })
  }
}
function bind(room, socket, role, seat) {
  seat.socket = socket
  clearTimeout(seat.timer)
  socket.room = room
  socket.role = role
  announce(room, socket, seat)
}
function leave(socket, explicit) {
  const room = socket.room
  if (!room) return
  const role = socket.role
  const seat = room[role]
  socket.room = null
  closeFrames(socket)
  closeBridge(room, role)
  if (seat?.socket !== socket) return
  seat.socket = null
  room.relay = new Set()
  if (workerRoom === room) {
    native.clear(role)
    send(worker, { type: 'worker-drop', round: room.round, seat: role })
  }
  const remove = () => {
    if (seat.socket || !rooms.has(room.id)) return
    if (role === 'host') {
      rooms.delete(room.id)
      clearTimeout(room.guest?.timer)
      if (room.guest?.socket) {
        const guest = room.guest.socket
        guest.room = null
        closeFrames(guest)
        send(guest, { type: 'closed' })
      }
      stopWorker(room)
    } else {
      room.guest = null
      stopWorker(room)
      send(room.host.socket, { type: 'vacant' })
    }
  }
  if (explicit) return remove()
  broadcast(room, { type: 'interrupted', round: room.round, seat: role })
  seat.timer = setTimeout(remove, reconnectMs)
}

function signal(target, msg, extra, expected) {
  if (msg.description?.type === expected && typeof msg.description.sdp === 'string') {
    const { type, sdp } = msg.description
    send(target, { ...extra, type: 'signal', round: msg.round, description: { type, sdp } })
  } else if (typeof msg.candidate?.candidate === 'string') {
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = msg.candidate
    send(target, { ...extra, type: 'signal', round: msg.round, candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } })
  }
}
function relayTo(room, role) {
  if (room.relay.has(role)) return
  room.relay.add(role)
  send(room[role].socket, { type: 'relay', round: room.round, seat: role })
  send(isCentral(room) ? worker : room.host.socket, { type: 'relay', round: room.round, seat: role })
}
function validKeys(msg) {
  return Number.isSafeInteger(msg.seq) && msg.seq > 0 && Array.isArray(msg.keys) &&
    msg.keys.length <= keys.length && msg.keys.every(key => inputCodes.has(key))
}
function registerWorker(socket, candidate) {
  const key = typeof candidate === 'string' ? Buffer.from(candidate) : Buffer.alloc(0)
  const expected = Buffer.from(workerSecret)
  if (!expected.length || key.length !== expected.length || !timingSafeEqual(key, expected) || socket.room || worker) {
    return socket.close(1008, 'Không thể đăng ký worker')
  }
  worker = socket
  send(socket, { type: 'worker-registered', frames: frameToken(socket) })
}
function workerMessage(msg) {
  const room = workerRoom
  if (!room || msg.round !== room.round) return
  if (msg.type === 'engine-status' && ['ready', 'suspect', 'renderer', 'error', 'running', 'paused'].includes(msg.state)) {
    broadcast(room, { type: 'engine-status', round: room.round, state: msg.state })
    return
  }
  if (!['host', 'guest'].includes(msg.seat) || !room[msg.seat]?.socket) return
  if (msg.type === 'native-keys' && validKeys(msg)) return native.input(msg.seat, msg.keys)
  if (msg.type === 'relay') relayTo(room, msg.seat)
  if (msg.type === 'signal' && !room.relay.has(msg.seat)) signal(room[msg.seat].socket, msg, {}, 'offer')
}

function frameConnection(socket, data, binary) {
  if (!socket.owner) {
    if (binary || data.length > 128) return socket.close(1008)
    const owner = frameOwners.get(data.toString())
    if (!owner || owner.readyState !== WebSocket.OPEN) return socket.close(1008)
    owner.frameSocket?.close()
    owner.frameSocket = socket
    socket.owner = owner
    return send(socket, { type: 'frames-ready' })
  }
  if (!binary || ++socket.frames > 30 || data.length < 7 ||
      data[4] !== 0xff || data[5] !== 0xd8 || socket.owner.frameSocket !== socket) return
  const fromWorker = socket.owner === worker
  const room = fromWorker ? workerRoom : socket.owner.room
  if (!room?.relay || data.readUInt32BE(0) !== room.round) return
  if (!fromWorker && (isCentral(room) || socket.owner !== room.host.socket)) return
  for (const role of room.relay) {
    const target = room[role]?.socket?.frameSocket
    if (target?.readyState === WebSocket.OPEN && target.bufferedAmount < maxFrame) {
      target.send(data, { binary: true })
    }
  }
}

sockets.on('connection', (socket, path) => {
  const parsedPath = new URL(path, 'http://localhost')
  if (parsedPath.pathname === '/lan') return bridgeConnection(socket, parsedPath)
  socket.alive = true
  socket.messages = 0
  socket.frames = 0
  socket.on('pong', () => { socket.alive = true })
  socket.on('error', () => socket.terminate())
  socket.on('close', () => {
    if (socket.owner?.frameSocket === socket) socket.owner.frameSocket = null
    if (worker === socket) {
      const room = workerRoom
      worker = workerRoom = null
      native.clear()
      if (room) {
        room.relay = new Set()
        broadcast(room, { type: 'worker-unavailable', round: room.round })
      }
    }
    closeFrames(socket)
    leave(socket, false)
  })
  socket.on('message', (data, binary) => {
    if (path === '/frames') return frameConnection(socket, data, binary)
    if (binary || ++socket.messages > 200 || data.length > 64 * 1024) return socket.close(1008, 'Giới hạn tin nhắn')
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if (socket === worker) return workerMessage(msg)
    if (msg.type === 'worker-register') return registerWorker(socket, msg.token)
    if (msg.type === 'leave') return leave(socket, true)
    if (msg.type === 'ping' && Number.isFinite(msg.t)) return send(socket, { type: 'pong', t: msg.t })

    if (['create', 'join', 'resume'].includes(msg.type)) {
      if (socket.room) return error(socket, 'Hãy rời phòng hiện tại trước.')
      if (msg.type === 'create') {
        const mode = msg.mode === 'central' ? 'central' : msg.mode === 'lan' ? 'lan' : 'peer'
        if (mode === 'central' && (!centralEnabled || !worker || !native.alive())) {
          return error(socket, 'Máy chạy trận chưa sẵn sàng. Hãy kết nối worker rồi thử lại.')
        }
        if (rooms.size >= 100) return error(socket, 'Máy chủ đang có quá nhiều phòng.')
        let id
        do {
          id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
        } while (rooms.has(id))
        const room = { id, mode, host: { token: token(), bridgeToken: token() }, guest: null, round: 0 }
        rooms.set(id, room)
        return bind(room, socket, 'host', room.host)
      }
      const id = typeof msg.id === 'string' ? msg.id.trim().toUpperCase() : ''
      const room = rooms.get(id)
      if (!room) return error(socket, 'Mã phòng không tồn tại hoặc phòng đã đóng.')
      if (msg.type === 'resume') {
        const role = ['host', 'guest'].find(role => room[role]?.token === msg.token && typeof msg.token === 'string')
        const seat = room[role]
        if (!seat || seat.socket) return error(socket, 'Ghế chưa sẵn sàng để kết nối lại.')
        bind(room, socket, role, seat)
      } else {
        if (room.guest) return error(socket, 'Phòng đã đủ 2 người.')
        room.guest = { token: token(), bridgeToken: token() }
        bind(room, socket, 'guest', room.guest)
      }
      return pair(room)
    }

    const room = socket.room
    if (!room || msg.round !== room.round || room[socket.role]?.socket !== socket) return
    const central = isCentral(room)
    if (msg.type === 'reset') return
    if (msg.type === 'retry' && central && workerRoom !== room) return pair(room)
    if (msg.type === 'repair' && room.host.socket && room.guest?.socket) return pair(room)
    if (msg.type === 'engine-status' && socket.role === 'host' && !central &&
        ['ready', 'suspect', 'renderer', 'error', 'running', 'paused'].includes(msg.state)) {
      return send(room.guest?.socket, { type: 'engine-status', round: room.round, state: msg.state })
    }
    if (!room.host.socket || !room.guest?.socket || (central && workerRoom !== room)) return
    const seat = socket.role
    const target = central ? worker : seat === 'host' ? room.guest.socket : room.host.socket
    if (msg.type === 'relay') return relayTo(room, central ? seat : 'guest')
    if (msg.type === 'input' && room.relay.has(seat) && validKeys(msg)) {
      return send(target, { type: 'input', round: room.round, seat, seq: msg.seq, keys: msg.keys })
    }
    if (msg.type === 'signal' && !room.relay.has(central ? seat : 'guest')) {
      signal(target, msg, central ? { seat } : {}, !central && seat === 'host' ? 'offer' : 'answer')
    }
  })
})

setInterval(() => {
  for (const socket of sockets.clients) {
    socket.messages = 0
    socket.frames = 0
    socket.signals = 0
  }
}, 1000).unref()
setInterval(() => {
  for (const socket of sockets.clients) {
    if (!socket.alive) socket.terminate()
    else {
      socket.alive = false
      socket.ping()
    }
  }
}, 15000).unref()

server.on('error', error => { console.error(error.message); native.stop(); process.exit(1) })
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => {
  console.log(`BVN Room • ${server.address().port}`)
  console.log(`Máy chạy game: http://127.0.0.1:${server.address().port}/worker.html`)
  console.log('Khóa quản trị (không gửi cho người chơi): ' + workerSecret)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { native.stop(); process.exit() })
}
