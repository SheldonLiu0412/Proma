/**
 * AgentOrchestrator — Agent 编排层
 *
 * 从 agent-service.ts 提取的核心业务逻辑，负责：
 * - 并发守卫（同一会话不允许并行请求）
 * - 渠道查找 + API Key 解密
 * - 环境变量构建 + SDK 路径解析
 * - 用户/助手消息持久化
 * - 事件流遍历 + 文本累积 + 事件持久化
 * - 错误处理 + 部分内容保存
 * - 自动标题生成
 *
 * 通过 EventBus 分发 AgentEvent，通过 SessionCallbacks 发送控制信号，
 * 完全解耦 Electron IPC，可独立测试（mock Adapter + EventBus）。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { AgentSendInput, AgentMessage, AgentGenerateTitleInput, AgentProviderAdapter, AgentSessionMeta, TypedError, RetryAttempt, SDKMessage, SDKAssistantMessage, AgentStreamPayload, RewindSessionResult } from '@proma/shared'
import {
  PROMA_DEFAULT_PERMISSION_MODE,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isSafeBashCommand,
  isPersistableSDKSystemMessage,
  normalizeMcpTransportType,
} from '@proma/shared'
import type { PermissionRequest, PromaPermissionMode, AskUserRequest, ExitPlanModeRequest, SDKSystemMessage } from '@proma/shared'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import { isPromptTooLongError, isThinkingSignatureError, isRuntimeNotFoundError, friendlyErrorMessage, mapSDKErrorToTypedError, extractErrorDetails } from './adapters/pi-agent-adapter'
import { isTransientNetworkError, isMalformedResponseError, isSessionNotFoundError } from './error-patterns'
import { AgentEventBus } from './agent-event-bus'
import { decryptApiKey, getChannelById, listChannels } from './channel-manager'
import { getAdapter, fetchTitle } from '@proma/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { appendSDKMessages, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages, getAgentSessionSDKMessages, truncateSDKMessages, resolveRewindUserMessageUuid, rewindFilesFromLegacySnapshot, removeSDKMessageByUuid, type LegacyFileHistoryRestoreResult } from './agent-session-manager'
import { getAgentWorkspace, getWorkspaceMcpConfig, getWorkspaceAutoMemoryDir, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles, getWorkspaceSkills, listAgentWorkspaces } from './agent-workspace-manager'
import { getAgentSessionMessagesPath, getAgentSessionsDir, getAgentSessionWorkspacePath, getAgentWorkspacePath, getSdkConfigDir, getWorkspaceFilesDir, getWorkspaceSkillsDir, getBundledCliPath, resolveWorkspaceFilesDir } from './config-paths'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { buildSystemPrompt, buildDynamicContext } from './agent-prompt-builder'
import { MAX_CONTEXT_MESSAGES, buildContextPrompt, buildRecoveryPrompt, buildReferencedSessionsPrompt } from './agent-session-context-prompt'
import { permissionService } from './agent-permission-service'
import type { PermissionResult, CanUseToolOptions } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService, type ExitPlanPermissionResult } from './agent-exit-plan-service'
import { removePromaAutoCompactSettings } from './agent-auto-compact-settings'
import { resolveAgentModelRouting } from './agent-model-routing'
import { validateToolInput } from './agent-tool-input-validator'
import { estimateTokenCount, WRITE_CONTENT_TOKEN_THRESHOLD } from './agent-tool-token-estimator'
import { buildBuiltinAgentTools } from './builtin-mcp/registry'
import { getBuiltinMcpDefinitions } from './builtin-mcp/baseline'
import { buildMcpBridgeTools, type McpBridgeBuildResult, type PromaMcpServerConfig } from './mcp-pi-bridge'
import { createAgentSidecarSnapshot, restoreAgentSidecarSnapshot, type AgentSidecarSnapshotRootInput, type AgentSidecarRestoreOptions, type AgentSidecarRestoreResult } from './agent-sidecar-snapshot'
import { buildAgentRuntimeEnv } from './agent-runtime-env'
import type { AgentTransportMode, AppSettings } from '../../types'

// ===== 类型定义 =====

/**
 * 会话控制信号回调
 *
 * 解耦 Electron webContents，使 Orchestrator 可独立测试。
 * agent-service.ts 负责将这些回调绑定到 webContents.send()。
 */
export interface SessionCallbacks {
  /** 发送流式错误 */
  onError: (error: string) => void
  /** 发送流式完成（携带已持久化的消息列表） */
  onComplete: (messages?: AgentMessage[], opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[]; backgroundTasksPending?: boolean }) => void
  /** 发送标题更新 */
  onTitleUpdated: (title: string) => void
  /** 用户消息已持久化，外部入口可据此通知前端切到实时会话 */
  onRunStarted?: (opts: { startedAt: number }) => void
}

// ===== 工具函数 =====

/**
 * 从错误诊断文本中提取 API 错误信息。
 *
 * Pi runtime 是 in-process adapter，没有旧 CLI stderr 通道；这里解析的是异常消息、
 * result.errors[] 等可用诊断拼出的文本。
 *
 * 解析类似这样的片段：
 * "401 {\"error\":{\"message\":\"...\"}}"
 * "API error: 400 Bad Request ..."
 */
function extractApiError(diagnosticText: string): { statusCode: number; message: string } | null {
  if (!diagnosticText) return null

  // 模式 1：JSON 错误格式 - "401 {...}"
  const jsonMatch = diagnosticText.match(/(\d{3})\s+(\{[^}]*"error"[^}]*\})/s)
  if (jsonMatch) {
    try {
      const statusCode = parseInt(jsonMatch[1]!)
      const errorObj = JSON.parse(jsonMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch {
      // JSON 解析失败，继续尝试其他模式
    }
  }

  // 模式 2：API error 格式 - "API error (attempt X/Y): 401 401 {...}"
  const apiErrorMatch = diagnosticText.match(/API error[^:]*:\s+(\d{3})\s+\d{3}\s+(\{.*?\})/s)
  if (apiErrorMatch) {
    try {
      const statusCode = parseInt(apiErrorMatch[1]!)
      const errorObj = JSON.parse(apiErrorMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch {
      // JSON 解析失败
    }
  }

  // 模式 3：直接的状态码 + 消息
  const simpleMatch = diagnosticText.match(/(\d{3})[:\s]+(.+?)(?:\n|$)/i)
  if (simpleMatch) {
    const statusCode = parseInt(simpleMatch[1]!)
    const message = simpleMatch[2]!.trim()
    if (statusCode >= 400 && statusCode < 600) {
      return { statusCode, message }
    }
  }

  return null
}

// ===== 自动重试工具函数 =====

/** 可自动重试的 TypedError 错误码 */
const AUTO_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'provider_error',      // overloaded 映射为 provider_error
  'service_error',
  'service_unavailable',
  'network_error',
])
const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g
const PI_AGENT_TRANSPORT_MODES: ReadonlySet<AgentTransportMode> = new Set([
  'sse',
  'websocket',
  'websocket-cached',
  'auto',
])

interface McpStartupAbortState {
  runToken: symbol
  controller: AbortController
}

/** 判断 typed_error 事件是否可自动重试 */
function isAutoRetryableTypedError(error: TypedError): boolean {
  return AUTO_RETRYABLE_ERROR_CODES.has(error.code)
}

function normalizeAgentTransportMode(value: unknown): AgentTransportMode | undefined {
  return typeof value === 'string' && PI_AGENT_TRANSPORT_MODES.has(value as AgentTransportMode)
    ? (value as AgentTransportMode)
    : undefined
}

function normalizeNonNegativeMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function buildPiRemoteConnectionOptions(
  settings: AppSettings,
): Pick<PiAgentQueryOptions, 'transport' | 'httpIdleTimeoutMs' | 'websocketConnectTimeoutMs'> {
  const transport = normalizeAgentTransportMode(settings.agentTransport)
  const httpIdleTimeoutMs = normalizeNonNegativeMs(settings.agentHttpIdleTimeoutMs)
  const websocketConnectTimeoutMs = normalizeNonNegativeMs(settings.agentWebsocketConnectTimeoutMs)
  return {
    ...(transport ? { transport } : {}),
    ...(httpIdleTimeoutMs !== undefined ? { httpIdleTimeoutMs } : {}),
    ...(websocketConnectTimeoutMs !== undefined ? { websocketConnectTimeoutMs } : {}),
  }
}

const READ_ONLY_TOOL_NAME_PREFIXES = [
  'list_',
  'get_',
  'read_',
  'fetch_',
  'search_',
  'query_',
  'lookup_',
  'history_',
  'wait_',
]

const PROMA_DYNAMIC_READ_ONLY_MCP_TOOLS = new Set([
  'mcp__feishu_chat__fetch_group_chat_history',
])

function getPiMcpShortToolName(toolName: string, serverName: string): string | null {
  const prefix = `mcp__${serverName}__`
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : null
}

function addKnownPromaReadOnlyToolNames(target: Set<string>, tools: ReadonlyArray<{ name: string }>): void {
  const builtinMcpDefinitions = getBuiltinMcpDefinitions()
  for (const tool of tools) {
    if (PROMA_DYNAMIC_READ_ONLY_MCP_TOOLS.has(tool.name)) {
      target.add(tool.name)
      continue
    }
    for (const definition of builtinMcpDefinitions) {
      const shortName = getPiMcpShortToolName(tool.name, definition.name)
      if (!shortName) continue
      const metadata = definition.tools.find((item) => item.name === shortName)
      if (metadata?.readOnly === true) {
        target.add(tool.name)
        break
      }
    }
  }
}

function isReadOnlyExternalToolName(toolName: string): boolean {
  if (
    toolName === 'TaskGet' ||
    toolName === 'TaskList' ||
    toolName === 'TodoRead' ||
    toolName === 'ListMcpResourcesTool' ||
    toolName === 'ReadMcpResourceTool' ||
    toolName === 'ListMcpResourceTemplatesTool' ||
    toolName === 'ListMcpPromptsTool' ||
    toolName === 'GetMcpPromptTool'
  ) return true
  if (toolName.startsWith('mcp__')) return false
  const normalized = toolName.toLowerCase()
  return READ_ONLY_TOOL_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function getFilePathFromWriteTool(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) return undefined
  return typeof input.file_path === 'string' ? input.file_path : undefined
}

function isPlanModeContextMarkdownWrite(toolName: string, input: Record<string, unknown>, agentCwd: string): boolean {
  const filePath = getFilePathFromWriteTool(toolName, input)
  if (!filePath || !filePath.toLowerCase().endsWith('.md')) return false

  const contextDir = resolve(agentCwd, '.context')
  const targetPath = resolve(agentCwd, filePath)
  const relativePath = relative(contextDir, targetPath)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

function getMessageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined
}

/** 判断 catch 块中的 API 错误是否可自动重试（HTTP 429 / 5xx / 已知可恢复错误模式 / 瞬时网络错误） */
function isAutoRetryableCatchError(
  apiError: { statusCode: number; message: string } | null,
  rawErrorMessage?: string,
  diagnosticText?: string,
): boolean {
  if (apiError) {
    // 529 是 Anthropic 的过载状态码，通常很快恢复；与 429 / 5xx 一并重试。
    if (apiError.statusCode === 429 || apiError.statusCode >= 500) return true
  }
  // 已知的可恢复错误模式（无 HTTP 状态码但可重试）
  if (rawErrorMessage) {
    if (rawErrorMessage.includes('context_management')) return true
  }
  // 兜底：extractApiError 未识别但诊断 / 错误文本中包含 502 / 529 或 overloaded 关键字时也视为可重试
  // 502 (Bad Gateway) 通常是上游网关瞬时异常，与 529 一样很快自行恢复
  const text = `${rawErrorMessage ?? ''}\n${diagnosticText ?? ''}`
  if (/\b502\b|\b529\b|overloaded/i.test(text)) return true
  // 瞬时网络错误（terminated / ECONNRESET / socket hang up 等）
  if (isTransientNetworkError(rawErrorMessage, diagnosticText)) return true
  // 上游响应体解析失败（JSON Parse error 等）：网关瞬时异常返回非 JSON 体，重试通常即可恢复
  if (isMalformedResponseError(rawErrorMessage, diagnosticText)) return true
  return false
}

/** 最大自动重试次数 */
const MAX_AUTO_RETRIES = 25

/** 重试可见性阈值：前 N 次重试不通知 UI，避免偶发瞬时波动频繁惊扰用户 */
const RETRY_VISIBILITY_THRESHOLD = 5

/** 自动重试累计等待预算（毫秒） */
const MAX_AUTO_RETRY_WAIT_MS = 5 * 60_000

/** 重试单次延迟上限（毫秒） */
const RETRY_MAX_DELAY_MS = 15_000

/**
 * 计算重试延迟（指数退避 + ±20% jitter）
 *
 * 基础序列：1s, 2s, 4s, 8s, 15s, 15s...（cap = 15s）
 * 叠加 ±20% 随机抖动，避免大量 session 同时重试造成惊群。
 * 累计等待会被限制在 5 分钟以内。
 */
function getRetryDelayMs(attempt: number, elapsedRetryDelayMs: number): number {
  const remainingMs = MAX_AUTO_RETRY_WAIT_MS - elapsedRetryDelayMs
  if (remainingMs <= 0) return 0

  const base = Math.min(1000 * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS)
  const jitter = base * (Math.random() * 0.4 - 0.2)
  return Math.min(remainingMs, Math.max(0, Math.round(base + jitter)))
}

/** 单条工具摘要最大字符数 */
const MAX_TOOL_SUMMARY_LENGTH = 200

function resolveMentionedSkillNames(workspaceSlug: string | undefined, mentionedSkills: string[] | undefined): string[] {
  const uniqueValues = [...new Set((mentionedSkills ?? []).map((value) => value.trim()).filter(Boolean))]
  if (uniqueValues.length === 0) return []
  if (!workspaceSlug) return uniqueValues

  try {
    const skills = getWorkspaceSkills(workspaceSlug)
    const byName = new Map(skills.map((skill) => [skill.name, skill.name]))
    const bySlug = new Map(skills.map((skill) => [skill.slug, skill.name]))
    return uniqueValues.map((value) => byName.get(value) ?? bySlug.get(value) ?? value)
  } catch (error) {
    console.warn('[Agent 编排] 解析 Skill mention 名称失败，保留原始引用:', error)
    return uniqueValues
  }
}

function extractSkillCommandNames(text: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(SKILL_COMMAND_PATTERN)) {
    const name = match[1]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function resolveCurrentSkillMentions(
  workspaceSlug: string | undefined,
  mentionedSkills: string[] | undefined,
  currentUserText: string,
  referencedSessionsBlock: string,
): string[] {
  return resolveMentionedSkillNames(workspaceSlug, [
    ...(mentionedSkills ?? []),
    ...extractSkillCommandNames(currentUserText),
    ...(referencedSessionsBlock.includes('/skill:session-cleaner') ? ['session-cleaner'] : []),
  ])
}

/** 标题生成 Prompt */
const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：'

/** 标题最大长度 */
const MAX_TITLE_LENGTH = 20

/** 默认会话标题（用于判断是否需要自动生成） */
const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/** 默认模型 ID */
const DEFAULT_MODEL_ID = 'claude-sonnet-5'

/**
 * 聚合一次 Agent 调用涉及的所有附加目录（去重，保持插入顺序）。
 *
 * 发消息（sendMessage）和 sidecar 快照都必须使用同一份聚合结果，
 * 否则 attachedDirectories 内的文件可能无法随 rewind 一起恢复。
 *
 * 来源：
 *   1. extraDirs：调用方传入的临时附加目录（例如 sendMessage 时用户当次提交的目录）
 *   2. 会话级 attachedDirectories + attachedFiles 的父目录
 *   3. 工作区级 attachedDirectories + attachedFiles 的父目录
 *   4. 工作区文件目录 workspace-files/
 */
function collectAttachedDirectories(params: {
  sessionMeta?: AgentSessionMeta
  workspaceSlug?: string
  extraDirs?: string[]
}): string[] {
  const { sessionMeta, workspaceSlug, extraDirs } = params
  const result: string[] = []
  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (!result.includes(dir)) result.push(dir)
  }

  for (const d of extraDirs ?? []) push(d)
  for (const d of sessionMeta?.attachedDirectories ?? []) push(d)
  for (const file of sessionMeta?.attachedFiles ?? []) push(dirname(file))

  if (workspaceSlug) {
    for (const d of getWorkspaceAttachedDirectories(workspaceSlug)) push(d)
    for (const f of getWorkspaceAttachedFiles(workspaceSlug)) push(dirname(f))
    push(getWorkspaceFilesDir(workspaceSlug))
  }

  return result
}

function collectRuntimeAdditionalDirectories(params: {
  sessionMeta?: AgentSessionMeta
  workspaceSlug?: string
  extraDirs?: string[]
}): string[] {
  const result = [...collectAttachedDirectories(params)]
  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (!result.includes(dir)) result.push(dir)
  }

  if (params.workspaceSlug) {
    // 允许 Agent 读取工作区根的 CLAUDE.md、.context/、.claude/memory/ 和 skills/。
    // 这些目录不进入 sidecar 快照，避免每轮复制整棵工作区。
    push(getAgentWorkspacePath(params.workspaceSlug))
  }
  // 允许 session-cleaner / 恢复 prompt 读取完整历史 JSONL。
  push(getAgentSessionsDir())

  return result
}

function buildSidecarSnapshotRoots(
  ownedCwd: string,
  attachedDirectories: string[],
): AgentSidecarSnapshotRootInput[] {
  return [
    { path: ownedCwd, kind: 'owned-session-cwd' },
    ...attachedDirectories.map((path) => ({
      path,
      kind: 'shared-root' as const,
    })),
  ]
}

function buildSessionCwdMap(sessionId: string, cwd: string): Map<string, string> {
  return new Map([[sessionId, cwd]])
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

function collectLegacySdkSessionIds(sessionMeta: AgentSessionMeta, assistantMessageUuid?: string): string[] {
  const messages = getAgentSessionSDKMessages(sessionMeta.id)
  const targetMessage = assistantMessageUuid
    ? messages.find((message) => 'uuid' in message && (message as { uuid?: string }).uuid === assistantMessageUuid)
    : undefined
  const targetSdkSessionId = targetMessage && 'session_id' in targetMessage
    ? (targetMessage as { session_id?: string }).session_id
    : undefined
  const historicalSdkSessionIds = messages
    .map((message) => 'session_id' in message ? (message as { session_id?: string }).session_id : undefined)

  return uniqueNonEmpty([
    targetSdkSessionId,
    sessionMeta.legacySdkSessionId,
    sessionMeta.forkSourceSdkSessionId,
    sessionMeta.sdkSessionId,
    ...historicalSdkSessionIds,
  ])
}

function buildWorkspaceFilesRootPathMap(targetWorkspaceSlug?: string): Map<string, string> {
  const map = new Map<string, string>()
  const targetWorkspaceFiles = targetWorkspaceSlug ? resolve(resolveWorkspaceFilesDir(targetWorkspaceSlug)) : undefined
  for (const workspace of listAgentWorkspaces()) {
    const sourceWorkspaceFiles = resolve(resolveWorkspaceFilesDir(workspace.slug))
    map.set(sourceWorkspaceFiles, targetWorkspaceFiles ?? sourceWorkspaceFiles)
  }
  return map
}

function buildSidecarRestoreOptions(params: {
  sessionId: string
  currentSessionCwd?: string
  sessionMeta: AgentSessionMeta
  workspaceSlug?: string
  extraRootPathMap?: Map<string, string>
}): AgentSidecarRestoreOptions | undefined {
  const { sessionId, currentSessionCwd, sessionMeta, workspaceSlug, extraRootPathMap } = params
  const rootPathMap = buildWorkspaceFilesRootPathMap(workspaceSlug)
  for (const dir of collectAttachedDirectories({ sessionMeta, workspaceSlug })) {
    const resolved = resolve(dir)
    rootPathMap.set(resolved, resolved)
  }
  for (const [source, target] of extraRootPathMap ?? new Map<string, string>()) {
    rootPathMap.set(resolve(source), resolve(target))
  }

  if (!currentSessionCwd && rootPathMap.size === 0) return undefined

  return {
    ...(currentSessionCwd ? { sessionCwdById: buildSessionCwdMap(sessionId, currentSessionCwd) } : {}),
    rootPathMap,
    restoreUnmappedRoots: false,
  }
}

function isMissingSidecarError(error?: string): boolean {
  if (!error) return false
  return error.includes('未找到 Proma sidecar 快照') || error.includes('Proma sidecar 快照没有可恢复')
}

// ===== AgentOrchestrator =====

export class AgentOrchestrator {
  private adapter: AgentProviderAdapter
  private eventBus: AgentEventBus
  private activeSessions = new Map<string, symbol>()

  /** 队列消息本地记录（sessionId → UUID 集合，用于防重） */
  private queuedMessageUuids = new Map<string, Set<string>>()

  /** 被用户手动中止的运行 token 集合（在 stop 中标记，终态路径中消费） */
  private stoppedRunTokens = new Set<symbol>()

  /** 运行中会话的当前权限模式（支持运行时动态切换） */
  private sessionPermissionModes = new Map<string, PromaPermissionMode>()

  /** MCP 远程连接启动阶段的取消控制器；adapter query 尚未创建时 stop 依赖它打断 connect/listTools */
  private mcpStartupAbortControllers = new Map<string, McpStartupAbortState>()

  constructor(adapter: AgentProviderAdapter, eventBus: AgentEventBus) {
    this.adapter = adapter
    this.eventBus = eventBus
  }

  private registerMcpStartupAbortController(sessionId: string, runToken: symbol): AbortSignal {
    const controller = new AbortController()
    this.mcpStartupAbortControllers.set(sessionId, { runToken, controller })
    return controller.signal
  }

  private clearMcpStartupAbortController(sessionId: string, runToken: symbol): void {
    const state = this.mcpStartupAbortControllers.get(sessionId)
    if (state?.runToken === runToken) {
      this.mcpStartupAbortControllers.delete(sessionId)
    }
  }

  private abortMcpStartup(sessionId: string, runToken: symbol | undefined): void {
    const state = this.mcpStartupAbortControllers.get(sessionId)
    if (!state || (runToken && state.runToken !== runToken)) return
    state.controller.abort()
    this.mcpStartupAbortControllers.delete(sessionId)
  }

  /**
   * 消费一次用户手动停止标记。
   *
   * SDK 在 query.close() 后不一定走异常路径：某些版本会先正常 yield result 再结束迭代。
   * 因此停止标记必须在所有终态路径统一消费，而不能只依赖 catch 块。
   */
  private consumeStoppedByUser(runToken: symbol): boolean {
    const stoppedByUser = this.stoppedRunTokens.has(runToken)
    this.stoppedRunTokens.delete(runToken)
    return stoppedByUser
  }

  /**
   * 构建工作区 MCP 服务器配置
   */
  private buildMcpServers(workspaceSlug: string | undefined): Record<string, PromaMcpServerConfig> {
    const mcpServers: Record<string, PromaMcpServerConfig> = {}
    if (!workspaceSlug) return mcpServers

    const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
    for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
      if (!entry.enabled) continue
      if (name === 'memos-cloud') continue
      const type = normalizeMcpTransportType((entry as { type?: unknown }).type)

      if (type === 'stdio' && entry.command) {
        mcpServers[name] = {
          type: 'stdio',
          command: entry.command,
          ...(entry.args && entry.args.length > 0 && { args: entry.args }),
          ...(entry.env && Object.keys(entry.env).length > 0 && { env: entry.env }),
          ...(entry.cwd && { cwd: entry.cwd }),
          required: false,
          startup_timeout_sec: entry.startup_timeout_sec ?? entry.timeout ?? 30,
          ...(entry.tool_timeout_sec !== undefined && { tool_timeout_sec: entry.tool_timeout_sec }),
        }
      } else if ((type === 'http' || type === 'sse' || type === 'websocket') && entry.url) {
        mcpServers[name] = {
          type,
          url: entry.url,
          ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
          ...(entry.startup_timeout_sec !== undefined && { startup_timeout_sec: entry.startup_timeout_sec }),
          ...(entry.timeout !== undefined && { timeout: entry.timeout }),
          ...(entry.tool_timeout_sec !== undefined && { tool_timeout_sec: entry.tool_timeout_sec }),
          ...(entry.sessionId && { sessionId: entry.sessionId }),
          ...(entry.reconnectionOptions && { reconnectionOptions: entry.reconnectionOptions }),
          ...(entry.auth && { auth: entry.auth }),
          required: false,
        }
      } else {
        console.warn(`[Agent 编排] MCP 服务器 "${name}" 配置不完整，已跳过（type=${entry.type}, command=${entry.command ?? '无'}, url=${entry.url ?? '无'}）`)
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      console.log(`[Agent 编排] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
    }

    return mcpServers
  }

  /**
   * 生成 Agent 会话标题
   *
   * 使用 Provider 适配器系统，支持所有渠道。任何错误返回 null。
   */
  async generateTitle(input: AgentGenerateTitleInput): Promise<string | null> {
    const { userMessage, channelId, modelId } = input
    console.log('[Agent 标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

    try {
      const channels = listChannels()
      const channel = channels.find((c) => c.id === channelId)
      if (!channel) {
        console.warn('[Agent 标题生成] 渠道不存在:', channelId)
        return null
      }

      const apiKey = decryptApiKey(channelId)
      const providerAdapter = getAdapter(channel.provider)
      const request = providerAdapter.buildTitleRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        prompt: TITLE_PROMPT + userMessage,
      })

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)
      const title = await fetchTitle(request, providerAdapter, fetchFn)
      if (!title) {
        console.warn('[Agent 标题生成] API 返回空标题')
        return null
      }

      const cleaned = title.trim().replace(/^["'""''「《]+|["'""''」》]+$/g, '').trim()
      const result = cleaned.slice(0, MAX_TITLE_LENGTH) || null

      console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
      return result
    } catch (error) {
      console.warn('[Agent 标题生成] 生成失败:', error)
      return null
    }
  }

  /**
   * 流完成后自动生成标题
   *
   * 如果会话标题仍为默认值，自动调用标题生成并通过回调通知。
   */
  private async autoGenerateTitle(
    sessionId: string,
    userMessage: string,
    channelId: string,
    modelId: string,
    callbacks: SessionCallbacks,
  ): Promise<void> {
    try {
      const meta = getAgentSessionMeta(sessionId)
      if (!meta || meta.title !== DEFAULT_SESSION_TITLE) return

      const title = await this.generateTitle({ userMessage, channelId, modelId })
      if (!title) return

      const latestMeta = getAgentSessionMeta(sessionId)
      if (!latestMeta || latestMeta.title !== DEFAULT_SESSION_TITLE) {
        console.log('[Agent 编排] 自动标题生成已跳过：会话标题已被更新')
        return
      }

      updateAgentSessionMeta(sessionId, { title })
      callbacks.onTitleUpdated(title)
      console.log(`[Agent 编排] 自动标题生成完成: "${title}"`)
    } catch (error) {
      console.warn('[Agent 编排] 自动标题生成失败:', error)
    }
  }

  /**
   * Session-not-found 恢复：保留磁盘 sdkSessionId，本轮切换到上下文回填模式
   *
   * 当 resume 的目标 session 报 "No conversation found" 时触发。注意该错误可能是
   * listSessions 路径哈希不匹配导致的误检（见步骤 9.6 注释），不代表会话真正失效，
   * 因此不清除磁盘 meta：本轮以非 resume 模式恢复，若失败下一轮仍可尝试 resume（#903）。
   * 调用方负责设置本地 existingSdkSessionId = undefined 和流程控制（break/continue）。
   *
   * @returns lastRetryableError 描述字符串
   */
  private prepareSessionNotFoundRecovery(
    sessionId: string,
    queryOptions: PiAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
  ): string {
    return this.prepareResumeFallbackRecovery(
      sessionId,
      queryOptions,
      contextualMessage,
      agentCwd,
      workspaceSlug,
      accumulatedMessages,
      queryStartedAt,
      '检测到 session-not-found（可能为误检），保留 sdkSessionId 并切换到上下文回填模式',
      'Session 暂不可 resume，切换到上下文回填模式',
    )
  }

  /**
   * Resume 失败恢复：本轮切到「非 resume + 历史回填恢复」模式，注入 session 自引用让 Agent
   * 优先通过 session-cleaner 读取干净历史继续工作。使用 <session_recovery> 标签指向当前会话，
   * 比 buildContextPrompt（仅注入 20 条摘要）提供完整得多的上下文连续性。
   *
   * 关于磁盘 meta 的 sdkSessionId（由 clearPersistedSession 控制，默认 false 即保留）：
   * - 默认保留：本轮恢复只改本地 queryOptions，不动磁盘；若本轮成功，SDK 新会话的 ID 会经
   *   onSessionId 回调自动覆盖 meta；若本轮失败到终止，下一轮仍可尝试 resume 旧 ID（#903）。
   *   这是「迷了就别删」的安全默认，适用于 session-not-found（可能为误检）等不确定场景。
   * - 仅 thinking-signature 跨模型不兼容时传 true：旧 ID 指向的 JSONL 焊死了旧模型思考块，
   *   当前模型 resume 必然再次失败，此时主动清除可避免下一轮无谓的失败往返。
   */
  private prepareResumeFallbackRecovery(
    sessionId: string,
    queryOptions: PiAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
    logMessage: string,
    retryReason: string,
    clearPersistedSession = false,
  ): string {
    console.log(`[Agent 编排] ${logMessage}`)
    // 先持久化当前已累积的消息，确保 JSONL 文件包含最新内容
    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
    accumulatedMessages.length = 0
    // 仅在确定旧会话永久无效时（thinking-signature）才清除磁盘 meta；
    // 其余场景保留，新 runtime 会话产生的 sdkSessionId 会通过 onSessionId 回调自动覆盖。
    if (clearPersistedSession) {
      try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
    }
    queryOptions.resumeSessionId = undefined
    queryOptions.prompt = buildRecoveryPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })
    return retryReason
  }

  /**
   * 持久化累积的 SDKMessage（Phase 4: 直接存储原始 SDKMessage）
   *
   * 只持久化 assistant、user、result 和需要长期可见的 system 消息。
   */
  private persistSDKMessages(
    sessionId: string,
    accumulatedMessages: SDKMessage[],
    durationMs?: number,
  ): void {
    if (accumulatedMessages.length === 0) return

    const hasCompactBoundary = accumulatedMessages.some((m) => {
      return m.type === 'system' && (m as SDKSystemMessage).subtype === 'compact_boundary'
    })

    const toPersist = accumulatedMessages.filter(
      (m) => m.type === 'assistant' || m.type === 'user' || m.type === 'result'
        || (m.type === 'system' && isPersistableSDKSystemMessage(m as SDKSystemMessage))
    ).filter((m) => {
      if (isPartialSDKMessage(m)) return false
      if (m.type === 'system') {
        const sysMsg = m as SDKSystemMessage
        if (hasCompactBoundary && sysMsg.subtype === 'status' && sysMsg.compact_result === 'success') {
          return false
        }
      }
      // 过滤 SDK 内部生成的 user 文本消息（如 Skill 展开 prompt），与实时流过滤逻辑一致
      if (m.type === 'user') {
        const content = (m as { message?: { content?: Array<{ type: string }> } }).message?.content
        const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
        if (!hasToolResult) return false
      }
      return true
    })

    if (toPersist.length === 0) return

    // 为没有 _createdAt 的消息补上时间戳（assistant 消息来自 SDK 原始输出，不含时间）
    const now = Date.now()
    const withTimestamps = toPersist.map((m) => {
      const msg = m as Record<string, unknown>
      if (typeof msg._createdAt === 'number') return m
      // 为 result 消息附加 _durationMs
      if (m.type === 'result' && durationMs != null) {
        return { ...m, _createdAt: now, _durationMs: durationMs } as unknown as SDKMessage
      }
      return { ...m, _createdAt: now } as unknown as SDKMessage
    })

    appendSDKMessages(sessionId, withTimestamps)
  }

  /**
   * 发送消息并流式推送事件
   *
   * 核心编排方法，从 agent-service.ts 的 runAgent 提取。
   * 通过 EventBus 分发 AgentEvent，通过 callbacks 发送控制信号。
   */
  async sendMessage(input: AgentSendInput, callbacks: SessionCallbacks): Promise<void> {
    const { sessionId, userMessage, channelId, modelId, workspaceId, additionalDirectories, customMcpServers, permissionModeOverride, mentionedSkills, mentionedMcpServers, mentionedSessionIds, automationContext } = input
    const diagnosticChunks: string[] = []

    // 0. 并发保护
    if (this.activeSessions.has(sessionId)) {
      console.warn(`[Agent 编排] 会话 ${sessionId} 正在处理中，拒绝新请求`)
      callbacks.onError('上一条消息仍在处理中，请稍候再试')
      callbacks.onComplete([], { startedAt: input.startedAt })
      return
    }

    // 0.5 清除上一轮中断标记
    try { updateAgentSessionMeta(sessionId, { stoppedByUser: false }) } catch { /* 会话可能已删除 */ }

    // 环境 / 配置类错误的统一上报：持久化为 TypedError 消息，由 SDKMessageRenderer 渲染
    const reportPreflightError = (typedError: TypedError) => {
      const errorContent = typedError.title
        ? `${typedError.title}: ${typedError.message}`
        : typedError.message
      const errorSDKMsg: SDKMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: errorContent }],
        },
        parent_tool_use_id: null,
        error: { message: typedError.message, errorType: typedError.code },
        _createdAt: Date.now(),
        _errorCode: typedError.code,
        _errorTitle: typedError.title,
        _errorDetails: typedError.details,
        _errorCanRetry: typedError.canRetry,
        _errorActions: typedError.actions,
      } as unknown as SDKMessage
      try { appendSDKMessages(sessionId, [errorSDKMsg]) } catch (e) {
        console.error('[Agent 编排] 持久化 preflight error 失败:', e)
      }
      callbacks.onError(errorContent)
      callbacks.onComplete([], { startedAt: input.startedAt })
    }

    // 1. Windows 平台：检查 Shell 环境可用性
    if (process.platform === 'win32') {
      const runtimeStatus = getRuntimeStatus()
      const shellStatus = runtimeStatus?.shell

      if (shellStatus && !shellStatus.gitBash?.available && !shellStatus.wsl?.available) {
        reportPreflightError({
          code: 'windows_shell_missing',
          title: 'Windows 环境未就绪',
          message:
            '需要 Git Bash 或 WSL 才能运行 Agent。建议安装 Git for Windows（自带 Git Bash），安装完成后点「打开环境检测」刷新状态。',
          details: [
            `Git Bash: ${shellStatus.gitBash?.error || '未检测到'}`,
            `WSL: ${shellStatus.wsl?.error || '未检测到'}`,
          ],
          actions: [
            { key: 'e', label: '打开环境检测', action: 'open_environment_check' },
            { key: 'g', label: '去官方下载 Git', action: 'open_external', payload: 'https://git-scm.com/download/win' },
          ],
          canRetry: false,
        })
        return
      }
    }

    // 2. 获取渠道信息并解密 API Key
    const channel = getChannelById(channelId)
    if (!channel) {
      reportPreflightError({
        code: 'channel_not_found',
        title: '渠道不存在',
        message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    let apiKey: string
    try {
      apiKey = decryptApiKey(channelId)
    } catch {
      reportPreflightError({
        code: 'api_key_decrypt_failed',
        title: 'API Key 解密失败',
        message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    // 2.1 立即抢占会话槽位（在所有同步检查通过后、第一个 await 之前）
    // 防止首个 await 期间并发调用绕过上方的检查，导致多条重复消息写入 JSONL
    // finally 块会通过 generation 匹配来安全清理，不影响正常流程
    const runToken = Symbol(sessionId)
    // 优先使用渲染进程传来的 startedAt（确保 STREAM_COMPLETE 竞态保护比较的是同一个值），
    // 否则用本地时间戳作为回退（headless 模式等无渲染进程场景）。
    const streamStartedAt = input.startedAt ?? Date.now()
    this.activeSessions.set(sessionId, runToken)
    const mcpStartupSignal = this.registerMcpStartupAbortController(sessionId, runToken)

    const hasNewerRun = (): boolean => {
      const activeRun = this.activeSessions.get(sessionId)
      return activeRun !== undefined && activeRun !== runToken
    }
    const isCurrentRunActive = (): boolean => this.activeSessions.get(sessionId) === runToken
    const releaseActiveRun = (): void => {
      // 在发送 STREAM_COMPLETE 前释放 active slot，避免渲染进程已进入空闲态、
      // 主进程仍在 finally 前短暂拒绝下一条消息。
      if (this.activeSessions.get(sessionId) !== runToken) return
      this.activeSessions.delete(sessionId)
      this.sessionPermissionModes.delete(sessionId)
      this.queuedMessageUuids.delete(sessionId)
      this.clearMcpStartupAbortController(sessionId, runToken)
    }
    const completeRun = (
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onComplete(messages, opts)
    }
    const failRun = (
      error: string,
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onError(error)
      callbacks.onComplete(messages, opts)
    }
    const completePreQueryStoppedRun = (): void => {
      const wasStoppedByUser = this.consumeStoppedByUser(runToken)
      if (!hasNewerRun()) {
        try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
      }
      completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
    }

    const modelRouting = resolveAgentModelRouting({ modelId: modelId || DEFAULT_MODEL_ID, provider: channel.provider })

    // 3. 读取已有的 SDK session ID（用于 resume）
    const sessionMeta = getAgentSessionMeta(sessionId)
    let existingSdkSessionId = sessionMeta?.sdkSessionId

    // 3.1 兼容旧元数据：Pi 迁移后不再使用 resumeAtMessageUuid，
    // 回退会清空 sdkSessionId 并通过 Proma 历史回填上下文。
    if (sessionMeta?.resumeAtMessageUuid) {
      updateAgentSessionMeta(sessionId, { resumeAtMessageUuid: undefined, sdkSessionId: undefined })
      existingSdkSessionId = undefined
      console.log('[Agent 编排] 已清理旧 resumeAtMessageUuid，切换到 Proma 历史回填模式')
    }

    console.log(`[Agent 编排] Resume 状态: sdkSessionId=${existingSdkSessionId || '无'}, proma sessionId=${sessionId}`)

    // 5. 持久化用户消息（SDKMessage 格式）
    const userMessageUuid = randomUUID()
    const userSDKMsg: SDKMessage = {
      type: 'user',
      message: {
        content: [{ type: 'text', text: userMessage }],
      },
      parent_tool_use_id: null,
      uuid: userMessageUuid,
      _createdAt: Date.now(),
    } as unknown as SDKMessage
    try {
      appendSDKMessages(sessionId, [userSDKMsg])
      callbacks.onRunStarted?.({ startedAt: streamStartedAt })
    } catch (error) {
      releaseActiveRun()
      throw error
    }

    // 6. 状态初始化
    const accumulatedMessages: SDKMessage[] = []
    let resolvedModel = modelId || DEFAULT_MODEL_ID
    let titleGenerationStarted = false
    let agentCwd: string | undefined
    let workspaceSlug: string | undefined
    let workspace: import('@proma/shared').AgentWorkspace | undefined
    const toolCleanups: Array<() => Promise<void>> = []

    try {
      console.log(
        `[Agent 编排] 启动 Pi SDK — 模型: ${modelId || DEFAULT_MODEL_ID}, resume: ${existingSdkSessionId ?? '无'}`,
      )

      // 确定 Agent 工作目录
      agentCwd = homedir()
      workspaceSlug = undefined
      workspace = undefined
      if (workspaceId) {
        const ws = getAgentWorkspace(workspaceId)
        if (ws) {
          agentCwd = getAgentSessionWorkspacePath(ws.slug, sessionId)
          workspaceSlug = ws.slug
          workspace = ws
          console.log(`[Agent 编排] 使用 session 级别 cwd: ${agentCwd} (${ws.name}/${sessionId})`)

          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 将尝试 resume: ${existingSdkSessionId}`)
          } else {
            console.log(`[Agent 编排] 无 sdkSessionId，将作为新会话启动（回填历史上下文）`)
          }
        }
      }

      // 9.4.1 Fork session JSONL 迁移已在 forkAgentSession 中完成，
      // fork 后的会话直接使用自己的 cwd，无需回退到源目录。
      // forkSourceDir 仅作为备用参考字段保留，不再影响 agentCwd。

      // 9.5 Pi SDK 不再读取 .claude/settings.json；Proma 继续使用 .context 目录承载计划和会话上下文。

      // 9.6 直接信任已保存的 sdkSessionId，跳过 listSessions 预验证
      // 原因：listSessions({ dir }) 基于 cwd 路径哈希查找，但 session 级别的 cwd
      // （如 ~/.proma/agent-workspaces/workspace-xxx/sessionId）与 SDK 内部存储的路径哈希可能不匹配，
      // 导致 listSessions 始终返回 0 个会话，误杀有效的 resume。
      // SDK 本身会优雅处理无效的 resume ID（回退为新会话），无需预验证。
      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 将直接使用已保存的 sdkSessionId 进行 resume: ${existingSdkSessionId}`)
      }

      const allAttachedDirectories = collectAttachedDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })
      const runtimeAdditionalDirectories = collectRuntimeAdditionalDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })

      try {
        await createAgentSidecarSnapshot({
          sessionId,
          messageUuid: userMessageUuid,
          roots: buildSidecarSnapshotRoots(agentCwd, allAttachedDirectories),
        })
      } catch (error) {
        console.warn('[Agent 编排] 创建 Proma sidecar 快照失败，当前轮次仍继续执行:', error)
      }

      // 10. 构建 Pi customTools：内置工具 + 工作区 MCP bridge + 动态注入工具
      const builtinToolsResult = await buildBuiltinAgentTools({
        sessionId,
        channelId,
        modelId,
        workspaceId,
        workspaceSlug,
        agentCwd,
        permissionMode: permissionModeOverride ?? sessionMeta?.permissionMode ?? PROMA_DEFAULT_PERMISSION_MODE,
        triggeredBy: input.triggeredBy,
        sessionMeta,
      })
      const customTools = [...builtinToolsResult.tools]
      const collaborationAvailable = builtinToolsResult.collaborationAvailable
      const proxyUrl = await getEffectiveProxyUrl()
      const runtimeEnv = buildAgentRuntimeEnv({ proxyUrl, runtimeStatus: getRuntimeStatus() })
      const readOnlyExternalTools = new Set<string>()

      const mcpServers = this.buildMcpServers(workspaceSlug)
      if (customMcpServers) {
        for (const [name, server] of Object.entries(customMcpServers)) {
          const piTools = (server as { __promaPiTools?: unknown }).__promaPiTools
          if (Array.isArray(piTools)) {
            customTools.push(...(piTools as NonNullable<PiAgentQueryOptions['customTools']>))
            console.log(`[Agent 编排] 已合并动态 Pi 工具: ${name} (${piTools.length} 个)`)
          } else if (typeof server.type === 'string') {
            mcpServers[name] = server as unknown as PromaMcpServerConfig
            console.log(`[Agent 编排] 已合并动态 MCP server: ${name}`)
          }
        }
      }

      if (Object.keys(mcpServers).length > 0) {
        const fetchFn = getFetchFn(proxyUrl)
        let bridgeResult: McpBridgeBuildResult
        try {
          bridgeResult = await buildMcpBridgeTools(mcpServers, fetchFn, agentCwd, runtimeEnv.env, mcpStartupSignal)
        } catch (error) {
          if (mcpStartupSignal.aborted || !isCurrentRunActive()) {
            console.log(`[Agent 编排] 会话 ${sessionId} 在 MCP 初始化阶段已被用户中止`)
            completePreQueryStoppedRun()
            return
          }
          throw error
        }
        customTools.push(...bridgeResult.tools)
        for (const toolName of bridgeResult.readOnlyToolNames) {
          readOnlyExternalTools.add(toolName)
        }
        toolCleanups.push(bridgeResult.cleanup)
      }
      this.clearMcpStartupAbortController(sessionId, runToken)
      if (!isCurrentRunActive()) {
        console.log(`[Agent 编排] 会话 ${sessionId} 在进入 Pi query 前已被用户中止`)
        completePreQueryStoppedRun()
        return
      }
      addKnownPromaReadOnlyToolNames(readOnlyExternalTools, customTools)

      // 11. 构建动态上下文和最终 prompt
      const dynamicCtx = buildDynamicContext({
        workspaceName: workspace?.name,
        workspaceSlug,
        agentCwd,
        additionalDirectories: runtimeAdditionalDirectories,
      })

      // 11.5 注入 mention 引用指令（Skill/MCP/会话）— 仅影响 prompt，不影响持久化
      let enrichedMessage = userMessage
      const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceId)
      const mentionedSkillNames = resolveCurrentSkillMentions(
        workspaceSlug,
        mentionedSkills,
        userMessage,
        referencedSessionsBlock,
      )
      if (referencedSessionsBlock) {
        enrichedMessage = `${referencedSessionsBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_sessions: ${mentionedSessionIds?.length ?? 0} sessions`)
      }
      if (mentionedSkillNames.length || mentionedMcpServers?.length) {
        const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
        for (const skillName of mentionedSkillNames) {
          toolLines.push(`- Skill: ${skillName}（请立即使用 /skill:${skillName} 展开并执行）`)
        }
        for (const name of mentionedMcpServers ?? []) {
          toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
        }
        enrichedMessage = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 mentioned_tools: ${mentionedSkillNames.length} skills, ${mentionedMcpServers?.length ?? 0} MCP`)
      }

      const contextualMessage = `${dynamicCtx}\n\n${enrichedMessage}`

      const isCompactCommand = userMessage.trim() === '/compact'
      const finalPrompt = isCompactCommand
        ? '/compact'
        : existingSdkSessionId
          ? contextualMessage
          : buildContextPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })

      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`)
      } else if (finalPrompt !== contextualMessage) {
        console.log(`[Agent 编排] 无 resume，已回填历史上下文（最近 ${MAX_CONTEXT_MESSAGES} 条消息）`)
      }

      // 12. 读取应用设置并确定权限模式
      // 权限模式只属于当前 session；新会话默认完全自动模式。
      const appSettings = getSettings()
      const initialPermissionMode: PromaPermissionMode = permissionModeOverride
        ?? sessionMeta?.permissionMode
        ?? PROMA_DEFAULT_PERMISSION_MODE
      // 注册到 Map，支持运行中动态切换
      this.sessionPermissionModes.set(sessionId, initialPermissionMode)
      console.log(`[Agent 编排] 权限模式: ${initialPermissionMode}${permissionModeOverride ? '（外部覆盖）' : ''}`)

      const emitPlanModeChanged = (active: boolean, source: 'initial' | 'tool' | 'permission'): void => {
        this.eventBus.emit(sessionId, {
          kind: 'proma_event',
          event: { type: 'plan_mode_changed', sessionId, active, source },
        })
      }

      // 当初始模式为 plan 时，通知渲染进程展示计划模式 UI（如「Agent 正在规划」横幅）
      if (initialPermissionMode === 'plan') {
        this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'enter_plan_mode', sessionId } })
        emitPlanModeChanged(true, 'initial')
      }

      /** 读取当前会话的实时权限模式（支持运行中切换） */
      const getPermissionMode = (): PromaPermissionMode =>
        this.sessionPermissionModes.get(sessionId) ?? initialPermissionMode

      // ExitPlanMode 拦截器：plan 模式下走 UI 审批流程
      const handleExitPlanMode = (toolInput: Record<string, unknown>, signal: AbortSignal): Promise<ExitPlanPermissionResult> => {
        return exitPlanService.handleExitPlanMode(
          sessionId,
          toolInput,
          signal,
          (request: ExitPlanModeRequest) => {
            this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'exit_plan_mode_request', request } })
          },
        )
      }

      /**
       * 判断 Bash 命令是否是只读的（计划模式下安全可执行）
       * 复用 Proma 权限规则，避免计划模式和自动审批使用不同的安全边界。
       */
      const isBashCommandReadOnly = (command: string): boolean => isSafeBashCommand(command)

      // Plan 模式下允许的只读工具（不包含 Write/Edit/Bash 等写操作）
      const PLAN_MODE_ALLOWED_TOOLS = new Set([
        'Read', 'LS', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        'Agent', 'TodoRead', 'TodoWrite', 'TaskOutput',
        'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
        'ListMcpResourcesTool', 'ReadMcpResourceTool',
        'ListMcpResourceTemplatesTool', 'ListMcpPromptsTool', 'GetMcpPromptTool',
      ])
      const DEFERRED_OR_PROACTIVE_TOOLS = new Set([
        'REPL', 'Workflow', 'ScheduleWakeup', 'Monitor', 'PushNotification',
        'CronCreate', 'CronDelete', 'RemoteTrigger',
      ])

      /** Plan 模式是否已被 Agent 进入（初始 plan 模式时天然为 true，其他模式需 EnterPlanMode 触发） */
      let planModeEntered = initialPermissionMode === 'plan'

      const autoCanUseTool = permissionService.createCanUseTool(
        sessionId,
        (request: PermissionRequest) => {
          this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'permission_request', request } })
        },
        undefined,
        undefined,
        readOnlyExternalTools,
      )

      const syncPlanModeFromToolUse = (toolName: string): void => {
        if (toolName === 'EnterPlanMode') {
          planModeEntered = true
          emitPlanModeChanged(true, 'tool')
          return
        }
        if (toolName === 'ExitPlanMode' && getPermissionMode() === 'bypassPermissions') {
          planModeEntered = false
          emitPlanModeChanged(false, 'tool')
          return
        }
        // auto/plan 下 ExitPlanMode 只是发起退出计划的审批请求。
        // 真正退出由用户审批结果触发，不能在工具开始时提前清掉计划态。
      }

      // 动态 canUseTool：每次调用读取当前权限模式，支持运行中切换
      const canUseTool = async (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): Promise<PermissionResult> => {
        const currentMode = getPermissionMode()

        // ── 参数校验守卫（所有模式、所有工具，优先于权限检查） ──
        const validationFailure = validateToolInput(toolName, input)
        if (validationFailure) {
          console.warn(`[Agent 工具验证] 参数缺失: tool=${toolName}, mode=${currentMode}`)
          return validationFailure
        }

        // ── Write 大文件 token 截断防护 ──
        if (toolName === 'Write' && typeof input.content === 'string') {
          const estimatedTokens = estimateTokenCount(input.content)
          if (estimatedTokens > WRITE_CONTENT_TOKEN_THRESHOLD) {
            console.warn(
              `[Agent 工具验证] Write 内容过大: tokens≈${estimatedTokens}, chars=${input.content.length}, file=${String(input.file_path)}`,
            )
            return {
              behavior: 'deny' as const,
              message:
                `The content for Write tool (~${estimatedTokens} estimated tokens, ${input.content.length} chars) is too large and may be truncated. ` +
                `Please split the write into smaller sequential steps: write the first portion of the file now, then use Edit tool to append remaining sections incrementally.`,
            }
          }
        }

        // ── EnterPlanMode / ExitPlanMode 处理 ──

        // 完全自动模式：计划进入和退出都透明化，保持 bypassPermissions 的无人值守语义。
        if (currentMode === 'bypassPermissions' && (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode')) {
          const active = toolName === 'EnterPlanMode'
          planModeEntered = active
          emitPlanModeChanged(active, 'tool')
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // ExitPlanMode：plan 模式下必须让用户确认计划。
        if (toolName === 'ExitPlanMode') {
          console.log(`[canUseTool] ExitPlanMode: signal.aborted=${options.signal.aborted}, planModeEntered=${planModeEntered}, mode=${currentMode}`)
          const result = await handleExitPlanMode(input, options.signal)
          if (result.behavior === 'allow' && 'targetMode' in result && result.targetMode) {
            // 更新 Map，后续 canUseTool 调用使用新模式
            this.sessionPermissionModes.set(sessionId, result.targetMode)
            planModeEntered = false
            emitPlanModeChanged(false, 'permission')
            // 同步通知 SDK 侧切换权限模式
            if (this.adapter.setPermissionMode) {
              this.adapter.setPermissionMode(sessionId, result.targetMode).catch((err: unknown) => {
                console.warn(`[Agent 编排] SDK 权限模式切换失败:`, err)
              })
            }
          }
          return result
        }

        // EnterPlanMode：标记进入状态，通知渲染进程
        if (toolName === 'EnterPlanMode') {
          planModeEntered = true
          emitPlanModeChanged(true, 'tool')
          this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'enter_plan_mode', sessionId } })
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // AskUserQuestion：始终走交互式问答流程，不受权限模式影响
        if (toolName === 'AskUserQuestion') {
          return askUserService.handleAskUserQuestion(
            sessionId, input, options.signal,
            (request: AskUserRequest) => {
              this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'ask_user_request', request } })
            },
          )
        }

        // ── 普通工具的权限分派 ──
        if (readOnlyExternalTools.has(toolName)) {
          return { behavior: 'allow' as const, updatedInput: input }
        }

        switch (currentMode) {
          case 'auto':
            return autoCanUseTool(toolName, input, options)

          case 'bypassPermissions':
            return { behavior: 'allow' as const, updatedInput: input }

          case 'plan': {
            // Plan 模式：只允许只读工具；所有文件写入都必须等计划审批通过。
            if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
              return { behavior: 'allow' as const, updatedInput: input }
            }
            // Pi SDK 不再读取 Claude 的 plansDirectory 设置；这里保留迁移前的计划文档例外，
            // 但收窄为当前会话 cwd 下的 .context/**/*.md，覆盖 .context/plan、todo.md、note.md 等工作文档。
            if (isPlanModeContextMarkdownWrite(toolName, input, agentCwd ?? homedir())) {
              return { behavior: 'allow' as const, updatedInput: input }
            }
            // Bash 工具：只读命令（find、grep、cat 等）允许执行，写操作拒绝
            if (toolName === 'Bash') {
              const command = typeof input.command === 'string' ? input.command : ''
              if (isBashCommandReadOnly(command)) {
                return { behavior: 'allow' as const, updatedInput: input }
              }
              return { behavior: 'deny' as const, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
            }
            // MCP / Proma custom tools：计划模式只允许可判定为只读的查询类工具。
            if (isReadOnlyExternalToolName(toolName)) {
              return { behavior: 'allow' as const, updatedInput: input }
            }
            if (DEFERRED_OR_PROACTIVE_TOOLS.has(toolName)) {
              return { behavior: 'deny' as const, message: '计划模式下不允许启动后台、定时、通知或脚本执行能力，请在计划审批通过后再执行' }
            }
            // 其余工具拒绝
            return { behavior: 'deny' as const, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
          }
          default:
            return { behavior: 'allow' as const, updatedInput: input }
        }
      }

      // 13. 构建 Adapter 查询选项
      // 检测用户选用的模型是否为 Claude 系列，决定协作提示词是否使用独立模型分层
      const claudeAvailable = (modelId || DEFAULT_MODEL_ID).toLowerCase().includes('claude')
      const maxTurns = appSettings.agentMaxTurns && appSettings.agentMaxTurns > 0
        ? appSettings.agentMaxTurns
        : undefined
      const systemPrompt = buildSystemPrompt({
        workspaceName: workspace?.name,
        workspaceSlug,
        sessionId,
        permissionMode: initialPermissionMode,
        claudeAvailable,
        deepSeekSubagentModel: modelRouting.subagentModel,
        collaborationAvailable,
      }) + (automationContext ? `\n\n## 定时任务执行上下文\n\n${automationContext}` : '')
      const queryOptions: PiAgentQueryOptions = {
        sessionId,
        prompt: finalPrompt,
        model: modelId || DEFAULT_MODEL_ID,
        cwd: agentCwd,
        apiKey,
        baseUrl: channel.baseUrl,
        provider: channel.provider,
        channelName: channel.name,
        proxyUrl,
        runtimeEnv,
        ...(maxTurns != null && { maxTurns }),
        permissionMode: initialPermissionMode,
        canUseTool,
        systemPrompt,
        resumeSessionId: existingSdkSessionId,
        piAgentDir: getSdkConfigDir(),
        piSessionDir: join(getSdkConfigDir(), 'sessions'),
        ...(customTools.length > 0 && { customTools }),
        // 合并附加目录：用户当次输入 + 会话级 + 工作区级 + Proma 历史/记忆目录
        ...(runtimeAdditionalDirectories.length > 0 ? { additionalDirectories: runtimeAdditionalDirectories } : {}),
        ...(workspaceSlug ? { additionalSkillPaths: [getWorkspaceSkillsDir(workspaceSlug)] } : {}),
        ...(mentionedSkillNames.length > 0 && { skillMentions: mentionedSkillNames }),
        // Pi 思考配置（从 settings 读取）
        ...(appSettings.agentThinking && { thinking: appSettings.agentThinking }),
        effort: appSettings.agentEffort ?? 'high',
        ...buildPiRemoteConnectionOptions(appSettings),
        // 子代理（Agent 工具）委派模型：DeepSeek 主模型下降级到 deepseek-v4-flash，缺省继承主模型
        ...(modelRouting.subagentModel && { subagentModel: modelRouting.subagentModel }),
        // 手动压缩：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型
        ...(isCompactCommand && { compactRequest: true }),
        ...(appSettings.agentMaxBudgetUsd != null && appSettings.agentMaxBudgetUsd > 0 && {
          maxBudgetUsd: appSettings.agentMaxBudgetUsd,
        }),
        onSessionId: (sdkSessionId: string) => {
          // 仅在 session_id 真正变化时才持久化。SDK v2 几乎每条消息都会回调 onSessionId，
          // 旧逻辑误用「初始快照后永不更新」的 existingSdkSessionId 作比较（回调里更新的是
          // capturedSdkSessionId），导致新会话每条消息都全量读写会话索引（readIndex + 原子写 +
          // 备份），再叠加一次读回验证。历史会话多 + 多会话并发时引发同步 fsync 风暴，周期性
          // 卡死主进程事件循环。capturedSdkSessionId 已初始化为 existingSdkSessionId，并在
          // session-not-found 重试时与其同步重置，比较它即可正确判定「真正变化」。
          const previousSdkSessionId = capturedSdkSessionId
          const isNewSessionId = sdkSessionId !== previousSdkSessionId
          capturedSdkSessionId = sdkSessionId
          if (isNewSessionId) {
            try {
              updateAgentSessionMeta(sessionId, {
                sdkSessionId,
                ...(previousSdkSessionId && previousSdkSessionId !== sdkSessionId && !sessionMeta?.legacySdkSessionId
                  ? { legacySdkSessionId: previousSdkSessionId }
                  : {}),
              })
              console.log(`[Agent 编排] 已保存 SDK session_id: ${sdkSessionId}`)
            } catch (err) {
              console.error(`[Agent 编排] 保存 SDK session_id 失败:`, err)
            }
          }

          // SDK 初始化完成后立即触发标题生成，使多会话并发时用户能快速区分
          if (!titleGenerationStarted) {
            titleGenerationStarted = true
            this.autoGenerateTitle(sessionId, userMessage, channelId, resolvedModel, callbacks)
              .catch((err) => console.error('[Agent 编排] 标题生成未捕获异常:', err))
          }
        },
        onModelResolved: (model: string) => {
          resolvedModel = model
          console.log(`[Agent 编排] SDK 确认模型: ${resolvedModel}`)
          // 通知渲染进程更新流式状态中的模型信息
          this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'model_resolved', model } })
        },
        onContextWindow: (cw: number) => {
          console.log(`[Agent 编排] 缓存 contextWindow: ${cw}`)
          // result 消息里的真实 contextWindow 透传到 renderer，
          // 覆盖流式过程中按模型名推断的 fallback 值（智谱等端点会把 [1m] 等后缀剥掉，导致 fallback 不准）
          this.eventBus.emit(sessionId, {
            kind: 'proma_event',
            event: { type: 'context_window', contextWindow: cw },
          })
        },
      }

      console.log(`[Agent 编排] 开始通过 Adapter 遍历事件流...`)

      // 14. 遍历 Adapter 产出的 AgentEvent 流（含自动重试）
      let lastRetryableError: string | undefined
      let retryDelayElapsedMs = 0
      let retryAttemptsScheduled = 0
      let retrySucceeded = false
      let skipNextRetryDelay = false
      let thinkingSignatureRecoveryAttempted = false
      let promptTooLongRecoveryAttempted = false
      let invisibleRecoveryAttempts = 0
      const canAutoRetry = (attempt: number): boolean =>
        attempt <= MAX_AUTO_RETRIES && retryDelayElapsedMs < MAX_AUTO_RETRY_WAIT_MS

      /** 捕获到的 SDK session ID（用于 resume / recovery） */
      let capturedSdkSessionId = existingSdkSessionId
      const canTryThinkingSignatureRecovery = (attempt: number): boolean =>
        !thinkingSignatureRecoveryAttempted &&
        canAutoRetry(attempt) &&
        !!(existingSdkSessionId || capturedSdkSessionId || queryOptions.resumeSessionId)
      const canTryPromptTooLongRecovery = (attempt: number): boolean =>
        !promptTooLongRecoveryAttempted &&
        canAutoRetry(attempt) &&
        !!(existingSdkSessionId || capturedSdkSessionId || queryOptions.resumeSessionId)

      const queryStartedAt = Date.now()
      const completeStoppedRun = (): void => {
        const wasStoppedByUser = this.consumeStoppedByUser(runToken)
        this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
        if (!hasNewerRun()) {
          try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
        }
        completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
      }

      for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
        // 非首次尝试：等待 + 发送重试事件到 UI
        if (attempt > 1) {
          if (skipNextRetryDelay) {
            skipNextRetryDelay = false
            console.log(`[Agent 编排] 已切换到上下文回填模式，立即重试`)
          } else {
            const retryAttempt = Math.max(1, attempt - 1 - invisibleRecoveryAttempts)
            const delayMs = getRetryDelayMs(retryAttempt, retryDelayElapsedMs)
            if (delayMs <= 0) {
              console.log(`[Agent 编排] 自动重试等待预算已耗尽 (${MAX_AUTO_RETRY_WAIT_MS}ms)，停止重试`)
              break
            }
            retryDelayElapsedMs += delayMs
            retryAttemptsScheduled = retryAttempt
            const delaySec = delayMs / 1000
            const attemptData: RetryAttempt = {
              attempt: retryAttempt,
              timestamp: Date.now(),
              reason: lastRetryableError ?? '未知错误',
              errorMessage: lastRetryableError ?? '',
              delaySeconds: delaySec,
            }

            // 前 RETRY_VISIBILITY_THRESHOLD 次重试静默进行，避免偶发瞬时波动频繁惊扰用户
            if (retryAttempt > RETRY_VISIBILITY_THRESHOLD) {
              this.eventBus.emit(sessionId, {
                kind: 'proma_event',
                event: { type: 'retry', status: 'starting', attempt: retryAttempt, maxAttempts: MAX_AUTO_RETRIES, delaySeconds: delaySec, reason: lastRetryableError ?? '未知错误' },
              })
              this.eventBus.emit(sessionId, {
                kind: 'proma_event',
                event: { type: 'retry', status: 'attempt', attemptData },
              })
            }

            console.log(`[Agent 编排] 第 ${retryAttempt} 次重试${retryAttempt <= RETRY_VISIBILITY_THRESHOLD ? '(静默)' : ''}，等待 ${delaySec}s...`)
            await new Promise((r) => setTimeout(r, delayMs))

            // 等待期间如果会话被中止，退出
            if (!isCurrentRunActive()) {
              completeStoppedRun()
              return
            }
          }
        }

        let shouldRetryFromError = false

        try {
          if (!isCurrentRunActive()) {
            completeStoppedRun()
            return
          }

          // 获取异步迭代器（手动 .next() 以支持 Promise.race 中断）
          const queryIterable = this.adapter.query(queryOptions)
          const queryIterator = queryIterable[Symbol.asyncIterator]()

          // 手动事件循环：Promise.race（SDKMessage vs result drain timeout）
          let pendingNext: Promise<IteratorResult<SDKMessage>> | null = null
          // 捕获 result.subtype 以传递给前端（用于区分 success/error_max_turns/error_max_budget_usd）
          let capturedResultSubtype: string | undefined
          // 捕获 result.errors[] 错误详情：SDK 在 error_during_execution 等场景下会把真实错误原因
          // 放进 errors[]，透传到前端用于展示具体错误（而非泛泛的"任务执行过程中发生错误"）。
          let capturedResultErrors: string[] | undefined
          // result 收到后的安全超时：正常情况下 adapter 收到 terminal result 后会主动 break 自己的
          // for-await 循环（触发 SDK iterator.return → cleanup），让此处的 next() 立即拿到 done。
          // 此 timeout 仅作真正的兜底安全网，防止极端情况（SDK 行为再次变化等）下 iterator 不关闭、
          // 事件循环无限挂起。正常运行下不应触发——若日志频繁出现 drain timeout，说明 adapter 主动
          // 终止路径失效，需排查。
          let drainTimeoutPromise: Promise<'drain_timeout'> | null = null
          const RESULT_DRAIN_TIMEOUT_MS = 2_000
          while (true) {
            if (!pendingNext) {
              pendingNext = queryIterator.next()
            }

            const racePromises: Array<Promise<{ kind: string; result: IteratorResult<SDKMessage> | null }>> = [
              pendingNext.then((r) => ({ kind: 'event' as const, result: r })),
            ]
            if (drainTimeoutPromise) {
              racePromises.push(drainTimeoutPromise.then(() => ({ kind: 'drain_timeout' as const, result: null })))
            }

            const raceResult = await Promise.race(racePromises)

            if (raceResult.kind === 'drain_timeout') {
              // 安全网：channel.close() 后 SDK 仍未在超时内关闭 iterator，强制退出
              console.warn(`[Agent 编排] drain timeout: SDK iterator 在 result 后 ${RESULT_DRAIN_TIMEOUT_MS}ms 内未关闭，强制退出`)
              pendingNext?.catch(() => {})
              pendingNext = null
              queryIterator.return?.(undefined as never).catch(() => {})
              break
            }

            const iterResult = raceResult.result
            if (!iterResult || iterResult.done) break

            pendingNext = null
            const msg = iterResult.value
            const msgRecord = msg as Record<string, unknown>
            const isPartialMessage = isPartialSDKMessage(msg)

            if (!isCurrentRunActive()) {
              await queryIterator.return?.(undefined as never).catch(() => {})
              completeStoppedRun()
              return
            }

            // SDK 权限模式可能在 canUseTool 前直接批准工具（如 bypassPermissions）。
            // 因此计划阶段状态要从实际 tool_use 流里同步，不能只依赖权限回调。
            if (msg.type === 'assistant') {
              const assistantMsg = msg as SDKAssistantMessage
              if (!assistantMsg.isReplay) {
                for (const block of assistantMsg.message.content) {
                  if (block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
                    syncPlanModeFromToolUse(block.name)
                  }
                }
              }
            }

            // 检测 assistant 消息中的 SDK 错误
            // 注意：子代理（Agent 工具）委派的子会话消息带非空 parent_tool_use_id，
            // 它们的内部错误只应作为子代理 tool_result 汇报，绝不能劫持父 turn 的控制流
            // （否则子代理一次瞬时错误会触发父 turn 整轮重试或直接终止父会话）。
            const isSubagentSidechain = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id != null
            if (msg.type === 'assistant' && !isPartialMessage && !isSubagentSidechain) {
              const assistantMsg = msg as SDKAssistantMessage
              if (assistantMsg.error) {
                const { detailedMessage, originalError } = extractErrorDetails(assistantMsg as unknown as Parameters<typeof extractErrorDetails>[0])
                let errorCode = assistantMsg.error.errorType || 'unknown_error'
                if (isPromptTooLongError(detailedMessage, originalError)) {
                  errorCode = 'prompt_too_long'
                }
                const typedError = mapSDKErrorToTypedError(errorCode, friendlyErrorMessage(detailedMessage), originalError)

                // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
                if (isSessionNotFoundError(detailedMessage, originalError) && existingSdkSessionId && canAutoRetry(attempt)) {
                  invisibleRecoveryAttempts += 1
                  skipNextRetryDelay = true
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                  diagnosticChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // Thinking signature 不兼容：通常由跨模型 resume 触发。
                // 先自动清除 SDK resume 关系，改用 Proma 已持久化上下文重跑一次；再失败才展示用户提示。
                if (
                  typedError.code === THINKING_SIGNATURE_ERROR_CODE &&
                  canTryThinkingSignatureRecovery(attempt)
                ) {
                  thinkingSignatureRecoveryAttempted = true
                  invisibleRecoveryAttempts += 1
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  skipNextRetryDelay = true
                  lastRetryableError = this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
                    '思考签名不兼容，切换到上下文回填模式',
                    true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
                  )
                  diagnosticChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 上下文过长：旧 SDK session 已经处于不可继续的超限状态。
                // 自动清除 resume 指针，改用 Proma 最近历史回填重跑一次；用于飞书/自动任务等无人值守入口自恢复。
                if (
                  typedError.code === 'prompt_too_long' &&
                  canTryPromptTooLongRecovery(attempt)
                ) {
                  promptTooLongRecoveryAttempted = true
                  invisibleRecoveryAttempts += 1
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  skipNextRetryDelay = true
                  lastRetryableError = this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
                    '上下文过长，切换到上下文回填模式',
                    true,
                  )
                  diagnosticChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 判断是否可自动重试
                if (isAutoRetryableTypedError(typedError) && canAutoRetry(attempt)) {
                  lastRetryableError = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                  console.log(`[Agent 编排] 可重试错误 (assistant error): ${typedError.code} - ${lastRetryableError}`)
                  this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                  accumulatedMessages.length = 0
                  // 与 catch 路径（isAutoRetryableCatchError）和思考签名回填路径保持一致：
                  // 重试前清空已累积的诊断文本，避免 25 次重试上限内字符串无限增长
                  diagnosticChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 不可重试 → 终止
                this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                if (typedError.code === 'prompt_too_long') {
                  try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
                }

                const errorContent = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                const errorSDKMsg: SDKMessage = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: errorContent }],
                  },
                  parent_tool_use_id: null,
                  error: { message: typedError.message, errorType: typedError.code },
                  _createdAt: Date.now(),
                  _errorCode: typedError.code,
                  _errorTitle: typedError.title,
                  _errorDetails: typedError.details,
                  _errorCanRetry: typedError.canRetry,
                  _errorActions: typedError.actions,
                } as unknown as SDKMessage
                appendSDKMessages(sessionId, [errorSDKMsg])
                console.log(`[Agent 编排] 已保存 TypedError 消息: ${typedError.code} - ${typedError.title}`)

                // 如果之前有可见重试记录，发送 retry_failed
                if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD && lastRetryableError) {
                  this.eventBus.emit(sessionId, {
                    kind: 'proma_event',
                    event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled, timestamp: Date.now(), reason: lastRetryableError, errorMessage: typedError.message, delaySeconds: 0 } },
                  })
                }

                // 透传归一化后的错误消息到前端，避免 SDK 原始 API Error 直接暴露给用户。
                this.eventBus.emit(sessionId, { kind: 'sdk_message', message: errorSDKMsg })
                try { updateAgentSessionMeta(sessionId, {}) } catch { /* 忽略 */ }
                completeRun(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
                return
              }
            }

            // 累积 assistant 和 user 消息用于持久化
            // - 跳过 replay 消息，避免 resume 时重复写入
            // - 对 user 消息，仅累积含 tool_result 的（初始用户消息已在步骤 5 手动持久化）
            // - 对 system 消息，仅累积需要长期可见的状态（压缩 / 权限拒绝）
            if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
              if (!msgRecord.isReplay && !isPartialMessage) {
                if (msg.type === 'user') {
                  // 仅累积包含 tool_result 的 user 消息（跳过 SDK 重新发出的初始用户消息）
                  const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
                  const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
                  if (hasToolResult) {
                    accumulatedMessages.push(msg)
                  }
                } else {
                  // 为 assistant 消息注入渠道 modelId，确保持久化后能正确匹配模型显示名。
                  // 子代理 sidechain 消息（parent_tool_use_id 非空）已带自己的 subModel 标签，
                  // 不能用父会话 modelId 覆盖，否则降级模型（如 deepseek-v4-flash）会被错误显示为父模型。
                  if (msg.type === 'assistant' && modelId
                    && (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id == null) {
                    (msg as Record<string, unknown>)._channelModelId = modelId
                  }
                  accumulatedMessages.push(msg)
                }
              }
            } else if (msg.type === 'system') {
              const sysMsg = msg as SDKSystemMessage
              if (isPersistableSDKSystemMessage(sysMsg)) {
                accumulatedMessages.push(msg)
              }
            }

            // Turn 结束时：持久化累积消息
            if (msg.type === 'result') {
              const resultTerminalReason = (msg as { terminal_reason?: string }).terminal_reason
              capturedResultSubtype = (msg as { subtype?: string }).subtype
                ?? (resultTerminalReason === 'max_tokens' ? 'max_tokens' : undefined)
              // SDK 的 SDKResultError 在 errors[] 中携带真实错误原因（error_during_execution 等场景），
              // 捕获后既用于重试判定，也透传到前端展示具体错误。
              const rawResultErrors = (msg as { errors?: unknown }).errors
              capturedResultErrors = Array.isArray(rawResultErrors)
                ? rawResultErrors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
                : undefined
              if (capturedResultErrors?.length) {
                diagnosticChunks.push(capturedResultErrors.join('\n'))
              }
              const lastAssistantUuid = [...accumulatedMessages]
                .reverse()
                .find((message) => message.type === 'assistant' && !isPartialSDKMessage(message))
              const postTurnSnapshotUuid = lastAssistantUuid ? getMessageUuid(lastAssistantUuid) : undefined
              if (postTurnSnapshotUuid && agentCwd) {
                try {
                  await createAgentSidecarSnapshot({
                    sessionId,
                    messageUuid: postTurnSnapshotUuid,
                    roots: buildSidecarSnapshotRoots(agentCwd, allAttachedDirectories),
                  })
                } catch (error) {
                  console.warn('[Agent 编排] 创建 Proma post-turn sidecar 快照失败:', error)
                }
              }
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              accumulatedMessages.length = 0
              const legacyKeptOpenForTasks = (msg as Record<string, unknown>)._keepChannelOpenForTasks === true
              if (legacyKeptOpenForTasks) {
                console.warn(
                  '[Agent 编排] Pi runtime 不支持旧后台任务自动续轮，已忽略 _keepChannelOpenForTasks；' +
                  '长耗时或需后台收敛的工作请使用 Proma automation / collaboration 工具。',
                )
              }
              // 分类打点：跟踪线上哪种 terminal_reason 最常见，配合 deferred_tool_use 回填决策
              const hasDeferredTool = (msg as { deferred_tool_use?: unknown }).deferred_tool_use != null
              console.log(
                `[Agent 编排] result 到达: sessionId=${sessionId}, subtype=${capturedResultSubtype ?? 'unknown'}, ` +
                `terminal_reason=${resultTerminalReason ?? 'undefined'}` +
                (legacyKeptOpenForTasks ? ', ignoredLegacyKeepChannelOpen=true' : '') +
                (hasDeferredTool ? ', hasDeferredTool=true' : '') +
                (capturedResultErrors?.length ? `, errors=${JSON.stringify(capturedResultErrors)}` : ''),
              )
              // error_during_execution 是 SDK 的兜底错误码，以 result（而非 assistant.error / 抛异常）形式到达，
              // 默认不会触发上面两条重试路径。这里用 errors[] 文本喂给现有的可重试判定（502/529/overloaded/
              // 网络瞬断 / 响应体解析失败等），命中则进入重试循环，复用统一的退避逻辑。
              if (
                capturedResultSubtype === 'error_during_execution' &&
                capturedResultErrors?.length &&
                isSessionNotFoundError(capturedResultErrors.join('\n'), diagnosticChunks.join('\n')) &&
                existingSdkSessionId &&
                canAutoRetry(attempt)
              ) {
                invisibleRecoveryAttempts += 1
                skipNextRetryDelay = true
                existingSdkSessionId = undefined
                capturedSdkSessionId = undefined
                lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                diagnosticChunks.length = 0
                shouldRetryFromError = true
                break
              }
              if (
                capturedResultSubtype === 'error_during_execution' &&
                capturedResultErrors?.length &&
                isAutoRetryableCatchError(null, capturedResultErrors.join('\n')) &&
                canAutoRetry(attempt)
              ) {
                lastRetryableError = capturedResultErrors[0]
                console.log(`[Agent 编排] 可重试错误 (result error_during_execution, attempt ${attempt}/${MAX_AUTO_RETRIES}): ${lastRetryableError}`)
                // 与 assistant.error / catch 重试路径保持一致：清空已累积诊断文本，避免重试上限内无限增长
                diagnosticChunks.length = 0
                shouldRetryFromError = true
                break
              }
              if (!drainTimeoutPromise) {
                // 启动 drain 超时安全网：正常情况下 adapter 收到 terminal result 会主动 break
                // 触发 iterator.return → 下一次 next() 立即返回 done，此 timeout 不会触发。
                // 仅在极端情况下（adapter 主动终止失效、SDK 行为再次变化）保护事件循环不无限挂起。
                drainTimeoutPromise = new Promise((resolve) =>
                  setTimeout(() => resolve('drain_timeout'), RESULT_DRAIN_TIMEOUT_MS),
                )
              }
            }

            // 过滤 SDK 内部生成的 user 消息（如 Skill 展开文本），避免在前端渲染为用户消息
            // 仅允许含 tool_result 的 user 消息通过（这些是工具调用的响应，需要展示）
            // 初始用户消息已通过前端乐观注入显示，无需 SDK 重复推送
            let shouldEmit = true
            if (msg.type === 'user') {
              const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
              const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
              if (!hasToolResult) {
                shouldEmit = false
              }
            }

            if (!shouldEmit) {
              // 跳过 SDK 内部 user 消息的前端推送
            } else {
              this.eventBus.emit(sessionId, { kind: 'sdk_message', message: msg })
            }
          }

          // 错误 break 触发了 → 继续循环
          if (shouldRetryFromError) {
            continue
          }

          const wasStoppedByUser = this.consumeStoppedByUser(runToken)

          // 正常完成 — 如果之前有可见重试，发送 retry_cleared
          if (!wasStoppedByUser && retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD) {
            this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'retry', status: 'cleared' } })
            console.log(`[Agent 编排] 重试成功，已在第 ${attempt} 次尝试后恢复`)
          }
          retrySucceeded = true

          // 15. 持久化 assistant 消息
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

          if (!hasNewerRun()) {
            try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 忽略 */ }
          }

          // Plan 模式：Agent 完成规划后注入"接受计划"建议
          if (initialPermissionMode === 'plan' && planModeEntered && isCurrentRunActive()) {
            this.eventBus.emit(sessionId, {
              kind: 'sdk_message',
              message: { type: 'prompt_suggestion', suggestion: '请执行该计划' } as unknown as SDKMessage,
            })
            console.log(`[Agent 编排] Plan 模式：已注入计划确认建议`)
          }

          // 发送完成信号
          completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })

          break  // 成功完成，退出重试循环

        } catch (error) {
          // 打印可用诊断文本。Pi 是 in-process runtime，没有旧 CLI stderr 通道。
          const fullDiagnosticOutput = diagnosticChunks.join('\n').trim()
          if (fullDiagnosticOutput) {
            console.error(`[Agent 编排] 完整诊断输出 (${fullDiagnosticOutput.length} 字符):`)
            console.error(fullDiagnosticOutput)
          } else {
            console.error('[Agent 编排] 无额外诊断输出')
          }

          // 用户主动中止
          if (!isCurrentRunActive()) {
            console.log(`[Agent 编排] 会话 ${sessionId} 已被用户中止`)
            completeStoppedRun()
            return
          }

          // 从可用诊断文本提取 API 错误
          const diagnosticOutput = diagnosticChunks.join('\n').trim()
          const apiError = extractApiError(diagnosticOutput)
          const rawErrorMessage = error instanceof Error ? error.message : ''
          const catchLooksPromptTooLong = isPromptTooLongError(
            apiError?.message ?? '',
            rawErrorMessage,
            diagnosticOutput,
          )

          // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
          if (isSessionNotFoundError(rawErrorMessage, diagnosticOutput) && existingSdkSessionId && canAutoRetry(attempt)) {
            invisibleRecoveryAttempts += 1
            skipNextRetryDelay = true
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
            diagnosticChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 上下文过长：清除超限 resume 指针，用 Proma 历史回填自动恢复一次。
          if (catchLooksPromptTooLong && canTryPromptTooLongRecovery(attempt)) {
            promptTooLongRecoveryAttempted = true
            invisibleRecoveryAttempts += 1
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            skipNextRetryDelay = true
            lastRetryableError = this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
              '上下文过长，切换到上下文回填模式',
              true,
            )
            diagnosticChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // Thinking signature 不兼容：先自动清除 SDK resume 关系并用上下文回填重跑一次。
          if (
            isThinkingSignatureError(apiError?.message ?? '', `${rawErrorMessage}\n${diagnosticOutput}`) &&
            canTryThinkingSignatureRecovery(attempt)
          ) {
            thinkingSignatureRecoveryAttempted = true
            invisibleRecoveryAttempts += 1
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            skipNextRetryDelay = true
            lastRetryableError = this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
              '思考签名不兼容，切换到上下文回填模式',
              true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
            )
            diagnosticChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 判断是否可重试
          if (isAutoRetryableCatchError(apiError, rawErrorMessage, diagnosticOutput) && canAutoRetry(attempt)) {
            lastRetryableError = apiError
              ? `API Error ${apiError.statusCode}: ${apiError.message}`
              : (error instanceof Error ? error.message : '未知错误')
            console.log(`[Agent 编排] 可重试错误 (catch, attempt ${attempt}/${MAX_AUTO_RETRIES}): ${lastRetryableError}`)
            // 保存部分内容
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            accumulatedMessages.length = 0
            diagnosticChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 不可重试 — 走原有终止逻辑
          const errorMessage = error instanceof Error ? error.message : '未知错误'
          console.error(`[Agent 编排] 执行失败:`, error)

          // 保存已累积的部分内容
          if (accumulatedMessages.length > 0) {
            try {
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              console.log(`[Agent 编排] 已保存部分执行结果 (${accumulatedMessages.length} 条消息)`)
            } catch (saveError) {
              console.error('[Agent 编排] 保存部分内容失败:', saveError)
            }
          }

          let userFacingError: string
          if (apiError) {
            userFacingError = friendlyErrorMessage(`API 错误 (${apiError.statusCode}):\n${apiError.message}`)
          } else {
            userFacingError = friendlyErrorMessage(errorMessage)
          }

          // 保存错误消息到 JSONL
          try {
            // 检测是否为 prompt too long 错误
            const isPromptTooLong = isPromptTooLongError(
              userFacingError,
              `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${diagnosticOutput}`,
            )
            const isThinkingSignature = isThinkingSignatureError(
              apiError?.message ?? '',
              [
                userFacingError,
                rawErrorMessage,
                error instanceof Error ? (error.stack ?? error.message) : String(error),
                diagnosticOutput,
              ].join('\n'),
            )
            // pi runtime 动态 import 失败（打包遗漏依赖 / 安装损坏）经此 catch 路径落地，
            // 不走 mapSDKErrorToTypedError，需在此单独识别以产出定向的「核心未就绪」错误码。
            const isRuntimeNotFound = isRuntimeNotFoundError(
              [
                userFacingError,
                rawErrorMessage,
                error instanceof Error ? (error.stack ?? error.message) : String(error),
                diagnosticOutput,
              ].join('\n'),
            )
            const errorCode = isPromptTooLong
              ? 'prompt_too_long'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_CODE
                : isRuntimeNotFound
                  ? 'agent_runtime_not_found'
                  : 'unknown_error'
            const errorTitle = isPromptTooLong
              ? '上下文过长'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_TITLE
                : isRuntimeNotFound
                  ? 'Agent 核心未就绪'
                  : '执行错误'
            const errorContent = isPromptTooLong
              ? '上下文过长：当前对话的上下文已超出模型限制，请压缩上下文或开启新会话'
              : isThinkingSignature
                ? `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
                : isRuntimeNotFound
                  ? 'Agent 核心未就绪：运行时依赖缺失或安装损坏，请重新下载安装 Proma 最新版本。'
                  : userFacingError
            const errorActions = isThinkingSignature
              ? [
                  { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
                  { key: 'r', label: '重试', action: 'retry' },
                ]
              : undefined
            userFacingError = errorContent
            if (isPromptTooLong) {
              try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
            }

            const errMsg: SDKMessage = {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: errorContent }],
              },
              parent_tool_use_id: null,
              error: { message: errorContent, errorType: errorCode },
              _createdAt: Date.now(),
              _errorCode: errorCode,
              _errorTitle: errorTitle,
              _errorActions: errorActions,
            } as unknown as SDKMessage
            appendSDKMessages(sessionId, [errMsg])
            console.log(`[Agent 编排] 已保存错误消息到 JSONL`)
          } catch (saveError) {
            console.error('[Agent 编排] 保存错误消息失败:', saveError)
          }

          // 如果之前有可见重试记录，发送 retry_failed
          if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD && lastRetryableError) {
            this.eventBus.emit(sessionId, {
              kind: 'proma_event',
              event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled, timestamp: Date.now(), reason: lastRetryableError, errorMessage: userFacingError, delaySeconds: 0 } },
            })
          }

          failRun(userFacingError, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })

          // 保留 sdkSessionId，确保下一轮能继续 resume（修复 #903）。
          // 此终止分支只会被「非 session-not-found」的错误命中（session 失效已在上文
          // isSessionNotFoundError 分支单独处理并切到恢复模式）。网络断连、服务端 5xx、
          // 未知错误都不代表 runtime 会话本身失效——其完整历史仍保存在
          // ~/.proma/sdk-config/sessions/.../{sdkSessionId}.jsonl 中，依旧可 resume。
          // 此前这里对 `!apiError`（如普通断连解析不出状态码）一律清除指针，导致下一轮
          // 退化为「仅回填最近 N 条」的冷启动，上下文从满载骤降（#903）。
          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 保留 sdkSessionId 以便下一轮 resume（错误未表明会话失效）`)
          }

          return
        }
      }

      // 重试循环结束（达到最大次数仍失败）
      if (!retrySucceeded && lastRetryableError) {
        const retryFailureMessage = retryDelayElapsedMs >= MAX_AUTO_RETRY_WAIT_MS
          ? '重试等待已达到 5 分钟后仍然失败'
          : `重试 ${retryAttemptsScheduled || MAX_AUTO_RETRIES} 次后仍然失败`

        // 仅当重试曾经对用户可见时才发送 retry_failed 事件
        if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD) {
          this.eventBus.emit(sessionId, {
            kind: 'proma_event',
            event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled || MAX_AUTO_RETRIES, timestamp: Date.now(), reason: lastRetryableError, errorMessage: retryFailureMessage, delaySeconds: 0 } },
          })
        }

        // 保存错误消息
        const retryErrorContent = `${retryFailureMessage}: ${lastRetryableError}`
        const retryErrorSDKMsg: SDKMessage = {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: retryErrorContent }],
          },
          parent_tool_use_id: null,
          error: { message: retryErrorContent, errorType: 'unknown_error' },
          _createdAt: Date.now(),
          _errorCode: 'unknown_error',
          _errorTitle: '重试失败',
        } as unknown as SDKMessage
        appendSDKMessages(sessionId, [retryErrorSDKMsg])

        failRun(`${retryFailureMessage}: ${lastRetryableError}`, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
      }

    } finally {
      await Promise.all(toolCleanups.map(async (cleanup) => {
        try {
          await cleanup()
        } catch (error) {
          console.warn('[Agent 编排] 清理 Pi 工具资源失败:', error)
        }
      }))
      // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
      releaseActiveRun()
      if (!this.activeSessions.has(sessionId)) {
        permissionService.clearSessionPending(sessionId)
        // askUserService 不在 turn 结束时清理——AskUserQuestion 的生命周期由用户交互决定，
        // 仅在会话真正删除时（DELETE_SESSION IPC）才清理。
        exitPlanService.clearSessionPending(sessionId)
      }
    }
  }

  /**
   * 中止指定会话的 Agent 执行
   *
   * 先从 activeSessions 移除（供 sendMessage catch 块检测用户中止），
   * 再调用 adapter.abort() 中止底层 SDK 进程。
   */
  stop(sessionId: string): void {
    const runToken = this.activeSessions.get(sessionId)
    this.abortMcpStartup(sessionId, runToken)
    this.activeSessions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    if (runToken) this.stoppedRunTokens.add(runToken)
    this.queuedMessageUuids.delete(sessionId)
    permissionService.clearSessionPending(sessionId)
    exitPlanService.clearSessionPending(sessionId)
    this.adapter.abort(sessionId)
    console.log(`[Agent 编排] 已中止会话: ${sessionId}`)
  }

  /** 检查指定会话是否正在处理中 */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  /**
   * 运行中动态切换会话的权限模式
   *
   * 同时更新 Proma 侧（canUseTool 闭包读取的 Map）和 SDK 侧（query.setPermissionMode）。
   * 典型场景：用户在 Agent 运行中通过 PermissionModeSelector 切换模式。
   */
  async updateSessionPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
    if (!this.activeSessions.has(sessionId)) return
    this.sessionPermissionModes.set(sessionId, mode)
    this.eventBus.emit(sessionId, {
      kind: 'proma_event',
      event: { type: 'plan_mode_changed', sessionId, active: mode === 'plan', source: 'permission' },
    })
    // 同步通知 SDK 侧
    if (this.adapter.setPermissionMode) {
      await this.adapter.setPermissionMode(sessionId, mode)
    }
    console.log(`[Agent 编排] 运行中权限模式已切换: sessionId=${sessionId}, mode=${mode}`)
  }

  // ===== 快照回退 =====

  private rewindFilesFromLegacyHistory(input: {
    sessionMeta: AgentSessionMeta
    assistantMessageUuid: string
    userMessageUuid?: string
    legacySdkSessionIds: string[]
    currentSessionCwd?: string
    workspaceSlug?: string
  }): AgentSidecarRestoreResult | undefined {
    const cwd = input.currentSessionCwd ?? homedir()
    const rootPathMap = buildWorkspaceFilesRootPathMap(input.workspaceSlug)
    const attachedDirectories = collectAttachedDirectories({
      sessionMeta: input.sessionMeta,
      workspaceSlug: input.workspaceSlug,
    })
    for (const dir of attachedDirectories) {
      const resolved = resolve(dir)
      rootPathMap.set(resolved, resolved)
    }

    const runLegacyRestore = (preferPromaUserUuid: boolean): LegacyFileHistoryRestoreResult => {
      const canUsePromaUserUuid = preferPromaUserUuid
        && !!input.userMessageUuid
        && input.userMessageUuid !== '__LAST_TURN__'
      return rewindFilesFromLegacySnapshot({
        sdkSessionIds: input.legacySdkSessionIds,
        cwd,
        rootPathMap,
        allowedDirectories: [cwd, ...attachedDirectories],
        ...(canUsePromaUserUuid
          ? { userMessageUuid: input.userMessageUuid }
          : { assistantMessageUuid: input.assistantMessageUuid }),
      })
    }

    let legacyResult = runLegacyRestore(true)
    if (!legacyResult.canRewind && !legacyResult.lastTurn && input.userMessageUuid && input.userMessageUuid !== '__LAST_TURN__') {
      legacyResult = runLegacyRestore(false)
    }

    if (legacyResult.canRewind) {
      console.log(
        `[Agent 编排] 已使用 legacy Claude file-history 恢复文件: `
        + `sdkSessionId=${legacyResult.resolvedSdkSessionId ?? 'unknown'}, userUuid=${legacyResult.resolvedUserMessageUuid ?? 'unknown'}`,
      )
      return {
        canRewind: true,
        filesChanged: legacyResult.filesChanged,
        restoredRoots: 0,
        skippedRoots: 0,
      }
    }

    if (legacyResult.lastTurn) {
      console.warn('[Agent 编排] legacy Claude file-history 判断目标是最后一轮，跳过文件恢复并允许截断')
      return {
        canRewind: true,
        filesChanged: [],
        restoredRoots: 0,
        skippedRoots: 0,
      }
    }

    return {
      canRewind: false,
      error: `Proma sidecar 不可用，legacy Claude file-history fallback 也失败：${legacyResult.error ?? '未知错误'}`,
    }
  }

  /**
   * 回退会话到指定消息点
   *
   * 1. 从 Proma sidecar 快照恢复文件到目标时刻的状态
   * 2. 文件恢复成功后，截断 Proma JSONL 到 assistantMessageUuid（inclusive）
   * 3. 清空 sdkSessionId，下次发消息时通过 Proma 历史回填上下文
   *
   * 文件恢复通过 Proma 自有 sidecar 完成，无需运行中的 Query。
   * 若文件恢复失败（无可用快照、快照缺失且非最后一轮、fork 源恢复也失败），
   * 则**不截断对话**，返回 conversationRewound:false + fileRewind 错误详情，
   * 由调用方据此提示用户（避免出现「对话已回退但文件停在最新态」的错位）。
   */
  async rewindSession(
    sessionId: string,
    assistantMessageUuid: string,
  ): Promise<RewindSessionResult> {
    // 0. 阻止运行中会话回退（JSONL 并发写入会损坏文件）
    if (this.activeSessions.has(sessionId)) {
      throw new Error('会话正在运行中，请停止后再回退')
    }

    const sessionMeta = getAgentSessionMeta(sessionId)
    if (!sessionMeta) throw new Error('会话不存在，无法回退')

    // 0.5 从 Proma JSONL 解析对应的 user message UUID（sidecar 快照 key）
    let workspaceSlug: string | undefined
    if (sessionMeta.workspaceId) {
      const ws = getAgentWorkspace(sessionMeta.workspaceId)
      if (ws) {
        workspaceSlug = ws.slug
      }
    }
    const currentSessionCwd = workspaceSlug
      ? getAgentSessionWorkspacePath(workspaceSlug, sessionId)
      : undefined
    const restoreOptions = buildSidecarRestoreOptions({
      sessionId,
      currentSessionCwd,
      sessionMeta,
      workspaceSlug,
    })
    const legacySdkSessionIds = collectLegacySdkSessionIds(sessionMeta, assistantMessageUuid)
    const userMessageUuid = resolveRewindUserMessageUuid(sessionId, assistantMessageUuid)
    console.log(`[Agent 编排] 回退: 解析 user uuid=${userMessageUuid || '未找到'} (assistant uuid=${assistantMessageUuid})`)

    // 1. 文件恢复：直接从 Proma sidecar 恢复，无需临时 Query
    let fileRewindResult: AgentSidecarRestoreResult | undefined
    if (userMessageUuid === '__LAST_TURN__') {
      console.log(`[Agent 编排] 回退: 最后一个 turn，尝试从 post-turn sidecar 恢复文件`)
      fileRewindResult = await restoreAgentSidecarSnapshot(sessionId, assistantMessageUuid, restoreOptions)
      if (!fileRewindResult.canRewind && isMissingSidecarError(fileRewindResult.error)) {
        console.warn(`[Agent 编排] 最后一轮 sidecar 不可用，按迁移前行为跳过文件恢复并继续截断: ${fileRewindResult.error}`)
        fileRewindResult = {
          canRewind: true,
          filesChanged: [],
          restoredRoots: 0,
          skippedRoots: 0,
        }
      }
    } else if (userMessageUuid) {
      try {
        // 收集附加目录仅用于日志；sidecar 元数据已经保存了当轮实际根目录。
        const rewindAttachedDirs = collectAttachedDirectories({ sessionMeta, workspaceSlug })
        console.log(`[Agent 编排] 回退: 直接从 Proma sidecar 恢复文件 (attachedDirs=${rewindAttachedDirs.length})`)
        fileRewindResult = await restoreAgentSidecarSnapshot(sessionId, userMessageUuid, restoreOptions)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn('[Agent 编排] 文件恢复失败，继续截断对话:', errMsg)
        if (err instanceof Error && err.stack) console.warn('[Agent 编排] 文件恢复错误堆栈:', err.stack)
        fileRewindResult = { canRewind: false, error: errMsg }
      }
    } else {
      fileRewindResult = { canRewind: false, error: '无法从 SDK session 中解析 user message UUID' }
    }

    if (!fileRewindResult.canRewind && sessionMeta.forkSourceSessionId && sessionMeta.forkSourceDir && workspaceSlug) {
      const currentDir = getAgentSessionWorkspacePath(workspaceSlug, sessionId)
      const sourceDir = resolve(sessionMeta.forkSourceDir)
      const targetUuid = userMessageUuid === '__LAST_TURN__' ? assistantMessageUuid : userMessageUuid
      if (targetUuid) {
        console.warn(`[Agent 编排] 当前会话 sidecar 恢复失败，尝试源 fork sidecar: source=${sessionMeta.forkSourceSessionId}`)
        const forkSourceRootPathMap = new Map<string, string>([[sourceDir, currentDir]])
        const sourceRestoreOptions = buildSidecarRestoreOptions({
          sessionId: sessionMeta.forkSourceSessionId,
          currentSessionCwd: currentDir,
          sessionMeta,
          workspaceSlug,
          extraRootPathMap: forkSourceRootPathMap,
        }) ?? {}
        fileRewindResult = await restoreAgentSidecarSnapshot(sessionMeta.forkSourceSessionId, targetUuid, {
          ...sourceRestoreOptions,
          sessionCwdById: new Map([[sessionMeta.forkSourceSessionId, currentDir]]),
          restoreUnmappedRoots: false,
        })
      }
    }

    if (!fileRewindResult.canRewind && !fileRewindResult.partial && legacySdkSessionIds.length > 0) {
      const legacyResult = this.rewindFilesFromLegacyHistory({
        sessionMeta,
        assistantMessageUuid,
        userMessageUuid,
        legacySdkSessionIds,
        currentSessionCwd,
        workspaceSlug,
      })
      if (legacyResult) {
        fileRewindResult = legacyResult
      }
    }

    if (!fileRewindResult.canRewind) {
      console.warn(`[Agent 编排] 文件恢复失败，取消截断对话: ${fileRewindResult.error ?? '未知错误'}`)
      return {
        conversationRewound: false,
        remainingMessages: getAgentSessionSDKMessages(sessionId).length,
        fileRewind: fileRewindResult,
      }
    }

    // 2. 截断 Proma JSONL
    const kept = truncateSDKMessages(sessionId, assistantMessageUuid)

    // 3. Pi runtime session 不能按 Proma assistant UUID 原地分支；清空后下一轮用截断历史回填。
    updateAgentSessionMeta(sessionId, { resumeAtMessageUuid: undefined, sdkSessionId: undefined })

    console.log(`[Agent 编排] 回退完成: sessionId=${sessionId}, 保留 ${kept.length} 条消息, 文件恢复=${fileRewindResult?.canRewind ?? '跳过'}`)

    return {
      conversationRewound: true,
      remainingMessages: kept.length,
      fileRewind: fileRewindResult,
    }
  }

  /** 中止所有活跃的 Agent 会话（应用退出时调用） */
  stopAll(): void {
    if (this.activeSessions.size > 0) {
      console.log(`[Agent 编排] 正在中止所有活跃会话 (${this.activeSessions.size} 个)...`)
    }
    // 即便 activeSessions 为空，也要调 dispose 清理可能残留的 pidMap / 子进程
    this.adapter.dispose()
    this.activeSessions.clear()
    this.stoppedRunTokens.clear()
    this.sessionPermissionModes.clear()
    this.queuedMessageUuids.clear()
  }

  // ===== 队列消息管理 =====

  /**
   * 流式追加消息
   *
   * 在 Agent 运行中注入用户消息到 SDK，使用 'now' 优先级立即处理。
   * 消息立即持久化到 JSONL。
   *
   * @returns 消息 UUID
   */
  async queueMessage(
    sessionId: string,
    text: string,
    rawText?: string,
    _priority?: string,
    presetUuid?: string,
    opts?: { interrupt?: boolean },
    mentionedSkills?: string[],
    mentionedMcpServers?: string[],
    mentionedSessionIds?: string[],
  ): Promise<string> {
    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话未运行，无法追加消息: ${sessionId}`)
    }

    if (!this.adapter.sendQueuedMessage) {
      throw new Error('[Agent 编排] 当前适配器不支持流式追加消息')
    }

    // 注入 mention 引用指令（Skill/MCP/会话）— 与 sendMessage 路径保持一致的 prompt 加工
    const meta = getAgentSessionMeta(sessionId)
    const workspaceSlug = meta?.workspaceId
      ? getAgentWorkspace(meta.workspaceId)?.slug
      : undefined

    let enrichedText = text
    const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, meta?.workspaceId)
    const mentionedSkillNames = resolveCurrentSkillMentions(
      workspaceSlug,
      mentionedSkills,
      text,
      referencedSessionsBlock,
    )
    if (referencedSessionsBlock) {
      enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`
    }
    if (mentionedSkillNames.length || mentionedMcpServers?.length) {
      const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
      for (const skillName of mentionedSkillNames) {
        toolLines.push(`- Skill: ${skillName}（请立即使用 /skill:${skillName} 展开并执行）`)
      }
      for (const name of mentionedMcpServers ?? []) {
        toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
      }
      enrichedText = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedText}`
    }

    const uuid = presetUuid || randomUUID()

    // 防重记录
    const uuids = this.queuedMessageUuids.get(sessionId) ?? new Set<string>()
    uuids.add(uuid)
    this.queuedMessageUuids.set(sessionId, uuids)

    // 构造 SDKUserMessage 并注入（强制 'now' 优先级）
    const sdkMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: enrichedText },
      parent_tool_use_id: null,
      priority: 'now' as const,
      uuid,
      session_id: sessionId,
    }

    let acceptedByRuntime = false
    try {
      // 先持久化到 JSONL，再注入 runtime，避免 Pi 已接收但 Proma 历史缺消息。
      const persistMsg: SDKMessage = {
        type: 'user',
        uuid,
        message: {
          content: [{ type: 'text', text: rawText ?? text }],
        },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
      } as unknown as SDKMessage
      appendSDKMessages(sessionId, [persistMsg])

      const queueAgentCwd = workspaceSlug
        ? getAgentSessionWorkspacePath(workspaceSlug, sessionId)
        : homedir()
      const queuedAttachedDirectories = collectAttachedDirectories({ sessionMeta: meta, workspaceSlug })
      try {
        await createAgentSidecarSnapshot({
          sessionId,
          messageUuid: uuid,
          roots: buildSidecarSnapshotRoots(queueAgentCwd, queuedAttachedDirectories),
        })
      } catch (error) {
        console.warn('[Agent 编排] 创建队列消息 Proma sidecar 快照失败，仍继续追加消息:', error)
      }

      // interrupt=true 由 Pi adapter 映射为 abort 当前 turn 后发送新 prompt；
      // 普通 now 优先级仍由 adapter.sendQueuedMessage → session.steer() 处理。
      await this.adapter.sendQueuedMessage(sessionId, sdkMessage, {
        interrupt: opts?.interrupt === true,
        onAccepted: () => {
          acceptedByRuntime = true
        },
        ...(mentionedSkillNames.length > 0 && { skillMentions: mentionedSkillNames }),
      })
      console.log(`[Agent 编排] 追加消息已注入: sessionId=${sessionId}, uuid=${uuid}, interrupt=${!!opts?.interrupt}`)
    } catch (error) {
      uuids.delete(uuid)
      if (!acceptedByRuntime) {
        try {
          removeSDKMessageByUuid(sessionId, uuid)
        } catch (rollbackError) {
          console.warn('[Agent 编排] 回滚队列消息持久化失败:', rollbackError)
        }
      }
      throw error
    }

    return uuid
  }
}
