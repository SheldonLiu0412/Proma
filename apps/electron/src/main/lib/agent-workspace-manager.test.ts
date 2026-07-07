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

  test('Given 旧 MCP 配置使用 transport 和 disabled When 归一化配置 Then 迁移为 type 和 enabled', () => {
    const normalized = normalizeWorkspaceMcpConfig({
      servers: {
        remote: {
          transport: 'sse',
          url: 'https://example.com/sse',
          disabled: false,
        },
        paused: {
          transport: 'streamableHttp',
          url: 'https://example.com/mcp',
          disabled: true,
        },
      },
    } as unknown as Parameters<typeof normalizeWorkspaceMcpConfig>[0])

    expect(normalized.servers.remote?.type).toBe('sse')
    expect(normalized.servers.remote?.enabled).toBe(true)
    expect(normalized.servers.remote?.transport).toBeUndefined()
    expect(normalized.servers.remote?.disabled).toBeUndefined()
    expect(normalized.servers.paused?.type).toBe('http')
    expect(normalized.servers.paused?.enabled).toBe(false)
  })

  test('Given 远程 MCP 缺少 type 但 URL 是 ws When 归一化配置 Then 推断为 websocket', () => {
    const normalized = normalizeWorkspaceMcpConfig({
      servers: {
        realtime: {
          url: 'wss://example.com/mcp',
        },
      },
    } as unknown as Parameters<typeof normalizeWorkspaceMcpConfig>[0])

    expect(normalized.servers.realtime?.type).toBe('websocket')
    expect(normalized.servers.realtime?.enabled).toBe(true)
  })
})
