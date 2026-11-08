import { createHmac, randomInt, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const root = await realpath(fileURLToPath(new URL('./public/', import.meta.url)))
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash', '.mp3': 'audio/mpeg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.xml': 'application/xml',
  '.ttf': 'font/ttf',
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end()
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/healthz') return res.writeHead(200).end('ok')
    const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
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
const inputCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO'])
const send = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const error = (socket, message) => send(socket, { type: 'error', message })
const stunUrls = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean)
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

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin
  let sameOrigin = false
  try { sameOrigin = new URL(origin).host === req.headers.host } catch {}
  if (req.url !== '/rooms' || !sameOrigin || sockets.clients.size >= 250) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws))
})

function leave(socket) {
  const room = socket.room
  if (!room) return
  socket.room = null
  if (socket === room.host) {
    rooms.delete(room.id)
    if (room.guest) room.guest.room = null
    send(room.guest, { type: 'closed' })
  } else if (socket === room.guest) {
    room.guest = null
    room.relay = false
    send(room.host, { type: 'vacant' })
  }
}

sockets.on('connection', socket => {
  socket.alive = true
  socket.messages = 0
  socket.frames = 0
  socket.on('pong', () => { socket.alive = true })
  socket.on('error', () => socket.terminate())
  socket.on('close', () => leave(socket))
  socket.on('message', (data, binary) => {
    const current = socket.room
    if (binary) {
      if (++socket.frames > 30 || !current?.relay || socket !== current.host) return
      const guest = current.guest
      if (data[0] === 0xff && data[1] === 0xd8 &&
          guest?.readyState === WebSocket.OPEN && guest.bufferedAmount < maxFrame) {
        guest.send(data, { binary: true })
      }
      return
    }
    if (++socket.messages > 160 || data.length > 64 * 1024) return socket.close(1008, 'Giới hạn tin nhắn')
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'leave') return leave(socket)
    // Lightweight application-level RTT (browser WebSocket doesn't expose ping()).
    if (msg.type === 'ping' && typeof msg.t === 'number' && Number.isFinite(msg.t)) {
      return send(socket, { type: 'pong', t: msg.t })
    }

    if (msg.type === 'create' || msg.type === 'join') {
      if (socket.room) return error(socket, 'Hãy rời phòng hiện tại trước.')
      if (msg.type === 'create') {
        let id
        do {
          id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
        } while (rooms.has(id))
        const room = { id, host: socket, guest: null, round: 0 }
        rooms.set(id, room)
        socket.room = room
        return send(socket, { type: 'room', id, role: 'host' })
      }
      const id = typeof msg.id === 'string' ? msg.id.trim().toUpperCase() : ''
      const room = id.length === 6 ? rooms.get(id) : null
      if (!room) return error(socket, 'Mã phòng không tồn tại hoặc phòng đã đóng.')
      if (room.guest) return error(socket, 'Phòng đã đủ 2 người.')
      socket.room = room
      room.guest = socket
      room.round += 1
      send(socket, { type: 'room', id, role: 'guest' })
      for (const peer of [socket, room.host]) {
        send(peer, { type: 'paired', round: room.round, iceServers: iceServers() })
      }
      return
    }

    const room = socket.room
    if (!room?.guest || msg.round !== room.round) return
    const host = room.host === socket
    if (msg.type === 'relay' && !room.relay) {
      room.relay = true
      for (const peer of [room.host, room.guest]) send(peer, { type: 'relay', round: room.round })
      return
    }
    if (msg.type === 'input' && room.relay && !host && Array.isArray(msg.keys) &&
        msg.keys.length <= 10 && msg.keys.every(key => inputCodes.has(key))) {
      send(room.host, { type: 'input', round: room.round, keys: msg.keys })
      return
    }
    if (msg.type !== 'signal' || room.relay) return
    const target = host ? room.guest : room.host
    if (msg.description?.type === (host ? 'offer' : 'answer') &&
        typeof msg.description.sdp === 'string') {
      const { type, sdp } = msg.description
      send(target, { type: 'signal', round: room.round, description: { type, sdp } })
    } else if (typeof msg.candidate?.candidate === 'string') {
      const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = msg.candidate
      send(target, { type: 'signal', round: room.round, candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } })
    }
  })
})

setInterval(() => {
  for (const socket of sockets.clients) {
    socket.messages = 0
    socket.frames = 0
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

server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`BVN Room • ${server.address().port}`)
})
