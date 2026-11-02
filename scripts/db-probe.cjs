/**
 * 数据库连通性探针（一次性验证脚本）。
 * 运行：node scripts/db-probe.cjs
 */
const mysql = require('mysql2/promise')

async function main() {
  const started = Date.now()
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 33066,
    user: 'root',
    password: 'root',
    connectTimeout: 5000
  })
  const [v] = await conn.query('SELECT VERSION() AS version, CURRENT_USER() AS cu')
  console.log('连接成功:', JSON.stringify(v[0]), '延迟', Date.now() - started, 'ms')

  const [dbs] = await conn.query('SHOW DATABASES')
  console.log('数据库:', dbs.map((r) => Object.values(r)[0]).join(', '))

  const [tables] = await conn.query(
    "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA='test' AND TABLE_TYPE='BASE TABLE'"
  )
  console.log('test 库表数:', tables.length)
  console.log('前 10 张表:', tables.slice(0, 10).map((t) => `${t.TABLE_NAME}(${t.TABLE_ROWS})`).join(', '))
  await conn.end()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
