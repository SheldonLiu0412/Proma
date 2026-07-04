import { describe, expect, test } from 'bun:test'
import type { RuntimeStatus } from '@proma/shared'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'

function baseRuntimeStatus(): RuntimeStatus {
  return {
    node: { available: false, path: null, version: null, error: null },
    bun: { available: false, path: null, version: null, source: null, error: null },
    git: { available: false, path: null, version: null, error: null },
    envLoaded: true,
    initializedAt: 1,
  }
}

describe('Agent runtime env', () => {
  test('Given 打包 CLI 和代理 When 构建 runtime env Then 注入 PROMA_CLI、增强 PATH、代理变量', () => {
    const runtimeEnv = buildAgentRuntimeEnv({
      platform: 'darwin',
      pathDelimiter: ':',
      bundledCliPath: '/Applications/Proma.app/Contents/Resources/bin/proma',
      proxyUrl: 'http://127.0.0.1:7890',
      processEnv: {
        PATH: '/usr/bin:/bin',
        NO_PROXY: 'localhost,127.0.0.1',
      },
      runtimeStatus: baseRuntimeStatus(),
    })

    expect(runtimeEnv.env.PROMA_CLI).toBe('/Applications/Proma.app/Contents/Resources/bin/proma')
    expect(runtimeEnv.env.PATH).toBe('/Applications/Proma.app/Contents/Resources/bin:/usr/bin:/bin')
    expect(runtimeEnv.env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(runtimeEnv.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(runtimeEnv.env.ALL_PROXY).toBe('http://127.0.0.1:7890')
    expect(runtimeEnv.env.NO_PROXY).toBe('localhost,127.0.0.1')
    expect(runtimeEnv.env.http_proxy).toBe('http://127.0.0.1:7890')
    expect(runtimeEnv.env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(runtimeEnv.env.all_proxy).toBe('http://127.0.0.1:7890')
    expect(runtimeEnv.env.no_proxy).toBe('localhost,127.0.0.1')
  })

  test('Given Windows Git Bash 检测结果 When 构建 runtime env Then 传递 Pi shellPath 兼容变量', () => {
    const runtimeStatus: RuntimeStatus = {
      ...baseRuntimeStatus(),
      shell: {
        gitBash: {
          available: true,
          path: 'D:\\Tools\\Git\\bin\\bash.exe',
          version: '5.2.15',
          error: null,
        },
        wsl: {
          available: false,
          version: null,
          defaultDistro: null,
          distros: [],
          error: '未安装',
        },
        recommended: 'git-bash',
      },
    }

    const runtimeEnv = buildAgentRuntimeEnv({
      platform: 'win32',
      pathDelimiter: ';',
      bundledCliPath: 'C:\\Proma\\bin\\proma.exe',
      processEnv: { Path: 'C:\\Windows\\System32' },
      runtimeStatus,
    })

    expect(runtimeEnv.shellKind).toBe('git-bash')
    expect(runtimeEnv.shellPath).toBe('D:\\Tools\\Git\\bin\\bash.exe')
    expect(runtimeEnv.env.CLAUDE_CODE_SHELL).toBe('D:\\Tools\\Git\\bin\\bash.exe')
    expect(runtimeEnv.env.SHELL).toBe('D:\\Tools\\Git\\bin\\bash.exe')
    expect(runtimeEnv.env.Path).toBe('C:\\Proma\\bin;C:\\Windows\\System32')
  })

  test('Given runtime env 和用户 env When 合并 Then 用户 env 优先且 PATH 大小写不重复', () => {
    const merged = mergeRuntimeEnv(
      {
        PATH: '/runtime/bin:/usr/bin',
        HTTP_PROXY: 'http://runtime-proxy',
        PROMA_CLI: '/runtime/bin/proma',
      },
      {
        Path: '/user/bin',
        HTTP_PROXY: 'http://user-proxy',
        CUSTOM_TOKEN: 'abc',
      },
    )

    expect(merged.PATH).toBeUndefined()
    expect(merged.Path).toBe('/user/bin')
    expect(merged.HTTP_PROXY).toBe('http://user-proxy')
    expect(merged.PROMA_CLI).toBe('/runtime/bin/proma')
    expect(merged.CUSTOM_TOKEN).toBe('abc')

    const lowerProxyMerged = mergeRuntimeEnv(
      {
        HTTP_PROXY: 'http://runtime-proxy',
        http_proxy: 'http://runtime-proxy',
      },
      {
        http_proxy: 'http://user-lower-proxy',
      },
    )
    expect(lowerProxyMerged.HTTP_PROXY).toBeUndefined()
    expect(lowerProxyMerged.http_proxy).toBe('http://user-lower-proxy')
  })
})
