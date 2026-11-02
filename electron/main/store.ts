import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConnectionProfile } from '../../src/types'

/**
 * 连接配置本地持久化。
 * 配置文件仅存连接元数据与加密后的凭据（credential），不含明文密码。
 */

export interface StoredProfile extends ConnectionProfile {
  /** safeStorage 加密后的密码（base64） */
  credential: string
  createdAt: string
  updatedAt: string
}

function storeFile(): string {
  return join(app.getPath('userData'), 'connections.json')
}

export function loadProfiles(): StoredProfile[] {
  const file = storeFile()
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(data) ? (data as StoredProfile[]) : []
  } catch {
    // 配置文件损坏时返回空列表，避免应用无法启动
    return []
  }
}

export function saveProfiles(profiles: StoredProfile[]): void {
  const file = storeFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(profiles, null, 2), 'utf-8')
}
