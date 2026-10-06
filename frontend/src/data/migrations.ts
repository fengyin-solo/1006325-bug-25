import { monthBucket, specOfEntrance } from './access-domain'
import { listRows, readCollection, saveRows, writeCollection, MIGRATION_KEY } from './local-store'
import type { EntryRow } from './types'

// 存量对齐方案（v1，依据写在每条记录的备注里）：
// 1. 分批：以「检查日期」所在月份为批次，按月份从前到后迁移；缺日期的归「月份不详」最后处理。
// 2. 缺项补齐：门禁类型、监控覆盖、授权人数按《出入口授权名册》的标准值回填；
//    检查人员、安防责任岗位按名册责任岗位回填；安防状态按当前状态回填。
// 3. 已有的可信取值一律沿用，占位样例值（「门禁安防运维样例N」）与空值视为缺项。
// 4. 早年改动过的记录不逐月反推（历史过程值无凭据），保留迁移时点现值，备注注明依据为
//    「上线前账面对接值（2026-10）」。
// 5. 每条记录的备注都写明补齐项与出处；迁移按行打「数据版本」标记，重复执行不重复回填。
const MIGRATION_BASE = '2026-10'
const MIGRATION_VERSION = 1

export type MigrationEntryLog = {
  id: number
  pointCode: string
  batch: string
  backfilled: string[]
  kept: string[]
  note: string
}

export type MigrationLog = {
  version: number
  ranAt: string
  rule: string
  batches: { batch: string; pointCodes: string[] }[]
  entries: MigrationEntryLog[]
  warnings: string[]
}

type MigrationLogs = Record<number, MigrationLog>

const PLACEHOLDER = /门禁安防运维样例\d*$/
const STATUS_TEXT: Record<string, string> = {
  待检查: '待检查',
  检查中: '检查中',
  状态正常: '正常',
  需整改: '需整改',
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true
  }
  const text = String(value).trim()
  return text === '' || PLACEHOLDER.test(text)
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
}

export function migrateAccessV1(silent = false): MigrationLog | null {
  const rows = listRows('access')
  const targets = rows.filter((row) => Number(row['数据版本'] ?? 0) < MIGRATION_VERSION)
  if (targets.length === 0) {
    return null
  }

  const entries: MigrationEntryLog[] = []
  const warnings: string[] = []
  const batchMap = new Map<string, string[]>()

  const next = rows.map((row) => {
    if (Number(row['数据版本'] ?? 0) >= MIGRATION_VERSION) {
      return row
    }
    const updated: EntryRow = { ...row }
    const backfilled: string[] = []
    const kept: string[] = []
    const entrance = String(row['所属出入口'] ?? '').trim()
    const spec = specOfEntrance(entrance)
    const batch = monthBucket(String(row['检查日期'] ?? ''))

    if (!spec) {
      warnings.push(`点位 ${String(row['点位编号'])} 的出入口「${entrance}」不在授权名册，责任岗位无法回填`)
    }

    if (isMissing(row['门禁类型'])) {
      updated['门禁类型'] = spec ? spec.accessType : '待核实'
      backfilled.push('门禁类型')
    } else {
      kept.push('门禁类型')
    }

    if (isMissing(row['监控覆盖'])) {
      updated['监控覆盖'] = spec ? spec.coverage : '待核实'
      backfilled.push('监控覆盖')
    } else {
      kept.push('监控覆盖')
    }

    const authorized = asPositiveInt(row['授权人数'])
    if (authorized === null) {
      updated['授权人数'] = spec ? spec.authorizedCount : 0
      backfilled.push('授权人数')
    } else {
      updated['授权人数'] = authorized
      kept.push('授权人数')
    }

    if (isMissing(row['检查人员'])) {
      updated['检查人员'] = spec ? `${spec.posts[0]}（迁移按责任岗位回填）` : '待核实'
      backfilled.push('检查人员')
    } else {
      kept.push('检查人员')
    }

    if (isMissing(row['安防状态'])) {
      updated['安防状态'] = STATUS_TEXT[String(row.status)] ?? String(row.status)
      backfilled.push('安防状态')
    } else {
      kept.push('安防状态')
    }

    updated['安防责任岗位'] = spec ? spec.posts.join('、') : '未登记出入口'
    backfilled.push('安防责任岗位')

    // 备注：补齐项逐项写明出处；无法逐月还原的早年改动也在这里交代依据。
    const sourceParts: string[] = []
    if (backfilled.includes('门禁类型') || backfilled.includes('监控覆盖') || backfilled.includes('授权人数')) {
      sourceParts.push('门禁类型/监控覆盖/授权人数缺项按《出入口授权名册》补齐')
    }
    if (backfilled.includes('检查人员') || backfilled.includes('安防责任岗位')) {
      sourceParts.push('检查人员、责任岗位按名册归属回填')
    }
    if (backfilled.includes('安防状态')) {
      sourceParts.push('安防状态按当前检查状态回填')
    }
    if (kept.length > 0) {
      sourceParts.push(`${kept.join('、')}沿用原门禁台账现值`)
    }
    if (row.abnormal === true) {
      sourceParts.push(
        '该点位早年有改动记录，逐月历史值无凭据可查，不予反推，保留迁移时点现值，依据：上线前账面对接值（2026-10）',
      )
    }
    const previousNote = isMissing(row['备注']) ? '' : `${String(row['备注']).trim()}；`
    updated['备注'] = `${previousNote}v1存量迁移·${batch}批次：${sourceParts.join('；')}。`
    updated['数据版本'] = MIGRATION_VERSION

    const pointCode = String(row['点位编号'] ?? row.id)
    entries.push({
      id: Number(row.id),
      pointCode,
      batch,
      backfilled,
      kept,
      note: String(updated['备注']),
    })
    const list = batchMap.get(batch) ?? []
    list.push(pointCode)
    batchMap.set(batch, list)
    return updated
  })

  saveRows('access', next, silent)

  // 批次顺序：真实月份由前到后，「月份不详」兜底排最后。
  const batches = [...batchMap.entries()]
    .sort(([a], [b]) => (a === '月份不详' ? 1 : b === '月份不详' ? -1 : a.localeCompare(b)))
    .map(([batch, pointCodes]) => ({ batch, pointCodes }))

  const log: MigrationLog = {
    version: MIGRATION_VERSION,
    ranAt: new Date().toISOString(),
    rule: '按检查日期归月份分批迁移；缺项按《出入口授权名册》与责任岗位回填并在备注注明出处；可信现值沿用；早年改动保留现值不反推。',
    batches,
    entries,
    warnings,
  }
  const history = readCollection<MigrationLogs>(MIGRATION_KEY, {})
  history[MIGRATION_VERSION] = log
  writeCollection(MIGRATION_KEY, history, silent)
  return log
}

export function getMigrationLog(version: number = MIGRATION_VERSION): MigrationLog | null {
  const history = readCollection<MigrationLogs>(MIGRATION_KEY, {})
  return history[version] ?? null
}

export function migrationVersion(): number {
  return MIGRATION_VERSION
}

export function migrationBase(): string {
  return MIGRATION_BASE
}
