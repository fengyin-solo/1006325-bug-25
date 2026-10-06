import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 门禁安防领域服务：本出入口的安防责任岗位才能写入；检查结论一次落库，
// 列表 / 详情 / 导出清单与隐患整改、运维值班交接两处台账同读同写；
// 所有跨台账写入先进同步队列（outbox），断线后从第一条没同步成的记录续传。

// ---------------------------------------------------------------------------
// 出入口与责任岗位登记：记录归属（安防责任岗位）只认这张表，不看提交人自己填什么。
// ---------------------------------------------------------------------------

export type EntranceInfo = {
  name: string
  responsiblePost: string
  legacyName?: string
}

export const ENTRANCES: EntranceInfo[] = [
  { name: '1号综合出入口', responsiblePost: '一号口安防值班岗' },
  { name: '3号通风出入口', responsiblePost: '三号口安防值班岗' },
  { name: '7号检修出入口', responsiblePost: '七号口安防值班岗' },
]

export const READ_ONLY_POST = '外岗代班（只读）'
export const POST_OPTIONS: string[] = [
  ...ENTRANCES.map((item) => item.responsiblePost),
  READ_ONLY_POST,
]

const ENTRANCE_BY_NAME = new Map(ENTRANCES.map((item) => [item.name, item]))

export function responsiblePostOf(entrance: string): string {
  return ENTRANCE_BY_NAME.get(entrance)?.responsiblePost ?? ''
}

export function ownsEntrance(post: string, entrance: string): boolean {
  return post === responsiblePostOf(entrance)
}

// ---------------------------------------------------------------------------
// 检查结论口径：结论标签、点位状态、是否异常、是否生成隐患，全部只从这里取。
// ---------------------------------------------------------------------------

export type CheckConclusion = '正常' | '需整改'

type ConclusionSpec = {
  rowStatus: string
  abnormal: boolean
  hazardLevel: string
}

const CONCLUSION_SPEC: Record<CheckConclusion, ConclusionSpec> = {
  正常: { rowStatus: '状态正常', abnormal: false, hazardLevel: '' },
  需整改: { rowStatus: '需整改', abnormal: true, hazardLevel: '一般' },
}

export type ConclusionInput = {
  post: string
  pointId: number
  conclusion: CheckConclusion
  门禁类型: string
  授权人数: number
  监控覆盖: string
  检查日期: string
  检查人员: string
  整改要求: string
  materialKey: string
}

export type SubmitResult = {
  ok: boolean
  message: string
  synced: boolean
}

// ---------------------------------------------------------------------------
// 领域状态（独立 localStorage）：同步队列、号段、材料版本、存量迁移批次都在这里。
// ---------------------------------------------------------------------------

const STATE_KEY = 'urban-utility-tunnel:access-state'
const SCHEMA_VERSION = 2

export type OutboxEntry = {
  seq: number
  materialKey: string
  materialVersion: number
  pointId: number
  entrance: string
  post: string
  operator: string
  submittedAt: string
  synced: boolean
  syncedAt: string
  superseded: boolean
  conclusion: CheckConclusion
  payload: ConclusionInput
}

export type MigrationBatch = {
  batch: string
  month: string
  count: number
  note: string
}

type AccessDomainState = {
  schemaVersion: number
  outbox: OutboxEntry[]
  nextSeq: number
  nextHazardSeq: number
  nextDutySeq: number
  materialVersions: Record<string, number>
  migratedBatchKeys: string[]
  migrationBatches: MigrationBatch[]
}

function storageRef(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  const globalStorage = (globalThis as unknown as { localStorage?: Storage }).localStorage
  return globalStorage ?? null
}

function initialState(): AccessDomainState {
  return {
    schemaVersion: SCHEMA_VERSION,
    outbox: [],
    nextSeq: 1,
    nextHazardSeq: 1,
    nextDutySeq: 1,
    materialVersions: {},
    migratedBatchKeys: [],
    migrationBatches: [],
  }
}

function loadState(): AccessDomainState {
  const storage = storageRef()
  if (!storage) {
    return initialState()
  }
  const raw = storage.getItem(STATE_KEY)
  if (!raw) {
    const fresh = initialState()
    storage.setItem(STATE_KEY, JSON.stringify(fresh))
    return fresh
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AccessDomainState>
    return { ...initialState(), ...parsed }
  } catch {
    const fresh = initialState()
    storage.setItem(STATE_KEY, JSON.stringify(fresh))
    return fresh
  }
}

let stateCache: AccessDomainState | null = null

function state(): AccessDomainState {
  if (stateCache === null) {
    stateCache = loadState()
  }
  return stateCache
}

function persistState(): void {
  const storage = storageRef()
  if (storage) {
    storage.setItem(STATE_KEY, JSON.stringify(state()))
  }
}

// 测试 / 重置入口：清掉领域状态，不碰业务台账。
export function resetAccessDomain(): void {
  stateCache = initialState()
  persistState()
}

// 模拟网络：默认在线；断线期间只入队不落台账，恢复后按 seq 顺序补推。
let online = true
export function setAccessOnline(value: boolean): void {
  if (value && !online) {
    online = true
    void flushOutbox()
  } else {
    online = value
  }
}
export function isAccessOnline(): boolean {
  return online
}

// ---------------------------------------------------------------------------
// 结论文本：门禁台账、值班交接清单里出现的同一份结论，永远由同一函数生成。
// ---------------------------------------------------------------------------

function conclusionText(entry: OutboxEntry): string {
  const p = entry.payload
  const tail = entry.conclusion === '需整改' && p.整改要求 ? `；整改要求：${p.整改要求}` : ''
  return `出入口${entry.entrance}点位${p.pointId}检查结论：${entry.conclusion}（门禁类型：${p.门禁类型}，授权人数：${p.授权人数}，检查日期：${p.检查日期}，材料批次：${entry.materialKey}）${tail}`
}

// ---------------------------------------------------------------------------
// 同步队列：applyEntry 是跨台账写入的唯一出口，幂等，任何一处已写成都不会再写第二次。
// ---------------------------------------------------------------------------

function applyAccessRow(entry: OutboxEntry, rows: EntryRow[]): void {
  const spec = CONCLUSION_SPEC[entry.conclusion]
  const p = entry.payload
  const index = rows.findIndex((row) => Number(row.id) === p.pointId)
  if (index < 0) {
    return
  }
  rows[index] = {
    ...rows[index],
    status: spec.rowStatus,
    pending: spec.rowStatus !== '状态正常',
    abnormal: spec.abnormal,
    门禁类型: p.门禁类型,
    授权人数: p.授权人数,
    监控覆盖: p.监控覆盖,
    检查日期: p.检查日期,
    检查人员: p.检查人员,
    安防状态: spec.rowStatus,
    责任岗位: responsiblePostOf(entry.entrance),
    最近检查结论: entry.conclusion,
    最近材料批次: entry.materialKey,
    结论时间: entry.submittedAt,
  }
}

function nextHazardId(rows: EntryRow[]): number {
  // 号段必须接在隐患台账现有 id 之后，否则会覆盖既有记录。
  if (state().nextHazardSeq === 1 && rows.length > 0) {
    state().nextHazardSeq = Math.max(...rows.map((row) => Number(row.id))) + 1
  }
  return state().nextHazardSeq++
}

function applyHazard(entry: OutboxEntry, rows: EntryRow[]): void {
  if (entry.conclusion !== '需整改') {
    return
  }
  const p = entry.payload
  const spec = CONCLUSION_SPEC.需整改
  const existing = rows.find((row) => String(row['来源材料批次'] ?? '') === entry.materialKey)
  if (existing) {
    const index = rows.findIndex((row) => row === existing)
    rows[index] = {
      ...rows[index],
      整改措施: `出入口${entry.entrance}门禁隐患整改（材料批次 ${entry.materialKey}，第${entry.materialVersion}版）：${p.整改要求 || '按门禁安防检查要求整改'}`,
      隐患等级: spec.hazardLevel,
      责任人员: p.检查人员,
      整改期限: p.检查日期,
      整改状态: '整改中',
      status: '整改中',
      pending: true,
      abnormal: true,
      来源材料批次: entry.materialKey,
      来源点位: p.pointId,
    }
    return
  }
  const id = nextHazardId(rows)
  rows.push({
    id,
    status: '整改中',
    pending: true,
    abnormal: true,
    隐患编号: `HAZA-ACCE-${String(id).padStart(4, '0')}`,
    隐患部位: `出入口${entry.entrance} / 点位${p.pointId}`,
    隐患等级: spec.hazardLevel,
    整改措施: `出入口${entry.entrance}门禁隐患整改（材料批次 ${entry.materialKey}，第${entry.materialVersion}版）：${p.整改要求 || '按门禁安防检查结论整改'}`,
    责任人员: p.检查人员,
    发现日期: p.检查日期,
    整改期限: p.检查日期,
    整改状态: '整改中',
    来源材料批次: entry.materialKey,
    来源点位: p.pointId,
  })
}

function nextDutyId(rows: EntryRow[]): number {
  // 接在值班台账现有 id 之后，避免覆盖既有交接记录。
  if (state().nextDutySeq === 1 && rows.length > 0) {
    state().nextDutySeq = Math.max(...rows.map((row) => Number(row.id))) + 1
  }
  return state().nextDutySeq++
}

function dutyLinkKey(entry: OutboxEntry, entrance: string): string {
  return `ACCE#${entry.pointId}#${entrance}`
}

function applyDuty(entry: OutboxEntry, rows: EntryRow[]): void {
  const text = conclusionText(entry)
  for (const entrance of ENTRANCES.map((item) => nameOf(item)).filter(
    (name) => name !== entry.entrance,
  )) {
    const linkKey = dutyLinkKey(entry, entrance)
    const index = rows.findIndex((row) => String(row['__accessLinkKey'] ?? '') === linkKey)
    const 班次 = '白班 08:00-20:00'
    if (index >= 0) {
      rows[index] = {
        ...rows[index],
        交接事项: text,
        值班日期: entry.payload.检查日期,
        交接状态: '已交接',
        status: '已交接',
        pending: false,
        abnormal: false,
      }
      continue
    }
    const id = nextDutyId(rows)
    rows.push({
      id,
      status: '已交接',
      pending: false,
      abnormal: false,
      交接编号: `DUTY-ACCE-${String(id).padStart(4, '0')}`,
      值班班组: `${entrance}值班组`,
      值班日期: entry.payload.检查日期,
      班次,
      值班人员: entrance,
      交接事项: text,
      交接人员: entry.post,
      交接状态: '已交接',
      __accessLinkKey: linkKey,
    })
  }
}

function nameOf(item: EntranceInfo): string {
  return item.name
}

function applyEntry(entry: OutboxEntry): void {
  // 三处台账在一次同步里连续落库；全部成功才把 outbox 条目标记 synced。
  const accessRows = listRows('access')
  applyAccessRow(entry, accessRows)
  saveRows('access', accessRows)

  const hazardRows = listRows('hazard')
  applyHazard(entry, hazardRows)
  saveRows('hazard', hazardRows)

  const dutyRows = listRows('duty')
  applyDuty(entry, dutyRows)
  saveRows('duty', dutyRows)

  entry.synced = true
  entry.syncedAt = new Date().toISOString()
  persistState()
}

// 断点续传：永远从第一条既没同步成、也没被新版顶替的记录（seq 最小）接着走，
// 不读取、不重放上一次同步时的值——落库值取自该条 outbox 自己携带的 payload。
export function flushOutbox(): { flushed: number } {
  const s = state()
  let flushed = 0
  for (const entry of [...s.outbox].sort((a, b) => a.seq - b.seq)) {
    if (entry.synced || entry.superseded) {
      continue
    }
    applyEntry(entry)
    flushed += 1
  }
  return { flushed }
}

export function pendingQueue(): OutboxEntry[] {
  return state()
    .outbox.filter((entry) => !entry.synced && !entry.superseded)
    .sort((a, b) => a.seq - b.seq)
}

export function resumeCursor(): number | null {
  const first = pendingQueue()[0]
  return first ? first.seq : null
}

// ---------------------------------------------------------------------------
// 提交入口：授权收口 + 同材料幂等（只留最新版）+ 在线即同步 / 断线先排队。
// ---------------------------------------------------------------------------

export function submitAccessConclusion(input: ConclusionInput): SubmitResult {
  const point = listRows('access').find((row) => Number(row.id) === input.pointId)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${input.pointId} 的安防点位`, synced: false }
  }
  const entrance = String(point['所属出入口'] ?? '')
  const ownerPost = responsiblePostOf(entrance)
  // 授权：提交检查 / 提出整改只允许本出入口安防责任岗位；其它岗位在该入口只读。
  if (!ownerPost || input.post !== ownerPost) {
    return {
      ok: false,
      message: `已驳回：点位${input.pointId}归属「${entrance}」，检查结论只接受其安防责任岗位「${ownerPost || '未登记'}」提交；当前岗位「${input.post}」在该入口为只读，记录归属保持不变`,
      synced: false,
    }
  }
  if (!Number.isFinite(input.授权人数) || input.授权人数 < 0) {
    return { ok: false, message: '授权人数需为不小于 0 的整数，本次提交未入库', synced: false }
  }
  if (!input.门禁类型.trim() || !input.检查日期.trim()) {
    return { ok: false, message: '门禁类型与检查日期为必填，本次提交未入库', synced: false }
  }

  const s = state()
  // 同一批材料再报一遍：版本号 +1，旧排队记录作废（superseded），两版绝不并写。
  const previousVersion = s.materialVersions[input.materialKey] ?? 0
  const version = previousVersion + 1
  s.materialVersions[input.materialKey] = version

  for (const old of s.outbox) {
    if (!old.synced && !old.superseded && old.materialKey === input.materialKey) {
      // 同批材料的旧版只作废弃留痕，不进同步队列，绝不允许在断点续传时重放旧值。
      old.superseded = true
    }
  }

  const seq = s.nextSeq++
  const entry: OutboxEntry = {
    seq,
    materialKey: input.materialKey,
    materialVersion: version,
    pointId: input.pointId,
    entrance,
    post: input.post,
    operator: input.检查人员,
    submittedAt: new Date().toISOString(),
    synced: false,
    syncedAt: '',
    superseded: false,
    conclusion: input.conclusion,
    payload: { ...input, 授权人数: Math.trunc(input.授权人数) },
  }
  s.outbox.push(entry)
  persistState()

  if (online) {
    flushOutbox()
  }
  const syncedNow = online
  const verb = input.conclusion === '需整改' ? '提出整改' : '提交检查结论'
  const again = version > 1 ? `（同批材料第${version}次提交，仅保留第${version}版，旧版不并入台账）` : ''
  return {
    ok: true,
    message: syncedNow
      ? `点位${input.pointId}${verb}已落库，列表/详情/导出清单与隐患整改、值班交接两处台账已同步${again}`
      : `点位${input.pointId}${verb}已受理并进入同步队列（断点序号 ${seq}）；当前断线，恢复后从该条续传，不会以上一版值顶替${again}`,
    synced: syncedNow,
  }
}

// ---------------------------------------------------------------------------
// 存量迁移：上线前（v1 骨架数据）按检查日期所在月份分批迁到 v2 口径。
// 缺项只补不抹，并在备注里写清出处；只跑一次，按月登记批次。
// ---------------------------------------------------------------------------

const PLACEHOLDER_PREFIX = '门禁安防运维样例'

function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true
  }
  const text = String(value).trim()
  return text === '' || text.startsWith(PLACEHOLDER_PREFIX)
}

function monthOf(date: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(date)
  return match ? `${match[1]}-${match[2]}` : '日期不详'
}

// 授权人数历史基准（依据：门禁授权花名册历次扩编记录）：
// 2025 年及更早按 6 人旧编制，2026 上半年 12 人，2026-07 起 16 人。
function baselineHeads(date: string): { heads: number; source: string } {
  if (/^202[0-5]/.test(date) || date === '') {
    return { heads: 6, source: '2025年及更早授权花名册旧编制（6人）' }
  }
  if (date < '2026-07') {
    return { heads: 12, source: '2026年上半年授权花名册（12人）' }
  }
  return { heads: 16, source: '2026年7月扩编后授权花名册（16人）' }
}

export function migrateAccessLedger(): MigrationBatch[] {
  const s = state()
  const rows = listRows('access')
  if (rows.length === 0) {
    return s.migrationBatches
  }
  // 只有上线前的老台账（没有责任岗位归属）才迁移；v2 数据直接跳过，保证幂等。
  const legacyRows = rows.filter((row) => isMissingValue(row['责任岗位']))
  if (legacyRows.length === 0) {
    return s.migrationBatches
  }
  const buckets = new Map<string, EntryRow[]>()
  for (const row of legacyRows) {
    const month = monthOf(String(row['检查日期'] ?? ''))
    const bucket = buckets.get(month)
    if (bucket) {
      bucket.push(row)
    } else {
      buckets.set(month, [row])
    }
  }

  const created: MigrationBatch[] = []
  for (const [month, bucket] of [...buckets.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const batch = s.migratedBatchKeys.includes(month) ? null : `MIGR-${month.replace('-', '')}`
    for (const row of bucket) {
      const remarks: string[] = []
      const date = String(row['检查日期'] ?? '')

      if (isMissingValue(row['授权人数'])) {
        const { heads, source } = baselineHeads(date)
        row['授权人数'] = heads
        remarks.push(`授权人数按检查日期${date || '（日期不详）'}回填，出处：${source}`)
      } else {
        row['授权人数'] = Number(row['授权人数'])
      }

      if (isMissingValue(row['门禁类型'])) {
        row['门禁类型'] = '刷卡门禁'
        remarks.push('门禁类型缺失，按上线前主流卡制统一补为「刷卡门禁」，出处：存量点位设备普查底表')
      }
      if (isMissingValue(row['监控覆盖'])) {
        row['监控覆盖'] = '已覆盖'
        remarks.push('监控覆盖缺失，按普查底表补为「已覆盖」')
      }
      if (isMissingValue(row['检查人员'])) {
        row['检查人员'] = responsiblePostOf(String(row['所属出入口'] ?? '')) || '安防责任岗位待确认'
        remarks.push('检查人员缺失，按出入口责任岗位归属补录，出处：安防岗位责任划分表')
      }
      if (isMissingValue(row['安防状态'])) {
        row['安防状态'] = String(row.status ?? '待检查')
        remarks.push('安防状态与点位状态口径对齐，出处：本次上线迁移')
      }

      row['责任岗位'] = responsiblePostOf(String(row['所属出入口'] ?? ''))
      const oldRemark = String(row['备注'] ?? '')
      if (remarks.length > 0) {
        const tag = batch ? `[迁移批次${batch}] ` : ''
        row['备注'] = (oldRemark && !oldRemark.startsWith(PLACEHOLDER_PREFIX) ? `${oldRemark}；` : '') + tag + remarks.join('；')
      } else if (!oldRemark || oldRemark.startsWith(PLACEHOLDER_PREFIX)) {
        row['备注'] = batch ? `[迁移批次${batch}] 存量记录，字段齐全，口径按月批量对齐` : ''
      }
    }
    if (batch) {
      const item: MigrationBatch = {
        batch,
        month,
        count: bucket.length,
        note: `上线前台账按月份分批迁移：${month} 共 ${bucket.length} 条，缺项已在备注写明出处`,
      }
      s.migrationBatches.push(item)
      s.migratedBatchKeys.push(month)
      created.push(item)
    }
  }

  saveRows('access', rows)
  persistState()
  return created
}

export function migrationBatches(): MigrationBatch[] {
  return state().migrationBatches
}

// 启动引导：老台账按月迁移；v2 种子则从备注里的批次标签还原批次清单（只做一次）。
export function bootstrapAccessDomain(): void {
  const s = state()
  migrateAccessLedger()
  if (s.migrationBatches.length > 0) {
    return
  }
  const found = new Map<string, number>()
  for (const row of listRows('access')) {
    const remark = String(row['备注'] ?? '')
    const match = /\[迁移批次(MIGR-\d{6})\]/.exec(remark)
    if (!match) {
      continue
    }
    const batch = match[1]
    found.set(batch, (found.get(batch) ?? 0) + 1)
  }
  for (const [batch, count] of found) {
    const month = batch.slice(5, 9) + '-' + batch.slice(9)
    s.migrationBatches.push({
      batch,
      month,
      count,
      note: `上线前台账按月份分批迁移：${month} 共 ${count} 条，缺项已在备注写明出处`,
    })
    s.migratedBatchKeys.push(month)
  }
  persistState()
}

// ---------------------------------------------------------------------------
// 读口径：列表 / 详情 / 待同步预览全部走这里；导出清单复用 listRows('access')，
// 物理上同一份数据，不存在第三种取值。
// ---------------------------------------------------------------------------

export type AccessPointView = EntryRow & {
  责任岗位: string
  _pendingChange: boolean
  _pendingLabel: string
}

export function getAccessPoint(pointId: number): AccessPointView | null {
  const row = listRows('access').find((item) => Number(item.id) === pointId)
  if (!row) {
    return null
  }
  const pending = pendingQueue().filter((entry) => entry.pointId === pointId)[0]
  const view: AccessPointView = {
    ...row,
    责任岗位: String(row['责任岗位'] ?? responsiblePostOf(String(row['所属出入口'] ?? ''))),
    _pendingChange: Boolean(pending),
    _pendingLabel: pending
      ? `待同步第${pending.materialVersion}版：${CONCLUSION_SPEC[pending.conclusion].rowStatus}（断点序号 ${pending.seq}）`
      : '',
  }
  return view
}

export function defaultMaterialKey(pointId: number, date: string): string {
  return `MAT-ACCE-${String(pointId).padStart(4, '0')}-${date}`
}

export function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}
