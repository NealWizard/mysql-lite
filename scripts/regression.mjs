/**
 * 本机回归（127.0.0.1:33066 / test / root/root）。
 * 只创建并清理 ml_reg_* 对象，不删其它库表。
 *
 * 用法：
 *   npx esbuild src/views/TableStructure/alterSql.ts --bundle --platform=node --format=esm --outfile=scripts/_alter-bundle.mjs
 *   node scripts/regression.mjs
 *   del scripts\_alter-bundle.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import mysql from 'mysql2/promise'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'scripts', '_alter-bundle.mjs')
const build = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['esbuild', 'src/views/TableStructure/alterSql.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`],
  { cwd: root, encoding: 'utf8', shell: true }
)
if (build.status !== 0) {
  console.error(build.stderr || build.stdout)
  process.exit(1)
}

const { buildAlterSql, fieldFromColumn, isViewDdl } = await import(pathToFileURL(bundle).href)

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log('  PASS ', name)
  } else {
    fail++
    console.log('  FAIL ', name, detail)
  }
}

const c = await mysql.createConnection({
  host: '127.0.0.1',
  port: 33066,
  user: 'root',
  password: 'root',
  database: 'test'
})

try {
  console.log('\n== 准备 ==')
  await c.query(`
    CREATE TABLE IF NOT EXISTS ml_reg_demo (
      id bigint primary key auto_increment,
      name varchar(32) not null comment '名',
      status tinyint not null default 1,
      note varchar(64) null
    ) ENGINE=InnoDB
  `)
  await c.query(`DELETE FROM ml_reg_demo`)
  await c.query(`INSERT INTO ml_reg_demo (name, status, note) VALUES ('alpha', 1, NULL), ('beta', 0, 'x')`)
  await c.query(`CREATE TABLE IF NOT EXISTS ml_reg_new (id int primary key, v varchar(8)) ENGINE=InnoDB`)

  console.log('\n== 元数据 ==')
  const [tabs] = await c.query(`SHOW TABLES LIKE 'ml_reg_%'`)
  const names = tabs.map((r) => Object.values(r)[0])
  check('新建表可见', names.includes('ml_reg_new') && names.includes('ml_reg_demo'), JSON.stringify(names))
  const [cols] = await c.query(`SHOW FULL COLUMNS FROM ml_reg_demo`)
  const idCol = cols.find((r) => r.Field === 'id')
  check('EXTRA auto_increment', String(idCol?.Extra || '').includes('auto_increment'))

  console.log('\n== ALTER 生成 ==')
  const base = [
    fieldFromColumn(
      { ordinal: 1, name: 'id', type: 'bigint(20)', nullable: false, defaultValue: null, comment: '自增id', key: 'PRI', extra: 'auto_increment' },
      'f1'
    ),
    fieldFromColumn(
      { ordinal: 2, name: 'name', type: 'varchar(32)', nullable: false, defaultValue: null, comment: '名', key: '', extra: '' },
      'f2'
    )
  ]
  const edited = structuredClone(base)
  edited[0] = { ...edited[0], comment: '主键' }
  const built = buildAlterSql('test', 'ml_reg_demo', edited, [], base, [])
  check('改注释保留 AUTO_INCREMENT', /AUTO_INCREMENT/i.test(built.sql) && /COMMENT '主键'/.test(built.sql), built.sql)
  check('视图识别', isViewDdl('CREATE VIEW v AS SELECT 1') && !isViewDdl('CREATE TABLE t (id int)'))

  console.log('\n== 查询 / NULL ==')
  const [rows] = await c.query('SELECT id, name, note FROM ml_reg_demo ORDER BY id')
  check('查出 2 行', rows.length === 2)
  check('含 NULL', rows.some((r) => r.note === null))

  console.log('\n== 真实 ALTER ==')
  await c.query(`ALTER TABLE ml_reg_demo ADD COLUMN ml_reg_tmp_col varchar(8) NULL`)
  const [c2] = await c.query(`SHOW COLUMNS FROM ml_reg_demo LIKE 'ml_reg_tmp_col'`)
  check('ADD COLUMN', c2.length === 1)
  await c.query(`ALTER TABLE ml_reg_demo DROP COLUMN ml_reg_tmp_col`)
  const [c3] = await c.query(`SHOW COLUMNS FROM ml_reg_demo LIKE 'ml_reg_tmp_col'`)
  check('DROP COLUMN', c3.length === 0)
} finally {
  console.log('\n== 清理 ==')
  await c.query('DROP TABLE IF EXISTS ml_reg_new, ml_reg_demo, ml_reg_demo2, ml_reg_vis')
  const [left] = await c.query(`SHOW TABLES LIKE 'ml_reg_%'`)
  check('回归表已清理', left.length === 0, JSON.stringify(left))
  await c.end()
  if (existsSync(bundle)) unlinkSync(bundle)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
