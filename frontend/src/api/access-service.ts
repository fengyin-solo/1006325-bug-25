import { handoverText, isValidDate, ownershipText, specOfEntrance } from '@/data/access-domain'
import {
  CHECKS_KEY,
  listRows,
  readCollection,
  saveRows,
  SYNC_QUEUE_KEY,
  SYNC_STATE_KEY,
  writeCollection,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 检查结论按「点位 + 检查日期」唯一：同一份检查反复提交只算一次，后报的覆盖旧版，不把两版并在一起。
export type AccessCheckRecord = {
  key: string
  pointId: number
  pointCode: string
  entrance: string
  checkDate: string
  conclusion: '正常' | '整改'
  issue: string
  checker: string
  checkerPost: string
  ledgerSnapshot: {
    accessType: string
    coverage: string
    authorizedCount: number
  }
  version: number
  firstSubmittedAt: string
  updatedAt: string
}

export type Operator = {
  name: string
  post: string
}

export type CheckSubmission = {
  operator: Operator
  pointId: number
  checkDate: string
  conclusion: '正常' | '整改'
  issue: string
}

type SyncTaskType = 'duty-handover' | 'hazard-rectify'

export type SyncTask = {
  id: number
  type: SyncTaskType
  checkKey: string
  status: 'pending' | 'done'
  attempts: number
  enqueuedAt: string
  lastError: string
}

export type SyncState = {
  online: boolean
  failNextOne: boolean
  lastDrainAt: string | null
}

type CheckCollection = Record<string, AccessCheckRecord>

function nowText(): string {
  return new Date().toISOString()
}

function checkKey(pointId: number, checkDate: string): string {
  return `${pointId}@${checkDate}`
}

function readChecks(): CheckCollection {
  return readCollection<CheckCollection>(CHECKS_KEY, {})
}

function writeChecks(checks: CheckCollection): void {
  writeCollection(CHECKS_KEY, checks)
}

export function getCheck(key: string): AccessCheckRecord | null {
  return readChecks()[key] ?? null
}

export function listChecks(): AccessCheckRecord[] {
  return Object.values(readChecks()).sort((a, b) =>
    a.checkDate === b.checkDate ? a.pointId - b.pointId : a.checkDate.localeCompare(b.checkDate),
  )
}

export function listChecksOfPoint(pointId: number): AccessCheckRecord[] {
  return listChecks().filter((record) => record.pointId === pointId)
}

// 授权口径：提交检查、提出整改只允许本出入口的安防责任岗位；其它岗位入口只读。
export function canSubmitForEntrance(post: string, entrance: string): boolean {
  const spec = specOfEntrance(entrance)
  return Boolean(spec && spec.posts.includes(post))
}

function findPoint(pointId: number): EntryRow | null {
  return listRows('access').find((row) => Number(row.id) === pointId) ?? null
}

// 授权人数这类台账字段一次落库：写检查结论时把门禁类型/监控覆盖/授权人数定版，
// 列表、详情、另存清单读的都是 access 台账里这同一份行，不存在三个取值。
function finalizeLedger(point: EntryRow): EntryRow {
  const spec = specOfEntrance(String(point['所属出入口'] ?? ''))
  const updated: EntryRow = { ...point }
  const note: string[] = []

  const authorized = Number(updated['授权人数'])
  if (!Number.isFinite(authorized) || authorized <= 0) {
    if (spec) {
      updated['授权人数'] = spec.authorizedCount
      note.push('授权人数提交时按授权名册落库')
    }
  }
  if (String(updated['门禁类型'] ?? '').trim() === '' || String(updated['门禁类型']) === '待核实') {
    if (spec) {
      updated['门禁类型'] = spec.accessType
      note.push('门禁类型提交时按授权名册落库')
    }
  }
  if (String(updated['监控覆盖'] ?? '').trim() === '' || String(updated['监控覆盖']) === '待核实') {
    if (spec) {
      updated['监控覆盖'] = spec.coverage
      note.push('监控覆盖提交时按授权名册落库')
    }
  }
  if (!updated['安防责任岗位'] || updated['安防责任岗位'] === '未登记出入口') {
    updated['安防责任岗位'] = spec ? spec.posts.join('、') : '未登记出入口'
  }
  if (note.length > 0) {
    const oldNote = String(updated['备注'] ?? '').trim()
    updated['备注'] = oldNote ? `${oldNote}；${note.join('；')}` : note.join('；')
  }
  return updated
}

// 整改结论落到隐患整改清单：同一点位的隐患只保留一条，复检正常即验收关闭。
function upsertHazardFromCheck(record: AccessCheckRecord): void {
  const rows = listRows('hazard')
  const hazardCode = `HAZA-ACCE-${record.pointCode}`
  const index = rows.findIndex((row) => String(row['隐患编号']) === hazardCode)
  const dueDate = new Date(`${record.checkDate}T00:00:00Z`)
  dueDate.setUTCDate(dueDate.getUTCDate() + 15)
  const dueText = dueDate.toISOString().slice(0, 10)

  if (record.conclusion === '整改') {
    const status = '待整改'
    const row: EntryRow =
      index >= 0
        ? { ...rows[index] }
        : {
            id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
            status,
            pending: true,
            abnormal: true,
          }
    row.status = status
    row.pending = true
    row.abnormal = true
    row['隐患编号'] = hazardCode
    row['隐患部位'] = `${record.pointCode}（${record.entrance}）`
    row['隐患等级'] = String(row['隐患等级'] ?? '').trim() !== '' ? row['隐患等级'] : '一般隐患'
    row['整改措施'] = record.issue.trim() !== '' ? record.issue : '按门禁安防检查结论整改'
    row['责任人员'] = record.checkerPost
    row['发现日期'] = record.checkDate
    row['整改期限'] = dueText
    row['整改状态'] = status
    const next = index >= 0 ? [...rows] : [...rows, row]
    if (index >= 0) {
      next[index] = row
    }
    saveRows('hazard', next)
    return
  }

  if (index >= 0) {
    const row: EntryRow = { ...rows[index] }
    row.status = '已验收'
    row.pending = false
    row.abnormal = false
    row['整改状态'] = '已验收'
    row['整改措施'] = `${String(row['整改措施'] ?? '').trim()}；${record.checkDate}复检正常，验收关闭（${record.checker}）`
    const next = [...rows]
    next[index] = row
    saveRows('hazard', next)
  }
}

// 值班交接清单：交接事项文本由统一生成器产出，门禁侧与值班侧读到的是同一句。
function applyDutyHandover(record: AccessCheckRecord): void {
  const rows = listRows('duty')
  const shiftCode = `DUTY-ACCE-${record.pointCode}-${record.checkDate}`
  const index = rows.findIndex((row) => String(row['交接编号']) === shiftCode)
  const spec = specOfEntrance(record.entrance)
  const text = handoverText({
    pointCode: record.pointCode,
    entrance: record.entrance,
    checkDate: record.checkDate,
    conclusion: record.conclusion === '正常' ? '正常' : '需整改',
    checker: record.checker,
    issue: record.issue,
  })
  const row: EntryRow =
    index >= 0
      ? { ...rows[index] }
      : {
          id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
          status: '已交接',
          pending: false,
          abnormal: false,
        }
  row.status = '已交接'
  row.pending = false
  row.abnormal = false
  row['交接编号'] = shiftCode
  row['值班班组'] = spec ? spec.groups[0] : record.checkerPost
  row['值班日期'] = record.checkDate
  row['班次'] = '安防检查交接'
  row['值班人员'] = record.checker
  row['交接事项'] = text
  row['交接人员'] = record.checker
  row['交接状态'] = '已交接'
  const next = index >= 0 ? [...rows] : [...rows, row]
  if (index >= 0) {
    next[index] = row
  }
  saveRows('duty', next)
}

// 隐患清单同步：队列里只存检查键，执行时回读最新结论，绝不拿入队时的旧值顶上。
function applyHazardSync(task: SyncTask): void {
  const record = getCheck(task.checkKey)
  if (!record) {
    throw new Error(`检查结论 ${task.checkKey} 已不存在，无法同步隐患清单`)
  }
  upsertHazardFromCheck(record)
}

function applyDutySync(task: SyncTask): void {
  const record = getCheck(task.checkKey)
  if (!record) {
    throw new Error(`检查结论 ${task.checkKey} 已不存在，无法同步交接清单`)
  }
  applyDutyHandover(record)
}

// ── 同步队列（持久化）：断线时任务留在队首，下次从第一个未同步成功的接着走 ────────────────

export function readSyncState(): SyncState {
  return readCollection<SyncState>(SYNC_STATE_KEY, { online: true, failNextOne: false, lastDrainAt: null })
}

export function setSyncState(patch: Partial<SyncState>): SyncState {
  const next = { ...readSyncState(), ...patch }
  writeCollection(SYNC_STATE_KEY, next)
  return next
}

function readQueue(): SyncTask[] {
  return readCollection<SyncTask[]>(SYNC_QUEUE_KEY, [])
}

function writeQueue(queue: SyncTask[]): void {
  writeCollection(SYNC_QUEUE_KEY, queue)
}

export function pendingSyncCount(): number {
  return readQueue().filter((task) => task.status === 'pending').length
}

function enqueue(type: SyncTaskType, checkKey: string): void {
  const queue = readQueue()
  const existing = queue.find((task) => task.type === type && task.checkKey === checkKey)
  if (existing) {
    // 同一批材料再报一遍：把旧的下发任务打回头部继续等，最新值在执行时回读，不做两版合并。
    existing.status = 'pending'
    existing.attempts = 0
    existing.lastError = ''
    existing.enqueuedAt = nowText()
    writeQueue(queue)
    return
  }
  queue.push({
    id: queue.reduce((max, task) => Math.max(max, task.id), 0) + 1,
    type,
    checkKey,
    status: 'pending',
    attempts: 0,
    enqueuedAt: nowText(),
    lastError: '',
  })
  writeQueue(queue)
}

export type DrainResult = { applied: number; failed: SyncTask | null; remaining: number }

// 排空队列：严格从队首开始；一条失败就停下，下次从这一条接着走。
export function drainSyncQueue(): DrainResult {
  const state = readSyncState()
  const queue = readQueue()
  let applied = 0
  let failed: SyncTask | null = null

  for (const task of queue) {
    if (task.status === 'done') {
      continue
    }
    if (!state.online) {
      break
    }
    task.attempts += 1
    if (state.failNextOne) {
      state.failNextOne = false
      task.lastError = `同步中断（${task.type}），下次将从本条继续`
      failed = task
      writeCollection(SYNC_STATE_KEY, { ...state, lastDrainAt: state.lastDrainAt })
      writeQueue(queue)
      return { applied, failed, remaining: queue.filter((item) => item.status === 'pending').length }
    }
    try {
      if (task.type === 'duty-handover') {
        applyDutySync(task)
      } else {
        applyHazardSync(task)
      }
      task.status = 'done'
      task.lastError = ''
      applied += 1
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : '同步失败'
      failed = task
      writeCollection(SYNC_STATE_KEY, { ...state, lastDrainAt: state.lastDrainAt })
      writeQueue(queue)
      return { applied, failed, remaining: queue.filter((item) => item.status === 'pending').length }
    }
  }

  writeQueue(queue)
  writeCollection(SYNC_STATE_KEY, { ...state, lastDrainAt: nowText() })
  return { applied, failed: null, remaining: queue.filter((item) => item.status === 'pending').length }
}

// ── 提交检查结论：授权 → 校验 → 台账落库 → 结论 upsert → 联动入队 ─────────────────────────

export function submitAccessCheck(input: CheckSubmission): ActionResult {
  const point = findPoint(input.pointId)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${input.pointId} 的安防点位` }
  }
  const entrance = String(point['所属出入口'] ?? '').trim()
  if (!canSubmitForEntrance(input.operator.post, entrance)) {
    // 越权提交驳回并写明记录归属。
    return {
      ok: false,
      message: `提交被驳回：${input.operator.name}（${input.operator.post}）不是${entrance}的安防责任岗位，该出入口对当前岗位只读。${ownershipText(entrance)}。`,
    }
  }
  if (!isValidDate(input.checkDate)) {
    return { ok: false, message: '检查日期格式不正确，应为 YYYY-MM-DD' }
  }
  if (input.conclusion === '整改' && input.issue.trim() === '') {
    return { ok: false, message: '提出整改必须填写问题描述，整改结论要能落进隐患整改清单' }
  }

  const rows = listRows('access')
  const index = rows.findIndex((row) => Number(row.id) === input.pointId)
  const ledger = finalizeLedger(rows[index])
  ledger['检查日期'] = input.checkDate
  ledger['检查人员'] = input.operator.name
  ledger.status = input.conclusion === '正常' ? '状态正常' : '需整改'
  ledger.pending = false
  ledger.abnormal = input.conclusion === '整改'
  ledger['安防状态'] = input.conclusion === '正常' ? '正常' : '需整改'
  const nextRows = [...rows]
  nextRows[index] = ledger
  saveRows('access', nextRows)

  const key = checkKey(input.pointId, input.checkDate)
  const checks = readChecks()
  const previous = checks[key]
  const record: AccessCheckRecord = {
    key,
    pointId: input.pointId,
    pointCode: String(ledger['点位编号']),
    entrance,
    checkDate: input.checkDate,
    conclusion: input.conclusion,
    issue: input.issue.trim(),
    checker: input.operator.name,
    checkerPost: input.operator.post,
    ledgerSnapshot: {
      accessType: String(ledger['门禁类型']),
      coverage: String(ledger['监控覆盖']),
      authorizedCount: Number(ledger['授权人数']) || 0,
    },
    version: (previous?.version ?? 0) + 1,
    firstSubmittedAt: previous?.firstSubmittedAt ?? nowText(),
    updatedAt: nowText(),
  }
  checks[key] = record
  writeChecks(checks)

  // 值班清单与台账同步更新；隐患清单每次都下发：整改则建/改单，复检正常则验收关闭，
  // 离线时任务进队列，恢复后从断点续传，执行时回读的始终是最新版结论。
  enqueue('duty-handover', key)
  enqueue('hazard-rectify', key)

  const state = readSyncState()
  if (state.online) {
    drainSyncQueue()
  }

  if (previous) {
    return {
      ok: true,
      message: `${record.pointCode} ${input.checkDate} 的检查已存在（v${previous.version}），本次提交只保留最新版 v${record.version}，不重复计数`,
    }
  }
  return {
    ok: true,
    message: `${record.pointCode} ${input.checkDate} 检查结论已落库（${record.conclusion === '正常' ? '状态正常' : '需整改'}），台账与交接清单已同步`,
  }
}

// 门禁页值班交接面板直接读取：内容与 duty 模块里 applyDutyHandover 写入的完全一致。
export function accessHandoverEntries(): { code: string; text: string; date: string }[] {
  return listChecks().map((record) => ({
    code: `DUTY-ACCE-${record.pointCode}-${record.checkDate}`,
    text: handoverText({
      pointCode: record.pointCode,
      entrance: record.entrance,
      checkDate: record.checkDate,
      conclusion: record.conclusion === '正常' ? '正常' : '需整改',
      checker: record.checker,
      issue: record.issue,
    }),
    date: record.checkDate,
  }))
}
