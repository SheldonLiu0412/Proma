import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('./agent-session-manager')

let manager: AgentSessionManager
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
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

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  const dir = join(tempHome, '.proma', 'agent-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(rows), 'utf-8')
}

function configDir(): string {
  return join(tempHome, '.proma')
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

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-session-manager-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  manager = await import('./agent-session-manager')
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

describe('Agent 会话 JSONL 读取', () => {
  test('Given 会话 JSONL 混入损坏行 When 读取 SDKMessage Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-with-bad-line', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍然可读' }] }, parent_tool_use_id: null }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-with-bad-line')

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given rewind 所需 Proma JSONL 存在损坏行 When 解析下一轮用户消息 Then 严格失败避免误判快照', () => {
    writeAgentSessionJsonl('session-rewind-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '继续' }] }, parent_tool_use_id: null }),
    ])

    expect(() => manager.resolveRewindUserMessageUuid('session-rewind-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
  })

  test('Given 会话 JSONL 存在损坏行 When 截断 SDKMessage Then 抛错避免重写不完整历史', () => {
    writeAgentSessionJsonl('session-truncate-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
    ])

    expect(() => manager.truncateSDKMessages('session-truncate-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
  })

  test('Given 队列消息已持久化 When runtime 拒绝接收 Then 可按 uuid 回滚该消息', () => {
    writeAgentSessionJsonl('session-queued-rollback', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '第一轮' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      JSON.stringify({ type: 'user', uuid: 'queued-1', message: { content: [{ type: 'text', text: '追加' }] } }),
    ])

    expect(manager.removeSDKMessageByUuid('session-queued-rollback', 'queued-1')).toBe(true)
    expect(manager.getAgentSessionSDKMessages('session-queued-rollback').map((message) => (
      'uuid' in message ? (message as { uuid?: string }).uuid : undefined
    ))).toEqual(['user-1', 'assistant-1'])
  })
})

describe('Agent 会话模型元数据', () => {
  test('Given 创建 Agent 会话时传入模型 When 读取会话元数据 Then 持久化 channelId 与 modelId', () => {
    const session = manager.createAgentSession('模型会话', 'channel-a', undefined, 'model-a')

    expect(session.channelId).toBe('channel-a')
    expect(session.modelId).toBe('model-a')
    expect(manager.getAgentSessionMeta(session.id)?.modelId).toBe('model-a')
  })

  test('Given 已有 Agent 会话 When 切换模型和渠道 Then 会话元数据同步更新', () => {
    const session = manager.createAgentSession('待切换会话', 'channel-a', undefined, 'model-a')

    const updated = manager.updateAgentSessionMeta(session.id, {
      channelId: 'channel-b',
      modelId: 'model-b',
    })

    expect(updated.channelId).toBe('channel-b')
    expect(updated.modelId).toBe('model-b')
    expect(manager.getAgentSessionMeta(session.id)?.channelId).toBe('channel-b')
    expect(manager.listAgentSessions().find((item) => item.id === session.id)?.modelId).toBe('model-b')
  })
})

describe('legacy Claude file-history 兼容', () => {
  test('Given legacy file-history-snapshot 存在 When 恢复到旧 turn Then 使用备份覆盖并删除 target 后新增文件', () => {
    const cwd = join(tempHome, 'legacy-workspace')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'note.txt'), 'latest', 'utf-8')
    writeFileSync(join(cwd, 'new.txt'), 'new file', 'utf-8')

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
      JSON.stringify({
        type: 'file-history-snapshot',
        isSnapshotUpdate: true,
        snapshot: {
          messageId: 'user-3',
          trackedFileBackups: {
            'new.txt': { backupFileName: null },
          },
        },
      }),
    ]), 'utf-8')

    const result = manager.rewindFilesFromLegacySnapshot({
      sdkSessionIds: ['legacy-sdk'],
      assistantMessageUuid: 'assistant-1',
      cwd,
      allowedDirectories: [cwd],
    })

    expect(result.canRewind).toBe(true)
    expect(readFileSync(join(cwd, 'note.txt'), 'utf-8')).toBe('old')
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
  })

  test('Given legacy 快照包含越界路径 When 恢复 Then 阻断部分回退', () => {
    const cwd = join(tempHome, 'legacy-workspace-unmapped')
    const outside = join(tempHome, 'legacy-outside.txt')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'note.txt'), 'latest', 'utf-8')
    writeFileSync(outside, 'outside latest', 'utf-8')

    const sdkProjectDir = join(configDir(), 'sdk-config', 'projects', 'project-hash')
    const historyDir = join(configDir(), 'sdk-config', 'file-history', 'legacy-sdk-unmapped')
    mkdirSync(sdkProjectDir, { recursive: true })
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(join(historyDir, 'note-backup'), 'old', 'utf-8')
    writeFileSync(join(historyDir, 'outside-backup'), 'outside old', 'utf-8')
    writeFileSync(join(sdkProjectDir, 'legacy-sdk-unmapped.jsonl'), jsonl([
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1' }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({
        type: 'file-history-snapshot',
        isSnapshotUpdate: false,
        snapshot: {
          messageId: 'user-2',
          trackedFileBackups: {
            'note.txt': { backupFileName: 'note-backup' },
            [outside]: { backupFileName: 'outside-backup' },
          },
        },
      }),
    ]), 'utf-8')

    const result = manager.rewindFilesFromLegacySnapshot({
      sdkSessionIds: ['legacy-sdk-unmapped'],
      assistantMessageUuid: 'assistant-1',
      cwd,
      allowedDirectories: [cwd],
    })

    expect(result.canRewind).toBe(false)
    expect(result.error).toContain('未映射或越界路径')
    expect(readFileSync(join(cwd, 'note.txt'), 'utf-8')).toBe('latest')
    expect(readFileSync(outside, 'utf-8')).toBe('outside latest')
  })

  test('Given 非最后一轮 fork 缺少 sidecar 且无 legacy file-history When 分叉 Then 阻断避免复制最新工作区', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-1', name: '测试工作区', slug: 'workspace-one', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([
      {
        id: 'source-session',
        title: '源会话',
        workspaceId: 'workspace-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const sourceDir = join(configDir(), 'agent-workspaces', 'workspace-one', 'source-session')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'latest.txt'), 'latest', 'utf-8')
    writeAgentSessionJsonl('source-session', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '继续' }] } }),
    ])

    await expect(manager.forkAgentSession({
      sessionId: 'source-session',
      upToMessageUuid: 'assistant-1',
    })).rejects.toThrow('无法安全分叉旧历史点')

    expect(manager.listAgentSessions().map((session) => session.id)).toEqual(['source-session'])
  })

  test('Given 非最后一轮 fork 的 sidecar 不可恢复但 legacy 可用 When 分叉 Then 使用 legacy 恢复旧文件状态', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-1', name: '测试工作区', slug: 'workspace-one', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([
      {
        id: 'source-session',
        title: '源会话',
        workspaceId: 'workspace-1',
        legacySdkSessionId: 'legacy-sdk',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const sourceDir = join(configDir(), 'agent-workspaces', 'workspace-one', 'source-session')
    mkdirSync(join(sourceDir, '.git'), { recursive: true })
    writeFileSync(join(sourceDir, 'note.txt'), 'latest', 'utf-8')
    writeAgentSessionJsonl('source-session', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '继续' }] } }),
    ])

    const { createAgentSidecarSnapshot } = await import('./agent-sidecar-snapshot')
    await createAgentSidecarSnapshot({
      sessionId: 'source-session',
      messageUuid: 'user-2',
      roots: [sourceDir, join(sourceDir, '.git')],
    })

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

    const fork = await manager.forkAgentSession({
      sessionId: 'source-session',
      upToMessageUuid: 'assistant-1',
    })

    const forkDir = join(configDir(), 'agent-workspaces', 'workspace-one', fork.id)
    expect(readFileSync(join(forkDir, 'note.txt'), 'utf-8')).toBe('old')
  })

  test('Given 删除会话引用多个 SDK ID When 其它会话仍引用 legacy ID Then 只清理未引用 runtime 数据', () => {
    writeAgentSessionsIndex([
      {
        id: 'delete-me',
        title: '待删',
        sdkSessionId: 'sdk-delete',
        legacySdkSessionId: 'legacy-shared',
        forkSourceSdkSessionId: 'fork-delete',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'keep-me',
        title: '保留',
        legacySdkSessionId: 'legacy-shared',
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    for (const sdkId of ['sdk-delete', 'legacy-shared', 'fork-delete']) {
      mkdirSync(join(configDir(), 'sdk-config', 'file-history', sdkId), { recursive: true })
      writeFileSync(join(configDir(), 'sdk-config', 'file-history', sdkId, 'backup'), sdkId, 'utf-8')
      mkdirSync(join(configDir(), 'sdk-config', 'projects', 'project-hash'), { recursive: true })
      writeFileSync(join(configDir(), 'sdk-config', 'projects', 'project-hash', `${sdkId}.jsonl`), '{}\n', 'utf-8')
      mkdirSync(join(configDir(), 'sdk-config', 'sessions'), { recursive: true })
      writeFileSync(join(configDir(), 'sdk-config', 'sessions', `${sdkId}.jsonl`), '{}\n', 'utf-8')
    }
    writeAgentSessionJsonl('delete-me', [JSON.stringify({ type: 'assistant', uuid: 'assistant-1' })])

    manager.deleteAgentSession('delete-me')

    expect(existsSync(join(configDir(), 'sdk-config', 'file-history', 'sdk-delete'))).toBe(false)
    expect(existsSync(join(configDir(), 'sdk-config', 'file-history', 'fork-delete'))).toBe(false)
    expect(existsSync(join(configDir(), 'sdk-config', 'file-history', 'legacy-shared'))).toBe(true)
    expect(existsSync(join(configDir(), 'sdk-config', 'projects', 'project-hash', 'legacy-shared.jsonl'))).toBe(true)
    expect(existsSync(join(configDir(), 'sdk-config', 'projects', 'project-hash', 'sdk-delete.jsonl'))).toBe(false)
    expect(existsSync(join(configDir(), 'sdk-config', 'sessions', 'fork-delete.jsonl'))).toBe(false)
  })
})
