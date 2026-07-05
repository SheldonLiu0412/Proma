import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve } from 'node:path'

type SidecarSnapshot = typeof import('./agent-sidecar-snapshot')

let sidecar: SidecarSnapshot
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

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-sidecar-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  sidecar = await import('./agent-sidecar-snapshot')
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

describe('Agent sidecar shared root 映射', () => {
  test('Given shared root 来自旧工作区 When 提供 rootPathMap Then 恢复到新 root 而不是旧 root', async () => {
    const oldRoot = join(tempHome, 'old-workspace-files')
    const newRoot = join(tempHome, 'new-workspace-files')
    mkdirSync(oldRoot, { recursive: true })
    mkdirSync(newRoot, { recursive: true })
    writeFileSync(join(oldRoot, 'note.md'), 'old snapshot', 'utf-8')

    await sidecar.createAgentSidecarSnapshot({
      sessionId: 'session-one',
      messageUuid: 'user-one',
      roots: [oldRoot],
    })

    writeFileSync(join(oldRoot, 'note.md'), 'latest old root', 'utf-8')
    const result = await sidecar.restoreAgentSidecarSnapshot('session-one', 'user-one', {
      rootPathMap: new Map([[resolve(oldRoot), resolve(newRoot)]]),
      restoreUnmappedRoots: false,
    })

    expect(result.canRewind).toBe(true)
    expect(readFileSync(join(newRoot, 'note.md'), 'utf-8')).toBe('old snapshot')
    expect(readFileSync(join(oldRoot, 'note.md'), 'utf-8')).toBe('latest old root')
  })

  test('Given shared root 无法映射 When 禁止恢复 unmapped roots Then 不写回旧 root 并返回不可恢复', async () => {
    const oldRoot = join(tempHome, 'unmapped-old-workspace-files')
    mkdirSync(oldRoot, { recursive: true })
    writeFileSync(join(oldRoot, 'note.md'), 'old snapshot', 'utf-8')

    await sidecar.createAgentSidecarSnapshot({
      sessionId: 'session-two',
      messageUuid: 'user-two',
      roots: [oldRoot],
    })

    writeFileSync(join(oldRoot, 'note.md'), 'latest old root', 'utf-8')
    const result = await sidecar.restoreAgentSidecarSnapshot('session-two', 'user-two', {
      rootPathMap: new Map(),
      restoreUnmappedRoots: false,
    })

    expect(result.canRewind).toBe(false)
    expect(readFileSync(join(oldRoot, 'note.md'), 'utf-8')).toBe('latest old root')
  })
})
