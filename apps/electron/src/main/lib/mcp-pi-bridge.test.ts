import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

type McpBridgeModule = typeof import('./mcp-pi-bridge')

interface FakeToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
  }
  _meta?: Record<string, unknown>
}

interface FakeListToolsResult {
  tools: FakeToolInfo[]
}

interface FakeRequestOptions {
  signal?: AbortSignal
  timeout?: number
}

interface FakeStdioTransportOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  stderr?: string
}

interface FakeRemoteTransportOptions {
  requestInit?: RequestInit
  fetch?: typeof fetch
  eventSourceInit?: {
    fetch?: typeof fetch
  }
  sessionId?: string
  reconnectionOptions?: {
    maxReconnectionDelay: number
    initialReconnectionDelay: number
    reconnectionDelayGrowFactor: number
    maxRetries: number
  }
}

interface FakeTransport {
  close: () => Promise<void>
}

interface DefinedTool {
  name: string
  label?: string
  description?: string
  parameters?: unknown
}

interface NormalizedTextBlock {
  type: 'text'
  text: string
}

interface NormalizedImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

type NormalizedContentBlock = NormalizedTextBlock | NormalizedImageBlock

interface ToolExecutionResult {
  content: NormalizedContentBlock[]
}

interface ExecutableTool {
  name: string
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolExecutionResult>
}

type ListToolsBehavior =
  | { kind: 'success'; tools: FakeToolInfo[] }
  | { kind: 'hang' }
  | { kind: 'throw'; error: Error }

let bridge: McpBridgeModule
let validator: typeof import('./mcp-validator')
let queuedListToolsBehaviors: ListToolsBehavior[] = []
const fakeClients: FakeClient[] = []
const fakeTransports: FakeStdioTransport[] = []
const fakeHttpTransports: FakeStreamableHTTPTransport[] = []
const fakeSseTransports: FakeSseTransport[] = []
const fakeWebSocketTransports: FakeWebSocketTransport[] = []

class FakeClient {
  readonly behavior: ListToolsBehavior
  connectCalls = 0
  closeCalls = 0
  listToolsOptions: Array<FakeRequestOptions | undefined> = []
  callToolOptions: Array<FakeRequestOptions | undefined> = []
  getPromptOptions: Array<FakeRequestOptions | undefined> = []
  readResourceOptions: Array<FakeRequestOptions | undefined> = []
  callToolResult: unknown = { content: [{ type: 'text', text: 'ok' }] }
  getPromptResult: unknown = { messages: [] }
  readResourceResult: unknown = { contents: [] }

  constructor(_clientInfo: { name: string; version: string }) {
    this.behavior = queuedListToolsBehaviors.shift() ?? { kind: 'success', tools: [] }
    fakeClients.push(this)
  }

  async connect(_transport: FakeTransport): Promise<void> {
    this.connectCalls += 1
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async listTools(_params?: unknown, options?: FakeRequestOptions): Promise<FakeListToolsResult> {
    this.listToolsOptions.push(options)
    if (this.behavior.kind === 'success') {
      return { tools: this.behavior.tools }
    }
    if (this.behavior.kind === 'throw') {
      throw this.behavior.error
    }

    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const error = new Error('MCP 请求已中止')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  }

  async callTool(_params: unknown, _resultSchema?: unknown, options?: FakeRequestOptions): Promise<unknown> {
    this.callToolOptions.push(options)
    return this.callToolResult
  }

  async getPrompt(_params: unknown, options?: FakeRequestOptions): Promise<unknown> {
    this.getPromptOptions.push(options)
    return this.getPromptResult
  }

  async readResource(_params: unknown, options?: FakeRequestOptions): Promise<unknown> {
    this.readResourceOptions.push(options)
    return this.readResourceResult
  }
}

class FakeStdioTransport implements FakeTransport {
  readonly stderr = {
    on: (_event: string, _listener: (chunk: Buffer) => void): void => undefined,
  }
  closeCalls = 0

  constructor(readonly options: FakeStdioTransportOptions) {
    fakeTransports.push(this)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

class FakeStreamableHTTPTransport implements FakeTransport {
  closeCalls = 0

  constructor(readonly url: URL, readonly options?: FakeRemoteTransportOptions) {
    fakeHttpTransports.push(this)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

class FakeSseTransport implements FakeTransport {
  closeCalls = 0

  constructor(readonly url: URL, readonly options?: FakeRemoteTransportOptions) {
    fakeSseTransports.push(this)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

class FakeWebSocketTransport implements FakeTransport {
  closeCalls = 0

  constructor(readonly url: URL) {
    fakeWebSocketTransports.push(this)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

mock.module('@earendil-works/pi-coding-agent', () => ({
  defineTool: (tool: DefinedTool): DefinedTool => tool,
}))

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}))

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeStdioTransport,
}))

mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: FakeStreamableHTTPTransport,
}))

mock.module('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: FakeSseTransport,
}))

mock.module('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: FakeWebSocketTransport,
}))

function resetFakes(): void {
  queuedListToolsBehaviors = []
  fakeClients.length = 0
  fakeTransports.length = 0
  fakeHttpTransports.length = 0
  fakeSseTransports.length = 0
  fakeWebSocketTransports.length = 0
}

function findExecutableTool(tools: unknown[], name: string): ExecutableTool | undefined {
  return tools.find((tool): tool is ExecutableTool => {
    if (!tool || typeof tool !== 'object') return false
    const record = tool as Record<string, unknown>
    return record.name === name && typeof record.execute === 'function'
  })
}

beforeAll(async () => {
  bridge = await import('./mcp-pi-bridge')
  validator = await import('./mcp-validator')
})

afterEach(() => {
  resetFakes()
})

describe('MCP Pi bridge 初始化', () => {
  test('Given optional MCP listTools 挂起 When 构建桥接工具 Then 超时关闭并跳过该服务器', async () => {
    queuedListToolsBehaviors.push({ kind: 'hang' })

    const result = await bridge.buildMcpBridgeTools({
      slow: {
        type: 'stdio',
        command: 'slow-mcp',
        required: false,
        startup_timeout_sec: 1,
      },
    })

    expect(result.tools).toHaveLength(0)
    expect(fakeClients[0]?.closeCalls).toBe(1)
    expect(fakeTransports[0]?.closeCalls).toBe(1)
    expect(fakeClients[0]?.listToolsOptions[0]?.timeout).toBe(1000)
  }, 5000)

  test('Given required MCP listTools 挂起 When 构建桥接工具 Then 超时关闭并抛错', async () => {
    queuedListToolsBehaviors.push({ kind: 'hang' })

    const buildPromise = bridge.buildMcpBridgeTools({
      requiredServer: {
        type: 'stdio',
        command: 'required-mcp',
        required: true,
        startup_timeout_sec: 1,
      },
    })

    await expect(buildPromise).rejects.toThrow('列出 MCP server requiredServer 工具 超时')
    expect(fakeClients[0]?.closeCalls).toBe(1)
    expect(fakeTransports[0]?.closeCalls).toBe(1)
  }, 5000)

  test('Given stdio MCP 配置包含 cwd When 创建 transport Then 使用 entry.cwd 而不是默认 cwd', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [] })

    const result = await bridge.buildMcpBridgeTools({
      fs: {
        type: 'stdio',
        command: 'filesystem-mcp',
        cwd: '/Users/jay/project-a',
      },
    }, undefined, '/Users/jay/default-cwd')

    await result.cleanup()

    expect(fakeTransports[0]?.options.cwd).toBe('/Users/jay/project-a')
  })

  test('Given 桥接的 MCP 工具 When 调用 Then callTool 使用配置的 tool_timeout_sec', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [{ name: 'echo' }] })

    const result = await bridge.buildMcpBridgeTools({
      tools: {
        type: 'stdio',
        command: 'tools-mcp',
        tool_timeout_sec: 5,
      },
    })

    const bridged = findExecutableTool(result.tools, 'mcp__tools__echo')
    expect(bridged).toBeDefined()
    await bridged!.execute('call-1', {})

    expect(fakeClients[0]?.callToolOptions[0]?.timeout).toBe(5000)

    await result.cleanup()
  })

  test('Given MCP 工具未配置 tool_timeout_sec When 调用 Then 回退到 60s 默认超时', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [{ name: 'echo' }] })

    const result = await bridge.buildMcpBridgeTools({
      tools: {
        type: 'stdio',
        command: 'tools-mcp',
      },
    })

    const bridged = findExecutableTool(result.tools, 'mcp__tools__echo')
    await bridged!.execute('call-1', {})

    expect(fakeClients[0]?.callToolOptions[0]?.timeout).toBe(60000)

    await result.cleanup()
  })

  test('Given HTTP MCP 配置包含 headers/session/reconnection When 构建桥接 Then 传递给 Streamable HTTP transport', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [{ name: 'echo' }] })

    const result = await bridge.buildMcpBridgeTools({
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        sessionId: 'session-1',
        reconnectionOptions: { maxRetries: 5 },
        startup_timeout_sec: 2,
      },
    })

    expect(fakeHttpTransports[0]?.url.toString()).toBe('https://example.com/mcp')
    expect(fakeHttpTransports[0]?.options?.requestInit?.headers).toEqual({ Authorization: 'Bearer token' })
    expect(fakeHttpTransports[0]?.options?.sessionId).toBe('session-1')
    expect(fakeHttpTransports[0]?.options?.reconnectionOptions).toEqual({
      maxReconnectionDelay: 30000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 5,
    })
    expect(fakeClients[0]?.listToolsOptions[0]?.timeout).toBe(2000)

    await result.cleanup()
    expect(fakeClients[0]?.closeCalls).toBe(1)
    expect(fakeHttpTransports[0]?.closeCalls).toBe(1)
  })

  test('Given HTTP MCP 配置包含 bearer auth When 构建桥接 Then 映射为 Authorization 请求头', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [] })

    const result = await bridge.buildMcpBridgeTools({
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        auth: { type: 'bearer', token: 'secret-token' },
      },
    })

    expect(fakeHttpTransports[0]?.options?.requestInit?.headers).toEqual({ Authorization: 'Bearer secret-token' })

    await result.cleanup()
  })

  test('Given SSE MCP 配置包含 basic auth When 构建桥接 Then 映射为 Basic Authorization 并注入 SSE fetch', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [] })

    const result = await bridge.buildMcpBridgeTools({
      events: {
        type: 'sse',
        url: 'https://example.com/sse',
        auth: { type: 'basic', username: 'alice', password: 'secret' },
      },
    })

    const expectedAuthorization = `Basic ${Buffer.from('alice:secret', 'utf-8').toString('base64')}`
    expect(fakeSseTransports[0]?.options?.requestInit?.headers).toEqual({ Authorization: expectedAuthorization })
    expect(fakeSseTransports[0]?.options?.eventSourceInit?.fetch).toBeDefined()

    await result.cleanup()
  })

  test('Given required HTTP MCP 配置包含 authProvider When 构建桥接 Then 明确失败且不创建 transport', async () => {
    const buildPromise = bridge.buildMcpBridgeTools({
      privateRemote: {
        type: 'http',
        url: 'https://example.com/mcp',
        auth: { type: 'oauth', authProvider: { name: 'custom-oauth' } },
        required: true,
      },
    })

    await expect(buildPromise).rejects.toThrow('authProvider')
    expect(fakeClients).toHaveLength(0)
    expect(fakeHttpTransports).toHaveLength(0)
  })

  test('Given SSE MCP 配置包含 headers When 构建桥接 Then POST 和 SSE fetch 都可注入请求头', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [] })

    const result = await bridge.buildMcpBridgeTools({
      events: {
        type: 'sse',
        url: 'https://example.com/sse',
        headers: { Authorization: 'Bearer sse-token' },
      },
    })

    expect(fakeSseTransports[0]?.options?.requestInit?.headers).toEqual({ Authorization: 'Bearer sse-token' })
    expect(fakeSseTransports[0]?.options?.eventSourceInit?.fetch).toBeDefined()

    await result.cleanup()
  })

  test('Given WebSocket MCP 配置 When 构建桥接 Then 使用 WebSocket transport', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [{ name: 'subscribe' }] })

    const result = await bridge.buildMcpBridgeTools({
      realtime: {
        type: 'websocket',
        url: 'wss://example.com/mcp',
      },
    })

    expect(fakeWebSocketTransports[0]?.url.toString()).toBe('wss://example.com/mcp')
    expect(result.tools.some((tool) => {
      const record = tool as unknown as Record<string, unknown>
      return record.name === 'mcp__realtime__subscribe'
    })).toBe(true)

    await result.cleanup()
    expect(fakeWebSocketTransports[0]?.closeCalls).toBe(1)
  })

  test('Given WebSocket MCP 配置包含 headers When 构建桥接 Then 明确失败避免认证静默无效', async () => {
    const buildPromise = bridge.buildMcpBridgeTools({
      realtime: {
        type: 'websocket',
        url: 'wss://example.com/mcp',
        headers: { Authorization: 'Bearer ws-token' },
        required: true,
      },
    })

    await expect(buildPromise).rejects.toThrow('WebSocket transport 不支持注入 headers/auth')
    expect(fakeClients).toHaveLength(0)
    expect(fakeWebSocketTransports).toHaveLength(0)
  })

  test('Given GetMcpPromptTool When 读取带 role 的 PromptMessage Then 展开嵌套 content 并加 role 前缀', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [] })

    const result = await bridge.buildMcpBridgeTools({
      prompts: {
        type: 'stdio',
        command: 'prompts-mcp',
        tool_timeout_sec: 7,
      },
    })

    fakeClients[0]!.getPromptResult = {
      messages: [
        { role: 'user', content: { type: 'text', text: '你好' } },
        { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
      ],
    }

    const getPromptTool = findExecutableTool(result.tools, 'GetMcpPromptTool')
    expect(getPromptTool).toBeDefined()
    const output = await getPromptTool!.execute('call-1', { name: 'greet' })

    expect(output.content).toEqual([
      { type: 'text', text: '[user] 你好' },
      { type: 'text', text: '[assistant] 在的' },
    ])
    expect(fakeClients[0]?.getPromptOptions[0]?.timeout).toBe(7000)

    await result.cleanup()
  })

  test('Given MCP 工具返回多类型 content When 调用桥接工具 Then 展开 resource 并明确降级不支持的类型', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [{ name: 'read_bundle' }] })

    const result = await bridge.buildMcpBridgeTools({
      content: {
        type: 'stdio',
        command: 'content-mcp',
      },
    })

    fakeClients[0]!.callToolResult = {
      content: [
        { type: 'text', text: 'plain text' },
        { type: 'image', data: 'direct-image-base64', mimeType: 'image/png' },
        {
          type: 'resource',
          resource: {
            uri: 'file:///notes.md',
            mimeType: 'text/markdown',
            text: '# Notes',
          },
        },
        {
          type: 'resource',
          resource: {
            uri: 'file:///chart.png',
            mimeType: 'image/png',
            blob: 'embedded-image-base64',
          },
        },
        { type: 'audio', data: 'audio-base64', mimeType: 'audio/wav' },
        {
          type: 'resource_link',
          uri: 'file:///linked.csv',
          name: 'linked.csv',
          description: '结果明细',
          mimeType: 'text/csv',
          size: 42,
        },
      ],
    }

    const bridged = findExecutableTool(result.tools, 'mcp__content__read_bundle')
    expect(bridged).toBeDefined()
    const output = await bridged!.execute('call-1', {})

    expect(output.content[0]).toEqual({ type: 'text', text: 'plain text' })
    expect(output.content[1]).toEqual({ type: 'image', data: 'direct-image-base64', mimeType: 'image/png' })
    expect(output.content[2]).toEqual({
      type: 'text',
      text: '[MCP resource kind=embedded, uri=file:///notes.md, mimeType=text/markdown]\n# Notes',
    })
    expect(output.content[3]).toEqual({
      type: 'text',
      text: '[MCP resource kind=embedded, uri=file:///chart.png, mimeType=image/png]',
    })
    expect(output.content[4]).toEqual({ type: 'image', data: 'embedded-image-base64', mimeType: 'image/png' })
    expect(output.content[5]?.type).toBe('text')
    expect((output.content[5] as NormalizedTextBlock).text).toContain('MCP audio 已降级为文本摘要')
    expect((output.content[5] as NormalizedTextBlock).text).toContain('mimeType: audio/wav')
    expect(output.content[6]?.type).toBe('text')
    expect((output.content[6] as NormalizedTextBlock).text).toContain('file:///linked.csv')
    expect((output.content[6] as NormalizedTextBlock).text).toContain('ReadMcpResourceTool')

    await result.cleanup()
  })

  test('Given ReadMcpResourceTool 读取 text/image/binary resource When 执行 Then 保留 uri 和 mime 关键信息', async () => {
    queuedListToolsBehaviors.push({ kind: 'success', tools: [] })

    const result = await bridge.buildMcpBridgeTools({
      resources: {
        type: 'stdio',
        command: 'resources-mcp',
      },
    })

    fakeClients[0]!.readResourceResult = {
      contents: [
        { uri: 'file:///doc.txt', mimeType: 'text/plain', text: 'hello' },
        { uri: 'file:///image.jpg', mimeType: 'image/jpeg', blob: 'image-base64' },
        { uri: 'file:///sound.wav', mimeType: 'audio/wav', blob: 'sound-base64' },
      ],
    }

    const readResourceTool = findExecutableTool(result.tools, 'ReadMcpResourceTool')
    expect(readResourceTool).toBeDefined()
    const output = await readResourceTool!.execute('call-1', { uri: 'file:///doc.txt' })

    expect(output.content[0]).toEqual({
      type: 'text',
      text: '[MCP resource kind=read, uri=file:///doc.txt, mimeType=text/plain]\nhello',
    })
    expect(output.content[1]).toEqual({
      type: 'text',
      text: '[MCP resource kind=read, uri=file:///image.jpg, mimeType=image/jpeg]',
    })
    expect(output.content[2]).toEqual({ type: 'image', data: 'image-base64', mimeType: 'image/jpeg' })
    expect(output.content[3]?.type).toBe('text')
    expect((output.content[3] as NormalizedTextBlock).text).toContain('file:///sound.wav')
    expect((output.content[3] as NormalizedTextBlock).text).toContain('mimeType: audio/wav')
    expect(fakeClients[0]?.readResourceOptions[0]?.timeout).toBe(60000)

    await result.cleanup()
  })

  test('Given 未标注的只读动作名称 When 构建桥接工具 Then 加入 readOnlyToolNames', async () => {
    queuedListToolsBehaviors.push({
      kind: 'success',
      tools: [
        { name: 'list_issues' },
        { name: 'getUser' },
        { name: 'search-files' },
        { name: 'read' },
        { name: 'fetch_url' },
        { name: 'queryDatabase' },
      ],
    })

    const result = await bridge.buildMcpBridgeTools({
      github: {
        type: 'stdio',
        command: 'github-mcp',
      },
    })

    expect(result.readOnlyToolNames).toContain('mcp__github__list_issues')
    expect(result.readOnlyToolNames).toContain('mcp__github__getUser')
    expect(result.readOnlyToolNames).toContain('mcp__github__search-files')
    expect(result.readOnlyToolNames).toContain('mcp__github__read')
    expect(result.readOnlyToolNames).toContain('mcp__github__fetch_url')
    expect(result.readOnlyToolNames).toContain('mcp__github__queryDatabase')

    await result.cleanup()
  })

  test('Given 名称或标注显示会修改状态 When 构建桥接工具 Then destructive 优先否决只读启发式', async () => {
    queuedListToolsBehaviors.push({
      kind: 'success',
      tools: [
        { name: 'delete_file', annotations: { readOnlyHint: true } },
        { name: 'get_or_create_user' },
        { name: 'postMessage' },
        { name: 'send_email' },
        { name: 'list_then_update' },
        { name: 'fetch_secret', annotations: { destructiveHint: true } },
      ],
    })

    const result = await bridge.buildMcpBridgeTools({
      mixed: {
        type: 'stdio',
        command: 'mixed-mcp',
      },
    })

    expect(result.readOnlyToolNames).not.toContain('mcp__mixed__delete_file')
    expect(result.readOnlyToolNames).not.toContain('mcp__mixed__get_or_create_user')
    expect(result.readOnlyToolNames).not.toContain('mcp__mixed__postMessage')
    expect(result.readOnlyToolNames).not.toContain('mcp__mixed__send_email')
    expect(result.readOnlyToolNames).not.toContain('mcp__mixed__list_then_update')
    expect(result.readOnlyToolNames).not.toContain('mcp__mixed__fetch_secret')

    await result.cleanup()
  })
})

describe('MCP validator 远程连接测试', () => {
  test('Given HTTP MCP 真实 listTools 返回认证错误 When 验证 Then 返回可理解的认证失败原因', async () => {
    queuedListToolsBehaviors.push({ kind: 'throw', error: new Error('401 Unauthorized') })

    const result = await validator.validateMcpServer('private-remote', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer bad-token' },
      enabled: true,
    })

    expect(result.valid).toBe(false)
    expect(result.reason).toContain('认证失败')
    expect(fakeClients[0]?.closeCalls).toBe(1)
    expect(fakeHttpTransports[0]?.closeCalls).toBe(1)
  })

  test('Given WebSocket MCP 使用 HTTP URL When 验证 Then 提示传输类型和 URL scheme 不匹配', async () => {
    const result = await validator.validateMcpServer('bad-ws', {
      type: 'websocket',
      url: 'https://example.com/mcp',
      enabled: true,
    })

    expect(result.valid).toBe(false)
    expect(result.reason).toContain('ws:// 或 wss://')
    expect(fakeClients).toHaveLength(0)
  })

  test('Given SSE MCP listTools 超时 When 验证 Then 返回连接超时原因并关闭连接', async () => {
    queuedListToolsBehaviors.push({ kind: 'hang' })

    const result = await validator.validateMcpServer('slow-sse', {
      type: 'sse',
      url: 'https://example.com/sse',
      startup_timeout_sec: 1,
      enabled: true,
    })

    expect(result.valid).toBe(false)
    expect(result.reason).toContain('连接超时')
    expect(fakeClients[0]?.closeCalls).toBe(1)
    expect(fakeSseTransports[0]?.closeCalls).toBe(1)
  }, 5000)
})
