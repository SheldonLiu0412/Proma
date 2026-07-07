import { describe, expect, mock, test } from 'bun:test'

mock.module('./user-profile-service', () => ({
  getUserProfile: () => ({ userName: '测试用户', avatar: '' }),
}))

let mockAutoMemoryBlock: string | undefined

mock.module('./agent-workspace-manager', () => ({
  getWorkspaceMcpConfig: () => ({ servers: {} }),
  buildAutoMemoryContextBlock: () => mockAutoMemoryBlock,
}))

const { buildSystemPrompt, buildDynamicContext } = await import('./agent-prompt-builder')

describe('Agent 系统提示词构建', () => {
  test('Given Pi SDK 迁移后的提示词 When 构建系统提示词 Then 不再宣称不存在的审查 Slash 能力', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-test',
      permissionMode: 'auto',
      claudeAvailable: true,
    })

    expect(prompt).not.toContain('/code-review')
    expect(prompt).not.toContain('/simplify')
    expect(prompt).toContain('简单代码审查优先使用 SDK SubAgent')
  })

  test('Given 计划模式 When 构建系统提示词 Then 使用 Pi SDK 实际工具名描述只读能力', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-test',
      permissionMode: 'plan',
      claudeAvailable: true,
    })

    expect(prompt).toContain('`read`、`grep`、`find`、`ls`')
    expect(prompt).toContain('`write`、`edit` 或 `bash` 写操作命令')
    expect(prompt).not.toContain('Read、Glob、Grep、WebSearch')
  })

  test('Given Pi SDK 项目上下文加载规则 When 构建系统提示词 Then 项目指令只说明 AGENTS.md', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-test',
      permissionMode: 'auto',
      claudeAvailable: true,
    })

    expect(prompt).toContain('工作区根目录下的 `AGENTS.md`')
    expect(prompt).not.toContain('AGENTS.md / CLAUDE.md')
    expect(prompt).not.toContain('CLAUDE.md')
  })

  test('Given 工作区存在 auto memory When 构建动态上下文 Then 注入 .agents/memory 内容', () => {
    mockAutoMemoryBlock = '### MEMORY.md\n- 用户画像: user-profile.md\n\n### user-profile.md\n- 偏好中文沟通'

    const context = buildDynamicContext({ workspaceSlug: 'workspace-test' })

    expect(context).toContain('<workspace_memory>')
    expect(context).toContain('`.agents/memory/`')
    expect(context).toContain('### MEMORY.md')
    expect(context.indexOf('### MEMORY.md')).toBeLessThan(context.indexOf('### user-profile.md'))
    expect(context).not.toContain('.claude/memory')
  })

  test('Given 工作区没有 auto memory When 构建动态上下文 Then 不注入空记忆块', () => {
    mockAutoMemoryBlock = undefined

    const context = buildDynamicContext({ workspaceSlug: 'workspace-test' })

    expect(context).not.toContain('<workspace_memory>')
  })
})
