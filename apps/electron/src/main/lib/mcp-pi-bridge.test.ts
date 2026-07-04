import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

type McpBridgeModule = typeof import('./mcp-pi-bridge')

interface FakeToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
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
  getPromptResult: unknown = { messages: [] }

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
    return { content: [{ type: 'text', text: 'ok' }] }
  }

  async getPrompt(_params: unknown, options?: FakeRequestOptions): Promise<unknown> {
    this.getPromptOptions.push(options)
    return this.getPromptResult
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

    const bridged = result.tools.find((tool) => (tool as { name: string }).name === 'mcp__tools__echo') as
      | { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }
      | undefined
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

    const bridged = result.tools.find((tool) => (tool as { name: string }).name === 'mcp__tools__echo') as
      | { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }
      | undefined
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

    const getPromptTool = result.tools.find((tool) => (tool as { name: string }).name === 'GetMcpPromptTool') as
      | { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }> }> }
      | undefined
    expect(getPromptTool).toBeDefined()
    const output = await getPromptTool!.execute('call-1', { name: 'greet' })

    expect(output.content).toEqual([
      { type: 'text', text: '[user] 你好' },
      { type: 'text', text: '[assistant] 在的' },
    ])
    expect(fakeClients[0]?.getPromptOptions[0]?.timeout).toBe(7000)

    await result.cleanup()
  })
})
