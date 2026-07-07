import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@proma/shared'
import type { PermissionResult } from './agent-permission-service'
import type { SessionCallbacks } from './agent-orchestrator'

type AgentOrchestratorModule = typeof import('./agent-orchestrator')
type AgentEventBusModule = typeof import('./agent-event-bus')
type ProcessWithResourcesPath = Omit<NodeJS.Process, 'resourcesPath'> & {
  resourcesPath?: string
}

let orchestratorModule: AgentOrchestratorModule
let eventBusModule: AgentEventBusModule
let tempHome = ''
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV
const processWithResourcesPath = process as unknown as ProcessWithResourcesPath
const originalResourcesPath = processWithResourcesPath.resourcesPath

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'tmp'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function configDir(): string {
  return join(tempHome, '.proma')
}

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionsIndex(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'agent-sessions.json'), JSON.stringify({
    version: 1,
    sessions,
  }), 'utf-8')
}

function writeAgentWorkspacesIndex(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'agent-workspaces.json'), JSON.stringify({
    version: 1,
    workspaces,
  }), 'utf-8')
}

function writeWorkspaceMcpConfig(workspaceSlug: string, config: Record<string, unknown>): void {
  const workspaceDir = join(configDir(), 'agent-workspaces', workspaceSlug)
  mkdirSync(workspaceDir, { recursive: true })
  writeFileSync(join(workspaceDir, 'mcp.json'), JSON.stringify(config), 'utf-8')
}

function writeChannelsConfig(channels: Array<Record<string, unknown>>): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'channels.json'), JSON.stringify({
    version: 2,
    channels,
  }), 'utf-8')
}

function agentChannel(input?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'channel-agent',
    name: 'Agent 渠道',
    provider: 'anthropic',
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    models: [{ id: 'model-a', name: 'Model A', enabled: true }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
}

function successResult(sessionId = 'sdk-session'): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    terminal_reason: 'completed',
    session_id: sessionId,
  } as unknown as SDKMessage
}

interface CapturedPiQueryInput extends AgentQueryInput {
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<PermissionResult>
  compactRequest?: boolean
  resumeSessionId?: string
}

function createCallbacks(): {
  callbacks: SessionCallbacks
  errors: string[]
  getCompleteCount: () => number
} {
  const errors: string[] = []
  let completes = 0
  return {
    callbacks: {
      onError: (error: string) => { errors.push(error) },
      onComplete: () => { completes += 1 },
      onTitleUpdated: () => {},
    },
    errors,
    getCompleteCount: () => completes,
  }
}

const adapter: AgentProviderAdapter = {
  async *query() {
    return
  },
  abort() {},
  dispose() {},
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-orchestrator-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  processWithResourcesPath.resourcesPath = join(tempHome, 'resources')
  orchestratorModule = await import('./agent-orchestrator')
  eventBusModule = await import('./agent-event-bus')
})

beforeEach(() => {
  rmSync(configDir(), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  if (originalResourcesPath === undefined) {
    processWithResourcesPath.resourcesPath = undefined
  } else {
    processWithResourcesPath.resourcesPath = originalResourcesPath
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('AgentOrchestrator rewind legacy fallback', () => {
  test('Given Proma sidecar 缺失且 legacy file-history 可用 When rewind Then 恢复文件并截断会话', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-1', name: '测试工作区', slug: 'workspace-one', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([
      {
        id: 'session-one',
        title: '旧会话',
        workspaceId: 'workspace-1',
        legacySdkSessionId: 'legacy-sdk',
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    const sessionDir = join(configDir(), 'agent-workspaces', 'workspace-one', 'session-one')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'note.txt'), 'latest', 'utf-8')
    mkdirSync(join(configDir(), 'agent-sessions'), { recursive: true })
    writeFileSync(join(configDir(), 'agent-sessions', 'session-one.jsonl'), jsonl([
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', session_id: 'legacy-sdk', message: { content: [{ type: 'text', text: '完成' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-2', session_id: 'legacy-sdk', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-3', session_id: 'legacy-sdk', message: { content: [{ type: 'text', text: '后续' }] } }),
    ]), 'utf-8')

    const sdkProjectDir = join(configDir(), 'sdk-config', 'projects', 'project-hash')
    const historyDir = join(configDir(), 'sdk-config', 'file-history', 'legacy-sdk')
    mkdirSync(sdkProjectDir, { recursive: true })
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(join(historyDir, 'note-backup'), 'old', 'utf-8')
    writeFileSync(join(sdkProjectDir, 'legacy-sdk.jsonl'), jsonl([
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1' }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({
        type: 'file-history-snapshot',
        isSnapshotUpdate: false,
        snapshot: {
          messageId: 'user-2',
          trackedFileBackups: {
            'note.txt': { backupFileName: 'note-backup' },
          },
        },
      }),
    ]), 'utf-8')

    const orchestrator = new orchestratorModule.AgentOrchestrator(adapter, new eventBusModule.AgentEventBus())
    const result = await orchestrator.rewindSession('session-one', 'assistant-1')

    expect(result.conversationRewound).toBe(true)
    expect(result.remainingMessages).toBe(1)
    expect(result.fileRewind?.canRewind).toBe(true)
    expect(readFileSync(join(sessionDir, 'note.txt'), 'utf-8')).toBe('old')
    expect(readFileSync(join(configDir(), 'agent-sessions', 'session-one.jsonl'), 'utf-8'))
      .toContain('assistant-1')
    expect(readFileSync(join(configDir(), 'agent-sessions', 'session-one.jsonl'), 'utf-8'))
      .not.toContain('assistant-3')
  })
})

describe('AgentOrchestrator Pi 迁移防线', () => {
  test('Given Chat-only 渠道 When 发送 Agent 消息 Then 后端拒绝且不进入 Pi runtime', async () => {
    writeChannelsConfig([
      agentChannel({
        id: 'channel-chat',
        provider: 'openai',
        models: [{ id: 'gpt-5', name: 'GPT-5', enabled: true }],
      }),
    ])
    writeAgentSessionsIndex([
      { id: 'session-chat', title: 'Chat-only', channelId: 'channel-chat', modelId: 'gpt-5', createdAt: 1, updatedAt: 1 },
    ])
    let queryCalls = 0
    const rejectingAdapter: AgentProviderAdapter = {
      async *query() {
        queryCalls += 1
        yield successResult()
      },
      abort() {},
      dispose() {},
    }
    const orchestrator = new orchestratorModule.AgentOrchestrator(rejectingAdapter, new eventBusModule.AgentEventBus())
    const { callbacks, errors, getCompleteCount } = createCallbacks()

    await orchestrator.sendMessage({
      sessionId: 'session-chat',
      userMessage: 'hello',
      channelId: 'channel-chat',
      modelId: 'gpt-5',
    }, callbacks)

    expect(queryCalls).toBe(0)
    expect(errors[0]).toContain('渠道不支持 Agent 模式')
    expect(getCompleteCount()).toBe(1)
  })

  test('Given headless 运行 When 模型调用 AskUserQuestion Then 直接拒绝避免永久等待', async () => {
    writeChannelsConfig([agentChannel()])
    writeAgentSessionsIndex([
      { id: 'session-headless', title: 'Headless', channelId: 'channel-agent', modelId: 'model-a', createdAt: 1, updatedAt: 1 },
    ])
    let decision: PermissionResult | undefined
    const askingAdapter: AgentProviderAdapter = {
      async *query(input: AgentQueryInput) {
        const piInput = input as CapturedPiQueryInput
        decision = await piInput.canUseTool?.('AskUserQuestion', { questions: [] }, {
          signal: new AbortController().signal,
          toolUseID: 'ask-1',
        })
        yield successResult()
      },
      abort() {},
      dispose() {},
    }
    const orchestrator = new orchestratorModule.AgentOrchestrator(askingAdapter, new eventBusModule.AgentEventBus())
    const { callbacks, errors, getCompleteCount } = createCallbacks()

    await orchestrator.sendMessage({
      sessionId: 'session-headless',
      userMessage: '需要问用户',
      channelId: 'channel-agent',
      modelId: 'model-a',
      interactive: false,
    }, callbacks)

    expect(decision).toEqual({
      behavior: 'deny',
      message: expect.stringContaining('无人值守入口'),
    })
    expect(errors).toEqual([])
    expect(getCompleteCount()).toBe(1)
  })

  test('Given stale Pi session When /compact 触发 resume 恢复 Then 重试时不再保留 compactRequest', async () => {
    writeChannelsConfig([agentChannel()])
    writeAgentSessionsIndex([
      {
        id: 'session-compact',
        title: 'Compact',
        channelId: 'channel-agent',
        modelId: 'model-a',
        sdkSessionId: 'stale-sdk-session',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const queryInputs: CapturedPiQueryInput[] = []
    const compactAdapter: AgentProviderAdapter = {
      async *query(input: AgentQueryInput) {
        const piInput = input as CapturedPiQueryInput
        queryInputs.push({ ...piInput })
        if (queryInputs.length === 1) {
          throw new Error('No conversation found with session ID stale-sdk-session')
        }
        yield successResult('new-sdk-session')
      },
      abort() {},
      dispose() {},
    }
    const orchestrator = new orchestratorModule.AgentOrchestrator(compactAdapter, new eventBusModule.AgentEventBus())
    const { callbacks, errors, getCompleteCount } = createCallbacks()

    await orchestrator.sendMessage({
      sessionId: 'session-compact',
      userMessage: '/compact',
      channelId: 'channel-agent',
      modelId: 'model-a',
    }, callbacks)

    expect(queryInputs).toHaveLength(2)
    expect(queryInputs[0]?.compactRequest).toBe(true)
    expect(queryInputs[1]?.resumeSessionId).toBeUndefined()
    expect(queryInputs[1]?.compactRequest).toBeUndefined()
    expect(queryInputs[1]?.prompt).not.toBe('/compact')
    expect(errors).toEqual([])
    expect(getCompleteCount()).toBe(1)
  })

  test('Given required MCP 配置不完整 When 发送 Agent 消息 Then 阻止运行且不进入 Pi runtime', async () => {
    writeChannelsConfig([agentChannel()])
    writeAgentWorkspacesIndex([
      { id: 'workspace-1', name: '测试工作区', slug: 'workspace-one', createdAt: 1, updatedAt: 1 },
    ])
    writeWorkspaceMcpConfig('workspace-one', {
      servers: {
        brokenRemote: {
          type: 'http',
          enabled: true,
          required: true,
        },
      },
    })
    writeAgentSessionsIndex([
      {
        id: 'session-required-mcp',
        title: 'Required MCP',
        channelId: 'channel-agent',
        modelId: 'model-a',
        workspaceId: 'workspace-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    let queryCalls = 0
    const requiredMcpAdapter: AgentProviderAdapter = {
      async *query() {
        queryCalls += 1
        yield successResult()
      },
      abort() {},
      dispose() {},
    }
    const orchestrator = new orchestratorModule.AgentOrchestrator(requiredMcpAdapter, new eventBusModule.AgentEventBus())
    const { callbacks } = createCallbacks()

    await expect(orchestrator.sendMessage({
      sessionId: 'session-required-mcp',
      userMessage: 'hello',
      channelId: 'channel-agent',
      modelId: 'model-a',
      workspaceId: 'workspace-1',
    }, callbacks)).rejects.toThrow('brokenRemote')

    expect(queryCalls).toBe(0)
  })
})
