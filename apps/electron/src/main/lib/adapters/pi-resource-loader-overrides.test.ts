import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createPromaAgentsFilesOverride } from './pi-resource-loader-overrides'

describe('Pi ResourceLoader 覆盖规则', () => {
  test('Given Pi SDK 返回 AGENTS 和旧 CLAUDE 项目文件 When Proma 覆盖 agents files Then 过滤旧 CLAUDE.md', () => {
    const override = createPromaAgentsFilesOverride()
    const result = override({
      agentsFiles: [
        { path: join('/tmp/project', 'AGENTS.md'), content: 'agents' },
        { path: join('/tmp/project', 'CLAUDE.md'), content: 'legacy' },
        { path: join('/tmp/project', 'CLAUDE.MD'), content: 'legacy upper' },
      ],
    })

    expect(result.agentsFiles.map((file) => file.path)).toEqual([join('/tmp/project', 'AGENTS.md')])
  })
})
