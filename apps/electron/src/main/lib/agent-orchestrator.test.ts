import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter } from '@proma/shared'

type AgentOrchestratorModule = typeof import('./agent-orchestrator')
type AgentEventBusModule = typeof import('./agent-event-bus')

let orchestratorModule: AgentOrchestratorModule
let eventBusModule: AgentEventBusModule
let tempHome = ''
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

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
