import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'

const currentDir = dirname(fileURLToPath(import.meta.url))
const defaultSkillsDir = resolve(currentDir, '../../../default-skills')
let tempDir: string | undefined

afterEach(() => {
  if (!tempDir) return
  rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('Agent 默认 Skill 加载', () => {
  test('Given 内置 pdf Skill When 使用 Pi ResourceLoader 加载 Then 不因 frontmatter 解析失败被跳过', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-pdf-skill-'))
    cpSync(resolve(defaultSkillsDir, 'pdf'), resolve(tempDir, 'pdf'), { recursive: true })

    const loader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir: resolve(tempDir, '.test-agent'),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      noSkills: true,
      additionalSkillPaths: [tempDir],
      systemPromptOverride: () => 'test',
    })

    await loader.reload()
    const result = loader.getSkills()
    const loadedSkillNames = result.skills.map((skill) => skill.name)
    const pdfDiagnostics = result.diagnostics.filter((diagnostic) =>
      diagnostic.path?.endsWith('/pdf/SKILL.md') || diagnostic.path?.endsWith('\\pdf\\SKILL.md'))

    expect(loadedSkillNames).toContain('pdf')
    expect(pdfDiagnostics).toEqual([])
  })
})
