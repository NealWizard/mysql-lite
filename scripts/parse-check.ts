/**
 * sqlParse 纯逻辑离线校验（无需数据库）。
 * 运行：node scripts/parse-check.ts（Node 24 原生支持 TypeScript）
 */
import { analyzeSql, firstKeyword, splitStatements, toCountSql, withPreviewLimit } from '../electron/services/query/sqlParse.ts'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}\n    期望: ${e}\n    实际: ${a}`)
  }
}

// ---------- 语句拆分 ----------
check('多条语句', splitStatements('SELECT 1; SELECT 2;').length, 2)
check('字符串内分号不切分', splitStatements("SELECT ';'").length, 1)
check('双引号内分号不切分', splitStatements('SELECT "a;b"').length, 1)
check('反引号内分号不切分', splitStatements('SELECT `a;b` FROM t').length, 1)
check('转义引号', splitStatements("SELECT 'a\\'b;'; SELECT 2").length, 2)
check('块注释内分号忽略', splitStatements('/* ; ; */ SELECT 1').length, 1)
check('行注释(-- 空格)内分号忽略', splitStatements('SELECT 1 -- ;\n; SELECT 2').length, 2)
check('# 注释内分号忽略', splitStatements('SELECT 1 # ;\n; SELECT 2').length, 2)
check('-- 后无空格不算注释', splitStatements('SELECT 1--x\n; SELECT 2').length, 2)
check('空语句被忽略', splitStatements(';;;').length, 0)
check('末尾无分号', splitStatements('SELECT 1').length, 1)
check(
  '语句内容保持完整',
  splitStatements("SELECT name FROM users WHERE tag = 'a;b';")[0],
  "SELECT name FROM users WHERE tag = 'a;b'"
)

// ---------- 首关键字 ----------
check('SELECT 首词', firstKeyword('  select * from t'), 'SELECT')
check('括号开头', firstKeyword('(SELECT 1)'), 'SELECT')
// 注释在拆分阶段已被剥离，firstKeyword 只接收剥离后的语句（真实执行路径）
check('注释剥离后首词', firstKeyword(splitStatements('-- hi\nSHOW TABLES')[0] ?? ''), 'SHOW')

// ---------- 危险语句识别 ----------
check('DROP 命中', analyzeSql('DROP TABLE t').risks.length, 1)
check('TRUNCATE 命中', analyzeSql('TRUNCATE TABLE t').risks.length, 1)
check('无WHERE的DELETE命中', analyzeSql('DELETE FROM users').risks.length, 1)
check('无WHERE的UPDATE命中', analyzeSql("UPDATE t SET a=1").risks.length, 1)
check('带WHERE的DELETE安全', analyzeSql('DELETE FROM users WHERE id=1').risks.length, 0)
check('带WHERE的UPDATE安全', analyzeSql("UPDATE t SET a='x;y' WHERE id=1").risks.length, 0)
check('WHERE在字符串中不误判', analyzeSql("DELETE FROM t WHERE note='x'").risks.length, 0)
check('SELECT 安全', analyzeSql('SELECT * FROM t').risks.length, 0)
check(
  '多语句中定位风险序号',
  analyzeSql('SELECT 1; DROP TABLE t; SELECT 2').risks.map((r) => r.index),
  [1]
)

// ---------- 预览 LIMIT ----------
check(
  'SELECT 补 LIMIT',
  withPreviewLimit('SELECT * FROM t', 1000, 0),
  { sql: 'SELECT * FROM t LIMIT 1001 OFFSET 0', limited: true }
)
check(
  '已有 LIMIT 不改写',
  withPreviewLimit('SELECT * FROM t LIMIT 10', 1000, 0),
  { sql: 'SELECT * FROM t LIMIT 10', limited: false }
)
check(
  '子查询里的 LIMIT 仍给外层补',
  withPreviewLimit('SELECT * FROM (SELECT * FROM t LIMIT 1) x', 1000, 2000),
  { sql: 'SELECT * FROM (SELECT * FROM t LIMIT 1) x LIMIT 1001 OFFSET 2000', limited: true }
)
check(
  '字符串中的 LIMIT 不算',
  withPreviewLimit("SELECT * FROM t WHERE name = 'limit'", 1000, 0).limited,
  true
)
check('SHOW 不补', withPreviewLimit('SHOW TABLES', 1000, 0).limited, false)
check('INTO 不补', withPreviewLimit("SELECT * FROM t INTO OUTFILE '/tmp/a'", 1000, 0).limited, false)
check('简单查询计数', toCountSql('SELECT * FROM t'), 'SELECT COUNT(*) AS cnt FROM t')
check(
  '去掉外层 ORDER BY',
  toCountSql('SELECT * FROM t WHERE name = \'order by x\' ORDER BY id'),
  'SELECT COUNT(*) AS cnt FROM t WHERE name = \'order by x\''
)
check('已有 LIMIT 不计数', toCountSql('SELECT * FROM t LIMIT 10'), null)
check('JOIN 套子查询', toCountSql('SELECT * FROM t JOIN u ON t.id = u.id')?.startsWith('SELECT COUNT(*) AS cnt FROM ('), true)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
