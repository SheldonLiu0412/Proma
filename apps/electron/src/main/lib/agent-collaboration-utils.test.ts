import { describe, expect, test } from 'bun:test'
import { resolveDelegationPermissionMode } from './agent-collaboration-utils'

describe('Agent 协作权限模式', () => {
  test('Given 父会话为 auto When 子会话请求更高权限 Then 降级为 auto', () => {
    expect(resolveDelegationPermissionMode('auto', 'bypassPermissions')).toBe('auto')
  })

  test('Given 父会话为 bypassPermissions When 子会话请求 auto Then 使用更保守的 auto', () => {
    expect(resolveDelegationPermissionMode('bypassPermissions', 'auto')).toBe('auto')
  })
})
