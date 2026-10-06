// 门禁安防领域端到端校验：内存 localStorage 模拟刷新/断线/越权/迁移/幂等等场景。
import assert from 'node:assert'

// ---- 内存版 localStorage ----
const memory = new Map<string, string>()
class MemoryStorage {
  getItem(key: string) {
    return memory.has(key) ? memory.get(key)! : null
  }
  setItem(key: string, value: string) {
    memory.set(key, String(value))
  }
  removeItem(key: string) {
    memory.delete(key)
  }
  clear() {
    memory.clear()
  }
}
;(globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage

const store = await import('./src/data/local-store')
const seed = await import('./src/data/seed')
const svc = await import('./src/api/access-domain')
const { exportEntries } = await import('./src/api/local-service')

const ENTRIES_KEY = store.storageKey()
const POST_1 = '一号口安防值班岗'
const POST_3 = '三号口安防值班岗'
const POST_7 = '七号口安防值班岗'
const READONLY = svc.READ_ONLY_POST

function reloadStore() {
  // 清模块内缓存，模拟“刷新页面”后从 localStorage 重新读取
  store.__reloadCacheForTest()
}

// 场景 1：v1 老台账（占位值、无责任岗位）按月迁移，缺项备注写出处
memory.clear()
const v1rows = JSON.parse(JSON.stringify(seed.SEED_ROWS))
// 强制把 access 改成老格式
v1rows.access = [
  { id: 1, status: '待检查', pending: true, abnormal: false, 点位编号: 'ACCE-0001', 所属出入口: '1号综合出入口', 门禁类型: '门禁安防运维样例1', 监控覆盖: '门禁安防运维样例1', 授权人数: '门禁安防运维样例1', 检查日期: '2025-11-03', 检查人员: '门禁安防运维样例1', 安防状态: '门禁安防运维样例1' },
  { id: 2, status: '检查中', pending: true, abnormal: true, 点位编号: 'ACCE-0002', 所属出入口: '3号通风出入口', 门禁类型: '门禁安防运维样例2', 监控覆盖: '门禁安防运维样例2', 授权人数: '门禁安防运维样例2', 检查日期: '2026-03-15', 检查人员: '门禁安防运维样例2', 安防状态: '门禁安防运维样例2' },
  { id: 3, status: '待检查', pending: true, abnormal: false, 点位编号: 'ACCE-0003', 所属出入口: '7号检修出入口', 门禁类型: '门禁安防运维样例3', 监控覆盖: '门禁安防运维样例3', 授权人数: '门禁安防运维样例3', 检查日期: '2026-09-03', 检查人员: '门禁安防运维样例3', 安防状态: '门禁安防运维样例3' },
]
memory.set(ENTRIES_KEY, JSON.stringify(v1rows))
svc.resetAccessDomain()
reloadStore()

svc.bootstrapAccessDomain()
assert.ok(svc.migrationBatches().length >= 1, '应按月生成迁移批次')
const accessAfterMig = store.listRows('access')
assert.strictEqual(accessAfterMig[0]['授权人数'], 6, '2025年记录回填旧编制6人')
assert.strictEqual(accessAfterMig[1]['授权人数'], 12, '2026上半年记录回填12人')
assert.strictEqual(accessAfterMig[2]['授权人数'], 16, '2026年7月起回填16人')
assert.strictEqual(accessAfterMig[0]['门禁类型'], '刷卡门禁', '门禁类型缺项统一补刷卡门禁')
assert.ok(String(accessAfterMig[0]['备注']).includes('授权花名册'), '备注需写明出处')
assert.strictEqual(accessAfterMig[0]['责任岗位'], POST_1, '责任岗位按出入口归属补上')
// 迁移幂等：再引导一次不新增批次
const batchCount = svc.migrationBatches().length
svc.bootstrapAccessDomain()
assert.strictEqual(svc.migrationBatches().length, batchCount, '存量迁移只跑一次')
console.log('✓ 场景1 存量按月迁移 + 缺项出处 + 幂等')

// 场景 2：越权提交驳回并写明归属
svc.setAccessOnline(true)
const reject = svc.submitAccessConclusion({
  post: POST_3, pointId: 1, conclusion: '正常', 门禁类型: '刷卡门禁', 授权人数: 99,
  监控覆盖: '全覆盖', 检查日期: '2026-10-06', 检查人员: POST_3, 整改要求: '', materialKey: 'MAT-X1',
})
assert.strictEqual(reject.ok, false)
assert.ok(reject.message.includes('驳回') && reject.message.includes(POST_1), '驳回需写明记录归属岗位')
const rejectReadonly = svc.submitAccessConclusion({
  post: READONLY, pointId: 1, conclusion: '需整改', 门禁类型: '刷卡门禁', 授权人数: 1,
  监控覆盖: '未覆盖', 检查日期: '2026-10-06', 检查人员: READONLY, 整改要求: 'x', materialKey: 'MAT-X2',
})
assert.strictEqual(rejectReadonly.ok, false, '只读岗位提交必须驳回')
assert.strictEqual(store.listRows('access')[0]['授权人数'], 6, '驳回不得改台账')
console.log('✓ 场景2 越权/只读岗位驳回且写明归属，台账不变')

// 场景 3：授权岗位一次落库，列表/详情/导出一致，隐患+值班两处台账同步
const r3 = svc.submitAccessConclusion({
  post: POST_1, pointId: 1, conclusion: '需整改', 门禁类型: '人脸+刷卡', 授权人数: 18,
  监控覆盖: '全覆盖', 检查日期: '2026-10-06', 检查人员: '王磊', 整改要求: '修复磁力锁',
  materialKey: 'MAT-ACCE-0001-2026-10-06',
})
assert.strictEqual(r3.ok, true)
assert.strictEqual(r3.synced, true)
const row3 = store.listRows('access')[0]
assert.strictEqual(row3['授权人数'], 18)
assert.strictEqual(row3['门禁类型'], '人脸+刷卡')
assert.strictEqual(row3.status, '需整改')
const detail3 = svc.getAccessPoint(1)!
assert.strictEqual(detail3['授权人数'], 18, '详情面板与列表同值')
const csv = exportEntries('access').content
assert.ok(csv.includes('人脸+刷卡') && csv.includes('18'), '另存清单必须取到新值')
const hazards = store.listRows('hazard')
const linked = hazards.filter((h) => String(h['来源材料批次']) === 'MAT-ACCE-0001-2026-10-06')
assert.strictEqual(linked.length, 1, '整改结论必须落到隐患整改清单，且只落一条')
assert.ok(String(linked[0]['整改措施']).includes('修复磁力锁'))
const duties = store.listRows('duty')
const handovers = duties.filter((d) => String(d['交接事项']).includes('MAT-ACCE-0001-2026-10-06'))
assert.strictEqual(handovers.length, 2, '其它两个出入口交接清单各一条，结论不写回本入口')
const texts = new Set(handovers.map((d) => d['交接事项']))
assert.strictEqual(texts.size, 1, '两处交接清单内容必须一致')
console.log('✓ 场景3 一次落库 + 列表/详情/导出一致 + 隐患清单 + 其它入口交接清单一致')

// 场景 4：刷新页面后值保持原样
reloadStore()
const row4 = store.listRows('access')[0]
assert.strictEqual(row4['授权人数'], 18, '刷新后授权人数保持新值')
assert.strictEqual(svc.getAccessPoint(1)!['授权人数'], 18)
console.log('✓ 场景4 返回再刷新记录保持原样')

// 场景 5：同一批材料反复提交只算一次、只留最新版，不合并
svc.submitAccessConclusion({
  post: POST_1, pointId: 1, conclusion: '需整改', 门禁类型: '人脸+刷卡', 授权人数: 20,
  监控覆盖: '全覆盖', 检查日期: '2026-10-06', 检查人员: '王磊', 整改要求: '修复磁力锁（二次确认）',
  materialKey: 'MAT-ACCE-0001-2026-10-06',
})
const h5 = store.listRows('hazard').filter((h) => String(h['来源材料批次']) === 'MAT-ACCE-0001-2026-10-06')
assert.strictEqual(h5.length, 1, '同批材料重报不得新增隐患')
assert.ok(String(h5[0]['整改措施']).includes('第2版'), '隐患清单取最新版并标注版本')
assert.strictEqual(store.listRows('access')[0]['授权人数'], 20, '台账只留最新版值')
assert.strictEqual(svc.pendingQueue().length, 0, '在线时队列应清空')
console.log('✓ 场景5 同批材料重报幂等，只保留最新版')

// 场景 6：断线只入队，不污染台账；恢复后从断点续传，不用旧值顶
svc.setAccessOnline(false)
const r6 = svc.submitAccessConclusion({
  post: POST_7, pointId: 3, conclusion: '正常', 门禁类型: '二维码门禁', 授权人数: 16,
  监控覆盖: '部分覆盖', 检查日期: '2026-10-06', 检查人员: '赵倩', 整改要求: '',
  materialKey: 'MAT-ACCE-0003-2026-10-06',
})
assert.strictEqual(r6.ok, true, '断线提交应被受理，实际：' + r6.message)
assert.strictEqual(r6.synced, false)
const cursor = svc.resumeCursor()
assert.ok(cursor !== null, '断线后应有断点序号')
const row6Before = store.listRows('access').find((r) => Number(r.id) === 3)!
assert.strictEqual(row6Before['授权人数'], 16, '断线期间台账不得被待同步值改动（仍是迁移回填值）')
assert.strictEqual(svc.getAccessPoint(3)!._pendingChange, true, '详情应提示有待同步新版')
// 断线下同批再报：旧排队记录作废
svc.submitAccessConclusion({
  post: POST_7, pointId: 3, conclusion: '正常', 门禁类型: '二维码门禁', 授权人数: 9,
  监控覆盖: '部分覆盖', 检查日期: '2026-10-06', 检查人员: '赵倩', 整改要求: '',
  materialKey: 'MAT-ACCE-0003-2026-10-06',
})
assert.strictEqual(svc.pendingQueue().length, 1, '同批材料排队只留最新一条')
assert.strictEqual(svc.pendingQueue()[0].payload.授权人数, 9)
// 再插一条别的点位，验证按 seq 顺序
svc.submitAccessConclusion({
  post: POST_3, pointId: 2, conclusion: '正常', 门禁类型: '刷卡门禁', 授权人数: 12,
  监控覆盖: '部分覆盖', 检查日期: '2026-10-06', 检查人员: '孙力', 整改要求: '',
  materialKey: 'MAT-ACCE-0002-2026-10-06',
})
svc.setAccessOnline(true)
const row6After = store.listRows('access').find((r) => Number(r.id) === 3)!
assert.strictEqual(row6After['授权人数'], 9, '续传落最新值9，而非断线前的16')
assert.strictEqual(row6After.status, '状态正常')
assert.strictEqual(svc.pendingQueue().length, 0, '续传完成队列清空')
console.log('✓ 场景6 断线暂存 + 断点续传 + 旧值不顶替 + 版本不合并')

// 场景 6b：断线期间结论从“需整改”改成“正常”，旧版被顶替，恢复后不得留下隐患残留
svc.setAccessOnline(false)
svc.submitAccessConclusion({
  post: POST_3, pointId: 2, conclusion: '需整改', 门禁类型: '刷卡门禁', 授权人数: 11,
  监控覆盖: '未覆盖', 检查日期: '2026-10-06', 检查人员: '孙力', 整改要求: '旧版整改要求',
  materialKey: 'MAT-FLIP-0002',
})
svc.submitAccessConclusion({
  post: POST_3, pointId: 2, conclusion: '正常', 门禁类型: '刷卡门禁', 授权人数: 12,
  监控覆盖: '已覆盖', 检查日期: '2026-10-06', 检查人员: '孙力', 整改要求: '',
  materialKey: 'MAT-FLIP-0002',
})
assert.strictEqual(svc.pendingQueue().length, 1, '同批材料改结论后只留最新一条排队')
svc.setAccessOnline(true)
const rowFlip = store.listRows('access').find((r) => Number(r.id) === 2)!
assert.strictEqual(rowFlip.status, '状态正常', '最终结论以最新版“正常”落库')
assert.strictEqual(
  store.listRows('hazard').filter((h) => String(h['来源材料批次']) === 'MAT-FLIP-0002').length,
  0,
  '被顶替的旧版“需整改”不得留下隐患残留',
)
console.log('✓ 场景6b 断线下结论改版，旧版不重放、不留隐患残留')

// 场景 7：值班清单与台账同步更新（交接事项随最新版刷新，不新增重复行）
const d7 = store.listRows('duty').filter((d) => String(d['交接事项']).includes('MAT-ACCE-0003-2026-10-06'))
assert.strictEqual(d7.length, 2, '点位3同步到其它两个出入口')
assert.ok(d7.every((d) => String(d['交接事项']).includes('授权人数：9')), '交接清单取最新版值')
console.log('✓ 场景7 值班清单与台账同步且两处一致')

console.log('\n全部校验通过 ✅')
