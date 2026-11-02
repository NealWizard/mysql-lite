import assert from 'node:assert/strict'
import { buildAlterSql, fieldFromColumn, indexFromInfo, isViewDdl, type FieldDraft, type IndexDraft } from '../src/views/TableStructure/alterSql'
import type { ColumnInfo } from '../src/types'

function col(partial: Partial<ColumnInfo> & Pick<ColumnInfo, 'name' | 'type'>): ColumnInfo {
  return {
    ordinal: 1,
    nullable: true,
    defaultValue: null,
    comment: '',
    key: '',
    extra: '',
    ...partial
  }
}

const id = fieldFromColumn(
  col({ name: 'id', type: 'bigint(20) unsigned', nullable: false, comment: '自增id', key: 'PRI', extra: 'auto_increment' }),
  'f1'
)
const name = fieldFromColumn(col({ name: 'org_name', type: 'varchar(64)', nullable: false, comment: '网点名称' }), 'f2')
const baseFields: FieldDraft[] = [id, name]
const baseIndexes: IndexDraft[] = []

const same = buildAlterSql('db', 't', baseFields, baseIndexes, baseFields, baseIndexes)
assert.equal(same.sql, '')

const comment = structuredClone(baseFields)
comment[0] = { ...comment[0], comment: '主键' }
const commentSql = buildAlterSql('db', 't', comment, [], baseFields, [])
assert.match(commentSql.sql, /MODIFY COLUMN `id` bigint\(20\) unsigned NOT NULL AUTO_INCREMENT COMMENT '主键'/)
assert.doesNotMatch(commentSql.sql, /DROP PRIMARY KEY/)

const added = structuredClone(baseFields)
added.push({
  ...name,
  key: 'n1',
  originalName: null,
  name: 'remark',
  type: 'varchar',
  length: '255',
  decimals: '',
  nullable: true,
  defaultValue: 'x',
  comment: '备注',
  primary: false,
  extra: '',
  unsigned: false,
  zerofill: false,
  enumMode: false,
  fullType: ''
})
const addSql = buildAlterSql('db', 't', added, [], baseFields, [])
assert.match(addSql.sql, /ADD COLUMN `remark` varchar\(255\) NULL DEFAULT 'x' COMMENT '备注'/)

const renamed = structuredClone(baseFields)
renamed[1] = { ...renamed[1], name: 'org_title' }
const renameSql = buildAlterSql('db', 't', renamed, [], baseFields, [])
assert.match(renameSql.sql, /CHANGE COLUMN `org_name` `org_title` varchar\(64\) NOT NULL COMMENT '网点名称'/)

const moved = structuredClone(baseFields).reverse()
const moveSql = buildAlterSql('db', 't', moved, [], baseFields, [])
assert.match(moveSql.sql, /MODIFY COLUMN `org_name` varchar\(64\) NOT NULL COMMENT '网点名称' FIRST/)

const pkOff = structuredClone(baseFields)
pkOff[0] = { ...pkOff[0], primary: false }
const pkSql = buildAlterSql('db', 't', pkOff, [], baseFields, [])
assert.match(pkSql.sql, /DROP PRIMARY KEY/)
assert.doesNotMatch(pkSql.sql, /ADD PRIMARY KEY/)

const idx = indexFromInfo({ name: 'idx_name', columns: 'org_name', unique: false }, 'i1')
assert.ok(idx)
const idxBase = [idx]
const idxRenamed: IndexDraft[] = [{ ...idx, name: 'idx_org' }]
const idxSql = buildAlterSql('db', 't', baseFields, idxRenamed, baseFields, idxBase)
assert.match(idxSql.sql, /RENAME INDEX `idx_name` TO `idx_org`/)

const idxCols: IndexDraft[] = [{ ...idx, columns: ['org_name', 'id'], unique: true }]
const idxColSql = buildAlterSql('db', 't', baseFields, idxCols, baseFields, idxBase)
assert.match(idxColSql.sql, /DROP INDEX `idx_name`/)
assert.match(idxColSql.sql, /ADD UNIQUE INDEX `idx_name` \(`org_name`, `id`\)/)

const dropped = baseFields.slice(0, 1)
const bad = buildAlterSql('db', 't', dropped, idxBase, baseFields, idxBase)
assert.equal(bad.error, '索引 idx_name 引用了不存在的字段 org_name')

const num = structuredClone(baseFields)
num[1] = { ...num[1], defaultValue: '1' }
const numSql = buildAlterSql('db', 't', num, [], baseFields, [])
assert.match(numSql.sql, /DEFAULT 1/)

const text = structuredClone(baseFields)
text[1] = { ...text[1], defaultValue: "a'b" }
const textSql = buildAlterSql('db', 't', text, [], baseFields, [])
assert.match(textSql.sql, /DEFAULT 'a''b'/)

assert.equal(isViewDdl('CREATE TABLE `view` (`id` int)'), false)
assert.equal(isViewDdl("CREATE ALGORITHM=UNDEFINED DEFINER=`a`@`%` SQL SECURITY DEFINER VIEW `db`.`v` AS select 1"), true)
assert.equal(indexFromInfo({ name: 'PRIMARY', columns: 'id', unique: true }, 'p'), null)

console.log('alter sql ok')
