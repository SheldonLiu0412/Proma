import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillVersion } from './config-paths'

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
