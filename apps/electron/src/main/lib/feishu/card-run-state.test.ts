import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, SDKAssistantMessage } from '@proma/shared'
import { createInitialState, reduce } from './card-run-state'

function assistant(text: string, options: { uuid?: string; partial?: boolean } = {}): AgentStreamPayload {
  const message: SDKAssistantMessage & { _partial?: boolean } = {
    type: 'assistant',
    ...(options.uuid ? { uuid: options.uuid } : {}),
    ...(options.partial ? { _partial: true } : {}),
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'text', text }],
    },
  }
  return { kind: 'sdk_message', message }
}

describe('飞书卡片运行态 partial 快照', () => {
  test('Given 同 uuid partial 与 final When reduce Then 最终文本替换同一块而不追加膨胀', () => {
    const state = [
      assistant('你', { uuid: 'assistant-1', partial: true }),
      assistant('你好', { uuid: 'assistant-1', partial: true }),
      assistant('你好，完成', { uuid: 'assistant-1' }),
    ].reduce(reduce, createInitialState())

    expect(state.blocks).toEqual([
      { kind: 'text', content: '你好，完成', streaming: false },
    ])
  })

  test('Given 缺少 uuid 的匿名 partial When reduce Then 用最终 assistant 替换最近匿名快照', () => {
    const state = [
      assistant('草稿', { partial: true }),
      assistant('最终'),
    ].reduce(reduce, createInitialState())

    expect(state.blocks).toEqual([
      { kind: 'text', content: '最终', streaming: false },
    ])
  })
})
