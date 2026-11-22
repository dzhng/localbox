import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative as relativePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pinFile = join(dirname(fileURLToPath(import.meta.url)), 'upstream.json')

/**
 * Why `framework` is not the one `npm run sparkle:build` made from the pinned commit and patch (its build receipt
 * against upstream.json, and its bytes against the receipt), or null when it is. The app build and the release's
 * validation both ask this.
 */
export function frameworkProblem(framework) {
  if (!existsSync(framework)) return `There is no Sparkle framework at ${framework}: run npm run sparkle:build (full Xcode and network), or set LOCALBOX_SPARKLE_FRAMEWORK`
  let receipt
  try { receipt = JSON.parse(readFileSync(join(framework, '../build-receipt.json'), 'utf8')) } catch { receipt = undefined }
  const pin = JSON.parse(readFileSync(pinFile, 'utf8'))
  if (receipt?.inputs?.commit !== pin.commit || receipt?.inputs?.patchSha256 !== pin.patchSha256 || frameworkIdentity(framework).sha256 !== receipt?.framework?.sha256)
    return `${framework} does not match its build receipt and apps/macos/App/sparkle/upstream.json: delete dist/sparkle and dist/sparkle-source, then run npm run sparkle:build`
  return null
}

export function frameworkIdentity(root) {
  root = realpathSync(root)
  const records = [['', 'directory', lstatSync(root).mode & 0o777]]
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const relative = prefix + name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = relativePath(root, realpathSync(path))
        if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`))
          throw new Error(`Framework link resolves outside the framework: ${relative}`)
        records.push([relative, 'link', readlinkSync(path)])
      } else if (stat.isDirectory()) {
        records.push([relative, 'directory', stat.mode & 0o777])
        visit(path, relative + '/')
      } else if (stat.isFile()) {
        records.push([
          relative,
          'file',
          stat.mode & 0o777,
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ])
      } else throw new Error(`Unsupported framework entry: ${relative}`)
    }
  }
  visit(root)
  return { sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex') }
}
