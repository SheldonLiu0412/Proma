/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { DEFAULT_INTERFACE_VARIANT, DEFAULT_THEME_MODE } from '../../types'
import type { AppSettings } from '../../types'
import { DEFAULT_AGENT_THINKING_LEVEL, resolveAgentThinkingLevel } from '@proma/shared'

function withResolvedSettings(data: Partial<AppSettings>): AppSettings {
  return {
    ...data,
    themeMode: data.themeMode || DEFAULT_THEME_MODE,
    interfaceVariant: data.interfaceVariant || DEFAULT_INTERFACE_VARIANT,
    onboardingCompleted: data.onboardingCompleted ?? false,
    environmentCheckSkipped: data.environmentCheckSkipped ?? false,
    notificationsEnabled: data.notificationsEnabled ?? true,
    longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
    richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
    feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
    builtinMcpDisabledIds: data.builtinMcpDisabledIds ?? [],
    agentThinkingLevel: resolveAgentThinkingLevel(data),
  }
}

function getDefaultSettings(): AppSettings {
  return {
    themeMode: DEFAULT_THEME_MODE,
    interfaceVariant: DEFAULT_INTERFACE_VARIANT,
    onboardingCompleted: false,
    environmentCheckSkipped: false,
    notificationsEnabled: true,
    longTextPasteAsAttachmentEnabled: false,
    richTextRenderingEnabled: false,
    feishuSessionMirror: { mode: 'off' },
    builtinMcpDisabledIds: [],
    agentThinkingLevel: DEFAULT_AGENT_THINKING_LEVEL,
  }
}

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return getDefaultSettings()
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AppSettings>
    return withResolvedSettings(data)
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return getDefaultSettings()
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const updated: AppSettings = {
    ...current,
    ...updates,
  }

  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
