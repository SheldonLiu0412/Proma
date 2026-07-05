import { describe, expect, test } from 'bun:test'
import type {
  Agent,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentToolResult,
  PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { createAgentRuntimeGuard } from './agent-runtime-guards'
import { installRuntimeGuardHooks } from './adapters/pi-agent-adapter'

type AfterToolCallHook = NonNullable<Agent['afterToolCall']>
type PrepareNextTurnHook = NonNullable<Agent['prepareNextTurnWithContext']>

function assistantMessage(costUsd?: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '完成' }],
    stopReason: 'stop',
    ...(costUsd != null && {
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: costUsd },
      },
    }),
  } as unknown as AgentMessage
}

function toolResult(terminate = false): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: '工具结果' }],
    details: { ok: true },
    terminate,
  }
}

function turnContext(message: AgentMessage = assistantMessage()): PrepareNextTurnContext {
  return {
    message,
    toolResults: [],
    context: {
      systemPrompt: 'system',
      messages: [message],
      tools: [],
    },
    newMessages: [message],
  } as unknown as PrepareNextTurnContext
}

function afterToolCallContext(result: AgentToolResult<unknown>): Parameters<AfterToolCallHook>[0] {
  return {
    result,
    isError: false,
  } as unknown as Parameters<AfterToolCallHook>[0]
}

function createFakeSession(params?: {
  afterToolCall?: AfterToolCallHook
  prepareNextTurnWithContext?: PrepareNextTurnHook
}): { session: AgentSession; getClearCount: () => number } {
  let clearCount = 0
  const session = {
    agent: {
      afterToolCall: params?.afterToolCall,
      prepareNextTurnWithContext: params?.prepareNextTurnWithContext,
      clearAllQueues: () => {
        clearCount += 1
      },
    },
  } as unknown as AgentSession

  return {
    session,
    getClearCount: () => clearCount,
  }
}

describe('Agent runtime guard', () => {
  test('纯文本 turn 达到 maxTurns 后阻止下一轮并返回 error_max_turns', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1 })

    guard.recordMessage(assistantMessage())

    expect(guard.shouldStopBeforeNextTurn()).toBe(true)
    expect(guard.getLimitResultOverride()).toMatchObject({
      subtype: 'error_max_turns',
      terminalReason: 'max_turns',
    })
    expect(guard.getResultOverride([assistantMessage()])?.errors[0]).toContain('最大轮次限制')
  })

  test('纯文本 turn 达到预算后阻止下一轮并返回 error_max_budget_usd', () => {
    const guard = createAgentRuntimeGuard({ maxBudgetUsd: 0.01 })
    const message = assistantMessage(0.02)

    guard.recordMessage(message)

    expect(guard.shouldStopBeforeNextTurn()).toBe(true)
    expect(guard.getResultOverride([message])).toMatchObject({
      subtype: 'error_max_budget_usd',
      terminalReason: 'max_budget_usd',
    })
  })

  test('未达到限制时不覆盖正常 result', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 2, maxBudgetUsd: 1 })

    guard.recordMessage(assistantMessage(0.1))

    expect(guard.shouldStopBeforeNextTurn()).toBe(false)
    expect(guard.getLimitResultOverride()).toBeUndefined()
    expect(guard.getResultOverride([assistantMessage()])).toBeUndefined()
  })

  test('工具结果仍会在达到限制后设置 terminate', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1 })

    guard.recordMessage(assistantMessage())
    const guardedResult = guard.applyToolResult(toolResult())

    expect(guardedResult.terminate).toBe(true)
  })

  test('Pi adapter hook 在 turn 边界清空 steer/follow-up 队列', async () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1 })
    const previousSnapshot = { context: { systemPrompt: 'next', messages: [], tools: [] } } as unknown as AgentLoopTurnUpdate
    const { session, getClearCount } = createFakeSession({
      prepareNextTurnWithContext: async () => previousSnapshot,
    })

    installRuntimeGuardHooks(session, guard)
    guard.recordMessage(assistantMessage())
    const hook = session.agent.prepareNextTurnWithContext
    if (!hook) throw new Error('prepareNextTurnWithContext 未安装')

    const nextTurn = await hook(turnContext(), undefined)

    expect(nextTurn).toBe(previousSnapshot)
    expect(getClearCount()).toBe(1)
  })

  test('Pi adapter afterToolCall hook 保留已有 hook 输出并设置 terminate', async () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1 })
    const { session } = createFakeSession({
      afterToolCall: async () => ({ content: [{ type: 'text', text: '前置 hook' }] }),
    })

    installRuntimeGuardHooks(session, guard)
    guard.recordMessage(assistantMessage())
    const hook = session.agent.afterToolCall
    if (!hook) throw new Error('afterToolCall 未安装')

    const result = await hook(afterToolCallContext(toolResult()), undefined)

    expect(result).toMatchObject({
      content: [{ type: 'text', text: '前置 hook' }],
      terminate: true,
    })
  })
})
