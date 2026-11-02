<script setup lang="ts">
/**
 * 连接管理弹窗：连接配置 CRUD + 测试连接。
 * 密码编辑时留空表示保持不变；保存后经 safeStorage 加密落盘。
 */
import { reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NSpin,
  useDialog,
  useMessage
} from 'naive-ui'
import { useConnectionStore } from '../../stores/connection'
import { useUiStore } from '../../stores/ui'
import { api } from '../../services/api'
import type { TestConnectionResult } from '../../types'

const conn = useConnectionStore()
const ui = useUiStore()
const message = useMessage()
const dialog = useDialog()

interface FormModel {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  defaultDatabase: string
  charset: string
  timeout: number
  visibleDatabases: string[] | null
}

const emptyForm = (): FormModel => ({
  id: '',
  name: '',
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  password: '',
  defaultDatabase: '',
  charset: 'utf8mb4',
  timeout: 10,
  visibleDatabases: null
})

const form = reactive<FormModel>(emptyForm())
const saving = ref(false)
const testing = ref(false)
const testResult = ref<TestConnectionResult | null>(null)
const pane = ref<'general' | 'ssl' | 'advanced'>('general')
const savePassword = ref(true)
const allDatabases = ref<string[]>([])
const checkedDbs = ref<string[]>([])
const dbLoading = ref(false)
const dbError = ref('')

watch(
  () => ui.connectionManagerVisible,
  (show) => {
    if (!show) return
    pane.value = 'general'
    savePassword.value = true
    testResult.value = null
    if (ui.connectionEditId) selectProfile(ui.connectionEditId)
    else newProfile()
    void loadDatabases()
  }
)

const charsetOptions = ['utf8mb4', 'utf8', 'gbk', 'latin1'].map((c) => ({ label: c, value: c }))

function selectProfile(id: string): void {
  const p = conn.profiles.find((x) => x.id === id)
  if (!p) return
  Object.assign(form, { ...p, password: '', visibleDatabases: p.visibleDatabases ?? null })
  testResult.value = null
}

function newProfile(): void {
  Object.assign(form, emptyForm())
  testResult.value = null
  allDatabases.value = []
  checkedDbs.value = []
  dbError.value = ''
}

function profilePayload() {
  return {
    id: form.id,
    name: form.name.trim(),
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    defaultDatabase: form.defaultDatabase.trim(),
    charset: form.charset,
    timeout: form.timeout,
    visibleDatabases: form.visibleDatabases
  }
}

/** 拉取实例上的全部库。已打开的连接直接用内存列表，避免再连一次。 */
async function loadDatabases(): Promise<void> {
  allDatabases.value = []
  checkedDbs.value = []
  dbError.value = ''
  if (!form.host.trim() || !form.username.trim()) return
  dbLoading.value = true
  try {
    const all =
      conn.connected && conn.activeId === form.id && conn.databases.length > 0
        ? conn.databases
        : await api().connections.databases(profilePayload(), passwordArg())
    allDatabases.value = all
    const saved = form.visibleDatabases
    checkedDbs.value = saved ? all.filter((d) => saved.includes(d)) : [...all]
  } catch (e) {
    dbError.value = String(e)
  } finally {
    dbLoading.value = false
  }
}

/** 密码策略：输入了新密码则使用；编辑且留空则保持原密码（传 undefined） */
function passwordArg(): string | undefined {
  if (!savePassword.value) return ''
  if (form.password !== '') return form.password
  return form.id ? undefined : ''
}

function validate(): string | null {
  if (!form.name.trim()) return '请填写连接名称'
  if (!form.host.trim()) return '请填写主机地址'
  if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) return '端口非法'
  if (!form.username.trim()) return '请填写用户名'
  return null
}

async function save(): Promise<void> {
  const err = validate()
  if (err) {
    message.warning(err)
    return
  }
  saving.value = true
  try {
    const visibleDatabases =
      allDatabases.value.length > 0 && checkedDbs.value.length === allDatabases.value.length
        ? null
        : allDatabases.value.length > 0
          ? [...checkedDbs.value]
          : form.visibleDatabases
    const saved = await api().connections.save(
      { ...profilePayload(), visibleDatabases },
      passwordArg()
    )
    form.id = saved.id
    await conn.refresh()
    if (conn.connected && conn.activeId === saved.id && !conn.shownDatabases.includes(conn.currentDb)) {
      conn.currentDb = conn.shownDatabases[0] ?? ''
    }
    message.success('已保存')
    ui.connectionManagerVisible = false
  } catch (e) {
    message.error(`保存失败：${String(e)}`)
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  const err = validate()
  if (err) {
    message.warning(err)
    return
  }
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await api().connections.test(
      {
        ...profilePayload()
      },
      passwordArg()
    )
  } finally {
    testing.value = false
  }
}

function remove(): void {
  if (!form.id) return
  dialog.warning({
    title: '删除连接',
    content: `确认删除连接「${form.name}」？该操作不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await api().connections.remove(form.id)
      await conn.refresh()
      newProfile()
      message.success('已删除')
    }
  })
}
</script>

<template>
  <NModal
    v-model:show="ui.connectionManagerVisible"
    preset="card"
    :title="form.id ? '编辑连接' : '新建连接'"
    style="width: 640px"
    :bordered="false"
  >
    <div class="dialog-body">
      <div class="dialog-nav">
        <button class="nav-item" :class="{ on: pane === 'general' }" @click="pane = 'general'">常规</button>
        <button class="nav-item" :class="{ on: pane === 'ssl' }" @click="pane = 'ssl'">SSL</button>
        <button class="nav-item" :class="{ on: pane === 'advanced' }" @click="pane = 'advanced'">高级</button>
      </div>
      <div class="dialog-form">
        <NForm v-show="pane === 'general'" label-placement="left" label-width="80" size="small">
          <NFormItem label="连接名称"><NInput v-model:value="form.name" placeholder="本地 MySQL" /></NFormItem>
          <NFormItem label="主机地址"><NInput v-model:value="form.host" placeholder="127.0.0.1" /></NFormItem>
          <NFormItem label="端口"><NInputNumber v-model:value="form.port" :min="1" :max="65535" style="width: 100%" /></NFormItem>
          <NFormItem label="用户名"><NInput v-model:value="form.username" /></NFormItem>
          <NFormItem label="密码">
            <NInput
              v-model:value="form.password"
              type="password"
              show-password-on="click"
              :placeholder="form.id ? '留空表示保持不变' : ''"
            />
          </NFormItem>
          <NFormItem label=" "><NCheckbox v-model:checked="savePassword">保存密码</NCheckbox></NFormItem>
        </NForm>
        <div v-show="pane === 'ssl'" class="ssl-tip">当前版本通过明文连接本机或内网 MySQL，不启用 SSL。</div>
        <NForm v-show="pane === 'advanced'" label-placement="left" label-width="80" size="small">
          <NFormItem label="默认库"><NInput v-model:value="form.defaultDatabase" placeholder="可选" /></NFormItem>
          <NFormItem label="显示的库">
            <div class="db-filter">
              <NSpin v-if="dbLoading" size="small" />
              <div v-else-if="dbError" class="db-error">{{ dbError }}</div>
              <template v-else-if="allDatabases.length">
                <div class="db-actions">
                  <NButton text size="tiny" type="primary" @click="checkedDbs = [...allDatabases]">全选</NButton>
                  <NButton text size="tiny" @click="checkedDbs = []">全不选</NButton>
                  <span class="db-count">已选 {{ checkedDbs.length }} / {{ allDatabases.length }}</span>
                </div>
                <NCheckboxGroup v-model:value="checkedDbs" class="db-checks">
                  <NCheckbox v-for="db in allDatabases" :key="db" :value="db" :label="db" />
                </NCheckboxGroup>
              </template>
              <span v-else class="db-error">填写主机和账号后可勾选要保留的库</span>
            </div>
          </NFormItem>
          <NFormItem label="字符集"><NSelect v-model:value="form.charset" :options="charsetOptions" /></NFormItem>
          <NFormItem label="超时(秒)"><NInputNumber v-model:value="form.timeout" :min="1" :max="120" style="width: 100%" /></NFormItem>
        </NForm>

        <div class="test-block">
          <div class="test-label">测试连接</div>
          <NButton size="small" :loading="testing" @click="test">测试连接</NButton>
          <NAlert v-if="testResult" :type="testResult.ok ? 'success' : 'error'" :bordered="false" style="margin-top: 8px">
            <template v-if="testResult.ok">连接成功！ MySQL {{ testResult.version }}</template>
            <template v-else>{{ testResult.error }}</template>
          </NAlert>
        </div>
      </div>
    </div>
    <template #footer>
      <NSpace justify="end">
        <NButton v-if="form.id" size="small" quaternary type="error" @click="remove">删除</NButton>
        <NButton size="small" @click="ui.connectionManagerVisible = false">取消</NButton>
        <NButton size="small" type="primary" :loading="saving" @click="save">确定</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.dialog-body {
  display: flex;
  min-height: 340px;
}

.dialog-nav {
  width: 120px;
  flex-shrink: 0;
  border-right: 1px solid #eef0f3;
  padding: 4px 0;
}

.nav-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 10px 16px;
  cursor: pointer;
  color: #434343;
  border-left: 3px solid transparent;
}

.nav-item.on {
  background: #e8f1ff;
  color: #2f6bff;
  border-left-color: #2f6bff;
}

.dialog-form {
  flex: 1;
  padding-left: 20px;
}

.ssl-tip {
  color: #8c8c8c;
  font-size: 13px;
  padding: 12px 0 24px;
}

.test-block {
  border-top: 1px solid #f2f3f5;
  margin-top: 8px;
  padding-top: 12px;
}

.test-label {
  font-size: 13px;
  margin-bottom: 8px;
  color: #434343;
}

.db-filter {
  width: 100%;
}

.db-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.db-count {
  color: #a8abb2;
  font-size: 12px;
}

.db-checks {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  padding: 6px 8px;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
}

.db-error {
  color: #a8abb2;
  font-size: 12px;
}
</style>
