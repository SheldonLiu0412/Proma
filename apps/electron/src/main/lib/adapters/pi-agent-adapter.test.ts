import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPiProxySettingsForQuery,
  buildAllowedToolRoots,
  buildPiRemoteConnectionSettings,
} from './pi-agent-adapter'

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

function snapshotProxyEnv(): Map<string, string | undefined> {
  return new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreProxyEnv(snapshot: Map<string, string | undefined>): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = snapshot.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('Pi Agent adapter remote connection settings', () => {
  test('Given queryOptions 包含远程连接字段 When 构建 Pi settings Then 透传 proxy、transport 和 timeout', () => {
    const settings = buildPiRemoteConnectionSettings({
      proxyUrl: ' http://127.0.0.1:7890 ',
      transport: 'websocket-cached',
      httpIdleTimeoutMs: 120000,
      websocketConnectTimeoutMs: 15000,
    })

    expect(settings).toEqual({
      httpProxy: 'http://127.0.0.1:7890',
      transport: 'websocket-cached',
      httpIdleTimeoutMs: 120000,
      websocketConnectTimeoutMs: 15000,
    })
  })

  test('Given queryOptions 未直接传 proxyUrl When runtimeEnv 含代理 Then 从 runtimeEnv 解析 httpProxy', () => {
    const settings = buildPiRemoteConnectionSettings({
      runtimeEnv: {
        env: {
          https_proxy: 'http://runtime-proxy:7890',
        },
      },
    })

    expect(settings.httpProxy).toBe('http://runtime-proxy:7890')
  })

  test('Given Pi proxy helper 未公开或仅设置部分变量 When 应用 scoped proxy Then 补齐并按栈恢复 env', () => {
    const originalEnv = snapshotProxyEnv()
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key]
    }

    const helperCalls: string[] = []
    const fakeSdk = {
      applyHttpProxySettings(proxyUrl) {
        if (proxyUrl) helperCalls.push(proxyUrl)
        process.env.HTTP_PROXY = 'http://sdk-helper-proxy'
      },
    } satisfies { applyHttpProxySettings: (proxyUrl: string | undefined) => void }

    try {
      const restoreFirst = applyPiProxySettingsForQuery(fakeSdk, { proxyUrl: 'http://first-proxy' })
      expect(helperCalls).toEqual(['http://first-proxy'])
      expect(process.env.HTTP_PROXY).toBe('http://first-proxy')
      expect(process.env.HTTPS_PROXY).toBe('http://first-proxy')
      expect(process.env.ALL_PROXY).toBe('http://first-proxy')
      expect(process.env.http_proxy).toBe('http://first-proxy')

      const restoreSecond = applyPiProxySettingsForQuery({}, { proxyUrl: 'http://second-proxy' })
      expect(process.env.HTTP_PROXY).toBe('http://second-proxy')

      restoreFirst()
      expect(process.env.HTTP_PROXY).toBe('http://second-proxy')

      restoreSecond()
      for (const key of PROXY_ENV_KEYS) {
        expect(process.env[key]).toBeUndefined()
      }
    } finally {
      restoreProxyEnv(originalEnv)
    }
  })
})

describe('Pi Agent adapter 工具路径授权根', () => {
  test('Given Proma 内部只读目录 When 构建工具根 Then 仅进入读取根而不进入写入根', () => {
    const tmpRoot = realpathSync.native('/tmp')
    const sessionDir = join(tmpRoot, 'proma', 'workspace', 'session-one')
    const attachedDir = join(tmpRoot, 'user-attached')
    const sessionsDir = join(tmpRoot, 'proma', 'agent-sessions')
    const workspaceDir = join(tmpRoot, 'proma', 'workspace')
    const roots = buildAllowedToolRoots(
      sessionDir,
      [attachedDir],
      [sessionsDir, workspaceDir],
    )

    expect(roots.readRoots).toContain(workspaceDir)
    expect(roots.readRoots).toContain(sessionsDir)
    expect(roots.readRoots).toContain(attachedDir)
    expect(roots.writeRoots).toContain(sessionDir)
    expect(roots.writeRoots).toContain(attachedDir)
    expect(roots.writeRoots).not.toContain(workspaceDir)
    expect(roots.writeRoots).not.toContain(sessionsDir)
  })
})
