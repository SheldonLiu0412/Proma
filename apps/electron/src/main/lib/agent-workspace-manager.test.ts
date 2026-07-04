import { describe, expect, test } from 'bun:test'
import { normalizeWorkspaceMcpConfig } from './agent-workspace-manager'

describe('Agent 工作区 MCP 配置', () => {
  test('Given 工作区 MCP 包含内置保留名 When 归一化配置 Then 剔除冲突项并保留普通服务器', () => {
    const normalized = normalizeWorkspaceMcpConfig({
      servers: {
        automation: {
          type: 'stdio',
          command: 'custom-automation',
          enabled: true,
        },
        nano_banana: {
          type: 'stdio',
          command: 'custom-nano',
          enabled: true,
        },
        github: {
          type: 'stdio',
          command: 'github-mcp',
          enabled: true,
        },
      },
    })

    expect(Object.keys(normalized.servers).sort()).toEqual(['github'])
    expect(normalized.servers.github?.command).toBe('github-mcp')
  })

  test('Given stdio MCP 配置包含 cwd When 归一化配置 Then 保留工作目录', () => {
    const normalized = normalizeWorkspaceMcpConfig({
      servers: {
        filesystem: {
          type: 'stdio',
          command: 'filesystem-mcp',
          cwd: '/Users/jay/project-a',
          enabled: true,
        },
      },
    })

    expect(normalized.servers.filesystem?.cwd).toBe('/Users/jay/project-a')
  })
})
