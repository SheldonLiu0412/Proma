/**
 * Proma MCP → Pi customTools bridge
 *
 * Pi SDK 没有直接消费 Proma 工作区 MCP server 配置的入口，因此这里把工作区
 * 已启用的 MCP tools 转换为 Pi customTools。连接生命周期限定在一次 Agent turn，
 * 由调用方在 finally 中 cleanup，避免 stdio 子进程或 HTTP 连接残留。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai/compat'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpReconnectionOptions, McpTransportType } from '@proma/shared'
import { mergeRuntimeEnv } from './agent-runtime-env'

export interface PromaMcpServerConfig {
  type: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  required?: boolean
  timeout?: number
  startup_timeout_sec?: number
  tool_timeout_sec?: number
  sessionId?: string
  reconnectionOptions?: McpReconnectionOptions
  auth?: Record<string, unknown>
}

export interface McpBridgeBuildResult {
  tools: ToolDefinition[]
  readOnlyToolNames: Set<string>
  cleanup: () => Promise<void>
}

interface ConnectedMcpServer {
  name: string
  client: import('@modelcontextprotocol/sdk/client/index.js').Client
  transport: Transport
  toolTimeoutMs: number
  closePromise?: Promise<void>
}

interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
  }
  _meta?: Record<string, unknown>
}

interface McpResourceContentInfo {
  uri?: string
  mimeType?: string
  text?: string
  blob?: string
  _meta?: unknown
  raw: Record<string, unknown>
}

interface McpResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
  size?: number
}

interface McpResourceTemplateInfo {
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}

interface McpPromptInfo {
  name: string
  description?: string
  arguments?: unknown[]
}

interface McpConnectionTestResult {
  toolCount: number
}

interface StreamableHttpReconnectionOptions {
  maxReconnectionDelay: number
  initialReconnectionDelay: number
  reconnectionDelayGrowFactor: number
  maxRetries: number
}

type DefineTool = typeof import('@earendil-works/pi-coding-agent')['defineTool']

const MCP_BRIDGE_LOAD_CONCURRENCY = 4
const BINARY_DATA_PREVIEW_CHARS = 120
const READ_ONLY_TOOL_ACTIONS = new Set(['list', 'get', 'search', 'read', 'fetch', 'query'])
const MUTATING_TOOL_ACTIONS = new Set([
  'append',
  'archive',
  'cancel',
  'clear',
  'commit',
  'create',
  'delete',
  'deploy',
  'drop',
  'edit',
  'execute',
  'insert',
  'install',
  'kill',
  'merge',
  'move',
  'mutate',
  'patch',
  'post',
  'publish',
  'push',
  'put',
  'remove',
  'rename',
  'replace',
  'restart',
  'run',
  'send',
  'set',
  'start',
  'stop',
  'submit',
  'trigger',
  'uninstall',
  'update',
  'upload',
  'upsert',
  'write',
])

type McpServerLoadResult =
  | {
      ok: true
      serverName: string
      config: PromaMcpServerConfig
      server: ConnectedMcpServer
      serverTools: McpToolInfo[]
    }
  | {
      ok: false
      serverName: string
      config: PromaMcpServerConfig
      error: unknown
    }

function createMcpAbortError(): Error {
  const error = new Error('MCP 请求已中止')
  error.name = 'AbortError'
  return error
}

async function withAbortableMcpRequest<T>(
  server: ConnectedMcpServer,
  signal: AbortSignal | undefined,
  task: (options: RequestOptions | undefined) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const requestOptions = signal || timeoutMs !== undefined
    ? {
        ...(signal ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      } satisfies RequestOptions
    : undefined
  let abortHandler: (() => void) | undefined

  if (signal) {
    abortHandler = () => {
      closeConnectedServer(server).catch((error: unknown) => {
        console.warn(`[MCP Bridge] 中止请求后关闭 MCP transport 失败 (${server.name}):`, error)
      })
    }
    if (signal.aborted) {
      abortHandler()
      throw createMcpAbortError()
    } else {
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  }

  try {
    return await task(requestOptions)
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler)
    }
  }
}

function sanitizeToolPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized || 'unnamed'
}

function bridgeToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeToolPart(serverName)}__${sanitizeToolPart(toolName)}`
}

function uniqueBridgeToolName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName)
    return baseName
  }
  let index = 2
  while (usedNames.has(`${baseName}__${index}`)) index++
  const uniqueName = `${baseName}__${index}`
  usedNames.add(uniqueName)
  return uniqueName
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getBooleanMeta(meta: Record<string, unknown> | undefined, keys: string[]): boolean {
  if (!meta) return false
  return keys.some((key) => meta[key] === true)
}

function toolNameActionCandidates(toolName: string): string[] {
  const bridgeParts = toolName.split('__')
  if (bridgeParts.length >= 3 && bridgeParts[0] === 'mcp') {
    return [bridgeParts.slice(2).join('__')]
  }
  return [toolName]
}

function tokenizeToolName(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function hasMutatingToolName(toolName: string): boolean {
  return toolNameActionCandidates(toolName).some((candidate) =>
    tokenizeToolName(candidate).some((token) => MUTATING_TOOL_ACTIONS.has(token)),
  )
}

function hasReadOnlyToolName(toolName: string): boolean {
  return toolNameActionCandidates(toolName).some((candidate) => {
    const [firstToken] = tokenizeToolName(candidate)
    return firstToken ? READ_ONLY_TOOL_ACTIONS.has(firstToken) : false
  })
}

function isReadOnlyMcpTool(tool: McpToolInfo): boolean {
  if (tool.annotations?.destructiveHint === true) return false
  if (getBooleanMeta(tool._meta, ['destructiveHint', 'destructive', 'mutating', 'write'])) return false
  if (hasMutatingToolName(tool.name)) return false
  if (tool.annotations?.readOnlyHint === true) return true
  if (getBooleanMeta(tool._meta, ['readOnlyHint', 'readOnly', 'readOnlyTool'])) return true
  return hasReadOnlyToolName(tool.name)
}

function asJsonObjectSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>
    return {
      type: 'object',
      ...record,
    }
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }
}

function getStartupTimeoutMs(config: PromaMcpServerConfig): number {
  return Math.max(1, config.startup_timeout_sec ?? config.timeout ?? 30) * 1000
}

const DEFAULT_TOOL_TIMEOUT_SEC = 60

function getToolTimeoutMs(config: PromaMcpServerConfig): number {
  return Math.max(1, config.tool_timeout_sec ?? DEFAULT_TOOL_TIMEOUT_SEC) * 1000
}

function createMcpTimeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} 超时 (${Math.ceil(timeoutMs / 1000)}s)`)
  error.name = 'TimeoutError'
  return error
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasHeaders(headers: Record<string, string> | undefined): headers is Record<string, string> {
  return Boolean(headers && Object.keys(headers).length > 0)
}

function mergeHeaderInit(existing: HeadersInit | undefined, headers: Record<string, string>): Headers {
  const merged = new Headers(existing)
  for (const [key, value] of Object.entries(headers)) {
    merged.set(key, value)
  }
  return merged
}

function createHeaderFetch(headers: Record<string, string> | undefined, fetchFn?: typeof fetch): typeof fetch | undefined {
  if (!fetchFn && !hasHeaders(headers)) return undefined
  const baseFetch = fetchFn ?? fetch
  const headerFetch = ((input, init) => {
    if (!hasHeaders(headers)) return baseFetch(input, init)
    return baseFetch(input, {
      ...init,
      headers: mergeHeaderInit(init?.headers, headers),
    })
  }) as typeof fetch
  const preconnect = (baseFetch as typeof fetch & { preconnect?: unknown }).preconnect
  return typeof preconnect === 'function'
    ? Object.assign(headerFetch, { preconnect }) as typeof fetch
    : headerFetch
}

function normalizeReconnectionOptions(options: McpReconnectionOptions | undefined): StreamableHttpReconnectionOptions | undefined {
  if (!options) return undefined
  const hasConfig = Object.values(options).some((value) => typeof value === 'number' && Number.isFinite(value))
  if (!hasConfig) return undefined

  return {
    maxReconnectionDelay: options.maxReconnectionDelay ?? 30_000,
    initialReconnectionDelay: options.initialReconnectionDelay ?? 1_000,
    reconnectionDelayGrowFactor: options.reconnectionDelayGrowFactor ?? 1.5,
    maxRetries: options.maxRetries ?? 2,
  }
}

async function withStartupAbortTimeout<T>(
  server: ConnectedMcpServer,
  label: string,
  timeoutMs: number,
  task: (options: RequestOptions | undefined) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined

  try {
    if (externalSignal?.aborted) {
      controller.abort()
      throw createMcpAbortError()
    }
    const raceTasks: Array<Promise<T>> = [
      withAbortableMcpRequest(server, controller.signal, task, timeoutMs),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(createMcpTimeoutError(label, timeoutMs))
          controller.abort()
        }, timeoutMs)
      }),
    ]
    if (externalSignal) {
      raceTasks.push(new Promise<never>((_, reject) => {
        abortHandler = () => {
          controller.abort()
          reject(createMcpAbortError())
        }
        externalSignal.addEventListener('abort', abortHandler, { once: true })
      }))
    }
    return await Promise.race(raceTasks)
  } finally {
    if (timeout) clearTimeout(timeout)
    if (externalSignal && abortHandler) externalSignal.removeEventListener('abort', abortHandler)
  }
}

function textContent(text: string): TextContent {
  return { type: 'text', text }
}

function safeJsonStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    return json ?? String(value)
  } catch {
    return String(value)
  }
}

function toMcpResourceContentInfo(value: unknown): McpResourceContentInfo | undefined {
  if (!isPlainRecord(value)) return undefined
  return {
    uri: getStringField(value, 'uri'),
    mimeType: getStringField(value, 'mimeType'),
    text: getStringField(value, 'text'),
    blob: getStringField(value, 'blob'),
    _meta: value._meta,
    raw: value,
  }
}

function formatMcpResourceHeader(label: string, resource: McpResourceContentInfo): string {
  const fields = [
    `kind=${label}`,
    resource.uri ? `uri=${resource.uri}` : undefined,
    resource.mimeType ? `mimeType=${resource.mimeType}` : undefined,
  ].filter((field): field is string => Boolean(field))
  const metaText = resource._meta !== undefined ? `\nmeta=${safeJsonStringify(resource._meta)}` : ''
  return `[MCP resource ${fields.join(', ')}]${metaText}`
}

function summarizeBinaryData(label: string, data: string, mimeType: string, uri?: string): TextContent {
  const preview = data.length > BINARY_DATA_PREVIEW_CHARS
    ? `${data.slice(0, BINARY_DATA_PREVIEW_CHARS)}...`
    : data
  const uriLine = uri ? `\nuri: ${uri}` : ''
  return textContent(
    `[MCP ${label} 已降级为文本摘要]${uriLine}\nmimeType: ${mimeType}\nbase64Length: ${data.length}\nbase64Preview: ${preview}`,
  )
}

function normalizeMcpResourceContent(resource: McpResourceContentInfo, label: string): Array<TextContent | ImageContent> {
  const mimeType = resource.mimeType ?? 'application/octet-stream'
  const header = formatMcpResourceHeader(label, { ...resource, mimeType })

  if (resource.text !== undefined) {
    return [textContent(`${header}\n${resource.text}`)]
  }

  if (resource.blob !== undefined && mimeType.startsWith('image/')) {
    return [
      textContent(header),
      { type: 'image', data: resource.blob, mimeType },
    ]
  }

  if (resource.blob !== undefined) {
    return [summarizeBinaryData('binary resource', resource.blob, mimeType, resource.uri)]
  }

  return [textContent(`${header}\n资源缺少 text/blob 字段，原始内容:\n${safeJsonStringify(resource.raw)}`)]
}

function normalizeEmbeddedResource(block: Record<string, unknown>): Array<TextContent | ImageContent> {
  const resource = toMcpResourceContentInfo(block.resource)
  if (!resource) {
    return [textContent(`MCP embedded resource 格式无效，已保留原始 JSON:\n${safeJsonStringify(block)}`)]
  }
  return normalizeMcpResourceContent(resource, 'embedded')
}

function normalizeResourceLink(block: Record<string, unknown>): TextContent {
  const linkInfo = {
    type: 'resource_link',
    uri: getStringField(block, 'uri'),
    name: getStringField(block, 'name'),
    title: getStringField(block, 'title'),
    description: getStringField(block, 'description'),
    mimeType: getStringField(block, 'mimeType'),
    size: getNumberField(block, 'size'),
  }
  return textContent(
    `MCP resource_link 仅提供资源引用，未内嵌内容。可使用 ReadMcpResourceTool 按 uri 读取。\n${safeJsonStringify(linkInfo)}`,
  )
}

function normalizeAudioContent(block: Record<string, unknown>): TextContent {
  const data = getStringField(block, 'data')
  const mimeType = getStringField(block, 'mimeType') ?? 'audio/unknown'
  if (!data) {
    return textContent(`MCP audio 内容缺少 base64 data，已保留原始 JSON:\n${safeJsonStringify(block)}`)
  }
  return summarizeBinaryData('audio', data, mimeType)
}

function normalizeContentBlock(block: Record<string, unknown>): Array<TextContent | ImageContent> {
  if (block.type === 'text' && typeof block.text === 'string') {
    return [{ type: 'text', text: block.text }]
  }
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
    return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
  }
  if (block.type === 'resource') {
    return normalizeEmbeddedResource(block)
  }
  if (block.type === 'resource_link') {
    return [normalizeResourceLink(block)]
  }
  if (block.type === 'audio') {
    return [normalizeAudioContent(block)]
  }
  return [textContent(`MCP content block 未知类型，已保留原始 JSON:\n${safeJsonStringify(block)}`)]
}

function normalizeContentBlocks(content: unknown): Array<TextContent | ImageContent> {
  const result: Array<TextContent | ImageContent> = []
  if (typeof content === 'string') {
    return [textContent(content)]
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      result.push(...normalizeContentBlock(item as Record<string, unknown>))
    }
  } else if (isPlainRecord(content)) {
    result.push(...normalizeContentBlock(content))
  }
  return result
}

function normalizeMcpContent(content: unknown, structuredContent: unknown): Array<TextContent | ImageContent> {
  const result = normalizeContentBlocks(content)

  if (result.length === 0 && structuredContent !== undefined) {
    result.push(textContent(safeJsonStringify(structuredContent)))
  }

  return result.length > 0 ? result : [textContent('工具已完成，但没有返回内容。')]
}

function normalizePromptMessages(messages: unknown): Array<TextContent | ImageContent> {
  const result: Array<TextContent | ImageContent> = []
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const record = message as Record<string, unknown>
      const role = typeof record.role === 'string' ? record.role : undefined
      // MCP PromptMessage 的正文在嵌套的 content 字段里，可能是单个 block 或 block 数组。
      const blocks = Array.isArray(record.content)
        ? record.content
        : record.content && typeof record.content === 'object'
          ? [record.content]
          : []
      for (const block of normalizeContentBlocks(blocks)) {
        if (role && block.type === 'text') {
          result.push(textContent(`[${role}] ${block.text}`))
        } else {
          result.push(block)
        }
      }
    }
  }

  return result.length > 0 ? result : [textContent('Prompt 已返回，但没有可展示内容。')]
}

function normalizeResourceContents(contents: unknown): Array<TextContent | ImageContent> {
  const result: Array<TextContent | ImageContent> = []
  if (!Array.isArray(contents)) return [textContent('资源读取完成，但没有返回内容。')]
  for (const item of contents) {
    if (!item || typeof item !== 'object') continue
    const resource = toMcpResourceContentInfo(item)
    if (resource) result.push(...normalizeMcpResourceContent(resource, 'read'))
  }
  return result.length > 0 ? result : [textContent('资源读取完成，但没有返回可展示内容。')]
}

function buildResourceTools(defineTool: DefineTool, connectedServers: ConnectedMcpServer[]): ToolDefinition[] {
  return [
    defineTool({
      name: 'ListMcpResourcesTool',
      label: '列出 MCP 资源',
      description: '列出当前工作区已连接 MCP servers 暴露的 resources。',
      promptSnippet: '列出当前工作区 MCP resources。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '可选：只列出指定 MCP server 的 resources。' },
        },
        additionalProperties: false,
      } as never,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        const requestedServer = typeof (params as Record<string, unknown>).server === 'string'
          ? String((params as Record<string, unknown>).server)
          : undefined
        const resources: Array<McpResourceInfo & { server: string }> = []
        const errors: string[] = []
        for (const server of connectedServers) {
          if (requestedServer && server.name !== requestedServer) continue
          try {
            const result = await withAbortableMcpRequest(server, signal, (options) =>
              server.client.listResources(undefined, options),
              server.toolTimeoutMs,
            )
            for (const resource of (result.resources ?? []) as McpResourceInfo[]) {
              resources.push({ ...resource, server: server.name })
            }
          } catch (error) {
            if (signal?.aborted) throw error
            errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return {
          content: [textContent(JSON.stringify({ resources, errors }, null, 2))],
          details: { resources, errors },
        }
      },
    }) as ToolDefinition,
    defineTool({
      name: 'ListMcpResourceTemplatesTool',
      label: '列出 MCP 资源模板',
      description: '列出当前工作区已连接 MCP servers 暴露的 resource templates。',
      promptSnippet: '列出当前工作区 MCP resource templates。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '可选：只列出指定 MCP server 的 resource templates。' },
        },
        additionalProperties: false,
      } as never,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        const requestedServer = typeof (params as Record<string, unknown>).server === 'string'
          ? String((params as Record<string, unknown>).server)
          : undefined
        const resourceTemplates: Array<McpResourceTemplateInfo & { server: string }> = []
        const errors: string[] = []
        for (const server of connectedServers) {
          if (requestedServer && server.name !== requestedServer) continue
          try {
            const result = await withAbortableMcpRequest(server, signal, (options) =>
              server.client.listResourceTemplates(undefined, options),
              server.toolTimeoutMs,
            )
            for (const template of (result.resourceTemplates ?? []) as McpResourceTemplateInfo[]) {
              resourceTemplates.push({ ...template, server: server.name })
            }
          } catch (error) {
            if (signal?.aborted) throw error
            errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return {
          content: [textContent(JSON.stringify({ resourceTemplates, errors }, null, 2))],
          details: { resourceTemplates, errors },
        }
      },
    }) as ToolDefinition,
    defineTool({
      name: 'ListMcpPromptsTool',
      label: '列出 MCP Prompts',
      description: '列出当前工作区已连接 MCP servers 暴露的 prompts。',
      promptSnippet: '列出当前工作区 MCP prompts。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '可选：只列出指定 MCP server 的 prompts。' },
        },
        additionalProperties: false,
      } as never,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        const requestedServer = typeof (params as Record<string, unknown>).server === 'string'
          ? String((params as Record<string, unknown>).server)
          : undefined
        const prompts: Array<McpPromptInfo & { server: string }> = []
        const errors: string[] = []
        for (const server of connectedServers) {
          if (requestedServer && server.name !== requestedServer) continue
          try {
            const result = await withAbortableMcpRequest(server, signal, (options) =>
              server.client.listPrompts(undefined, options),
              server.toolTimeoutMs,
            )
            for (const prompt of (result.prompts ?? []) as McpPromptInfo[]) {
              prompts.push({ ...prompt, server: server.name })
            }
          } catch (error) {
            if (signal?.aborted) throw error
            errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return {
          content: [textContent(JSON.stringify({ prompts, errors }, null, 2))],
          details: { prompts, errors },
        }
      },
    }) as ToolDefinition,
    defineTool({
      name: 'GetMcpPromptTool',
      label: '读取 MCP Prompt',
      description: '读取当前工作区 MCP prompt。可指定 server；不指定时按 name 在所有 server 中查找。',
      promptSnippet: '读取 MCP prompt 内容。',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'MCP prompt 名称。' },
          server: { type: 'string', description: '可选：指定 MCP server 名。' },
          arguments: {
            type: 'object',
            description: '可选：传给 MCP prompt 的 arguments。',
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      } as never,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        const input = params as Record<string, unknown>
        const name = typeof input.name === 'string' ? input.name : ''
        if (!name) throw new Error('name 必填')
        const requestedServer = typeof input.server === 'string' ? input.server : undefined
        const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
          ? Object.fromEntries(Object.entries(input.arguments as Record<string, unknown>).map(([key, value]) => [
              key,
              typeof value === 'string' ? value : JSON.stringify(value),
            ]))
          : undefined
        const errors: string[] = []
        for (const server of connectedServers) {
          if (requestedServer && server.name !== requestedServer) continue
          try {
            const result = await withAbortableMcpRequest(server, signal, (options) =>
              server.client.getPrompt({ name, arguments: args }, options),
              server.toolTimeoutMs,
            )
            return {
              content: normalizePromptMessages(result.messages),
              details: { server: server.name, name, result },
            }
          } catch (error) {
            if (signal?.aborted) throw error
            errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        throw new Error(`未能读取 MCP prompt ${name}: ${errors.join('; ') || '没有可用 MCP server'}`)
      },
    }) as ToolDefinition,
    defineTool({
      name: 'ReadMcpResourceTool',
      label: '读取 MCP 资源',
      description: '读取当前工作区 MCP resource。可指定 server；不指定时按 URI 在所有 server 中查找。',
      promptSnippet: '读取 MCP resource 内容。',
      parameters: {
        type: 'object',
        required: ['uri'],
        properties: {
          uri: { type: 'string', description: 'MCP resource URI。' },
          server: { type: 'string', description: '可选：指定 MCP server 名。' },
        },
        additionalProperties: false,
      } as never,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
        const input = params as Record<string, unknown>
        const uri = typeof input.uri === 'string' ? input.uri : ''
        if (!uri) throw new Error('uri 必填')
        const requestedServer = typeof input.server === 'string' ? input.server : undefined
        const errors: string[] = []
        for (const server of connectedServers) {
          if (requestedServer && server.name !== requestedServer) continue
          try {
            const result = await withAbortableMcpRequest(server, signal, (options) =>
              server.client.readResource({ uri }, options),
              server.toolTimeoutMs,
            )
            return {
              content: normalizeResourceContents(result.contents),
              details: { server: server.name, uri, result },
            }
          } catch (error) {
            if (signal?.aborted) throw error
            errors.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        throw new Error(`未能读取 MCP resource ${uri}: ${errors.join('; ') || '没有可用 MCP server'}`)
      },
    }) as ToolDefinition,
  ]
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  try {
    if (signal?.aborted) throw createMcpAbortError()
    const raceTasks: Array<Promise<T>> = [
      task,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} 超时 (${Math.ceil(timeoutMs / 1000)}s)`)), timeoutMs)
      }),
    ]
    if (signal) {
      raceTasks.push(new Promise<never>((_, reject) => {
        abortHandler = () => reject(createMcpAbortError())
        signal.addEventListener('abort', abortHandler, { once: true })
      }))
    }
    return await Promise.race(raceTasks)
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

async function createTransport(
  serverName: string,
  config: PromaMcpServerConfig,
  fetchFn?: typeof fetch,
  defaultCwd?: string,
  runtimeEnv?: Record<string, string>,
): Promise<Transport> {
  if (config.type === 'stdio') {
    if (!config.command) throw new Error(`MCP server ${serverName} 缺少 command`)
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const stdioEnv = mergeRuntimeEnv(runtimeEnv, config.env)
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(Object.keys(stdioEnv).length > 0 && { env: stdioEnv }),
      cwd: config.cwd ?? defaultCwd,
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text) console.warn(`[MCP Bridge] ${serverName} stderr: ${text}`)
    })
    return transport
  }

  if (!config.url) throw new Error(`MCP server ${serverName} 缺少 url`)
  const requestInit = hasHeaders(config.headers)
    ? { headers: config.headers }
    : undefined
  const url = new URL(config.url)

  if (config.type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(url, {
      requestInit,
      fetch: fetchFn,
      eventSourceInit: {
        fetch: createHeaderFetch(config.headers, fetchFn),
      },
    })
  }

  if (config.type === 'websocket') {
    const { WebSocketClientTransport } = await import('@modelcontextprotocol/sdk/client/websocket.js')
    return new WebSocketClientTransport(url)
  }

  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const reconnectionOptions = normalizeReconnectionOptions(config.reconnectionOptions)
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    fetch: fetchFn,
    ...(config.sessionId && { sessionId: config.sessionId }),
    ...(reconnectionOptions && { reconnectionOptions }),
  })
}

async function connectServer(
  serverName: string,
  config: PromaMcpServerConfig,
  fetchFn?: typeof fetch,
  defaultCwd?: string,
  runtimeEnv?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ConnectedMcpServer> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const transport = await createTransport(serverName, config, fetchFn, defaultCwd, runtimeEnv)
  const client = new Client({ name: 'proma-pi-mcp-bridge', version: '1.0.0' })
  const timeoutMs = getStartupTimeoutMs(config)
  const toolTimeoutMs = getToolTimeoutMs(config)
  try {
    await withTimeout(`连接 MCP server ${serverName}`, timeoutMs, client.connect(transport), signal)
    return { name: serverName, client, transport, toolTimeoutMs }
  } catch (error) {
    await closeConnectedServer({ name: serverName, client, transport, toolTimeoutMs })
    throw error
  }
}

async function closeConnectedServer(server: ConnectedMcpServer): Promise<void> {
  if (server.closePromise) return server.closePromise
  server.closePromise = (async () => {
    try {
      await server.client.close()
    } catch (error) {
      console.warn(`[MCP Bridge] 关闭 MCP client 失败 (${server.name}):`, error)
    }
    try {
      await server.transport.close?.()
    } catch (error) {
      console.warn(`[MCP Bridge] 关闭 MCP transport 失败 (${server.name}):`, error)
    }
  })()
  return server.closePromise
}

async function listServerTools(
  server: ConnectedMcpServer,
  config: PromaMcpServerConfig,
  signal?: AbortSignal,
): Promise<McpToolInfo[]> {
  const timeoutMs = getStartupTimeoutMs(config)
  const listResult = await withStartupAbortTimeout(
    server,
    `列出 MCP server ${server.name} 工具`,
    timeoutMs,
    (options) => server.client.listTools(undefined, options),
    signal,
  )
  return (listResult.tools ?? []) as McpToolInfo[]
}

export async function testMcpServerConnection(
  serverName: string,
  config: PromaMcpServerConfig,
  fetchFn?: typeof fetch,
  defaultCwd?: string,
  runtimeEnv?: Record<string, string>,
  signal?: AbortSignal,
): Promise<McpConnectionTestResult> {
  const server = await connectServer(serverName, config, fetchFn, defaultCwd, runtimeEnv, signal)
  try {
    const tools = await listServerTools(server, config, signal)
    return { toolCount: tools.length }
  } finally {
    await closeConnectedServer(server)
  }
}

async function loadMcpServer(
  serverName: string,
  config: PromaMcpServerConfig,
  fetchFn: typeof fetch | undefined,
  defaultCwd: string | undefined,
  runtimeEnv: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<McpServerLoadResult> {
  let server: ConnectedMcpServer | undefined
  try {
    server = await connectServer(serverName, config, fetchFn, defaultCwd, runtimeEnv, signal)
    const serverTools = await listServerTools(server, config, signal)
    return { ok: true, serverName, config, server, serverTools }
  } catch (error) {
    if (server) await closeConnectedServer(server)
    return { ok: false, serverName, config, error }
  }
}

async function loadMcpServersWithConcurrency(
  entries: Array<[string, PromaMcpServerConfig]>,
  fetchFn: typeof fetch | undefined,
  defaultCwd: string | undefined,
  runtimeEnv: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<McpServerLoadResult[]> {
  const results: McpServerLoadResult[] = new Array(entries.length)
  let nextIndex = 0
  const workerCount = Math.min(MCP_BRIDGE_LOAD_CONCURRENCY, entries.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      const entry = entries[index]
      if (!entry) return
      const [serverName, config] = entry
      results[index] = await loadMcpServer(serverName, config, fetchFn, defaultCwd, runtimeEnv, signal)
    }
  }))

  return results
}

export async function buildMcpBridgeTools(
  servers: Record<string, PromaMcpServerConfig>,
  fetchFn?: typeof fetch,
  defaultCwd?: string,
  runtimeEnv?: Record<string, string>,
  signal?: AbortSignal,
): Promise<McpBridgeBuildResult> {
  const { defineTool } = await import('@earendil-works/pi-coding-agent')
  const connectedServers: ConnectedMcpServer[] = []
  const tools: ToolDefinition[] = []
  const readOnlyToolNames = new Set<string>()
  const usedToolNames = new Set<string>()
  const loadResults = await loadMcpServersWithConcurrency(Object.entries(servers), fetchFn, defaultCwd, runtimeEnv, signal)

  if (signal?.aborted) {
    await Promise.all(loadResults.map((result) => result.ok ? closeConnectedServer(result.server) : Promise.resolve()))
    throw createMcpAbortError()
  }

  const requiredFailure = loadResults.find((result) => !result.ok && result.config.required)
  if (requiredFailure && !requiredFailure.ok) {
    console.error(`[MCP Bridge] required MCP server ${requiredFailure.serverName} 初始化失败: ${formatErrorMessage(requiredFailure.error)}`)
    await Promise.all(loadResults.map((result) => result.ok ? closeConnectedServer(result.server) : Promise.resolve()))
    throw requiredFailure.error
  }

  for (const result of loadResults) {
    if (!result.ok) {
      console.warn(`[MCP Bridge] 跳过 optional MCP server ${result.serverName}: ${formatErrorMessage(result.error)}`)
      continue
    }

    const { serverName, server, serverTools, config } = result
    const toolTimeoutMs = getToolTimeoutMs(config)
    connectedServers.push(server)
    for (const tool of serverTools) {
      const baseName = bridgeToolName(serverName, tool.name)
      const name = uniqueBridgeToolName(baseName, usedToolNames)
      if (isReadOnlyMcpTool(tool)) readOnlyToolNames.add(name)
      tools.push(defineTool({
        name,
        label: `${serverName}:${tool.name}`,
        description: tool.description ?? `调用 MCP server ${serverName} 的 ${tool.name} 工具。`,
        promptSnippet: `调用 MCP server ${serverName} 的 ${tool.name} 工具。`,
        parameters: asJsonObjectSchema(tool.inputSchema) as never,
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
          const callResult = await withAbortableMcpRequest(server, signal, (options) =>
            server.client.callTool({
              name: tool.name,
              arguments: params as Record<string, unknown>,
            }, undefined, options),
            toolTimeoutMs,
          )
          const content = normalizeMcpContent(callResult.content, callResult.structuredContent)
          if (callResult.isError) {
            throw new Error(content.map((item) => item.type === 'text' ? item.text : `[${item.mimeType} image]`).join('\n'))
          }
          return {
            content,
            details: callResult.structuredContent ?? callResult,
          }
        },
      }) as ToolDefinition)
    }
    console.log(`[MCP Bridge] 已桥接 MCP server ${serverName}: ${serverTools.length} 个工具`)
  }

  if (connectedServers.length > 0) {
    tools.push(...buildResourceTools(defineTool, connectedServers))
    for (const toolName of [
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'ListMcpResourceTemplatesTool',
      'ListMcpPromptsTool',
      'GetMcpPromptTool',
    ]) {
      readOnlyToolNames.add(toolName)
    }
  }

  return {
    tools,
    readOnlyToolNames,
    cleanup: async () => {
      await Promise.all(connectedServers.map(closeConnectedServer))
    },
  }
}
