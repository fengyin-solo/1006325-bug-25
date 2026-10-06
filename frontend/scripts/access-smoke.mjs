// 门禁安防写入与口径的冒烟验证：node scripts/access-smoke.mjs
// 用内存版 localStorage 替身，直接 bundle 源码跑业务逻辑（不依赖浏览器）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const memory = new Map()
const listeners = []
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => {
      memory.set(k, String(v))
    },
    removeItem: (k) => memory.delete(k),
  },
  addEventListener: (type, fn) => {
    if (type === 'storage') listeners.push(fn)
  },
}

const harness = `
export { migrateAccessV1, getMigrationLog } from '@/data/migrations'
export { readSchemaVersion, writeSchemaVersion, listRows, STORAGE_KEY } from '@/data/local-store'
export {
  submitAccessCheck, drainSyncQueue, setSyncState, pendingSyncCount,
  listChecks, getCheck, readSyncState, accessHandoverEntries,
} from '@/api/access-service'
export { listEntries, exportEntries } from '@/api/local-service'
`
const dir = mkdtempSync(join(tmpdir(), 'access-smoke-'))
const entry = join(dir, 'harness.ts')
writeFileSync(entry, harness)

const outfile = join(dir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  alias: { '@': join(process.cwd(), 'src') },
})

const mod = await import(pathToFileURL(outfile).href)

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}  ${detail}`)
  }
}

// 模拟首次启动：v1 迁移
mod.writeSchemaVersion(1)
const log = mod.migrateAccessV1(true)
check('v1 迁移执行且按月分批', log && log.batches.map((b) => b.batch).join(',') === '2026-07,2026-08,2026-09', JSON.stringify(log?.batches))
const migrated = mod.listRows('access')
const p1 = migrated.find((r) => r['点位编号'] === 'ACCE-0001')
check('缺授权人数按名册回填为数字', p1['授权人数'] === 24 && typeof p1['授权人数'] === 'number', String(p1['授权人数']))
const p2 = migrated.find((r) => r['点位编号'] === 'ACCE-0002')
check('已有可信授权人数沿用现值', p2['授权人数'] === 18, String(p2['授权人数']))
check('占位门禁类型按名册补齐', p2['门禁类型'] === '刷卡+人脸门禁', p2['门禁类型'])
check('安防责任岗位回填', p2['安防责任岗位'] === '东区安防一班、东区安防二班', p2['安防责任岗位'])
check('备注写明出处', String(p2['备注']).includes('授权名册') && String(p2['备注']).includes('2026-10'), p2['备注'])
check('迁移幂等：再跑不重复处理', mod.migrateAccessV1(true) === null)
check('迁移日志已持久化', mod.getMigrationLog(1)?.entries.length === 6)

// 越权提交：值班管理员替东区1号口提交，应驳回并写明归属
const deny = mod.submitAccessCheck({
  operator: { name: '张三', post: '值班管理员' },
  pointId: 1,
  checkDate: '2026-10-01',
  conclusion: '正常',
  issue: '',
})
check('越权提交被驳回且写明归属', !deny.ok && deny.message.includes('驳回') && deny.message.includes('东区安防'), deny.message)
check('越权不产生检查结论', mod.listChecks().length === 0)

// 跨出入口越权：西区岗位提交东区点位
const deny2 = mod.submitAccessCheck({
  operator: { name: '李慧', post: '西区安防一班' },
  pointId: 1,
  checkDate: '2026-10-01',
  conclusion: '正常',
  issue: '',
})
check('其它出入口责任岗位同样被驳回', !deny2.ok && deny2.message.includes('只读'), deny2.message)

// 授权岗位提交正常结论
const ok = mod.submitAccessCheck({
  operator: { name: '周建国', post: '东区安防一班' },
  pointId: 1,
  checkDate: '2026-10-01',
  conclusion: '正常',
  issue: '',
})
check('责任岗位提交成功', ok.ok, ok.message)
const rowAfter = mod.listRows('access').find((r) => r.id === 1)
check('台账一次落库：状态/检查人员更新', rowAfter.status === '状态正常' && rowAfter['检查人员'] === '周建国')
check('授权人数定版不被详情/清单改回', rowAfter['授权人数'] === 24)
// 列表与另存清单取值一致
const listVal = mod.listEntries('access').items.find((r) => r.id === 1)['授权人数']
const csvLine = mod.exportEntries('access').content.split('\n').find((l) => l.startsWith('1,'))
check('列表/详情/CSV 同一取值', String(listVal) === '24' && csvLine.includes(',24,'), csvLine)
// 值班交接清单已写入
const dutyRows = mod.listRows('duty')
const dutyRow = dutyRows.find((r) => r['交接编号'] === 'DUTY-ACCE-ACCE-0001-2026-10-01')
check('交接清单已同步且两处文本一致', dutyRow && mod.accessHandoverEntries()[0].text === dutyRow['交接事项'], dutyRow?.['交接事项'])
check('同步队列无积压', mod.pendingSyncCount() === 0)

// 同一份检查反复提交只算一次、只留最新版
mod.submitAccessCheck({
  operator: { name: '周建国', post: '东区安防一班' },
  pointId: 1,
  checkDate: '2026-10-01',
  conclusion: '整改',
  issue: '门锁偶发失效',
})
const keys = mod.listChecks().filter((r) => r.pointId === 1 && r.checkDate === '2026-10-01')
check('同点位同日期只保留一条结论', keys.length === 1)
check('只留最新版且版本号递增', keys[0].conclusion === '整改' && keys[0].version === 2, JSON.stringify(keys[0]))
// 隐患整改清单已落
const hazardRows = mod.listRows('hazard')
const hazard = hazardRows.find((r) => r['隐患编号'] === 'HAZA-ACCE-ACCE-0001')
check('整改结论进入隐患清单', hazard && hazard.status === '待整改' && hazard['整改措施'] === '门锁偶发失效', JSON.stringify(hazard))

// 再报一遍正常：隐患关闭，仍然只有一条隐患
mod.submitAccessCheck({
  operator: { name: '周建国', post: '东区安防一班' },
  pointId: 1,
  checkDate: '2026-10-01',
  conclusion: '正常',
  issue: '',
})
const hazard2 = mod.listRows('hazard').find((r) => r['隐患编号'] === 'HAZA-ACCE-ACCE-0001')
check('复检正常关闭同一隐患且不新增', hazard2.status === '已验收' && mod.listRows('hazard').filter((r) => r['隐患编号'] === 'HAZA-ACCE-ACCE-0001').length === 1)

// 整改必须有问题描述
const noIssue = mod.submitAccessCheck({
  operator: { name: '周建国', post: '东区安防一班' },
  pointId: 1,
  checkDate: '2026-10-03',
  conclusion: '整改',
  issue: '   ',
})
check('空问题的整改被拒', !noIssue.ok && noIssue.message.includes('隐患'), noIssue.message)

// 断线：提交进队列，恢复后从断点续传，且执行的是最新值
mod.setSyncState({ online: false })
mod.submitAccessCheck({
  operator: { name: '孙立峰', post: '东区安防二班' },
  pointId: 2,
  checkDate: '2026-10-05',
  conclusion: '整改',
  issue: '初版问题',
})
check('断线时队列积压', mod.pendingSyncCount() > 0)
// 同一批材料再报一遍（新版），不并两版
const re = mod.submitAccessCheck({
  operator: { name: '孙立峰', post: '东区安防二班' },
  pointId: 2,
  checkDate: '2026-10-05',
  conclusion: '整改',
  issue: '最新版问题',
})
check('重报提示为覆盖而非新增', re.ok && re.message.includes('最新版'), re.message)
check('结论只有最新版', mod.getCheck('2@2026-10-05').issue === '最新版问题')
const queueLenBefore = mod.pendingSyncCount()
mod.setSyncState({ online: true })
const drained = mod.drainSyncQueue()
check('恢复后续传成功且队列清空', drained.failed === null && mod.pendingSyncCount() === 0, JSON.stringify(drained))
check('隐患清单落的是最新版而非初版', mod.listRows('hazard').find((r) => r['隐患编号'] === 'HAZA-ACCE-ACCE-0002')['整改措施'] === '最新版问题')
check('续传没有产生重复任务', queueLenBefore >= 2)

// 模拟同步中断：下一条失败、停留队首、再恢复从该条继续
mod.setSyncState({ online: false })
mod.submitAccessCheck({
  operator: { name: '周建国', post: '东区安防一班' },
  pointId: 1,
  checkDate: '2026-10-06',
  conclusion: '正常',
  issue: '',
})
mod.setSyncState({ online: true, failNextOne: true })
const firstDrain = mod.drainSyncQueue()
check('中断时停在失败条且记录原因', firstDrain.failed !== null && firstDrain.remaining >= 1, JSON.stringify(firstDrain.failed))
const secondDrain = mod.drainSyncQueue()
check('再同步从失败条继续直到清空', secondDrain.failed === null && mod.pendingSyncCount() === 0)

// 刷新语义：所有数据都在 localStorage，重读仍是落库值
check('刷新后记录保持原样', mod.listEntries('access').items.find((r) => r.id === 1)['授权人数'] === 24)

// 跨标签：另一个标签写 storage，本标签缓存失效读到新值
const before = mod.listRows('duty').length
const raw = JSON.parse(memory.get(mod.STORAGE_KEY))
raw.duty.push({ id: 999, status: '已交接', pending: false, abnormal: false, 交接编号: 'TEST-X' })
memory.set(mod.STORAGE_KEY, JSON.stringify(raw))
listeners[0]({ key: mod.STORAGE_KEY })
check('storage 事件后台账同步更新', mod.listRows('duty').length === before + 1 && mod.listRows('duty').some((r) => r['交接编号'] === 'TEST-X'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
