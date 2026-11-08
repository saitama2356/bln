export const p2Keys = {
  KeyW: ['ArrowUp', 'ArrowUp', 38], KeyA: ['ArrowLeft', 'ArrowLeft', 37],
  KeyS: ['ArrowDown', 'ArrowDown', 40], KeyD: ['ArrowRight', 'ArrowRight', 39],
  KeyJ: ['Numpad1', '1', 97], KeyK: ['Numpad2', '2', 98], KeyL: ['Numpad3', '3', 99],
  KeyU: ['Numpad4', '4', 100], KeyI: ['Numpad5', '5', 101], KeyO: ['Numpad6', '6', 102],
}
export const p1Keys = Object.fromEntries(Object.keys(p2Keys).map(code =>
  [code, [code, code[3].toLowerCase(), code.charCodeAt(3)]]))
export const validKeys = keys => Array.isArray(keys) && keys.length <= 10 &&
  keys.every(key => Object.hasOwn(p2Keys, key))

let rufflePromise
function loadRuffle() {
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

export function startGame(container, notify) {
  const cleanup = new AbortController()
  const { signal } = cleanup
  let instance, canvas, monitor, runtime, lastInput = 0, attempts = 0
  let state
  const report = (next, detail) => {
    if (!signal.aborted && (state !== next || detail)) {
      state = next
      notify(next, detail)
    }
  }
  const key = (mapping, code, down) => {
    if (!canvas || !Object.hasOwn(mapping, code)) return
    const [flashCode, value, keyCode] = mapping[code]
    const event = new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code: flashCode, key: value, location: flashCode.startsWith('Numpad') ? 3 : 0,
      bubbles: true, cancelable: true, composed: true,
    })
    Object.defineProperties(event, { keyCode: { value: keyCode }, which: { value: keyCode } })
    canvas.dispatchEvent(event)
  }
  const ready = (async () => {
    await loadRuffle()
    signal.throwIfAborted()
    instance = window.RufflePlayer.newest().createPlayer()
    instance.config = {
      autoplay: 'on', unmuteOverlay: 'hidden', splashScreen: false,
      preferredRenderer: 'canvas', allowScriptAccess: false,
      backgroundExecutionMode: 'mainThread',
      fontSources: ['/fonts/DejaVuSans.ttf', '/fonts/DejaVuSans-Bold.ttf'],
      defaultFonts: { sans: ['DejaVu Sans'] },
    }
    container.replaceChildren(instance)
    instance.addEventListener('keydown', event => {
      if (event.repeat || !Object.hasOwn(p2Keys, event.code) && !event.code.startsWith('Arrow') &&
          !event.code.startsWith('Numpad')) return
      lastInput = performance.now()
      attempts++
    }, { capture: true, signal })
    runtime = instance.ruffle()
    try {
      await runtime.load({ url: '/game.swf' })
    } finally {
      // The pinned build can create its instance after the element was removed.
      if (signal.aborted) instance.disconnectedCallback()
    }
    for (let step = 0; step < 100; step++) {
      signal.throwIfAborted()
      canvas = instance.shadowRoot?.querySelector('canvas')
      if (canvas) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!canvas) throw new Error('Ruffle chưa mở được màn hình game.')
    for (const type of ['contextlost', 'webglcontextlost']) {
      canvas.addEventListener(type, () => report('renderer', type), { signal })
    }
    for (const type of ['contextrestored', 'webglcontextrestored']) {
      canvas.addEventListener(type, () => report('running', type), { signal })
    }
    const sample = document.createElement('canvas')
    sample.width = 32
    sample.height = 24
    const context = sample.getContext('2d', { willReadFrequently: true })
    let previous, lastMotion = 0, motionSamples = 0, lastActiveSample = 0
    if (context) monitor = setInterval(() => {
      if (instance.shadowRoot?.querySelector('#panic')) {
        clearInterval(monitor)
        report('error', 'Ruffle hiển thị thông báo lỗi nghiêm trọng.')
        return
      }
      if (document.hidden || runtime.isPlaying === false || canvas.width < 2 || canvas.height < 2) {
        if (runtime.isPlaying === false && ['ready', 'running', 'suspect'].includes(state)) report('paused')
        previous = null
        attempts = motionSamples = lastMotion = 0
        return
      }
      if (state === 'paused') report('running')
      const now = performance.now()
      // Idle menus do not require a GPU/CPU readback. Keep the sample window
      // around recent controls, without treating inactivity as a frozen game.
      if (now - lastInput > 5000 || !lastInput) return
      if (lastActiveSample && now - lastActiveSample > 10000) {
        previous = null
        motionSamples = lastMotion = 0
      }
      lastActiveSample = now
      try {
        context.drawImage(canvas, 0, 0, sample.width, sample.height)
        const pixels = context.getImageData(0, 0, sample.width, sample.height).data
        let changed = 0
        if (previous) {
          for (let i = 0; i < pixels.length; i += 4) {
            if (Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) +
                Math.abs(pixels[i + 2] - previous[i + 2]) > 16) changed++
          }
        }
        previous = pixels
        if (changed >= 3) {
          lastMotion = now
          motionSamples++
          attempts = 0
          if (state === 'suspect') report('running')
        } else if (motionSamples >= 3 && lastMotion && now - lastMotion > 8000 &&
            attempts >= 5 && now - lastInput < 5000 && state !== 'renderer') {
          report('suspect')
        }
      } catch (error) {
        clearInterval(monitor)
        report('running', 'Không đọc được khung lấy mẫu: ' + error.name)
      }
    }, 1000)
    report('ready')
    return canvas
  })()
  ready.catch(error => { if (!signal.aborted) report('error', error.message) })
  return {
    ready, key,
    mute(value) { if (runtime) runtime.volume = value ? 0 : 1 },
    stop() {
      cleanup.abort()
      clearInterval(monitor)
      instance?.remove()
    },
  }
}

export function remoteKeys(engine, mapping) {
  const held = new Set()
  return keys => {
    const next = new Set(keys)
    for (const code of held) if (!next.has(code)) engine()?.key(mapping, code, false)
    for (const code of next) if (!held.has(code)) engine()?.key(mapping, code, true)
    held.clear()
    for (const code of next) held.add(code)
  }
}
