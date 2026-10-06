<template>
  <section class="page" data-module="access">
    <header class="page-head">
      <div>
        <h2>门禁安防运维管理</h2>
        <p class="page-desc">
          安防责任岗位按出入口归属：只有本出入口的安防责任岗位能提交检查结论 / 提出整改，
          其它岗位在该入口只读。授权人数、门禁类型随结论一次落库，列表、详情面板与另存清单同读一份台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记安防点位</button>
        <button class="btn" type="button" @click="exportRows">另存门禁安防清单</button>
      </div>
    </header>

    <div class="sync-bar">
      <span class="sync-item">当前岗位：<strong>{{ store.post }}</strong></span>
      <span class="sync-item">
        同步通道：
        <button class="btn mini" type="button" @click="toggleLink">{{ online ? '在线（点击模拟断线）' : '断线（点击恢复）' }}</button>
      </span>
      <span class="sync-item">待同步：{{ queue.length }} 条<template v-if="cursor !== null">，下次从断点序号 {{ cursor }} 续传</template></span>
      <button class="btn mini" type="button" :disabled="!online || queue.length === 0" @click="manualFlush">立即续传</button>
    </div>

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
          <th>操作（按岗位授权）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="pendingOf(Number(row.id))" class="badge warn">有待同步新版</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(Number(row.id))">详情</button>
            <template v-if="canWrite(String(row['所属出入口'] ?? ''))">
              <button class="link" type="button" @click="openSubmit('正常', row)">提交检查</button>
              <button class="link" type="button" @click="openSubmit('正常', row)">判定正常</button>
              <button class="link danger" type="button" @click="openSubmit('需整改', row)">提出整改</button>
            </template>
            <span v-else class="readonly-tag" :title="`记录归属：${row['责任岗位']}`">只读（归属{{ row['责任岗位'] }}）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无门禁安防运维数据</td>
        </tr>
      </tbody>
    </table>

    <section v-if="queue.length" class="queue-panel">
      <h3>同步队列（断线期间暂存，恢复后从第一条没同步成的记录续传，不用上一版值顶替）</h3>
      <ul>
        <li v-for="entry in queue" :key="entry.seq">
          断点序号 {{ entry.seq }} ｜ 点位 {{ entry.pointId }}（{{ entry.entrance }}）｜
          材料批次 {{ entry.materialKey }} 第{{ entry.materialVersion }}版 ｜ 结论「{{ entry.conclusion }}」
        </li>
      </ul>
    </section>

    <section v-if="batches.length" class="queue-panel">
      <h3>上线前台账迁移批次（按检查日期所在月份分批，缺项出处见各记录备注）</h3>
      <ul>
        <li v-for="batch in batches" :key="batch.batch">{{ batch.batch }} ｜ {{ batch.note }}</li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条门禁安防运维记录；列表、详情面板、另存清单同读一份台账</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 详情面板：直接读台账行；有待同步新版时给出明确标识，不与已落库值混排 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>安防点位详情 · {{ detail['点位编号'] }}</h3>
          <button class="btn ghost mini" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detail[column] || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
        </dl>
        <p v-if="detail._pendingChange" class="error-text">{{ detail._pendingLabel }}；刷新台账前此处显示的仍是已落库值</p>
        <p v-else class="ok-text">台账值已为最新，返回列表或刷新页面取值保持一致</p>
      </div>
    </div>

    <!-- 提交检查 / 提出整改：同一表单，按结论预置；授权人数等字段在这一刻一次落库 -->
    <div v-if="form" class="modal-mask" @click.self="closeSubmit">
      <form class="modal" @submit.prevent="confirmSubmit">
        <header class="modal-head">
          <h3>{{ form.conclusion === '需整改' ? '提出整改' : '提交检查结论' }} · {{ form.pointName }}</h3>
          <button class="btn ghost mini" type="button" @click="closeSubmit">关闭</button>
        </header>
        <p class="page-desc">归属出入口「{{ form.entrance }}」，仅其安防责任岗位「{{ ownerPost(form.entrance) }}」可提交。</p>
        <div class="form-grid">
          <label>
            <span>检查结论</span>
            <select v-model="form.conclusion">
              <option value="正常">正常</option>
              <option value="需整改">需整改（同步落入隐患整改清单）</option>
            </select>
          </label>
          <label>
            <span>门禁类型</span>
            <select v-model="form.门禁类型">
              <option>刷卡门禁</option>
              <option>人脸+刷卡</option>
              <option>二维码门禁</option>
            </select>
          </label>
          <label>
            <span>授权人数（一次落库）</span>
            <input v-model.number="form.授权人数" type="number" min="0" step="1" required />
          </label>
          <label>
            <span>监控覆盖</span>
            <select v-model="form.监控覆盖">
              <option>全覆盖</option>
              <option>部分覆盖</option>
              <option>已覆盖</option>
              <option>未覆盖</option>
            </select>
          </label>
          <label>
            <span>检查日期</span>
            <input v-model="form.检查日期" type="date" required />
          </label>
          <label>
            <span>检查人员</span>
            <input v-model="form.检查人员" required />
          </label>
          <label class="wide">
            <span>材料批次（同一批材料反复提交只留最新版，不合并两版）</span>
            <input v-model="form.materialKey" required />
          </label>
          <label v-if="form.conclusion === '需整改'" class="wide">
            <span>整改要求（写入隐患整改清单，并进入其它出入口交接清单）</span>
            <textarea v-model="form.整改要求" rows="2"></textarea>
          </label>
        </div>
        <footer class="modal-foot">
          <button class="btn primary" type="submit">确认提交</button>
          <button class="btn ghost" type="button" @click="closeSubmit">取消</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  defaultMaterialKey,
  flushOutbox,
  getAccessPoint,
  isAccessOnline,
  migrationBatches,
  ownsEntrance,
  pendingQueue,
  responsiblePostOf,
  setAccessOnline,
  submitAccessConclusion,
  todayText,
  type AccessPointView,
  type CheckConclusion,
  type OutboxEntry,
} from '@/api/access-domain'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('access')
const columns = meta.fields
const statuses = ['待检查', '检查中', '状态正常', '需整改']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const online = ref(isAccessOnline())
const queue = ref<OutboxEntry[]>([])
const batches = ref(migrationBatches())
const detail = ref<AccessPointView | null>(null)

type FormState = {
  pointId: number
  pointName: string
  entrance: string
  conclusion: CheckConclusion
  门禁类型: string
  授权人数: number
  监控覆盖: string
  检查日期: string
  检查人员: string
  整改要求: string
  materialKey: string
}
const form = ref<FormState | null>(null)

const stats = computed(() => [
  { label: '待检查点位', value: rows.value.filter((row) => row.status === '待检查' || row.status === '检查中').length },
  { label: '状态正常点位', value: rows.value.filter((row) => row.status === '状态正常').length },
  { label: '需整改点位', value: rows.value.filter((row) => row.status === '需整改').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const cursor = computed(() => (queue.value.length ? queue.value[0].seq : null))

function canWrite(entrance: string): boolean {
  return ownsEntrance(store.post, entrance)
}

function ownerPost(entrance: string): string {
  return responsiblePostOf(entrance)
}

function pendingOf(pointId: number): OutboxEntry | undefined {
  return queue.value.find((entry) => entry.pointId === pointId)
}

function refreshQueue() {
  queue.value = pendingQueue()
  batches.value = migrationBatches()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  // 另存清单直接导出台账物理行，不可能出现第三种取值。
  downloadEntries(meta.key)
  okMessage.value = '清单已按当前台账另存，取值与列表、详情一致'
}

function openCreate() {
  errorMessage.value = '安防点位登记入口尚未接入审批流'
}

function openDetail(pointId: number) {
  detail.value = getAccessPoint(pointId)
}

function closeDetail() {
  detail.value = null
}

function openSubmit(conclusion: CheckConclusion, row: EntryRow) {
  errorMessage.value = ''
  const entrance = String(row['所属出入口'] ?? '')
  if (!canWrite(entrance)) {
    errorMessage.value = `已驳回：该点位归属「${entrance}」的「${ownerPost(entrance)}」，当前岗位「${store.post}」只读`
    return
  }
  const date = todayText()
  form.value = reactive({
    pointId: Number(row.id),
    pointName: String(row['点位编号'] ?? row.id),
    entrance,
    conclusion,
    门禁类型: String(row['门禁类型'] ?? '刷卡门禁'),
    授权人数: Number(row['授权人数'] ?? 0) || 0,
    监控覆盖: String(row['监控覆盖'] ?? '已覆盖'),
    检查日期: date,
    检查人员: store.post,
    整改要求: '',
    materialKey: defaultMaterialKey(Number(row.id), date),
  }) as FormState
}

function closeSubmit() {
  form.value = null
}

function confirmSubmit() {
  if (!form.value) {
    return
  }
  const result = submitAccessConclusion({
    post: store.post,
    pointId: form.value.pointId,
    conclusion: form.value.conclusion,
    门禁类型: form.value.门禁类型,
    授权人数: Number(form.value.授权人数),
    监控覆盖: form.value.监控覆盖,
    检查日期: form.value.检查日期,
    检查人员: form.value.检查人员,
    整改要求: form.value.整改要求,
    materialKey: form.value.materialKey,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    okMessage.value = ''
    return
  }
  okMessage.value = result.message
  errorMessage.value = ''
  form.value = null
  reload()
  refreshQueue()
  if (detail.value) {
    detail.value = getAccessPoint(detail.value.id as number)
  }
}

function toggleLink() {
  const next = !online.value
  setAccessOnline(next)
  online.value = isAccessOnline()
  if (next) {
    okMessage.value = '同步通道已恢复，已从断点序号最小的未同步记录续传完成'
  } else {
    okMessage.value = '已模拟断线：提交只进同步队列，不动台账，恢复后续传'
  }
  reload()
  refreshQueue()
}

function manualFlush() {
  const { flushed } = flushOutbox()
  okMessage.value = flushed > 0 ? `已从断点续传 ${flushed} 条，三处台账已同步` : '没有待同步记录'
  reload()
  refreshQueue()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshQueue()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '门禁安防运维列表读取失败'
  }
}

onMounted(reload)
</script>
