// 门禁安防域的台账口径：出入口与安防责任岗位的归属关系、门禁标准、以及各处共用的文本生成器。
// 授权校验、存量回填、交接清单都以这里为唯一依据，避免多个入口各说各话。

export type EntranceSpec = {
  entrance: string
  posts: string[]
  groups: string[]
  accessType: string
  coverage: string
  authorizedCount: number
}

// 出入口责任名册：只有岗位和出入口都对上的安防责任岗位，才允许提交检查/提出整改。
export const ENTRANCE_REGISTRY: EntranceSpec[] = [
  {
    entrance: '东区1号口',
    posts: ['东区安防一班', '东区安防二班'],
    groups: ['东出口安防班组'],
    accessType: '刷卡门禁',
    coverage: '全覆盖',
    authorizedCount: 24,
  },
  {
    entrance: '东区2号口',
    posts: ['东区安防一班', '东区安防二班'],
    groups: ['东出口安防班组'],
    accessType: '刷卡+人脸门禁',
    coverage: '全覆盖',
    authorizedCount: 20,
  },
  {
    entrance: '西区1号口',
    posts: ['西区安防一班'],
    groups: ['西出口安防班组'],
    accessType: '人脸门禁',
    coverage: '重点覆盖',
    authorizedCount: 12,
  },
  {
    entrance: '西区2号口',
    posts: ['西区安防一班'],
    groups: ['西出口安防班组'],
    accessType: '刷卡门禁',
    coverage: '全覆盖',
    authorizedCount: 10,
  },
  {
    entrance: '南区1号口',
    posts: ['南区安防班'],
    groups: ['南出口安防班组'],
    accessType: '人脸门禁',
    coverage: '全覆盖',
    authorizedCount: 30,
  },
  {
    entrance: '中区检修通道',
    posts: ['中区安防班'],
    groups: ['中通道安防班组'],
    accessType: '双人双锁通道门',
    coverage: '重点覆盖',
    authorizedCount: 8,
  },
]

export function specOfEntrance(entrance: string): EntranceSpec | null {
  return ENTRANCE_REGISTRY.find((spec) => spec.entrance === entrance) ?? null
}

// 记录归属的标准写法：越权驳回、交接清单、隐患清单都复用这句，口径只有一个。
export function ownershipText(entrance: string): string {
  const spec = specOfEntrance(entrance)
  if (!spec) {
    return `${entrance}：未登记安防责任岗位`
  }
  return `${entrance}归属${spec.groups.join('、')}（责任岗位：${spec.posts.join('、')}）`
}

export type CheckSummary = {
  pointCode: string
  entrance: string
  checkDate: string
  conclusion: string
  checker: string
  issue?: string
}

// 交接清单文本只由这一个函数生成：门禁详情里的交接条目与值班交接清单逐字一致。
export function handoverText(summary: CheckSummary): string {
  const issue = summary.issue && summary.issue.trim() !== '' ? `，问题：${summary.issue.trim()}` : ''
  return `【门禁安防检查】${summary.pointCode}（${summary.entrance}）${summary.checkDate}检查结论：${summary.conclusion}${issue}；提交人：${summary.checker}；${ownershipText(summary.entrance)}`
}

export function isValidDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  return !Number.isNaN(Date.parse(value))
}

export function monthBucket(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date.slice(0, 7)
  }
  return '月份不详'
}
