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
import { mergeRuntimeEnv } from './agent-runtime-env'

export interface PromaMcpServerConfig {
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  required?: boolean
  startup_timeout_sec?: number
  tool_timeout_sec?: number
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

type DefineTool = typeof import('@earendil-works/pi-coding-agent')['defineTool']

const MCP_BRIDGE_LOAD_CONCURRENCY = 4

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

function isReadOnlyMcpTool(tool: McpToolInfo): boolean {
  if (tool.annotations?.destructiveHint === true) return false
  if (tool.annotations?.readOnlyHint === true) return true
  const metaReadOnly = tool._meta?.readOnlyHint ?? tool._meta?.['readOnly']
  return metaReadOnly === true
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
  return Math.max(1, config.startup_timeout_sec ?? 30) * 1000
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

async function withStartupAbortTimeout<T>(
  server: ConnectedMcpServer,
  label: string,
  timeoutMs: number,
  task: (options: RequestOptions | undefined) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      withAbortableMcpRequest(server, controller.signal, task, timeoutMs),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(createMcpTimeoutError(label, timeoutMs))
          controller.abort()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function textContent(text: string): TextContent {
  return { type: 'text', text }
}

function normalizeContentBlocks(content: unknown): Array<TextContent | ImageContent> {
  const result: Array<TextContent | ImageContent> = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const block = item as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') {
        result.push({ type: 'text', text: block.text })
      } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        result.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      } else {
        result.push(textContent(JSON.stringify(block, null, 2)))
      }
    }
  }
  return result
}

function normalizeMcpContent(content: unknown, structuredContent: unknown): Array<TextContent | ImageContent> {
  const result = normalizeContentBlocks(content)

  if (result.length === 0 && structuredContent !== undefined) {
    result.push(textContent(JSON.stringify(structuredContent, null, 2)))
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
    const block = item as Record<string, unknown>
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream'
    if (typeof block.text === 'string') {
      result.push(textContent(block.text))
    } else if (typeof block.blob === 'string' && mimeType.startsWith('image/')) {
      result.push({ type: 'image', data: block.blob, mimeType })
    } else if (typeof block.blob === 'string') {
      result.push(textContent(`[${mimeType} blob, ${block.blob.length} base64 chars]`))
    }
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

async function withTimeout<T>(label: string, timeoutMs: number, task: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} 超时 (${Math.ceil(timeoutMs / 1000)}s)`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
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
  const requestInit = config.headers && Object.keys(config.headers).length > 0
    ? { headers: config.headers }
    : undefined

  if (config.type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(config.url), {
      requestInit,
      fetch: fetchFn,
    })
  }

  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit,
    fetch: fetchFn,
  })
}

async function connectServer(
  serverName: string,
  config: PromaMcpServerConfig,
  fetchFn?: typeof fetch,
  defaultCwd?: string,
  runtimeEnv?: Record<string, string>,
): Promise<ConnectedMcpServer> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const transport = await createTransport(serverName, config, fetchFn, defaultCwd, runtimeEnv)
  const client = new Client({ name: 'proma-pi-mcp-bridge', version: '1.0.0' })
  const timeoutMs = getStartupTimeoutMs(config)
  const toolTimeoutMs = getToolTimeoutMs(config)
  try {
    await withTimeout(`连接 MCP server ${serverName}`, timeoutMs, client.connect(transport))
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
): Promise<McpToolInfo[]> {
  const timeoutMs = getStartupTimeoutMs(config)
  const listResult = await withStartupAbortTimeout(
    server,
    `列出 MCP server ${server.name} 工具`,
    timeoutMs,
    (options) => server.client.listTools(undefined, options),
  )
  return (listResult.tools ?? []) as McpToolInfo[]
}

async function loadMcpServer(
  serverName: string,
  config: PromaMcpServerConfig,
  fetchFn: typeof fetch | undefined,
  defaultCwd: string | undefined,
  runtimeEnv: Record<string, string> | undefined,
): Promise<McpServerLoadResult> {
  let server: ConnectedMcpServer | undefined
  try {
    server = await connectServer(serverName, config, fetchFn, defaultCwd, runtimeEnv)
    const serverTools = await listServerTools(server, config)
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
      results[index] = await loadMcpServer(serverName, config, fetchFn, defaultCwd, runtimeEnv)
    }
  }))

  return results
}

export async function buildMcpBridgeTools(
  servers: Record<string, PromaMcpServerConfig>,
  fetchFn?: typeof fetch,
  defaultCwd?: string,
  runtimeEnv?: Record<string, string>,
): Promise<McpBridgeBuildResult> {
  const { defineTool } = await import('@earendil-works/pi-coding-agent')
  const connectedServers: ConnectedMcpServer[] = []
  const tools: ToolDefinition[] = []
  const readOnlyToolNames = new Set<string>()
  const usedToolNames = new Set<string>()
  const loadResults = await loadMcpServersWithConcurrency(Object.entries(servers), fetchFn, defaultCwd, runtimeEnv)

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
