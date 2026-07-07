import { describe, expect, test } from 'bun:test'
import {
  isAgentThinkingLevel,
  migrateLegacyAgentThinkingLevel,
  resolveAgentThinkingLevel,
} from './agent-thinking-level'

describe('Agent thinking level 设置迁移', () => {
  test('Given 已存在 Pi thinkingLevel When 解析设置 Then 直接使用该值', () => {
    expect(resolveAgentThinkingLevel({ agentThinkingLevel: 'minimal' })).toBe('minimal')
    expect(resolveAgentThinkingLevel({ agentThinkingLevel: 'xhigh' })).toBe('xhigh')
  })

  test('Given 未显式开启思考且旧默认 effort 为 high When 迁移 Then 结果为 off', () => {
    expect(resolveAgentThinkingLevel({ agentEffort: 'high' })).toBe('off')
  })

  test('Given 旧设置显式关闭思考 When 迁移 Then 结果为 off', () => {
    expect(migrateLegacyAgentThinkingLevel({ type: 'disabled' }, 'high')).toBe('off')
  })

  test('Given 旧 adaptive 思考开启 When 迁移 Then 使用 effort 控制等级', () => {
    expect(migrateLegacyAgentThinkingLevel({ type: 'adaptive' }, 'low')).toBe('low')
    expect(migrateLegacyAgentThinkingLevel({ type: 'adaptive' }, 'medium')).toBe('medium')
    expect(migrateLegacyAgentThinkingLevel({ type: 'adaptive' }, 'high')).toBe('high')
    expect(migrateLegacyAgentThinkingLevel({ type: 'adaptive' }, 'max')).toBe('xhigh')
    expect(migrateLegacyAgentThinkingLevel({ type: 'adaptive' })).toBe('high')
  })

  test('Given 旧固定预算思考 When 迁移 Then 映射到最接近的 Pi 等级', () => {
    expect(migrateLegacyAgentThinkingLevel({ type: 'enabled', budgetTokens: 2048 })).toBe('low')
    expect(migrateLegacyAgentThinkingLevel({ type: 'enabled', budgetTokens: 8192 })).toBe('medium')
    expect(migrateLegacyAgentThinkingLevel({ type: 'enabled', budgetTokens: 16384 })).toBe('high')
    expect(migrateLegacyAgentThinkingLevel({ type: 'enabled', budgetTokens: 20000 })).toBe('xhigh')
  })

  test('Given 非法 thinkingLevel When 校验 Then 返回 false', () => {
    expect(isAgentThinkingLevel('high')).toBe(true)
    expect(isAgentThinkingLevel('max')).toBe(false)
    expect(isAgentThinkingLevel(undefined)).toBe(false)
  })
})
