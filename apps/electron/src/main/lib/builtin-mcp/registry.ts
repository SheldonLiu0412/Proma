/**
 * Proma 内置 MCP 注册中心
 *
 * Orchestrator 只调用这里的统一入口；各内置 MCP 的可用性、注入条件和错误隔离
 * 都收敛在本模块，避免主编排流程继续膨胀。
 */

import type { AgentSessionMeta, PromaPermissionMode } from '@proma/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { isBuiltinMcpUserEnabled } from './settings'

export interface BuiltinMcpInjectContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceSlug?: string
  agentCwd?: string
  permissionMode?: PromaPermissionMode
  triggeredBy?: 'user' | 'automation' | 'delegation'
  sessionMeta?: AgentSessionMeta
}

async function buildBuiltinSafely(name: string, task: () => Promise<ToolDefinition[]>): Promise<ToolDefinition[]> {
  try {
    return await task()
  } catch (error) {
    console.error(`[Agent 编排] 构建内置 Pi 工具失败 (${name}):`, error)
    return []
  }
}

export async function buildBuiltinAgentTools(ctx: BuiltinMcpInjectContext): Promise<{ tools: ToolDefinition[]; collaborationAvailable: boolean }> {
  const tools: ToolDefinition[] = []

  if (isBuiltinMcpUserEnabled('nano-banana')) {
    const { buildNanoBananaAgentTools } = await import('../chat-tools/nano-banana-mcp')
    tools.push(...await buildBuiltinSafely('nano-banana', () => buildNanoBananaAgentTools(
      ctx.sessionId,
      ctx.agentCwd,
    )))
  }

  if (isBuiltinMcpUserEnabled('automation')) {
    const { buildAutomationAgentTools } = await import('../automation-agent-tools')
    tools.push(...await buildBuiltinSafely('automation', () => buildAutomationAgentTools({
      sessionId: ctx.sessionId,
      channelId: ctx.channelId,
      modelId: ctx.modelId,
      workspaceId: ctx.workspaceId,
      triggeredBy: ctx.triggeredBy,
    })))
  }

  const collaborationAvailable = isBuiltinMcpUserEnabled('collaboration') &&
    !!ctx.workspaceId &&
    ctx.triggeredBy !== 'delegation' &&
    (ctx.sessionMeta?.delegationDepth ?? 0) === 0

  if (collaborationAvailable) {
    const { buildAgentCollaborationTools } = await import('../agent-collaboration-tools')
    tools.push(...await buildBuiltinSafely('collaboration', () => buildAgentCollaborationTools({
      sessionId: ctx.sessionId,
      channelId: ctx.channelId,
      modelId: ctx.modelId,
      workspaceId: ctx.workspaceId,
      permissionMode: ctx.permissionMode,
      triggeredBy: ctx.triggeredBy,
    })))
  }

  return { tools, collaborationAvailable }
}
