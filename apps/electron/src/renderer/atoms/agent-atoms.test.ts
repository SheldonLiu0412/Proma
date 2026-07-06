import { describe, expect, test } from 'bun:test'
import {
  applyAgentEvent,
  buildAgentSessionIndicatorMap,
  shouldApplyStreamComplete,
  type AgentStreamState,
} from './agent-atoms'
import type { AgentEvent } from '@proma/shared'

function streamState(running: boolean): AgentStreamState {
  return {
    running,
    content: '',
    toolActivities: [],
  }
}

describe('buildAgentSessionIndicatorMap', () => {
  test('Given 恢复出的 pending permission 但没有 running stream When 构建指示点 Then 会话标记为 blocked', () => {
    const result = buildAgentSessionIndicatorMap({
      streamStates: new Map(),
      pendingPermissionRequests: new Map([['session-a', [{}]]]),
      pendingAskUserRequests: new Map(),
      pendingExitPlanRequests: new Map(),
      unviewedCompletedSessionIds: new Set(),
    })

    expect(result.get('session-a')).toBe('blocked')
  })

  test('Given 会话同时 running 且存在 pending 请求 When 构建指示点 Then blocked 优先于 running', () => {
    const result = buildAgentSessionIndicatorMap({
      streamStates: new Map([['session-a', streamState(true)]]),
      pendingPermissionRequests: new Map(),
      pendingAskUserRequests: new Map([['session-a', [{}]]]),
      pendingExitPlanRequests: new Map(),
      unviewedCompletedSessionIds: new Set(['session-a']),
    })

    expect(result.get('session-a')).toBe('blocked')
  })

  test('Given 无 pending 的 running 与 completed 会话 When 构建指示点 Then 分别保留对应状态', () => {
    const result = buildAgentSessionIndicatorMap({
      streamStates: new Map([
        ['running-session', streamState(true)],
        ['idle-session', streamState(false)],
      ]),
      pendingPermissionRequests: new Map(),
      pendingAskUserRequests: new Map(),
      pendingExitPlanRequests: new Map(),
      unviewedCompletedSessionIds: new Set(['completed-session']),
    })

    expect(result.get('running-session')).toBe('running')
    expect(result.get('completed-session')).toBe('completed')
    expect(result.has('idle-session')).toBe(false)
  })
})

describe('applyAgentEvent run_resumed 兼容态', () => {
  test('Given 普通完成后保留 usage 的空闲状态 When 收到旧 run_resumed Then 不恢复运行态', () => {
    const prev: AgentStreamState = {
      running: false,
      backgroundWaiting: false,
      content: '',
      toolActivities: [],
      inputTokens: 10,
    }

    expect(applyAgentEvent(prev, { type: 'run_resumed' } as AgentEvent)).toBe(prev)
  })

  test('Given 历史后台等待状态 When 收到 run_resumed Then 仅兼容性恢复运行态', () => {
    const prev: AgentStreamState = {
      running: false,
      backgroundWaiting: true,
      content: '',
      toolActivities: [],
    }

    expect(applyAgentEvent(prev, { type: 'run_resumed' } as AgentEvent)).toEqual({
      running: true,
      backgroundWaiting: false,
      content: '',
      toolActivities: [],
    })
  })
})

describe('shouldApplyStreamComplete 代际保护', () => {
  test('Given 新运行已开始 When 旧 complete 晚到 Then 忽略旧完成事件', () => {
    const current: AgentStreamState = {
      running: true,
      startedAt: 200,
      content: '',
      toolActivities: [],
    }

    expect(shouldApplyStreamComplete(current, 100)).toBe(false)
  })

  test('Given 当前运行匹配 When complete 到达 Then 允许收束状态', () => {
    const current: AgentStreamState = {
      running: true,
      startedAt: 100,
      content: '',
      toolActivities: [],
    }

    expect(shouldApplyStreamComplete(current, 100)).toBe(true)
  })

  test('Given 状态已清理 When 旧 complete 重复到达 Then 不再应用副作用', () => {
    expect(shouldApplyStreamComplete(undefined, 100)).toBe(false)
  })
})
