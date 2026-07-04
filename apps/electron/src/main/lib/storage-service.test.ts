import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type StorageService = typeof import('./storage-service')

let service: StorageService
let tempHome = ''
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'tmp'),
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
  },
  clipboard: {},
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  screen: {},
  shell: {},
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function configDir(): string {
  return join(tempHome, '.proma')
}

function sdkProjectsDir(): string {
  return join(configDir(), 'sdk-config', 'projects', 'project-hash')
}

function writeActiveSessionIndex(): void {
  writeFileSync(join(configDir(), 'agent-sessions.json'), JSON.stringify({
    version: 1,
    sessions: [
      {
        id: 'active-session',
        title: '活跃会话',
        sdkSessionId: 'sdk-active',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }), 'utf-8')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-storage-service-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  service = await import('./storage-service')
})

beforeEach(() => {
  rmSync(configDir(), { recursive: true, force: true })
  mkdirSync(sdkProjectsDir(), { recursive: true })
  writeActiveSessionIndex()
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

describe('SDK 配置清理', () => {
  test('Given projects 文件名包含活跃 sdkSessionId When 清理孤儿 SDK 配置 Then 保留活跃文件', async () => {
    const activeFile = join(sdkProjectsDir(), 'project-sdk-active-transcript.jsonl')
    const orphanFile = join(sdkProjectsDir(), 'project-orphan-transcript.jsonl')
    writeFileSync(activeFile, 'active')
    writeFileSync(orphanFile, 'orphan')

    const beforeStats = await service.calculateStorageStats()
    const sdkCategory = beforeStats.categories.find((category) => category.key === 'sdk-config')
    expect(sdkCategory?.count).toBe(2)
    expect(sdkCategory?.orphanCount).toBe(1)

    const result = await service.cleanupStorage({
      categories: ['sdk-config'],
      orphansOnly: true,
      archivedBeforeDays: 0,
    })

    expect(result.deletedCount).toBe(1)
    expect(existsSync(activeFile)).toBe(true)
    expect(existsSync(orphanFile)).toBe(false)
  })
})
