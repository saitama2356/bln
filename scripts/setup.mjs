import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localize } from './localize.mjs'

const ruffleRepo = 'https://github.com/DuyOrbit/naruto-vs-bleach-online.git'
const ruffleRevision = '222ba8f8f08b379509bde031a116108e1211c18a'
const gameSources = [
  'https://gamebox.bvnplay.online/games/bvn-3.0/',
  'https://en.gameslol.net/data/bleachvsnaruto300/',
  'https://flashga.me/public/storage/games/bleach-vs-naruto-3.0-files/',
]
const destination = fileURLToPath(new URL('../public/', import.meta.url))
const stage = await mkdtemp(join(dirname(destination), '.bvn-setup-'))
const sourceDir = process.env.BVN_ASSET_DIR && resolve(process.env.BVN_ASSET_DIR)
const manifest = JSON.parse(await readFile(new URL('./assets.json', import.meta.url), 'utf8'))

function isExpected(bytes, expected) {
  return createHash('sha256').update(bytes).digest('hex') === expected
}

async function download(path, expected) {
  if (sourceDir) {
    const bytes = await readFile(join(sourceDir, path))
    if (isExpected(bytes, expected)) return bytes
    throw new Error('Sai mã kiểm tra của tài nguyên cục bộ: ' + path)
  }
  const failures = []
  for (const base of gameSources) {
    const filename = path === 'game.swf' && base === gameSources[0] ? 'main.swf' : path
    try {
      const response = await fetch(new URL(filename, base), { signal: AbortSignal.timeout(45000) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (isExpected(bytes, expected)) return bytes
      throw new Error('tệp không khớp phiên bản')
    } catch (error) {
      failures.push(new URL(base).host + ' (' + error.message + ')')
    }
  }
  throw new Error('Không tải được ' + path + '. ' + failures.join(', '))
}

try {
  const paths = Object.entries(manifest)
  let done = 0
  let next = 0
  let failure
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (!failure && next < paths.length) {
      const [path, expected] = paths[next++]
      try {
        const bytes = await download(path, expected)
        const target = join(stage, path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
        if (++done % 40 === 0) console.log('Đã nạp ' + done + '/' + paths.length + ' tệp game')
      } catch (error) {
        failure ??= error
      }
    }
  }))
  if (failure) throw failure

  await mkdir(join(stage, 'assets', 'font'), { recursive: true })
  await localize(stage)
  const checkout = join(stage, 'checkout')
  await mkdir(checkout)
  const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'inherit' })
  git('init', '-q')
  git('sparse-checkout', 'set', 'ruffle')
  git('fetch', '--depth=1', ruffleRepo, ruffleRevision)
  git('checkout', '--quiet', '--detach', 'FETCH_HEAD')
  await mkdir(join(stage, 'ruffle'), { recursive: true })
  for (const name of ['ruffle.js', 'ruffle_web_bg.PBF26GHG.wasm', 'ruffle_web-wasm_mvp_bg.RBLKBOTU.wasm']) {
    await cp(join(checkout, 'ruffle', name), join(stage, 'ruffle', name))
  }

  for (const path of ['assets', 'game.swf', 'ruffle']) {
    const target = join(destination, path)
    await rm(target, { recursive: true, force: true })
    await rename(join(stage, path), target)
  }
  console.log('Đã nạp Bleach vs Naruto 3.0 tiếng Việt. Dùng npm start để mở phòng.')
} finally {
  await rm(stage, { recursive: true, force: true })
}
