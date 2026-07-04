import type { ProviderType } from '@proma/shared'

export const DEEPSEEK_SUBAGENT_MODEL_ID = 'deepseek-v4-flash'
export interface AgentModelRoutingInput {
  modelId?: string
  provider?: ProviderType
}

export interface AgentModelRoutingPolicy {
  /** 是否命中 DeepSeek 系列主模型 */
  deepSeekFamily: boolean
  /** 命中时 Proma 协作提示词建议使用的轻量子任务模型 */
  subagentModel?: string
}

/**
 * 解析 Agent 辅助模型路由策略。
 *
 * DeepSeek 系列主模型使用 deepseek-v4-flash 承担协作/子任务提示策略，
 * 避免复杂主模型被高频探索 / 审查子任务消耗。
 */
export function resolveAgentModelRouting(input: AgentModelRoutingInput): AgentModelRoutingPolicy {
  const model = input.modelId?.trim().toLowerCase() ?? ''
  const deepSeekFamily = input.provider === 'deepseek' ||
    model.startsWith('deepseek-') ||
    model.includes('/deepseek-')

  return {
    deepSeekFamily,
    ...(deepSeekFamily && { subagentModel: DEEPSEEK_SUBAGENT_MODEL_ID }),
  }
}
