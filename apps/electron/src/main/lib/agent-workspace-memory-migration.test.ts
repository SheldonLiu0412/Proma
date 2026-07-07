import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { migrateWorkspaceMemoryRootToAgents } from './agent-workspace-manager'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-memory-migration-'))
  tempRoots.push(root)
  return root
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function readText(path: string): string {
  return readFileSync(path, 'utf-8')
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('工作区记忆一次性迁移', () => {
  test('Given 旧工作区只有 CLAUDE.md When 迁移工作区记忆 Then 在 AGENTS.md 追加带 marker 的迁移区块且不会重复', () => {
    const root = makeTempRoot()
    writeText(join(root, 'CLAUDE.md'), '# 旧项目规则\n\n- 使用 Bun')

    const first = migrateWorkspaceMemoryRootToAgents(root)
    const second = migrateWorkspaceMemoryRootToAgents(root)
    const agents = readText(join(root, 'AGENTS.md'))

    expect(first.agentsMdMigrated).toBe(true)
    expect(second.agentsMdMigrated).toBe(false)
    expect(agents).toContain('<!-- proma:migrated-from-claude-md:start -->')
    expect(agents).toContain('## 迁移自 CLAUDE.md')
    expect(agents).toContain('- 使用 Bun')
    expect(agents.match(/proma:migrated-from-claude-md:start/g)?.length).toBe(1)
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)
  })

  test('Given AGENTS.md 已存在 When 迁移 CLAUDE.md Then 保留新文件并把旧内容追加到迁移区块', () => {
    const root = makeTempRoot()
    writeText(join(root, 'AGENTS.md'), '# 当前项目规则\n\n- 使用 AGENTS')
    writeText(join(root, 'CLAUDE.md'), '# 旧项目规则\n\n- 历史约束')

    const result = migrateWorkspaceMemoryRootToAgents(root)
    const agents = readText(join(root, 'AGENTS.md'))

    expect(result.agentsMdMigrated).toBe(true)
    expect(agents.startsWith('# 当前项目规则')).toBe(true)
    expect(agents).toContain('## 迁移自 CLAUDE.md')
    expect(agents).toContain('- 历史约束')
  })

  test('Given AGENTS.md 已包含旧内容 When 迁移 CLAUDE.md Then 只追加 marker 不重复正文', () => {
    const root = makeTempRoot()
    writeText(join(root, 'AGENTS.md'), '# 当前项目规则\n\n- 历史约束')
    writeText(join(root, 'CLAUDE.md'), '- 历史约束')

    migrateWorkspaceMemoryRootToAgents(root)
    const agents = readText(join(root, 'AGENTS.md'))

    expect(agents.match(/- 历史约束/g)?.length).toBe(1)
    expect(agents).toContain('Proma 仅记录本次路径迁移')
  })

  test('Given 新旧 auto memory 有同名冲突 When 迁移 Then 不覆盖新文件并归档旧冲突内容', () => {
    const root = makeTempRoot()
    writeText(join(root, '.claude', 'memory', 'MEMORY.md'), '# 旧索引')
    writeText(join(root, '.claude', 'memory', 'topic.md'), '旧主题')
    writeText(join(root, '.agents', 'memory', 'MEMORY.md'), '# 新索引')

    const result = migrateWorkspaceMemoryRootToAgents(root)

    expect(result.autoMemoryCopied).toBe(2)
    expect(result.autoMemoryConflicts).toBe(1)
    expect(readText(join(root, '.agents', 'memory', 'MEMORY.md'))).toBe('# 新索引')
    expect(readText(join(root, '.agents', 'memory', 'topic.md'))).toBe('旧主题')
    expect(readText(join(root, '.agents', 'memory', '_legacy-claude', 'MEMORY.md'))).toBe('# 旧索引')
  })
})
