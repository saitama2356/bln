export function socketFor(path) {
  return new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path)
}

export function frameLink(token, receive, changed = () => {}) {
  let connection, retry, closed = false, ready = false
  function connect() {
    const socket = socketFor('/frames')
    connection = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => socket.send(token)
    socket.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        ready = true
        changed(true)
      } else if (data.byteLength > 6) {
        receive(new DataView(data).getUint32(0), new Blob([data.slice(4)], { type: 'image/jpeg' }))
      }
    }
    socket.onclose = () => {
      if (closed) return
      ready = false
      changed(false)
      retry = setTimeout(connect, 1000)
    }
  }
  connect()
  return {
    available: () => ready && connection.readyState === WebSocket.OPEN && connection.bufferedAmount < 96 * 1024,
    send(round, blob) {
      const header = new DataView(new ArrayBuffer(4))
      header.setUint32(0, round)
      connection.send(new Blob([header.buffer, blob]))
    },
    stop() {
      closed = true
      ready = false
      clearTimeout(retry)
      connection.close()
    },
  }
}

export function streamJpeg(source, round, link, profile, onFrame) {
  const frame = document.createElement('canvas')
  const context = frame.getContext('2d', { alpha: false })
  let running = true, timer, delay = 65, quality = 0.46, stable = 0
  const schedule = (elapsed = 0) => { timer = setTimeout(tick, Math.max(8, delay - elapsed)) }
  function congested() {
    delay = Math.min(115, delay + 8)
    quality = Math.max(0.37, quality - 0.04)
    stable = 0
  }
  function tick() {
    if (!running) return
    const channel = link()
    const sourceWidth = source.videoWidth || source.width
    const sourceHeight = source.videoHeight || source.height
    if (!sourceWidth || !sourceHeight || !channel?.available()) {
      congested()
      return schedule()
    }
    const smooth = profile() === 'smooth'
    const scale = Math.min(1, (smooth ? 480 : 640) / sourceWidth, (smooth ? 360 : 480) / sourceHeight)
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    if (frame.width !== width || frame.height !== height) {
      frame.width = width
      frame.height = height
    }
    const start = performance.now()
    try {
      context.drawImage(source, 0, 0, width, height)
      frame.toBlob(blob => {
        if (!running) return
        const elapsed = performance.now() - start
        if (blob && blob.size < 160 * 1024 && channel === link() && channel.available()) {
          channel.send(round, blob)
          onFrame(width, height, elapsed)
        }
        if (!blob || elapsed > 55 || blob.size >= 160 * 1024 || !channel.available()) congested()
        else if (++stable >= 16) {
          delay = Math.max(50, delay - 4)
          quality = Math.min(0.54, quality + 0.02)
          stable = 0
        }
        schedule(elapsed)
      }, 'image/jpeg', smooth ? Math.min(0.45, quality) : quality)
    } catch {
      congested()
      schedule()
    }
  }
  tick()
  return () => { running = false; clearTimeout(timer) }
}

export async function capVideo(sender, smooth) {
  const params = sender.getParameters()
  if (!params.encodings?.length) return
  params.encodings[0].maxBitrate = smooth ? 850000 : 1800000
  params.encodings[0].maxFramerate = smooth ? 24 : 30
  params.encodings[0].scaleResolutionDownBy = smooth ? 1.33 : 1
  await sender.setParameters(params)
}
