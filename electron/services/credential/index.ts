import { safeStorage } from 'electron'

/**
 * 凭据服务：使用操作系统级加密（Windows DPAPI）保护数据库密码。
 * 密文以 base64 形式存入配置文件，永不明文落盘。
 */

export function encryptPassword(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('操作系统凭据加密不可用，无法安全保存密码')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

export function decryptPassword(cipher: string): string {
  if (!cipher) return ''
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
}
