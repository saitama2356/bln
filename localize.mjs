import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { inflateSync, deflateSync } from 'node:zlib'
import { join } from 'node:path'

function packedInteger(value) {
  const bytes = []
  while (value > 127) {
    bytes.push((value & 127) | 128)
    value >>>= 7
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

// Change AVM2 string constants in place by index, preserving code and references.
function translateAbc(tag, strings, hits) {
  const abcStart = tag.indexOf(0, 4) + 1
  let cursor = abcStart + 4
  function readInteger() {
    let value = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = tag.readUInt8(cursor++)
      value |= (byte & 127) << shift
      if (!(byte & 128)) return value >>> 0
    }
    throw new Error('Giá trị AVM2 không hợp lệ.')
  }
  for (let pool = 0; pool < 2; pool++) {
    const count = readInteger()
    for (let index = 1; index < count; index++) readInteger()
  }
  const doubleCount = readInteger()
  cursor += Math.max(0, doubleCount - 1) * 8
  const stringCount = readInteger()
  const parts = [tag.subarray(0, cursor)]
  let changed = false
  for (let index = 1; index < stringCount; index++) {
    const begin = cursor
    const length = readInteger()
    const value = tag.toString('utf8', cursor, cursor + length)
    cursor += length
    if (Object.hasOwn(strings, value)) {
      const translated = Buffer.from(strings[value])
      parts.push(packedInteger(translated.length), translated)
      hits.add(value)
      changed = true
    } else {
      parts.push(tag.subarray(begin, cursor))
    }
  }
  return changed ? Buffer.concat([...parts, tag.subarray(cursor)]) : tag
}

function translateSwf(source, strings) {
  if (source.toString('ascii', 0, 3) !== 'CWS') throw new Error('Tệp game 3.0 không hợp lệ.')
  const raw = inflateSync(source.subarray(8))
  let cursor = Math.ceil((5 + (raw[0] >> 3) * 4) / 8) + 4
  const parts = [raw.subarray(0, cursor)]
  const hits = new Set()
  while (cursor < raw.length) {
    const start = cursor
    const info = raw.readUInt16LE(cursor)
    cursor += 2
    const type = info >> 6
    let length = info & 63
    if (length === 63) {
      length = raw.readUInt32LE(cursor)
      cursor += 4
    }
    const tag = raw.subarray(cursor, cursor + length)
    cursor += length
    const updated = type === 82 ? translateAbc(tag, strings, hits) : tag
    if (updated === tag) {
      parts.push(raw.subarray(start, cursor))
    } else {
      const tagHeader = Buffer.alloc(6)
      tagHeader.writeUInt16LE((type << 6) | 63, 0)
      tagHeader.writeUInt32LE(updated.length, 2)
      parts.push(tagHeader, updated)
    }
  }
  for (const label of ['SINGLE PLAY', 'SINGLE VS PEOPLE', 'CONTINUE', '游戏初始化：正在加载游戏资源']) {
    if (!hits.has(label)) throw new Error('Thiếu chuỗi cần Việt hóa: ' + label)
  }
  const updated = Buffer.concat(parts)
  const header = Buffer.from(source.subarray(0, 8))
  header.writeUInt32LE(updated.length + 8, 4)
  return Buffer.concat([header, deflateSync(updated)])
}

const readJson = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'))

export async function localize(folder) {
  const swf = join(folder, 'game.swf')
  await writeFile(swf, translateSwf(await readFile(swf), await readJson('vi-strings.json')))
  for (const [file, labels] of Object.entries(await readJson('vi-names.json'))) {
    const path = join(folder, 'assets', 'config', file)
    const xml = await readFile(path, 'utf8')
    const translated = xml.replace(/(<(?:fighter|map)\b[^<>]*?\bid="([^"]+)"[^<>]*?\bname=")[^"]*(")/g,
      (match, start, id, end) => Object.hasOwn(labels, id) ? start + labels[id] + end : match)
    await writeFile(path, translated)
  }
  for (const ext of ['xml', 'png']) {
    await copyFile(new URL('vi-font.' + ext, import.meta.url), join(folder, 'assets', 'font', 'font1.' + ext))
  }
}
