/**
 * MCP 服务器验证器
 *
 * 在将 MCP 服务器配置传递给 Agent SDK 之前，验证其可用性：
 * - stdio 类型：检查命令是否存在
 * - http/sse/websocket 类型：真实连接并调用 listTools
 *
 * 避免配置错误的 MCP 服务器导致整个 Agent SDK 无法启动。
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { normalizeMcpTransportType } from '@proma/shared'
import type { McpServerEntry } from '@proma/shared'
import { testMcpServerConnection, type PromaMcpServerConfig } from './mcp-pi-bridge'

/**
 * MCP 验证结果
 */
export interface McpValidationResult {
  /** 服务器名称 */
  name: string
  /** 是否验证通过 */
  valid: boolean
  /** 失败原因（如果 valid 为 false） */
  reason?: string
}

export interface McpValidationOptions {
  fetchFn?: typeof fetch
  defaultCwd?: string
  runtimeEnv?: Record<string, string>
}

/**
 * 验证单个 MCP 服务器配置
 *
 * @param name 服务器名称
 * @param entry MCP 服务器配置
 * @returns 验证结果
 */
export async function validateMcpServer(
  name: string,
  entry: McpServerEntry,
  options: McpValidationOptions = {},
): Promise<McpValidationResult> {
  const type = normalizeMcpTransportType(entry.type ?? entry.transport)

  if (!type) {
    return {
      name,
      valid: false,
      reason: `未知的传输类型: ${String(entry.type ?? entry.transport)}`,
    }
  }

  // stdio 类型：检查命令是否存在
  if (type === 'stdio') {
    if (!entry.command) {
      return {
        name,
        valid: false,
        reason: '缺少 command 字段',
      }
    }

    // 检查命令是否可执行
    const commandValid = await isCommandAvailable(entry.command)
    if (!commandValid) {
      return {
        name,
        valid: false,
        reason: `命令不存在或不可执行: ${entry.command}`,
      }
    }

    return { name, valid: true }
  }

  // 远程类型：检查 URL 格式后做真实 MCP connect + listTools
  if (type === 'http' || type === 'sse' || type === 'websocket') {
    if (!entry.url) {
      return {
        name,
        valid: false,
        reason: '缺少 url 字段',
      }
    }

    let url: URL
    try {
      url = new URL(entry.url)
    } catch {
      return {
        name,
        valid: false,
        reason: `无效的 URL 格式: ${entry.url}`,
      }
    }

    const schemeError = validateRemoteUrlScheme(type, url)
    if (schemeError) {
      return {
        name,
        valid: false,
        reason: schemeError,
      }
    }

    try {
      await testMcpServerConnection(name, buildRemoteTestConfig(type, entry), options.fetchFn, options.defaultCwd, options.runtimeEnv)
      return { name, valid: true }
    } catch (error) {
      return {
        name,
        valid: false,
        reason: formatRemoteMcpError(type, error),
      }
    }
  }
  return {
    name,
    valid: false,
    reason: `未知的传输类型: ${type}`,
  }
}

function validateRemoteUrlScheme(type: PromaMcpServerConfig['type'], url: URL): string | undefined {
  if (type === 'websocket') {
    return url.protocol === 'ws:' || url.protocol === 'wss:'
      ? undefined
      : `WebSocket MCP 需要使用 ws:// 或 wss:// URL，当前为 ${url.protocol}`
  }

  return url.protocol === 'http:' || url.protocol === 'https:'
    ? undefined
    : `${type.toUpperCase()} MCP 需要使用 http:// 或 https:// URL，当前为 ${url.protocol}`
}

function buildRemoteTestConfig(type: PromaMcpServerConfig['type'], entry: McpServerEntry): PromaMcpServerConfig {
  return {
    type,
    url: entry.url,
    ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
    ...(entry.timeout !== undefined && { timeout: entry.timeout }),
    ...(entry.startup_timeout_sec !== undefined && { startup_timeout_sec: entry.startup_timeout_sec }),
    ...(entry.tool_timeout_sec !== undefined && { tool_timeout_sec: entry.tool_timeout_sec }),
    ...(entry.sessionId && { sessionId: entry.sessionId }),
    ...(entry.reconnectionOptions && { reconnectionOptions: entry.reconnectionOptions }),
    ...(entry.auth && { auth: entry.auth }),
    required: true,
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true
  return /timeout|timed out|超时|abort/i.test(getErrorMessage(error))
}

function isAuthError(error: unknown): boolean {
  if (error instanceof Error && /Unauthorized|Auth/i.test(error.name)) return true
  return /\b(401|403)\b|unauthorized|forbidden|auth|认证|授权/i.test(getErrorMessage(error))
}

function isProtocolError(error: unknown): boolean {
  return /protocol|json-?rpc|initialize|listTools|MCP|SSE|event stream|content-type/i.test(getErrorMessage(error))
}

function formatRemoteMcpError(type: PromaMcpServerConfig['type'], error: unknown): string {
  const detail = getErrorMessage(error)
  if (isTimeoutError(error)) {
    return `连接超时，请检查服务是否启动、URL 是否正确以及网络是否可达。详情: ${detail}`
  }
  if (isAuthError(error)) {
    return `认证失败，请检查 Authorization 等请求头或服务端权限配置。详情: ${detail}`
  }
  if (isProtocolError(error)) {
    return `已连接到远程地址，但 MCP 协议握手或 listTools 失败，请确认该地址是 ${type} MCP 端点。详情: ${detail}`
  }
  return `无法连接远程 MCP 服务，请检查服务状态、URL、代理和请求头配置。详情: ${detail}`
}

/**
 * 检查命令是否可用
 *
 * 策略：
 * 1. 如果是绝对路径，检查文件是否存在
 * 2. 如果是相对命令（如 npx），使用 which 查找
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  // 绝对路径
  if (command.startsWith('/') || command.startsWith('\\') || /^[A-Z]:/i.test(command)) {
    return existsSync(command)
  }

  // 相对命令：使用 which 查找
  try {
    // 跨平台 which 查找
    const whichCommand = process.platform === 'win32' ? 'where' : 'which'
    execSync(`${whichCommand} ${command}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 批量验证 MCP 服务器配置
 *
 * @param servers MCP 服务器配置对象
 * @returns 验证结果数组
 */
export async function validateMcpServers(
  servers: Record<string, McpServerEntry>,
): Promise<McpValidationResult[]> {
  const results: McpValidationResult[] = []

  for (const [name, entry] of Object.entries(servers)) {
    // 跳过未启用的服务器
    if (!entry.enabled) continue

    const result = await validateMcpServer(name, entry)
    results.push(result)
  }

  return results
}
