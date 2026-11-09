import { spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { constants } from 'node:fs'
import { access, copyFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const keys = ['KeyW','KeyA','KeyS','KeyD','KeyJ','KeyK','KeyL','KeyU','KeyI','KeyO','KeyP','Escape','Enter']
const positions = {
  host: [0,1,2,3,4,5,6,7,8,9,10,22,23],
  guest: [11,12,13,14,15,16,17,18,19,20,21],
}
export async function runNative(folder) {
  const testPort = Number(process.env.BVN_TEST_AIR_PORT)
  let child, alive = true
  const port = testPort || randomInt(49152, 65536)
  const token = testPort ? process.env.BVN_TEST_AIR_TOKEN : randomBytes(16).toString('hex')
  if (testPort && !/^[a-f0-9]{32}$/.test(token ?? '')) throw new Error('Thiếu khóa kiểm thử AIR.')
  if (!testPort) {
    if (process.platform !== 'darwin' || !folder) throw new Error('Dùng npm start -- "$GAME" trên Mac.')
    const dir = resolve(folder)
    const adl = process.env.AIR_HOME ? join(process.env.AIR_HOME, 'bin/adl') : 'adl'
    for (const file of ['launch.swf', 'version.json', 'lang/zh-CN.json', 'assets/subswfs/loading.swf']) {
      await access(join(dir, file))
    }
    for (const file of ['application-web-online.xml','launch-web-online.swf']) {
      const source = new URL('./native/' + file, import.meta.url)
      const target = join(dir, file)
      try { await copyFile(source, target, constants.COPYFILE_EXCL) } catch (error) {
        if (error.code !== 'EEXIST' || !(await readFile(source)).equals(await readFile(target))) throw error
      }
    }
    child = spawn(adl, [join(dir, 'application-web-online.xml'), dir, '--', 'bvn-web-keys', String(port), token],
      { cwd: dir, stdio: 'inherit' })
    await new Promise((res, reject) => { child.once('spawn', res); child.once('error', reject) })
    child.on('exit', () => { alive = false; console.error('Cửa sổ game đã đóng. Khởi động lại dịch vụ để mở game mới.') })
  }
  const udp = createSocket('udp4')
  udp.on('error', error => console.error('Kết nối AIR:', error.message))
  let seq = 0
  const state = { host: 0, guest: 0 }
  const flush = () => {
    if (alive) udp.send(Buffer.from(`${token}:${++seq}:${state.host | state.guest}`), port, '127.0.0.1',
      error => { if (error) console.error('Kết nối AIR:', error.message) })
  }
  let timer
  return {
    alive: () => alive,
    begin() { clearInterval(timer); state.host = state.guest = 0; flush(); timer = setInterval(flush, 100).unref() },
    input(seat, pressed) {
      const next = pressed.reduce((mask, key) => {
        const position = positions[seat][keys.indexOf(key)]
        return position === undefined ? mask : mask | 1 << position
      }, 0)
      if (state[seat] !== next) { state[seat] = next; flush() }
    },
    clear(seat) {
      if (seat) state[seat] = 0
      else { state.host = state.guest = 0; clearInterval(timer) }
      flush()
    },
    stop() { clearInterval(timer); udp.close(); child?.kill() },
  }
}
