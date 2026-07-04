/**
 * Pi 子代理（SubAgent）委派工具 —— 可插拔模块
 *
 * 提供模型可调用的 `Agent` 工具（把子任务委派到一个全新上下文、
 * 独立执行、拿回结果）。pi SDK 官方不内置 sub-agents，这里用 pi 自己的 `createAgentSession`
 * 原语在工具 execute 内嵌套开一个子会话实现，零第三方依赖。
 *
 * 【解耦约定】
 * - 本模块不 import pi-agent-adapter 的运行时导出（只 import 其类型，类型在编译期擦除，无循环依赖）；
 *   所有运行时能力经 SubagentToolDeps 依赖注入传入。
 * - 单一开关 isSubagentDelegationEnabled() 控制启停；适配器只有一处接线。
 * - 未来若要彻底移除：删除本文件 + 适配器里那一处 `...(isSubagentDelegationEnabled() ? [...] : [])` 接线即可，
 *   核心 query 循环一行不动。
 */

import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { AgentMessage, AgentToolResult, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AgentSession, AgentSessionEvent, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import type { SDKMessage } from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import type { AgentRuntimeGuard } from '../agent-runtime-guards'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type SkillLoadResult = ReturnType<ResourceLoader['getSkills']>

/**
 * 子代理委派能力总开关。
 *
 * 默认开启（对齐旧 SDK 行为）；设置环境变量 PROMA_DISABLE_SUBAGENT=1 可关闭。
 * 关闭后适配器不会注册 Agent 工具，模型也就无法委派子代理 —— 能力干净消失，无残留副作用。
 */
export function isSubagentDelegationEnabled(): boolean {
  return process.env.PROMA_DISABLE_SUBAGENT !== '1'
}

/**
 * 依赖注入：适配器把构建子会话所需的运行时能力传进来，避免本模块反向依赖适配器造成循环。
 */
export interface SubagentToolDeps {
  sdk: PiSdk
  /** 子会话工作目录（与父会话一致） */
  cwd: string
  /** 父会话查询选项（复用其鉴权、渠道、代理、目录、权限回调等） */
  parentInput: PiAgentQueryOptions
  /** 把子会话消息桥接到父队列（已由本模块打好 parent_tool_use_id 标记） */
  emitChildMessage: (message: SDKMessage) => void
  /** 复用适配器的模型构建（传入覆盖了 model 字段的 input，实现子代理模型路由/降级） */
  buildModel: (input: PiAgentQueryOptions) => Promise<{
    authStorage: unknown
    registry: unknown
    model: unknown
  }>
  /** 复用适配器的内置工具构建（read/bash/edit/write/grep/find/ls，不含 Agent → 递归守卫） */
  buildBuiltinTools: (
    sdk: PiSdk,
    cwd: string,
    additionalDirectories: string[] | undefined,
    canUseTool: PiAgentQueryOptions['canUseTool'],
    runtimeEnv: PiAgentQueryOptions['runtimeEnv'],
  ) => ToolDefinition[]
  /** 复用适配器的 Proma 产品工具构建，并继续走父会话 canUseTool 包装 */
  buildPromaProductTools: (
    sdk: PiSdk,
    canUseTool: PiAgentQueryOptions['canUseTool'],
  ) => ToolDefinition[]
  /** 复用适配器的外部工具权限包装（MCP / dynamic tools） */
  wrapCustomTools: (
    tools: ToolDefinition[] | undefined,
    canUseTool: PiAgentQueryOptions['canUseTool'],
  ) => ToolDefinition[]
  /** 复用适配器的 Pi→SDKMessage 转换 */
  convertPiMessage: (
    message: AgentMessage,
    sessionId: string,
    channelModelId: string | undefined,
    options: { final?: boolean; uuid?: string },
  ) => SDKMessage | null
  /** 复用适配器的 tool_result 封装 */
  createTextToolResult: (text: string, details?: unknown) => AgentToolResult<unknown>
  /** 复用适配器的 user 消息是否含 tool_result 判定 */
  hasToolResult: (message: SDKMessage) => boolean
  /** 构建与父会话一致的 Proma Skill 白名单过滤器 */
  createSkillsOverride: (additionalSkillPaths: string[] | undefined) => (base: SkillLoadResult) => SkillLoadResult
  /**
   * 重新加载 Proma Skill 并展开 prompt 中显式调用的 /skill:name。
   * explicitSkillNames 用于把父会话通过 UI mention 显式引用的 skill 一并注入子会话
   * （与主会话路径对齐：preparePromptWithPromaSkills 的第三参）。
   */
  preparePromptWithSkills: (
    resourceLoader: ResourceLoader,
    prompt: string,
    explicitSkillNames?: string[],
  ) => Promise<string>
  /** 子会话思考等级（与父会话一致） */
  thinkingLevel: ThinkingLevel
  /**
   * 父会话的运行时护栏（maxTurns/maxBudgetUsd）。子代理消耗的轮次/成本必须计入同一个护栏实例，
   * 否则子代理会绕过用户配置的预算/轮次上限（子会话独立于父 session，不共享 pi 的计费）。
   */
  runtimeGuard: AgentRuntimeGuard
}

/** 从 pi AssistantMessage 抽取纯文本（用于把子代理最终答复作为 tool_result 返回给父会话） */
function extractAssistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((block) => (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block
      ? String((block as { text: unknown }).text ?? '')
      : ''))
    .join('')
    .trim()
}

/** 子代理系统提示：聚焦、独立、返回结论。对齐旧 SDK Task 子代理"接受一个任务、自主完成、汇报结果"的语义。 */
function buildChildSystemPrompt(parentSystemPrompt: string, description: string): string {
  return `${parentSystemPrompt}

---

你现在是一个被主 Agent 委派的临时 SubAgent，任务聚焦：${description}

- 独立完成这个子任务，不要反问主 Agent（你无法与用户交互）。
- 完成后用简洁、结构化的方式直接给出最终结论/产出，这段文本会作为工具结果返回给主 Agent。
- 不要再创建新的 SubAgent。`
}

const SUBAGENT_DELEGATION_TOOL_NAMES = new Set([
  'Agent',
  'mcp__collaboration__delegate_agent',
  'mcp__collaboration__delegate_agents',
  'mcp__collaboration__continue_delegation',
])

function canInheritTool(tool: ToolDefinition): boolean {
  return !SUBAGENT_DELEGATION_TOOL_NAMES.has(tool.name)
}

function dedupeToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>()
  const result: ToolDefinition[] = []
  for (const tool of tools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    result.push(tool)
  }
  return result
}

/**
 * 构建 `Agent` 子代理委派工具定义。
 *
 * 行为对齐通用 Task/Agent 委派工具：
 * - 模型自主调用，传入 description（子任务简述）+ prompt（完整子任务指令）；
 * - 在一个全新的 pi 子会话里独立执行（拥有自己的 read/bash/edit/write/grep/find/ls，
 *   并继承父会话非委派类 Proma / MCP / dynamic tools）；
 * - 子会话每条消息以 parent_tool_use_id 关联流式推给前端，实现嵌套展示（option B 完全对等）；
 * - 子会话结束后，最终文本作为 tool_result 返回给父会话。
 * - 子代理模型：优先 parentInput.subagentModel（如 DeepSeek 主模型下降级到 deepseek-v4-flash），否则继承主模型。
 */
export function createSubagentToolDefinition(deps: SubagentToolDeps): ToolDefinition {
  const { sdk, cwd, parentInput, emitChildMessage } = deps

  return sdk.defineTool({
    name: 'Agent',
    label: '委派子代理',
    description:
      '把一个聚焦的子任务委派给临时 SubAgent，在全新上下文里独立执行并返回结论。' +
      '适合并行探索多个独立子系统、需要独立/对抗性视角（安全审计、设计、调研），' +
      '或直觉路径反复受阻需要深度探索时使用。不要用它做能直接完成的简单操作。',
    promptSnippet: '委派一个聚焦子任务给临时 SubAgent，在独立上下文完成后返回结论。',
    parameters: Type.Object({
      description: Type.String({ description: '子任务的简短描述（一句话，用于 UI 展示与子代理定位）。' }),
      prompt: Type.String({ description: '交给子代理的完整、自包含的任务指令（含必要上下文、约束、期望输出）。' }),
    }),
    async execute(toolCallId, params, signal) {
      const { description, prompt } = params as { description: string; prompt: string }

      const subModel = parentInput.subagentModel?.trim() || parentInput.model
      const childInput: PiAgentQueryOptions = { ...parentInput, model: subModel }
      const { authStorage, registry, model } = await deps.buildModel(childInput)

      const sessionManager = sdk.SessionManager.inMemory(cwd)
      const childTools = dedupeToolDefinitions([
        ...deps.buildBuiltinTools(
          sdk,
          cwd,
          parentInput.additionalDirectories,
          parentInput.canUseTool,
          parentInput.runtimeEnv,
        ),
        ...deps.buildPromaProductTools(sdk, parentInput.canUseTool).filter(canInheritTool),
        ...deps.wrapCustomTools(parentInput.customTools, parentInput.canUseTool).filter(canInheritTool),
      ])

      const proxyUrl = parentInput.proxyUrl?.trim()
      const childSystemPrompt = buildChildSystemPrompt(parentInput.systemPrompt, description)
      const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        ...(proxyUrl ? { httpProxy: proxyUrl } : {}),
      })
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: parentInput.piAgentDir,
        settingsManager,
        noSkills: true,
        additionalSkillPaths: parentInput.additionalSkillPaths ?? [],
        skillsOverride: deps.createSkillsOverride(parentInput.additionalSkillPaths),
        systemPromptOverride: () => childSystemPrompt,
      })
      await resourceLoader.reload()

      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: parentInput.piAgentDir,
        authStorage: authStorage as never,
        modelRegistry: registry as never,
        settingsManager,
        resourceLoader,
        sessionManager,
        model: model as never,
        thinkingLevel: deps.thinkingLevel,
        noTools: 'builtin',
        customTools: childTools,
      })

      // 从 createAgentSession 成功后就纳入 try/finally：setup 阶段（systemPrompt 注入、subscribe、
      // addEventListener）任何抛错都能保证子会话被 dispose，避免泄漏未释放的子会话。
      let unsubscribe: (() => void) | undefined
      let onAbort: (() => void) | undefined
      let lastAssistantText = ''
      try {
        session.agent.toolExecution = 'sequential'

        // 子会话内的 assistant 消息 uuid 分组（复刻父会话逻辑，保证同一条 assistant 的流式增量共用 uuid）
        let activeUuid: string | undefined
        let activeTimestamp: number | undefined
        const assistantUuidFor = (message: AgentMessage): string => {
          const timestamp = typeof (message as { timestamp?: unknown }).timestamp === 'number'
            ? (message as { timestamp: number }).timestamp
            : undefined
          if (!activeUuid || (timestamp !== undefined && activeTimestamp !== undefined && activeTimestamp !== timestamp)) {
            activeUuid = randomUUID()
            activeTimestamp = timestamp
          } else if (activeTimestamp === undefined) {
            activeTimestamp = timestamp
          }
          return activeUuid
        }

        // 子会话消息挂到父会话：session_id 用父会话 id（归属父 turn，便于持久化与渲染），
        // parent_tool_use_id 用本工具调用 id（渲染层据此把子代理输出嵌套进 Agent 工具节点）。
        const forward = (message: SDKMessage | null): void => {
          if (!message) return
          const m = message as { parent_tool_use_id?: string | null; session_id?: string }
          m.parent_tool_use_id = toolCallId
          m.session_id = parentInput.sessionId
          emitChildMessage(message)
        }

        unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          try {
            switch (event.type) {
              case 'message_update': {
                const converted = deps.convertPiMessage(event.message, parentInput.sessionId, subModel, {
                  final: false,
                  uuid: assistantUuidFor(event.message),
                })
                if (converted?.type === 'assistant') forward(converted)
                break
              }
              case 'message_end': {
                const isAssistant = !!event.message && typeof event.message === 'object'
                  && 'role' in event.message && (event.message as { role?: string }).role === 'assistant'
                // 把子代理的轮次/成本计入父会话的同一个 runtimeGuard，确保 maxTurns/maxBudgetUsd
                // 对子代理同样生效（子会话独立于父 session，不共享 pi 计费，必须在此显式回灌）。
                deps.runtimeGuard.recordMessage(event.message)
                const converted = deps.convertPiMessage(event.message, parentInput.sessionId, subModel, {
                  final: true,
                  ...(isAssistant && { uuid: assistantUuidFor(event.message) }),
                })
                if (converted && (converted.type !== 'user' || deps.hasToolResult(converted))) forward(converted)
                if (isAssistant) {
                  lastAssistantText = extractAssistantText(event.message as AssistantMessage) || lastAssistantText
                  activeUuid = undefined
                  activeTimestamp = undefined
                }
                break
              }
              // 故意不转发 agent_end：子代理的结束不是父 turn 的结束，父 turn 由本工具 return 收敛。
            }
          } catch {
            // 子消息桥接失败不应中断子代理执行；结果仍会通过最终 return 汇报。
          }
        })

        onAbort = (): void => {
          session.abort().catch(() => {})
        }
        signal?.addEventListener('abort', onAbort)

        // 与主会话路径对齐：除子任务正文里 /skill: 抠出的 skill 外，
        // 再叠加父会话通过 UI mention 显式引用的 skillMentions，透传给子会话。
        await session.prompt(
          await deps.preparePromptWithSkills(resourceLoader, prompt, parentInput.skillMentions),
          { source: 'rpc' },
        )
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        unsubscribe?.()
        session.dispose()
      }

      return deps.createTextToolResult(
        lastAssistantText || '（子代理未产生文本结论）',
        { subagent: true, description },
      )
    },
  }) as unknown as ToolDefinition
}
