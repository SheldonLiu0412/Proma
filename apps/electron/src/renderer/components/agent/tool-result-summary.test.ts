import { describe, expect, test } from 'bun:test'
import { summarizeToolResultContent } from './tool-result-summary'

describe('summarizeToolResultContent', () => {
  test('Given 纯图片 tool_result When 摘要 Then 不生成占位文本', () => {
    const result = summarizeToolResultContent([
      {
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      },
    ])

    expect(result).toBeUndefined()
  })

  test('Given 图片和文本混合 tool_result When 摘要 Then 只保留文本结果', () => {
    const result = summarizeToolResultContent([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: '图片已生成。' },
    ])

    expect(result).toBe('图片已生成。')
  })

  test('Given 非图片二进制 tool_result When 摘要 Then 保留二进制摘要', () => {
    const result = summarizeToolResultContent([
      { type: 'binary', blob: 'abc', mimeType: 'application/pdf' },
    ])

    expect(result).toBe('[二进制结果: application/pdf]')
  })
})
