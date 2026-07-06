import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'
import type { PermissionRequest } from '@proma/shared'

function options(): CanUseToolOptions {
  return {
    signal: new AbortController().signal,
    toolUseID: crypto.randomUUID(),
  }
}

describe('AgentPermissionService auto 权限模式', () => {
  test('Given 只读工具和只读 Bash When 检查权限 Then 自动允许且不发审批请求', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto', (request) => requests.push(request))

    await expect(canUseTool('Read', { file_path: 'README.md' }, options()))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: 'README.md' } })
    await expect(canUseTool('Bash', { command: 'ls -la' }, options()))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } })
    expect(requests).toEqual([])
  })

  test('Given 写工具 When 用户批准并选择始终允许 Then 同会话同工具后续自动允许', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto', (request) => requests.push(request))

    const first = canUseTool('Write', { file_path: 'note.txt', content: 'hello' }, options())
    expect(requests).toHaveLength(1)
    expect(requests[0]?.toolName).toBe('Write')

    expect(service.respondToPermission(requests[0]!.requestId, 'allow', true)).toBe('session-auto')
    await expect(first).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'note.txt', content: 'hello' },
    })

    await expect(canUseTool('Write', { file_path: 'next.txt', content: 'world' }, options()))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: 'next.txt', content: 'world' } })
    expect(requests).toHaveLength(1)
  })

  test('Given 子 Agent 写工具 When auto 模式检查权限 Then 仍需用户审批', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto', (request) => requests.push(request))

    const result = canUseTool('Write', { file_path: 'worker.txt', content: 'from worker' }, {
      ...options(),
      agentID: 'worker-1',
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.toolName).toBe('Write')
    expect(service.respondToPermission(requests[0]!.requestId, 'deny', false)).toBe('session-auto')
    await expect(result).resolves.toEqual({ behavior: 'deny', message: '用户拒绝了此操作' })
  })
})
