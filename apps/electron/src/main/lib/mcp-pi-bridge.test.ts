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

let bridge: McpBridgeModule
let queuedListToolsBehaviors: ListToolsBehavior[] = []
const fakeClients: FakeClient[] = []
const fakeTransports: FakeStdioTransport[] = []

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

  async connect(_transport: FakeStdioTransport): Promise<void> {
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

class FakeStdioTransport {
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

mock.module('@earendil-works/pi-coding-agent', () => ({
  defineTool: (tool: DefinedTool): DefinedTool => tool,
}))

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}))

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeStdioTransport,
}))

function resetFakes(): void {
  queuedListToolsBehaviors = []
  fakeClients.length = 0
  fakeTransports.length = 0
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
