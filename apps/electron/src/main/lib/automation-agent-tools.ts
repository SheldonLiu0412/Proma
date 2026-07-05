/**
 * Agent 内置定时任务工具
 *
 * 通过 Pi customTools 暴露 Proma Automation 的创建、维护和运行记录能力。
 * 这些工具服务于 Agent 模式，不经过渲染进程 IPC，因此这里必须独立做参数校验。
 */

import {
  type Automation,
  type AutomationScheduleType,
  type AutomationSessionMode,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from '@proma/shared'
import type { TProperties, TSchema } from 'typebox'
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
} from './automation-manager'
import {
  broadcastChanged as broadcastAutomationsChanged,
  runAutomationNow,
} from './automation-scheduler'
import { getAgentSessionMeta } from './agent-session-manager'

interface AutomationAgentToolContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  triggeredBy?: 'user' | 'automation' | 'delegation'
}

interface AutomationToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
}

interface CreateAutomationToolArgs {
  name?: string
  prompt?: string
  scheduleType?: AutomationScheduleType
  intervalMinutes?: number
  timeOfDay?: string
  dayOfWeek?: number
  dayOfMonth?: number
  scheduledAt?: number
  maxRuns?: number
  active?: boolean
  sessionMode?: AutomationSessionMode
}

interface UpdateAutomationToolArgs extends CreateAutomationToolArgs {
  id?: string
}

type TypeBuilder = typeof import('typebox').Type

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function validScheduleType(v: unknown): v is AutomationScheduleType {
  return v === 'interval' || v === 'daily' || v === 'weekly' || v === 'monthly' || v === 'once'
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
}

function assertNonBlank(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${field} 不能为空`)
  }
  return value.trim()
}

function validateScheduleFields(input: Partial<CreateAutomationInput | UpdateAutomationInput>): void {
  if (input.scheduleType !== undefined && !validScheduleType(input.scheduleType)) {
    throw new Error(`非法的 scheduleType: ${String(input.scheduleType)}`)
  }
  if (input.intervalMinutes !== undefined && (!isFiniteInt(input.intervalMinutes) || input.intervalMinutes < 1)) {
    throw new Error(`非法的 intervalMinutes: ${String(input.intervalMinutes)}`)
  }
  if (input.timeOfDay !== undefined && !TIME_OF_DAY_PATTERN.test(input.timeOfDay)) {
    throw new Error(`非法的 timeOfDay: ${String(input.timeOfDay)}`)
  }
  if (input.dayOfWeek !== undefined && (!isFiniteInt(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6)) {
    throw new Error(`非法的 dayOfWeek: ${String(input.dayOfWeek)}`)
  }
  if (input.dayOfMonth !== undefined && (!isFiniteInt(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31)) {
    throw new Error(`非法的 dayOfMonth: ${String(input.dayOfMonth)}`)
  }
  if (input.scheduledAt !== undefined && (typeof input.scheduledAt !== 'number' || !Number.isFinite(input.scheduledAt) || input.scheduledAt <= 0)) {
    throw new Error(`非法的 scheduledAt: ${String(input.scheduledAt)}（应为毫秒时间戳）`)
  }
  if (input.maxRuns !== undefined && (!isFiniteInt(input.maxRuns) || input.maxRuns < 1)) {
    throw new Error(`非法的 maxRuns: ${String(input.maxRuns)}（应为 ≥1 的整数）`)
  }
  if (input.sessionMode !== undefined && input.sessionMode !== 'daily' && input.sessionMode !== 'reuse') {
    throw new Error(`非法的 sessionMode: ${String(input.sessionMode)}`)
  }
}

function summarizeAutomation(a: Automation, includeHistory: boolean): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    active: a.active,
    scheduleType: a.scheduleType,
    intervalMinutes: a.intervalMinutes,
    timeOfDay: a.timeOfDay,
    dayOfWeek: a.dayOfWeek,
    dayOfMonth: a.dayOfMonth,
    scheduledAt: a.scheduledAt,
    maxRuns: a.maxRuns,
    runCount: a.runCount ?? 0,
    completedAt: a.completedAt,
    sessionMode: a.sessionMode,
    workspaceId: a.workspaceId,
    sourceSessionId: a.sourceSessionId,
    lastSessionId: a.lastSessionId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    nextRunAt: a.nextRunAt,
    lastRunAt: a.lastRunAt,
    consecutiveFailures: a.consecutiveFailures ?? 0,
    prompt: a.prompt,
    ...(includeHistory && { runHistory: a.runHistory }),
  }
}

function jsonResult(payload: unknown): AutomationToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function getCurrentAutomationId(ctx: AutomationAgentToolContext): string | undefined {
  return getAgentSessionMeta(ctx.sessionId)?.sourceAutomationId
}

function buildAutomationSchemas(Type: TypeBuilder) {
  const scheduleType = Type.Union([
    Type.Literal('interval'),
    Type.Literal('daily'),
    Type.Literal('weekly'),
    Type.Literal('monthly'),
    Type.Literal('once'),
  ])
  const sessionMode = Type.Union([Type.Literal('daily'), Type.Literal('reuse')])
  const describeSchema = <T extends TSchema>(schema: T, description: string): T => ({ ...schema, description })
  const strictObject = (properties: TProperties, description?: string) => (
    Type.Object(properties, { additionalProperties: false, ...(description ? { description } : {}) })
  )

  return {
    list: strictObject({
      active: Type.Optional(Type.Boolean({ description: '只列出启用或暂停任务；不传则列出全部' })),
      includeHistory: Type.Optional(Type.Boolean({ description: '是否包含运行历史，默认 false' })),
    }),
    get: strictObject({
      id: Type.Optional(Type.String({ description: '定时任务 ID；定时任务自动执行中可省略以读取当前任务' })),
    }),
    create: strictObject({
      name: Type.String({ description: '任务名，简短说明长期反复执行的目标' }),
      prompt: Type.String({ description: '每次触发时发送给 Agent 的完整自然语言指令' }),
      scheduleType: describeSchema(scheduleType, '调度类型：interval 固定间隔，daily 每天定点，weekly 每周定点，monthly 每月定点，once 指定时刻只运行一次'),
      intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, description: '固定间隔分钟数；scheduleType=interval 时必填。间隔可以远大于 10-30 分钟，如 1440=每天、10080=每周' })),
      timeOfDay: Type.Optional(Type.String({ pattern: TIME_OF_DAY_PATTERN.source, description: '每天/每周/每月触发时间，24 小时制 HH:MM' })),
      dayOfWeek: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, description: '每周触发日，0=周日，1=周一，...，6=周六' })),
      dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, description: '每月触发日，1-31；scheduleType=monthly 时必填' })),
      scheduledAt: Type.Optional(Type.Integer({ minimum: 1, description: '一次性任务的绝对触发时间（毫秒时间戳）；scheduleType=once 时必填。用于"在某个具体时间点跑一次"，如 N 小时/天后或某个日期时刻' })),
      maxRuns: Type.Optional(Type.Integer({ minimum: 1, description: '最大运行次数上限（按实际执行次数计，成功+失败都算）；达到后任务自动停用。不传=不限次。可与任意 scheduleType 叠加，如 interval+maxRuns=3 表示"每隔一段时间跑，共跑 3 次就停"' })),
      active: Type.Optional(Type.Boolean({ description: '创建后是否启用，默认 true' })),
      sessionMode: Type.Optional(describeSchema(sessionMode, '会话模式：daily=同一自然日内的触发复用同一个子会话，跨日新建（默认）；reuse=始终复用同一个子会话（保留长期上下文，token 成本更高）')),
    }),
    update: strictObject({
      id: Type.Optional(Type.String({ description: '定时任务 ID；定时任务自动执行中可省略以更新当前任务' })),
      name: Type.Optional(Type.String({ description: '新的任务名' })),
      prompt: Type.Optional(Type.String({ description: '新的执行提示词' })),
      scheduleType: Type.Optional(describeSchema(scheduleType, '新的调度类型')),
      intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, description: '新的固定间隔分钟数' })),
      timeOfDay: Type.Optional(Type.String({ pattern: TIME_OF_DAY_PATTERN.source, description: '新的每天/每周/每月触发时间，24 小时制 HH:MM' })),
      dayOfWeek: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, description: '新的每周触发日，0=周日，...，6=周六' })),
      dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, description: '新的每月触发日，1-31' })),
      scheduledAt: Type.Optional(Type.Integer({ minimum: 1, description: '新的一次性触发时间（毫秒时间戳），scheduleType=once 时使用' })),
      maxRuns: Type.Optional(Type.Integer({ minimum: 1, description: '新的最大运行次数上限（按实际执行次数计）；改动会重置已执行次数计数' })),
      active: Type.Optional(Type.Boolean({ description: '启用或暂停任务' })),
      sessionMode: Type.Optional(describeSchema(sessionMode, '新的会话模式：daily=同一自然日内复用，跨日新建；reuse=始终复用同一个子会话')),
    }),
    delete: strictObject({
      id: Type.String({ description: '要删除的定时任务 ID' }),
    }),
    runNow: strictObject({
      id: Type.Optional(Type.String({ description: '要立即运行的定时任务 ID；定时任务自动执行中可省略以运行当前任务' })),
    }),
  }
}

export async function buildAutomationAgentTools(
  ctx: AutomationAgentToolContext,
): Promise<import('@earendil-works/pi-coding-agent').ToolDefinition[]> {
  const { defineTool } = await import('@earendil-works/pi-coding-agent')
  const { Type } = await import('typebox')
  const schemas = buildAutomationSchemas(Type)
  const toResult = (payload: unknown) => {
    const result = jsonResult(payload)
    return { content: result.content, details: undefined }
  }

  return [
    defineTool({
      name: 'mcp__automation__list_automations',
      label: 'List Automations',
      description: '列出 Proma 持久化定时任务。用于查看已有长期反复任务、判断是否需要新建任务、检查运行状态和最近失败情况。',
      parameters: schemas.list,
      async execute(_id, raw) {
        const args = raw as { active?: boolean; includeHistory?: boolean }
        const items = listAutomations()
          .filter((a) => args.active === undefined || a.active === args.active)
          .map((a) => summarizeAutomation(a, args.includeHistory === true))
        return toResult({ automations: items })
      },
    }),
    defineTool({
      name: 'mcp__automation__get_automation',
      label: 'Get Automation',
      description: '读取单个 Proma 定时任务详情和运行记录。定时任务自动执行中可以省略 id 来读取当前任务，用于自检和自迭代。',
      parameters: schemas.get,
      async execute(_id, raw) {
        const args = raw as { id?: string }
        const id = args.id?.trim() || getCurrentAutomationId(ctx)
        if (!id) throw new Error('id 必填；只有定时任务自动执行中才可以省略 id')
        const automation = getAutomation(id)
        if (!automation) throw new Error(`定时任务不存在: ${id}`)
        return toResult({ automation: summarizeAutomation(automation, true) })
      },
    }),
    defineTool({
      name: 'mcp__automation__create_automation',
      label: 'Create Automation',
      description: '创建 Proma 持久化定时任务。适合无人值守、有稳定价值的场景：长期反复的周期任务，以及未来某个时间点跑一次的延时任务或跑有限几次就停的任务。',
      parameters: schemas.create,
      async execute(_id, raw) {
        const args = raw as CreateAutomationToolArgs
        if (ctx.triggeredBy === 'automation' || getCurrentAutomationId(ctx)) {
          throw new Error('当前是定时任务自动执行，禁止递归创建新的定时任务；请改用 update_automation 调整当前任务')
        }
        const input: CreateAutomationInput = {
          name: assertNonBlank(args.name, 'name'),
          prompt: assertNonBlank(args.prompt, 'prompt'),
          scheduleType: args.scheduleType ?? 'interval',
          intervalMinutes: args.intervalMinutes ?? 10,
          timeOfDay: args.timeOfDay,
          dayOfWeek: args.dayOfWeek,
          dayOfMonth: args.dayOfMonth,
          scheduledAt: args.scheduledAt,
          maxRuns: args.maxRuns,
          channelId: ctx.channelId,
          modelId: ctx.modelId,
          workspaceId: ctx.workspaceId,
          sessionMode: args.sessionMode,
          sourceSessionId: ctx.sessionId,
          active: args.active ?? true,
        }
        validateScheduleFields(input)
        if (input.scheduleType === 'interval' && args.intervalMinutes === undefined) throw new Error('scheduleType=interval 时 intervalMinutes 必填')
        if ((input.scheduleType === 'daily' || input.scheduleType === 'weekly' || input.scheduleType === 'monthly') && !input.timeOfDay) throw new Error('scheduleType=daily/weekly/monthly 时 timeOfDay 必填')
        if (input.scheduleType === 'weekly' && input.dayOfWeek === undefined) throw new Error('scheduleType=weekly 时 dayOfWeek 必填')
        if (input.scheduleType === 'monthly' && input.dayOfMonth === undefined) throw new Error('scheduleType=monthly 时 dayOfMonth 必填')
        if (input.scheduleType === 'once' && input.scheduledAt === undefined) throw new Error('scheduleType=once 时 scheduledAt（绝对触发时间戳）必填')
        const automation = createAutomation(input)
        broadcastAutomationsChanged()
        return toResult({ automation: summarizeAutomation(automation, true) })
      },
    }),
    defineTool({
      name: 'mcp__automation__update_automation',
      label: 'Update Automation',
      description: '修改 Proma 定时任务，包括名称、执行提示词、频率、启用状态和会话模式。定时任务自动执行中可以省略 id 来修改当前任务。',
      parameters: schemas.update,
      async execute(_id, raw) {
        const args = raw as UpdateAutomationToolArgs
        const id = args.id?.trim() || getCurrentAutomationId(ctx)
        if (!id) throw new Error('id 必填；只有定时任务自动执行中才可以省略 id')
        const input: UpdateAutomationInput = {
          id,
          name: args.name?.trim(),
          prompt: args.prompt?.trim(),
          scheduleType: args.scheduleType,
          intervalMinutes: args.intervalMinutes,
          timeOfDay: args.timeOfDay,
          dayOfWeek: args.dayOfWeek,
          dayOfMonth: args.dayOfMonth,
          scheduledAt: args.scheduledAt,
          maxRuns: args.maxRuns,
          active: args.active,
          sessionMode: args.sessionMode,
        }
        if (input.name !== undefined) assertNonBlank(input.name, 'name')
        if (input.prompt !== undefined) assertNonBlank(input.prompt, 'prompt')
        validateScheduleFields(input)
        if (input.scheduleType === 'once' && input.scheduledAt === undefined) {
          const existing = getAutomation(id)
          if (!existing?.scheduledAt) throw new Error('scheduleType 改为 once 时必须提供 scheduledAt（绝对触发时间戳）')
        }
        const automation = updateAutomation(input)
        if (!automation) throw new Error(`定时任务不存在: ${id}`)
        broadcastAutomationsChanged()
        return toResult({ automation: summarizeAutomation(automation, true) })
      },
    }),
    defineTool({
      name: 'mcp__automation__delete_automation',
      label: 'Delete Automation',
      description: '删除 Proma 定时任务。只在用户明确要求删除，或任务已经长期无价值且用户确认后使用。',
      parameters: schemas.delete,
      async execute(_id, raw) {
        const args = raw as { id?: string }
        const ok = deleteAutomation(assertNonBlank(args.id, 'id'))
        if (ok) broadcastAutomationsChanged()
        return toResult({ deleted: ok })
      },
    }),
    defineTool({
      name: 'mcp__automation__run_automation_now',
      label: 'Run Automation Now',
      description: '立即运行 Proma 定时任务。用于用户要求马上验证，或修改任务后需要试跑一次。定时任务自动执行中不要调用自己触发重入。',
      parameters: schemas.runNow,
      async execute(_id, raw) {
        const args = raw as { id?: string }
        const id = args.id?.trim() || getCurrentAutomationId(ctx)
        if (!id) throw new Error('id 必填；只有定时任务自动执行中才可以省略 id')
        if (ctx.triggeredBy === 'automation' && id === getCurrentAutomationId(ctx)) {
          throw new Error('当前任务正在自动执行，不能立即运行自身')
        }
        await runAutomationNow(id)
        return toResult({ started: true, id })
      },
    }),
  ]
}
