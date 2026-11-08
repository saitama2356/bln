import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'

test('Room seats, round isolation and optional worker', { timeout: 15000 }, async t => {
  const secret = randomBytes(32).toString('hex')
  const app = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: '0', ROOM_WORKER_SECRET: secret, STUN_URLS: '' },
  })
  t.after(() => app.kill())
  const [startup] = await once(app.stdout, 'data')
  const port = /BVN Room • (\d+)/.exec(String(startup))[1]
  const clients = []
  t.after(() => clients.forEach(socket => socket.terminate()))
  async function connect(path = 'rooms') {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/' + path, {
      origin: 'http://127.0.0.1:' + port,
    })
    clients.push(socket)
    const messages = []
    socket.on('message', (data, binary) => messages.push(binary ? data : JSON.parse(data)))
    await once(socket, 'open')
    return {
      socket, messages,
      send(type, payload = {}) { socket.send(JSON.stringify({ type, ...payload })) },
      async take(type) {
        const until = Date.now() + 2500
        while (Date.now() < until) {
          const index = messages.findIndex(message => message.type === type)
          if (index >= 0) return messages.splice(index, 1)[0]
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.fail('Không nhận được bản tin ' + type)
      },
    }
  }
  const [p1, p2, outsider] = await Promise.all([connect(), connect(), connect()])
  p1.send('create', { mode: 'central' })
  assert.match((await p1.take('error')).message, /chưa sẵn sàng/)
  const unauthorized = await connect()
  unauthorized.send('worker-register', { token: randomBytes(32).toString('hex') })
  assert.equal((await once(unauthorized.socket, 'close'))[0], 1008)
  const worker = await connect()
  worker.send('worker-register', { token: secret })
  const registered = await worker.take('worker-registered')
  p1.send('create', { mode: 'central' })
  const room = await p1.take('room')
  p2.send('join', { id: room.id })
  const guest = await p2.take('room')
  assert.equal(guest.role, 'guest')
  const first = (await p1.take('paired')).round
  assert.equal((await p2.take('paired')).round, first)
  assert.equal((await worker.take('worker-start')).round, first)
  outsider.send('join', { id: room.id })
  assert.match((await outsider.take('error')).message, /đủ 2 người/)
  outsider.send('resume', { id: room.id, token: room.id })
  assert.match((await outsider.take('error')).message, /Ghế chưa sẵn sàng/)

  worker.send('signal', { round: first, seat: 'guest', candidate: { candidate: 'candidate:early' } })
  assert.equal((await p2.take('signal')).candidate.candidate, 'candidate:early')
  p1.send('relay', { round: first })
  p2.send('relay', { round: first })
  await Promise.all([p1.take('relay'), p2.take('relay'), worker.take('relay')])
  const p2Frames = await connect('frames')
  p2Frames.socket.send(guest.frames)
  await p2Frames.take('frames-ready')
  const workerFrames = await connect('frames')
  workerFrames.socket.send(registered.frames)
  await workerFrames.take('frames-ready')
  const frame = round => {
    const data = Buffer.from([0, 0, 0, 0, 0xff, 0xd8, 0xff, 0xd9])
    data.writeUInt32BE(round)
    return data
  }
  const frameReceived = once(p2Frames.socket, 'message')
  workerFrames.socket.send(frame(first - 1))
  workerFrames.socket.send(frame(first))
  const [jpeg, binary] = await frameReceived
  assert.equal(binary, true)
  assert.equal(jpeg.readUInt32BE(0), first)
  outsider.send('input', { round: first, seq: 1, keys: ['KeyI'] })
  p2.send('input', { round: first, seat: 'host', seq: 1, keys: ['KeyJ'] })
  assert.equal((await worker.take('input')).seat, 'guest')

  p1.send('reset', { round: first })
  p2.send('reset', { round: first })
  const reset = (await p1.take('reset')).round
  assert.equal(reset, first + 1)
  assert.equal((await p2.take('reset')).round, reset)
  assert.equal((await worker.take('worker-start')).restart, true)
  await Promise.all([p1.take('paired'), p2.take('paired')])

  p2.socket.close()
  assert.equal((await p1.take('interrupted')).seat, 'guest')
  const returned = await connect()
  returned.send('resume', { id: room.id, token: guest.resume })
  assert.equal((await returned.take('room')).role, 'guest')
  const resumed = (await returned.take('paired')).round
  assert.equal(resumed, reset + 1)
  assert.equal((await worker.take('worker-start')).restart, false)
  worker.socket.close()
  assert.equal((await p1.take('worker-unavailable')).round, resumed)
  assert.equal((await returned.take('worker-unavailable')).round, resumed)
  p1.send('leave')
  await returned.take('closed')
})
