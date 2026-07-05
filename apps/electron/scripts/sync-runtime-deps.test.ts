import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncRuntimeDeps } from './sync-runtime-deps'

let tempDir: string | undefined

afterEach(() => {
  if (!tempDir) return
  rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

interface TestPackageManifest {
  name: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function packageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/')
    if (!scope || !name) throw new Error(`非法测试包名: ${packageName}`)
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function writePackage(nodeModulesDir: string, manifest: TestPackageManifest): void {
  const dir = packageDir(nodeModulesDir, manifest.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }, null, 2))
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
}

describe('sync-runtime-deps', () => {
  test('Given 目标 node_modules 有旧包 When 同步 runtime deps Then 先清空并只复制 allowlist 依赖闭包', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-runtime-deps-'))
    const sourceNodeModules = join(tempDir, 'source', 'node_modules')
    const targetNodeModules = join(tempDir, 'app', 'node_modules')

    writePackage(sourceNodeModules, {
      name: 'root-a',
      dependencies: { 'dep-a': '1.0.0' },
      optionalDependencies: { 'missing-optional': '1.0.0' },
    })
    writePackage(sourceNodeModules, { name: 'dep-a' })
    writePackage(sourceNodeModules, { name: '@scope/root-b' })

    writePackage(targetNodeModules, { name: 'old-package' })
    writePackage(targetNodeModules, { name: '@anthropic-ai/claude-agent-sdk-old' })

    const result = syncRuntimeDeps({
      sourceNodeModules,
      targetNodeModules,
      externalRuntimePackages: ['root-a', '@scope/root-b'],
    })

    expect(existsSync(packageDir(targetNodeModules, 'old-package'))).toBe(false)
    expect(existsSync(packageDir(targetNodeModules, '@anthropic-ai/claude-agent-sdk-old'))).toBe(false)
    expect(existsSync(packageDir(targetNodeModules, 'root-a'))).toBe(true)
    expect(existsSync(packageDir(targetNodeModules, 'dep-a'))).toBe(true)
    expect(existsSync(packageDir(targetNodeModules, '@scope/root-b'))).toBe(true)
    expect([...result.copiedPackages].sort()).toEqual(['@scope/root-b', 'dep-a', 'root-a'])
    expect(result.skippedOptionalPackages).toEqual(['missing-optional'])
  })

  test('Given 依赖闭包混入旧 Claude runtime When 同步 runtime deps Then stale 检查失败', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-runtime-deps-stale-'))
    const sourceNodeModules = join(tempDir, 'source', 'node_modules')
    const targetNodeModules = join(tempDir, 'app', 'node_modules')

    writePackage(sourceNodeModules, {
      name: 'root-a',
      dependencies: { '@anthropic-ai/claude-agent-sdk-native': '1.0.0' },
    })
    writePackage(sourceNodeModules, { name: '@anthropic-ai/claude-agent-sdk-native' })

    expect(() => syncRuntimeDeps({
      sourceNodeModules,
      targetNodeModules,
      externalRuntimePackages: ['root-a'],
    })).toThrow('旧 Claude Agent SDK')
  })
})
