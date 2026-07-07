import type {
  AgentStreamPayload,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@proma/shared'

/**
 * 飞书流式卡片的运行时状态机。
 *
 * 把 AgentStreamPayload（sdk_message + proma_event）累积成一个结构化的
 * RunState，便于渲染层无时序地把状态转成 CardKit 2.0 JSON。设计参考
 * zara/feishu-claude-code-bridge `src/card/run-state.ts`，但消费的是
 * Proma 的 SDKMessage 形态而非 claude CLI 的 stream-json。
 *
 * 所有 reducer 是纯函数：`reduce(state, payload) → state`。
 */

export type ToolStatus = 'running' | 'done' | 'error'

export interface ToolEntry {
  id: string
  name: string
  input: unknown
  status: ToolStatus
  output?: string
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry }

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null

export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout'

export interface RunState {
  blocks: Block[]
  /** assistant uuid → text block 下标，用于 Pi partial 快照 upsert。 */
  assistantTextBlockIndexes?: Record<string, number>
  /** 缺少 uuid 的 partial 只能按最近匿名 partial 快照兜底替换。 */
  anonymousPartialTextBlockIndex?: number
  /** 已展示的 tool_use，避免 partial 快照重复插入工具块。 */
  seenToolUseKeys?: Record<string, true>
  reasoning: { content: string; active: boolean }
  footer: FooterStatus
  terminal: Terminal
  errorMsg?: string
  /** idle_timeout 终态下，无响应的分钟数（卡片渲染时拼"N 分钟无响应"）。 */
  idleTimeoutMinutes?: number
  startedAt: number
  /** result 消息携带的元数据，渲染卡片底部 summary 用。 */
  meta: {
    durationMs?: number
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
    model?: string
  }
}

export function createInitialState(): RunState {
  return {
    blocks: [],
    assistantTextBlockIndexes: {},
    seenToolUseKeys: {},
    reasoning: { content: '', active: false },
    footer: 'thinking',
    terminal: 'running',
    startedAt: Date.now(),
    meta: {},
  }
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  )
}

function upsertTextSnapshot(
  state: RunState,
  text: string,
  uuid: string | undefined,
  isPartial: boolean,
): RunState {
  if (uuid) {
    const assistantTextBlockIndexes = state.assistantTextBlockIndexes ?? {}
    const existingIndex = assistantTextBlockIndexes[uuid]
    if (typeof existingIndex === 'number') {
      const existing = state.blocks[existingIndex]
      if (existing && existing.kind === 'text') {
        const blocks = [...state.blocks]
        blocks[existingIndex] = { kind: 'text', content: text, streaming: isPartial }
        return {
          ...state,
          blocks,
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        }
      }
    }

    const blocks = [...closeStreamingText(state.blocks), { kind: 'text' as const, content: text, streaming: true }]
    return {
      ...state,
      blocks,
      assistantTextBlockIndexes: { ...assistantTextBlockIndexes, [uuid]: blocks.length - 1 },
      reasoning: { ...state.reasoning, active: false },
      footer: 'streaming',
    }
  }

  if (isPartial) {
    const existingIndex = state.anonymousPartialTextBlockIndex
    if (typeof existingIndex === 'number') {
      const existing = state.blocks[existingIndex]
      if (existing && existing.kind === 'text') {
        const blocks = [...state.blocks]
        blocks[existingIndex] = { kind: 'text', content: text, streaming: true }
        return {
          ...state,
          blocks,
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        }
      }
    }

    const blocks = [...closeStreamingText(state.blocks), { kind: 'text' as const, content: text, streaming: true }]
    return {
      ...state,
      blocks,
      anonymousPartialTextBlockIndex: blocks.length - 1,
      reasoning: { ...state.reasoning, active: false },
      footer: 'streaming',
    }
  }

  if (state.anonymousPartialTextBlockIndex !== undefined) {
    const blocks = [...state.blocks]
    blocks[state.anonymousPartialTextBlockIndex] = { kind: 'text', content: text, streaming: false }
    return {
      ...state,
      blocks,
      anonymousPartialTextBlockIndex: undefined,
      reasoning: { ...state.reasoning, active: false },
      footer: 'streaming',
    }
  }

  return {
    ...state,
    blocks: [...closeStreamingText(state.blocks), { kind: 'text', content: text, streaming: true }],
    reasoning: { ...state.reasoning, active: false },
    footer: 'streaming',
  }
}

function appendThinking(state: RunState, delta: string): RunState {
  return {
    ...state,
    reasoning: { content: state.reasoning.content + delta, active: true },
    footer: 'thinking',
  }
}

function startTool(state: RunState, id: string, name: string, input: unknown): RunState {
  const tool: ToolEntry = { id, name, input, status: 'running' }
  return {
    ...state,
    blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
    reasoning: { ...state.reasoning, active: false },
    footer: 'tool_running',
  }
}

function markToolSeen(state: RunState, key: string): RunState {
  const seenToolUseKeys = state.seenToolUseKeys ?? {}
  if (seenToolUseKeys[key]) return state
  return { ...state, seenToolUseKeys: { ...seenToolUseKeys, [key]: true } }
}

function completeTool(state: RunState, id: string, output: string, isError: boolean): RunState {
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'tool' || b.tool.id !== id) return b
    return {
      ...b,
      tool: { ...b.tool, status: isError ? ('error' as const) : ('done' as const), output },
    }
  })
  return { ...state, blocks }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: string }).text === 'string') {
          return (c as { text: string }).text
        }
        try {
          return JSON.stringify(c)
        } catch {
          return String(c)
        }
      })
      .join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

export function reduce(state: RunState, payload: AgentStreamPayload): RunState {
  if (payload.kind === 'sdk_message') {
    const msg = payload.message

    if (msg.type === 'assistant') {
      const am = msg as SDKAssistantMessage
      let next = state
      if (am.message?.model && !next.meta.model) {
        next = { ...next, meta: { ...next.meta, model: am.message.model } }
      }
      // assistant 消息上若携带顶层 error 字段，直接转为 error 终态
      // （SDK 偶尔会在 assistant 帧带 error，不走 result 路径）
      if (am.error?.message) {
        return markError(state, am.error.message)
      }
      const meta = am as SDKAssistantMessage & { _partial?: boolean }
      const messageUuid = typeof meta.uuid === 'string' && meta.uuid.length > 0 ? meta.uuid : undefined
      const isPartial = meta._partial === true
      const assistantText = am.message?.content
        ?.map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
        .join('') ?? ''
      if (assistantText) {
        next = upsertTextSnapshot(next, assistantText, messageUuid, isPartial)
      }

      for (const [index, block] of (am.message?.content ?? []).entries()) {
        if (block.type === 'thinking') {
          const thinking = (block as { thinking?: unknown }).thinking
          if (typeof thinking === 'string' && thinking) {
            next = appendThinking(next, thinking)
          }
        } else if (block.type === 'tool_use') {
          const tb = block as { id?: unknown; name?: unknown; input?: unknown }
          if (typeof tb.id === 'string' && typeof tb.name === 'string') {
            const toolKey = `${messageUuid ?? (isPartial ? 'anonymous-partial' : 'anonymous-final')}:${tb.id || `${tb.name}:${index}`}`
            if (next.seenToolUseKeys?.[toolKey]) continue
            next = markToolSeen(next, toolKey)
            next = startTool(next, tb.id, tb.name, tb.input)
          }
        }
      }
      return next
    }

    if (msg.type === 'user') {
      const um = msg as SDKUserMessage
      let next = state
      for (const block of um.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const trb = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown }
          if (typeof trb.tool_use_id === 'string') {
            const output = stringifyToolResult(trb.content)
            next = completeTool(next, trb.tool_use_id, output, trb.is_error === true)
          }
        }
      }
      return next
    }

    if (msg.type === 'result') {
      const rm = msg as SDKResultMessage
      const meta = {
        ...state.meta,
        durationMs: Date.now() - state.startedAt,
        inputTokens: rm.usage?.input_tokens,
        outputTokens: rm.usage?.output_tokens,
        costUsd: rm.total_cost_usd,
      }
      // result.subtype 以 'error' 开头视为错误（含 error / error_max_turns /
      // error_max_budget_usd / error_during_execution）
      const isError = typeof rm.subtype === 'string' && rm.subtype.startsWith('error')
      if (isError) {
        const errMsg = rm.errors?.[0] ?? rm.subtype ?? 'Agent 运行出错'
        return {
          ...state,
          blocks: closeStreamingText(state.blocks),
          reasoning: { ...state.reasoning, active: false },
          terminal: 'error',
          footer: null,
          errorMsg: errMsg,
          meta,
        }
      }
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
        meta,
      }
    }

    return state
  }

  if (payload.kind === 'proma_event') {
    const evt = payload.event
    if (evt.type === 'model_resolved') {
      return { ...state, meta: { ...state.meta, model: evt.model } }
    }
    return state
  }

  return state
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  }
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  }
}

export function markError(state: RunState, message: string): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'error',
    footer: null,
    errorMsg: message,
  }
}

/** 当外部确认 run 已结束但 state 仍是 running 时，兜底收尾。 */
export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  }
}
