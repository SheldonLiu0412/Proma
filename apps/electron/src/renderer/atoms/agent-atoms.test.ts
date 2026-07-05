import { describe, expect, test } from 'bun:test'
import {
  buildAgentSessionIndicatorMap,
  type AgentStreamState,
} from './agent-atoms'

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
