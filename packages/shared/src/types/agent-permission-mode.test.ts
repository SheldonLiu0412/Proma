import { describe, expect, test } from 'bun:test'
import {
  PROMA_DEFAULT_PERMISSION_MODE,
  PROMA_PERMISSION_MODES,
  isPromaPermissionMode,
  migratePermissionMode,
} from './agent'

describe('Proma Agent 权限模式', () => {
  test('Given 历史 auto 权限模式 When 校验与迁移 Then 保留自动审批语义', () => {
    expect(PROMA_PERMISSION_MODES).toEqual(['auto', 'bypassPermissions', 'plan'])
    expect(isPromaPermissionMode('auto')).toBe(true)
    expect(migratePermissionMode('auto')).toBe('auto')
  })

  test('Given 非法权限模式 When 迁移 Then 回到当前默认模式', () => {
    expect(PROMA_DEFAULT_PERMISSION_MODE).toBe('bypassPermissions')
    expect(migratePermissionMode('legacy-ask')).toBe(PROMA_DEFAULT_PERMISSION_MODE)
  })
})
