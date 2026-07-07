import { describe, expect, test } from 'bun:test'
import { inferMcpTransportType, normalizeMcpTransportType } from './mcp-transport'

describe('MCP transport normalization', () => {
  test('keeps canonical transport types unchanged', () => {
    expect(normalizeMcpTransportType('stdio')).toBe('stdio')
    expect(normalizeMcpTransportType('http')).toBe('http')
    expect(normalizeMcpTransportType('sse')).toBe('sse')
    expect(normalizeMcpTransportType('websocket')).toBe('websocket')
  })

  test('maps Streamable HTTP aliases to canonical http', () => {
    expect(normalizeMcpTransportType('streamableHttp')).toBe('http')
    expect(normalizeMcpTransportType('streamable-http')).toBe('http')
    expect(normalizeMcpTransportType('streamable_http')).toBe('http')
  })

  test('maps WebSocket aliases to canonical websocket', () => {
    expect(normalizeMcpTransportType('ws')).toBe('websocket')
    expect(normalizeMcpTransportType('wss')).toBe('websocket')
  })

  test('rejects unknown transport types', () => {
    expect(normalizeMcpTransportType(undefined)).toBeNull()
  })

  test('infers legacy entries without type', () => {
    expect(inferMcpTransportType({ command: 'npx' })).toBe('stdio')
    expect(inferMcpTransportType({ url: 'http://127.0.0.1:14242/mcp/' })).toBe('http')
    expect(inferMcpTransportType({ url: 'ws://127.0.0.1:14242/mcp/' })).toBe('websocket')
    expect(inferMcpTransportType({ url: 'wss://example.com/mcp/' })).toBe('websocket')
    expect(inferMcpTransportType({})).toBe('stdio')
  })
})
