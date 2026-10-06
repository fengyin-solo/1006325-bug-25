<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">维护值班交接记录，围绕交接编号、值班班组、值班日期、班次做登记、筛选与状态流转。门禁安防检查结论由本出入口安防责任岗位提交后同步写入本清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值班交接记录</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'synced-row': isAccessHandover(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据，可先登记值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 门禁检查交接事项：文本由统一生成器产出，与门禁页「写入值班交接清单」逐字一致 -->
    <section class="handover-panel">
      <h3>门禁安防检查交接事项 <small>（来源：门禁安防检查，同步状态 {{ pendingCount > 0 ? `${pendingCount} 条排队中` : '已全部同步' }}）</small></h3>
      <table v-if="accessHandovers.length" class="data-table inner-table">
        <thead><tr><th>交接编号</th><th>值班日期</th><th>交接事项</th></tr></thead>
        <tbody>
          <tr v-for="row in accessHandovers" :key="String(row.id)">
            <td>{{ row['交接编号'] }}</td>
            <td>{{ row['值班日期'] }}</td>
            <td>{{ row['交接事项'] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">暂无门禁安防检查交接事项；断线期间提交的检查恢复后自动补同步。</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条运维值班交接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { pendingSyncCount } from '@/api/access-service'
import { subscribeStore } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ['交接编号', '值班班组', '值班日期', '班次', '值班人员', '交接事项', '交接人员', '交接状态']
const actions = ['发起交接', '确认交接', '登记遗留']
const statuses = ['待交接', '交接中', '已交接', '有遗留']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const pendingCount = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待交接班次', value: rows.value.filter((row) => String(row.status) === '待交接').length },
  { label: '已交接班次', value: rows.value.filter((row) => String(row.status) === '已交接').length },
  { label: '有遗留事项', value: rows.value.filter((row) => String(row.status) === '有遗留').length },
])

function isAccessHandover(row: EntryRow): boolean {
  return String(row['交接编号'] ?? '').startsWith('DUTY-ACCE-')
}

const accessHandovers = computed(() => rows.value.filter(isAccessHandover))

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值班交接记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    pendingCount.value = pendingSyncCount()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

// 门禁侧在另一处提交后，本页随数据变更自动刷新，两处始终同步。
const unsubscribe = subscribeStore((change) => {
  if (change.scope === 'sync' || (change.scope === 'entries' && (change.key === 'duty' || change.key === '*'))) {
    reload()
  }
})

onMounted(reload)
onUnmounted(unsubscribe)
</script>
