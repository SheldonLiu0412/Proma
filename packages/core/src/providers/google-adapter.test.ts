import { describe, expect, test } from 'bun:test'
import { GoogleAdapter } from './google-adapter.ts'
import type { StreamRequestInput, TitleRequestInput } from './types.ts'

interface GoogleThinkingConfigBody {
  includeThoughts?: boolean
  thinkingBudget?: number
  thinkingLevel?: string
}

interface GoogleGenerationConfigBody {
  maxOutputTokens?: number
  thinkingConfig?: GoogleThinkingConfigBody
}

interface GoogleRequestBody {
  generationConfig?: GoogleGenerationConfigBody
}

const adapter = new GoogleAdapter()

function buildStreamBody(overrides: Partial<StreamRequestInput>): GoogleRequestBody {
  const request = adapter.buildStreamRequest({
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'test-key',
    modelId: 'gemini-2.5-flash',
    history: [],
    userMessage: '你好',
    readImageAttachments: () => [],
    ...overrides,
  })
  return JSON.parse(request.body) as GoogleRequestBody
}

function buildTitleBody(overrides: Partial<TitleRequestInput>): GoogleRequestBody {
  const request = adapter.buildTitleRequest({
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'test-key',
    modelId: 'gemini-2.5-flash',
    prompt: '给这段对话起标题',
    ...overrides,
  })
  return JSON.parse(request.body) as GoogleRequestBody
}

describe('Google adapter 思考配置', () => {
  test('Given Gemini 2.5 Flash 未开启思考 When 构建请求 Then 显式关闭 thinkingBudget', () => {
    const body = buildStreamBody({ modelId: 'gemini-2.5-flash' })

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  test('Given Gemini 3 Flash 未开启思考 When 构建请求 Then 使用 minimal 思考等级', () => {
    const body = buildStreamBody({ modelId: 'gemini-3.5-flash' })

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'minimal' })
  })

  test('Given Gemini 2.5 Pro 未开启思考 When 构建请求 Then 使用最小 thinkingBudget', () => {
    const body = buildStreamBody({ modelId: 'gemini-2.5-pro' })

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 128 })
  })

  test('Given Gemini Pro 未开启思考 When 构建请求 Then 使用可用的低思考等级', () => {
    const body = buildStreamBody({ modelId: 'gemini-3.1-pro-preview' })

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })

  test('Given 用户开启思考 When 构建请求 Then 返回思考摘要并设置预算', () => {
    const body = buildStreamBody({
      modelId: 'gemini-2.5-flash',
      thinkingEnabled: true,
    })

    expect(body.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 16384,
    })
  })

  test('Given Gemini 2.5 Flash 标题生成 When 构建请求 Then 标题也关闭默认思考', () => {
    const body = buildTitleBody({ modelId: 'gemini-2.5-flash' })

    expect(body.generationConfig).toEqual({
      maxOutputTokens: 50,
      thinkingConfig: { thinkingBudget: 0 },
    })
  })
})
