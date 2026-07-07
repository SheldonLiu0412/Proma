import type { McpTransportType } from '../types/agent'

const STREAMABLE_HTTP_ALIASES = new Set([
  'streamablehttp',
  'streamableHttp',
  'streamable-http',
  'streamable_http',
])

const WEBSOCKET_ALIASES = new Set(['ws', 'wss'])

export function normalizeMcpTransportType(type: unknown): McpTransportType | null {
  if (type === 'stdio' || type === 'http' || type === 'sse' || type === 'websocket') {
    return type
  }

  if (typeof type === 'string' && STREAMABLE_HTTP_ALIASES.has(type)) {
    return 'http'
  }

  if (typeof type === 'string' && WEBSOCKET_ALIASES.has(type.toLowerCase())) {
    return 'websocket'
  }

  return null
}

export function inferMcpTransportType(entry: {
  command?: unknown
  url?: unknown
}): McpTransportType {
  if (typeof entry.command === 'string' && entry.command.trim()) {
    return 'stdio'
  }

  if (typeof entry.url === 'string' && entry.url.trim()) {
    const url = entry.url.trim()
    try {
      const protocol = new URL(url).protocol.toLowerCase()
      if (protocol === 'ws:' || protocol === 'wss:') {
        return 'websocket'
      }
    } catch {
      if (/^wss?:\/\//i.test(url)) {
        return 'websocket'
      }
    }

    return 'http'
  }

  return 'stdio'
}
