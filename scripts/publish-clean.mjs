/**
 * 发布干净安装包。不读取、不删除 %APPDATA%\mysql-lite 里的连接和工作区。
 * 安装包内程序的数据目录名改为 mysql-lite-release，打开时是空的。
 * 用法：node scripts/publish-clean.mjs
 * 产物：release-clean/MySQL Lite Setup 1.0.0.exe
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command) {
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npx electron-vite build')
run(
  'npx electron-builder --win nsis -c.directories.output=release-clean -c.extraMetadata.name=mysql-lite-release'
)
