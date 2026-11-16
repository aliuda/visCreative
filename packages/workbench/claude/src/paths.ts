import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path'

function existingParent(path: string): string | undefined {
  try { return realpathSync.native(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    try { lstatSync(path); return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    const parent = dirname(path)
    if (parent === path) return
    const resolved = existingParent(parent)
    if (resolved === undefined) return
    try { if (!statSync(resolved).isDirectory()) return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    return join(resolved, basename(path))
  }
}

export function canonicalToolPath(path: string): string | undefined {
  if (!isAbsolute(path) || path.includes('\0')) return
  try {
    // Resolve before each parent traversal, including on Windows where realpath otherwise erases junction/.. .
    if (process.platform === 'win32') {
      path = path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
    }
    const root = parse(path).root
    let current = root
    for (const part of path.slice(root.length).split(process.platform === 'win32' ? /[/\\]+/ : /\/+/).filter(Boolean)) {
      if (part === '.' || part === '..') {
        const resolved = existingParent(current)
        if (resolved === undefined || !statSync(resolved).isDirectory()) return
        current = part === '..' ? dirname(resolved) : resolved
      } else current = join(current, part)
    }
    return existingParent(current)
  } catch { return }
}

export function insideDirectories(path: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  const target = canonicalToolPath(path)
  if (!target) return false
  return roots.some(root => {
    const resolved = canonicalToolPath(root)
    if (!resolved) return false
    try { if (!statSync(resolved).isDirectory()) return false } catch { return false }
    const fromRoot = relative(platform === 'win32' ? resolved.toLowerCase() : resolved, platform === 'win32' ? target.toLowerCase() : target)
    return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  })
}
