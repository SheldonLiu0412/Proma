import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Channel, ChannelModel, ProviderType } from '@proma/shared'

let channels: Channel[] = []

mock.module('./channel-manager', () => ({
  listChannels: () => channels,
  getChannelById: (id: string) => channels.find((channel) => channel.id === id),
}))

const {
  listSwitchableChannels,
  resolveChannelByIndex,
} = await import('./bridge-model-utils')

interface TestChannelInput {
  id: string
  name: string
  provider: ProviderType
  enabled?: boolean
  models?: ChannelModel[]
}

function enabledModel(id: string): ChannelModel {
  return { id, name: id, enabled: true }
}

function disabledModel(id: string): ChannelModel {
  return { id, name: id, enabled: false }
}

function testChannel(input: TestChannelInput): Channel {
  return {
    id: input.id,
    name: input.name,
    provider: input.provider,
    baseUrl: 'https://example.com',
    apiKey: '',
    models: input.models ?? [enabledModel(`${input.id}-model`)],
    enabled: input.enabled ?? true,
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  channels = []
})

describe('Bridge 模型切换渠道过滤', () => {
  test('Given 混合渠道 When 列出可切换渠道 Then 只保留 Agent 兼容且启用并有启用模型的渠道', () => {
    channels = [
      testChannel({ id: 'anthropic', name: 'Anthropic', provider: 'anthropic' }),
      testChannel({ id: 'openai', name: 'OpenAI', provider: 'openai' }),
      testChannel({ id: 'custom', name: 'Custom', provider: 'custom' }),
      testChannel({ id: 'doubao', name: '豆包', provider: 'doubao' }),
      testChannel({ id: 'disabled', name: '停用 DeepSeek', provider: 'deepseek', enabled: false }),
      testChannel({
        id: 'no-enabled-model',
        name: '无启用模型',
        provider: 'qwen-anthropic',
        models: [disabledModel('qwen-disabled')],
      }),
      testChannel({ id: 'qwen-anthropic', name: '通义 Anthropic', provider: 'qwen-anthropic' }),
    ]

    expect(listSwitchableChannels().map((channel) => channel.id)).toEqual([
      'anthropic',
      'qwen-anthropic',
    ])
  })

  test('Given Chat-only 渠道被过滤 When 按序号解析渠道 Then 序号只对应可切换渠道', () => {
    channels = [
      testChannel({ id: 'openai', name: 'OpenAI', provider: 'openai' }),
      testChannel({ id: 'deepseek', name: 'DeepSeek', provider: 'deepseek' }),
      testChannel({ id: 'custom', name: 'Custom', provider: 'custom' }),
      testChannel({ id: 'kimi', name: 'Kimi API', provider: 'kimi-api' }),
    ]

    expect(resolveChannelByIndex(1)?.id).toBe('deepseek')
    expect(resolveChannelByIndex(2)?.id).toBe('kimi')
    expect(resolveChannelByIndex(3)).toBeUndefined()
  })
})
