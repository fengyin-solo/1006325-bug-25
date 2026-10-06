<template>
  <section class="page" data-module="access">
    <header class="page-head">
      <div>
        <h2>门禁安防运维管理</h2>
        <p class="page-desc">维护安防点位。提交检查、提出整改仅限本出入口的安防责任岗位，其它岗位入口只读；授权人数、门禁类型一次落库，列表、详情与另存清单同一取值。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">另存门禁安防清单（CSV）</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 同步状态：两个入口（门禁台账、值班交接清单）共用一条持久化队列，断线从断点续传 -->
    <div class="sync-bar">
      <span class="sync-dot" :class="syncState.online ? 'online' : 'offline'"></span>
      <span>同步链路：<strong>{{ syncState.online ? '在线' : '断线中' }}</strong></span>
      <span>待同步：<strong>{{ pendingCount }}</strong> 条{{ pendingCount > 0 ? '（恢复后从队首续传）' : '' }}</span>
      <label class="sync-toggle"><input type="checkbox" :checked="syncState.online" @change="toggleOnline" />在线</label>
      <button class="btn" type="button" :disabled="!syncState.online" @click="reconnectAndDrain">恢复并从断点续传</button>
      <button class="btn ghost" type="button" :disabled="!syncState.online" @click="simulateDrop">模拟下一条同步中断</button>
      <span v-if="syncMessage" class="sync-msg">{{ syncMessage }}</span>
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
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ selected: selectedId === Number(row.id) }">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] === undefined ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="selectPoint(row)">详情</button>
            <button
              v-if="canWrite(row)"
              class="link"
              type="button"
              @click="selectPoint(row)"
            >提交检查结论</button>
            <span v-else class="readonly-tag" :title="ownership(row)">只读 · 非责任岗位</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无门禁安防运维数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条门禁安防运维记录 · 清单取值与台账、详情同源</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情面板：读的就是列表同一个 row 正本；刷新后仍保持选中，值不回退 -->
    <aside v-if="selected" class="detail-panel">
      <div class="detail-head">
        <h3>{{ selected['点位编号'] }} 详情</h3>
        <button class="btn ghost" type="button" @click="selectedId = null">关闭</button>
      </div>
      <dl class="detail-grid">
        <template v-for="column in detailColumns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ selected[column] === '' || selected[column] === undefined ? '—' : selected[column] }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ selected.status }}</dd>
        <dt>记录归属</dt>
        <dd>{{ ownership(selected) }}</dd>
      </dl>
      <p v-if="!canWrite(selected)" class="readonly-note">当前岗位（{{ store.operatorPost }}）对该出入口只读，提交检查与提出整改请由{{ selected['安防责任岗位'] || '责任岗位' }}办理。</p>

      <form v-else class="check-form" @submit.prevent="submitCheck">
        <h4>提交检查结论（同点位同日期反复提交只算一次，只留最新版）</h4>
        <label>检查日期
          <input v-model="form.checkDate" type="date" required />
        </label>
        <label>结论
          <select v-model="form.conclusion">
            <option value="正常">判定正常</option>
            <option value="整改">提出整改</option>
          </select>
        </label>
        <label class="wide">问题描述（提出整改必填，将写入隐患整改清单）
          <textarea v-model="form.issue" rows="2" :disabled="form.conclusion !== '整改'"></textarea>
        </label>
        <div class="form-actions">
          <button class="btn primary" type="submit">提交结论并同步台账</button>
          <span v-if="formMessage" :class="formOk ? 'ok-text' : 'error-text'">{{ formMessage }}</span>
        </div>
      </form>

      <div class="check-history">
        <h4>该点位检查结论（最新版）</h4>
        <ul v-if="pointChecks.length">
          <li v-for="record in pointChecks" :key="record.key">
            {{ record.checkDate }} · {{ record.conclusion === '正常' ? '判定正常' : '提出整改' }}
            <span v-if="record.issue">：{{ record.issue }}</span>
            · {{ record.checker }}（{{ record.checkerPost }}） · v{{ record.version }}
          </li>
        </ul>
        <p v-else class="muted">尚无检查结论。</p>
      </div>
    </aside>

    <!-- 写进值班交接清单的条目：与值班模块逐字一致 -->
    <section class="handover-panel">
      <h3>写入值班交接清单的门禁检查事项 <small>（值班清单与台账同步更新，两处内容一致）</small></h3>
      <table v-if="handovers.length" class="data-table inner-table">
        <thead><tr><th>交接编号</th><th>值班日期</th><th>交接事项</th></tr></thead>
        <tbody>
          <tr v-for="item in handovers" :key="item.code">
            <td>{{ item.code }}</td>
            <td>{{ item.date }}</td>
            <td>{{ item.text }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">暂无同步到交接清单的检查事项。</p>
    </section>

    <!-- 上线前台账迁移：按月份分批，缺项出处都写在备注里 -->
    <section v-if="migrationLog" class="migration-panel">
      <details>
        <summary>上线前台账迁移（v{{ migrationLog.version }}，共 {{ migrationBatches.length }} 个月份批次 / {{ migrationLog.entries.length }} 条）</summary>
        <p class="muted">{{ migrationLog.rule }}</p>
        <div v-for="batch in migrationBatches" :key="batch.batch" class="batch-block">
          <strong>{{ batch.batch === '月份不详' ? '月份不详（兜底批）' : batch.batch + ' 批次' }}</strong>：{{ batch.pointCodes.join('、') }}
        </div>
        <ul class="migration-list">
          <li v-for="entry in migrationEntries" :key="entry.id">
            {{ entry.pointCode }}（{{ entry.batch }}）：{{ entry.note }}
          </li>
        </ul>
        <p v-if="migrationLog.warnings.length" class="error-text">
          告警：{{ migrationLog.warnings.join('；') }}
        </p>
      </details>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  accessHandoverEntries,
  canSubmitForEntrance,
  drainSyncQueue,
  listChecksOfPoint,
  pendingSyncCount,
  readSyncState,
  setSyncState,
  submitAccessCheck,
} from '@/api/access-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { getMigrationLog } from '@/data/migrations'
import { ownershipText } from '@/data/access-domain'
import {
  CHECKS_KEY,
  subscribeStore,
  SYNC_QUEUE_KEY,
  SYNC_STATE_KEY,
} from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('access')
const store = useSessionStore()
const columns = ['点位编号', '所属出入口', '门禁类型', '监控覆盖', '授权人数', '检查日期', '检查人员', '安防状态', '安防责任岗位']
const detailColumns = ['点位编号', '所属出入口', '门禁类型', '监控覆盖', '授权人数', '检查日期', '检查人员', '安防状态', '安防责任岗位', '备注']
const statuses = ['待检查', '检查中', '状态正常', '需整改']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const formMessage = ref('')
const formOk = ref(false)
const syncMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedId = ref<number | null>(null)
const pendingCount = ref(0)
const syncState = ref(readSyncState())

const form = ref({ checkDate: '2026-10-06', conclusion: '正常' as '正常' | '整改', issue: '' })

const selected = computed(() =>
  selectedId.value === null ? null : rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)
const pointChecks = computed(() => (selected.value ? listChecksOfPoint(Number(selected.value.id)) : []))
const handovers = ref(accessHandoverEntries())
const migrationLog = ref(getMigrationLog(1))
const migrationEntries = computed(() => migrationLog.value?.entries ?? [])
const migrationBatches = computed(() => migrationLog.value?.batches ?? [])

const stats = computed(() => [
  { label: '待检查点位', value: rows.value.filter((row) => String(row.status) === '待检查').length },
  { label: '状态正常点位', value: rows.value.filter((row) => String(row.status) === '状态正常').length },
  { label: '需整改点位', value: rows.value.filter((row) => String(row.status) === '需整改').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
function canWrite(row: EntryRow): boolean {
  return canSubmitForEntrance(store.operatorPost, String(row['所属出入口'] ?? ''))
}

function ownership(row: EntryRow): string {
  return ownershipText(String(row['所属出入口'] ?? ''))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function selectPoint(row: EntryRow) {
  selectedId.value = Number(row.id)
  formMessage.value = ''
  form.value = { checkDate: String(row['检查日期'] ?? '2026-10-06'), conclusion: '正常', issue: '' }
}

function submitCheck() {
  if (!selected.value) {
    return
  }
  formOk.value = false
  const result = submitAccessCheck({
    operator: { name: store.operator, post: store.operatorPost },
    pointId: Number(selected.value.id),
    checkDate: form.value.checkDate,
    conclusion: form.value.conclusion,
    issue: form.value.issue,
  })
  formMessage.value = result.message
  formOk.value = result.ok
  if (result.ok) {
    form.value.issue = ''
  }
  reload()
}

function toggleOnline(event: Event) {
  const online = (event.target as HTMLInputElement).checked
  setSyncState({ online })
  syncState.value = readSyncState()
  if (online) {
    const result = drainSyncQueue()
    syncMessage.value = result.applied > 0 ? `已续传 ${result.applied} 条` : '链路恢复，无待同步项'
  } else {
    syncMessage.value = '已断线，新提交将排队，恢复后从队首继续'
  }
  refreshSync()
}

function reconnectAndDrain() {
  setSyncState({ online: true })
  const result = drainSyncQueue()
  syncState.value = readSyncState()
  syncMessage.value = result.failed
    ? `在「${result.failed.type} / ${result.failed.checkKey}」处仍失败：${result.failed.lastError}`
    : `同步完成，本次下发 ${result.applied} 条，剩余 ${result.remaining} 条`
  refreshSync()
}

function simulateDrop() {
  setSyncState({ failNextOne: true })
  const result = drainSyncQueue()
  syncState.value = readSyncState()
  syncMessage.value = result.failed
    ? `已模拟中断：${result.failed.checkKey}（${result.failed.type}）未同步成功，下次从本条继续`
    : '当前没有可中断的待同步任务'
  refreshSync()
}

function refreshSync() {
  pendingCount.value = pendingSyncCount()
  syncState.value = readSyncState()
  handovers.value = accessHandoverEntries()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 选中行被删除或重置时兜底；刷新后按 id 重新选中，详情值与列表同源不回退。
    if (selectedId.value !== null && !rows.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '门禁安防运维列表读取失败'
  }
  migrationLog.value = getMigrationLog(1)
  refreshSync()
}

const unsubscribe = subscribeStore((change) => {
  if (
    change.scope === 'sync' ||
    (change.scope === 'collection' && change.key === CHECKS_KEY) ||
    (change.scope === 'entries' && (change.key === 'access' || change.key === 'hazard' || change.key === 'duty' || change.key === '*'))
  ) {
    reload()
  }
})

onMounted(reload)
onUnmounted(unsubscribe)
</script>
