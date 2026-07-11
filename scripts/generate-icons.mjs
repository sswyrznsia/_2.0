import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'assets', 'icon.svg')
const pngPath = path.join(root, 'assets', 'icon.png')
const icoPath = path.join(root, 'assets', 'icon.ico')

await sharp(source).resize(512, 512).png().toFile(pngPath)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const buffers = await Promise.all(
  sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()),
)
await writeFile(icoPath, await pngToIco(buffers))
