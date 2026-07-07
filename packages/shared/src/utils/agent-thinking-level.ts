import type { AgentEffort, AgentThinkingLevel, ThinkingConfig } from '../types/agent'

export const DEFAULT_AGENT_THINKING_LEVEL: AgentThinkingLevel = 'off'

const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === 'string' && AGENT_THINKING_LEVELS.includes(value as AgentThinkingLevel)
}

export function migrateLegacyAgentThinkingLevel(
  thinking?: ThinkingConfig,
  effort?: AgentEffort,
): AgentThinkingLevel {
  if (!thinking || thinking.type === 'disabled') return DEFAULT_AGENT_THINKING_LEVEL

  if (thinking.type === 'enabled') {
    const budget = thinking.budgetTokens
    if (budget <= 2048) return 'low'
    if (budget <= 8192) return 'medium'
    if (budget <= 16384) return 'high'
    return 'xhigh'
  }

  switch (effort) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'max':
      return 'xhigh'
    case 'high':
    default:
      return 'high'
  }
}

export function resolveAgentThinkingLevel(params: {
  agentThinkingLevel?: unknown
  agentThinking?: ThinkingConfig
  agentEffort?: AgentEffort
}): AgentThinkingLevel {
  if (isAgentThinkingLevel(params.agentThinkingLevel)) {
    return params.agentThinkingLevel
  }

  return migrateLegacyAgentThinkingLevel(params.agentThinking, params.agentEffort)
}
