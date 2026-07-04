#!/usr/bin/env bun
/**
 * 同步 Electron 打包时需要保留为 external 的主进程运行时依赖。
 *
 * Bun workspace 会把依赖 hoist 到仓库根 node_modules；electron-builder 的 files
 * 规则以 apps/electron 为 appDir，因此打包前需要把 external 依赖闭包复制到
 * apps/electron/node_modules，保证 packaged app 中 Node 模块解析可用。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const EXTERNAL_RUNTIME_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  'pdfjs-dist',
]

const STALE_CLAUDE_RUNTIME_SCOPE = '@anthropic-ai'
const STALE_CLAUDE_RUNTIME_PREFIX = 'claude-agent-sdk'

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')
const sourceNodeModules = join(repoRoot, 'node_modules')
const targetNodeModules = join(appDir, 'node_modules')
const copiedPackages = new Set<string>()
const skippedOptionalPackages: string[] = []

function getPackageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/')
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function getPackageManifest(packageName: string): PackageManifest | undefined {
  const manifestPath = join(getPackageDir(sourceNodeModules, packageName), 'package.json')
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackageManifest
}

function listRuntimeDependencies(manifest: PackageManifest): Array<{ name: string; optional: boolean }> {
  const dependencies = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false }))
  const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true }))
  return [...dependencies, ...optionalDependencies]
}

function copyPackage(packageName: string, optional = false): void {
  if (copiedPackages.has(packageName)) return

  const sourceDir = getPackageDir(sourceNodeModules, packageName)
  const manifest = getPackageManifest(packageName)
  if (!manifest || !existsSync(sourceDir)) {
    if (optional) {
      skippedOptionalPackages.push(packageName)
      return
    }
    throw new Error(`缺少运行时依赖: ${packageName} (${sourceDir})`)
  }

  copiedPackages.add(packageName)

  const targetDir = getPackageDir(targetNodeModules, packageName)
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: false,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })

  for (const dependency of listRuntimeDependencies(manifest)) {
    copyPackage(dependency.name, dependency.optional)
  }
}

function assertNoAbsoluteSymlinks(dir: string): void {
  if (!existsSync(dir)) return
  const stack = [dir]
  const offenders: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath)
        if (target.startsWith('/')) offenders.push(fullPath)
        continue
      }
      if (stat.isDirectory()) stack.push(fullPath)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`检测到绝对 symlink，会导致打包后模块解析失效: ${offenders.slice(0, 10).join(', ')}`)
  }
}

function listStaleClaudeRuntimePackages(): string[] {
  if (!existsSync(targetNodeModules)) return []

  const stalePackages: string[] = []
  const stack = [targetNodeModules]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry)
      const stat = lstatSync(fullPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue

      if (entry === STALE_CLAUDE_RUNTIME_SCOPE) {
        for (const scopedEntry of readdirSync(fullPath)) {
          if (scopedEntry.startsWith(STALE_CLAUDE_RUNTIME_PREFIX)) {
            stalePackages.push(join(fullPath, scopedEntry))
          }
        }
        continue
      }

      stack.push(fullPath)
    }
  }

  return stalePackages
}

function removeStaleClaudeRuntimePackages(): void {
  const stalePackages = listStaleClaudeRuntimePackages()
  for (const packageDir of stalePackages) {
    rmSync(packageDir, { recursive: true, force: true })
  }
  if (stalePackages.length > 0) {
    console.log(`[runtime-deps] 已清理 ${stalePackages.length} 个旧 Claude Agent SDK 运行时包`)
  }
}

function assertNoStaleClaudeRuntimePackages(): void {
  const stalePackages = listStaleClaudeRuntimePackages()
  if (stalePackages.length > 0) {
    throw new Error(`检测到旧 Claude Agent SDK 残留: ${stalePackages.join(', ')}`)
  }
}

function main(): void {
  mkdirSync(targetNodeModules, { recursive: true })
  removeStaleClaudeRuntimePackages()

  for (const packageName of EXTERNAL_RUNTIME_PACKAGES) {
    copyPackage(packageName)
  }

  assertNoStaleClaudeRuntimePackages()
  assertNoAbsoluteSymlinks(targetNodeModules)

  const skipped = skippedOptionalPackages.length > 0
    ? `，跳过未安装 optional 依赖 ${skippedOptionalPackages.length} 个`
    : ''
  console.log(`[runtime-deps] 已同步 ${copiedPackages.size} 个主进程运行时依赖${skipped}`)
}

main()
