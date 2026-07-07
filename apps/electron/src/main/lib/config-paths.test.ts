import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSafeSessionId,
  assertSafeWorkspaceSlug,
  parseSkillVersion,
} from './config-paths'

let tempDir: string | undefined

afterEach(() => {
  if (!tempDir) return
  rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

interface VersionScenario {
  label: string
  value: string
  expected: string
}

const versionScenarios: VersionScenario[] = [
  { label: '无引号 version', value: '1.2.3', expected: '1.2.3' },
  { label: 'ASCII 双引号 version', value: '"1.2.3"', expected: '1.2.3' },
  { label: '弯引号 version', value: '“1.2.3”', expected: '1.2.3' },
]

describe('默认 Skill version 解析', () => {
  for (const scenario of versionScenarios) {
    test(`Given SKILL.md 使用${scenario.label} When 解析版本 Then 返回干净 semver`, () => {
      tempDir = mkdtempSync(join(tmpdir(), 'proma-skill-version-'))
      const skillDir = join(tempDir, 'test-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---\r\nname: test-skill\r\nversion: ${scenario.value}\r\n---\r\n# Test\r\n`)

      expect(parseSkillVersion(skillDir)).toBe(scenario.expected)
    })
  }
})

describe('Agent 工作区路径片段校验', () => {
  test('Given 合法工作区 slug 和会话 ID When 校验路径片段 Then 原样返回', () => {
    expect(assertSafeWorkspaceSlug('workspace-one')).toBe('workspace-one')
    expect(assertSafeWorkspaceSlug('workspace_1.2')).toBe('workspace_1.2')
    expect(assertSafeSessionId('session-123')).toBe('session-123')
  })

  test('Given 工作区 slug 含路径逃逸 When 校验路径片段 Then 拒绝该输入', () => {
    for (const slug of ['../escape', '..', '.', 'workspace/child', 'workspace\\child']) {
      expect(() => assertSafeWorkspaceSlug(slug)).toThrow('工作区 slug 包含非法路径片段')
    }
  })

  test('Given 会话 ID 含路径逃逸 When 校验路径片段 Then 拒绝该输入', () => {
    for (const sessionId of ['../session', '..', '.', 'session/child', 'session\\child']) {
      expect(() => assertSafeSessionId(sessionId)).toThrow('Agent 会话 ID 包含非法路径片段')
    }
  })
})
