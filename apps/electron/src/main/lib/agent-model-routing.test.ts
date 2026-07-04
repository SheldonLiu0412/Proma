import { describe, expect, test } from 'bun:test'
import {
  DEEPSEEK_SUBAGENT_MODEL_ID,
  resolveAgentModelRouting,
} from './agent-model-routing'

describe('Agent 辅助模型路由', () => {
  test('Given DeepSeek V4 Pro When 解析模型路由 Then SubAgent 固定到 DeepSeek V4 Flash', () => {
    const policy = resolveAgentModelRouting({
      modelId: 'deepseek-v4-pro',
      provider: 'deepseek',
    })

    expect(policy.deepSeekFamily).toBe(true)
    expect(policy.subagentModel).toBe(DEEPSEEK_SUBAGENT_MODEL_ID)
  })

  test('Given DeepSeek 兼容渠道模型 When 解析模型路由 Then 仍识别为 DeepSeek 系列', () => {
    const policy = resolveAgentModelRouting({
      modelId: 'gateway/deepseek-v4-pro',
      provider: 'custom',
    })

    expect(policy.deepSeekFamily).toBe(true)
    expect(policy.subagentModel).toBe(DEEPSEEK_SUBAGENT_MODEL_ID)
  })

  test('Given 非 DeepSeek 模型 When 解析模型路由 Then 不指定子任务模型', () => {
    const policy = resolveAgentModelRouting({
      modelId: 'claude-sonnet-4-6',
      provider: 'anthropic',
    })

    expect(policy.deepSeekFamily).toBe(false)
    expect(policy.subagentModel).toBeUndefined()
  })

  test('Given DeepSeek 模型 When 解析模型路由 Then 返回 Proma 子任务模型策略', () => {
    const policy = resolveAgentModelRouting({
      modelId: 'deepseek-v4-flash',
      provider: 'deepseek',
    })

    expect(policy.subagentModel).toBe(DEEPSEEK_SUBAGENT_MODEL_ID)
  })
})
