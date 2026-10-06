import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：业务数据放在 localStorage 里，刷新、关掉再打开都还在。
// 模块台账共用 entries 键；门禁域的检查结论、同步队列、迁移日志、同步设置各占一个键，
// 切回后端时每个键对应一张表/一个接口，页面不用改。
export const STORAGE_KEY = 'urban-utility-tunnel:entries'
export const CHECKS_KEY = 'urban-utility-tunnel:access-checks'
export const SYNC_QUEUE_KEY = 'urban-utility-tunnel:access-sync-queue'
export const SYNC_STATE_KEY = 'urban-utility-tunnel:access-sync-state'
export const MIGRATION_KEY = 'urban-utility-tunnel:migrations'
export const SCHEMA_KEY = 'urban-utility-tunnel:schema-version'
export const SCHEMA_VERSION = 1

// 数据变更总线：页面订阅后重取正本，列表/详情/导出自然一致；跨标签页靠 storage 事件一并兜住。
export type StoreChange =
  | { scope: 'entries'; key: string }
  | { scope: 'collection'; key: string }
  | { scope: 'sync' }

type Listener = (change: StoreChange) => void
const listeners = new Set<Listener>()

function emit(change: StoreChange): void {
  listeners.forEach((listener) => listener(change))
}

export function subscribeStore(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 每个存储键各自缓存，互不覆盖；任何键被改动都让对应缓存失效，杜绝「改了正本、详情读旧值」。
const entryCache: { value: Record<string, EntryRow[]> | null } = { value: null }
const collectionCache = new Map<string, unknown>()

function readJSON<T>(key: string): T | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (raw === null) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJSON(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

export function readSchemaVersion(): number {
  return readJSON<number>(SCHEMA_KEY) ?? 0
}

export function writeSchemaVersion(version: number): void {
  writeJSON(SCHEMA_KEY, version)
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 以种子模块为底合并：种子是各模块的初始版本，台账只在自己键内演进，不做整体覆盖。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (entryCache.value === null) {
    entryCache.value = readStorage()
  }
  return entryCache.value
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[], silent = false): void {
  const next = { ...allRows(), [key]: rows }
  entryCache.value = next
  writeJSON(STORAGE_KEY, next)
  if (!silent) {
    emit({ scope: 'entries', key })
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 门禁域的集合型数据（检查结论、同步队列、迁移日志、同步设置）走同一套读写口径。
export function readCollection<T>(key: string, fallback: T): T {
  if (!collectionCache.has(key)) {
    collectionCache.set(key, readJSON<T>(key) ?? clone(fallback))
  }
  return clone(collectionCache.get(key) as T)
}

export function writeCollection<T>(key: string, value: T, silent = false): T {
  collectionCache.set(key, clone(value))
  writeJSON(key, value)
  if (!silent) {
    emit(key === SYNC_QUEUE_KEY || key === SYNC_STATE_KEY ? { scope: 'sync' } : { scope: 'collection', key })
  }
  return value
}

// 其它标签页写入时本标签的缓存全部失效，回读时取的都是最新正本，不拿旧缓存顶上。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.key) {
      return
    }
    if (event.key === STORAGE_KEY) {
      entryCache.value = null
      emit({ scope: 'entries', key: '*' })
      return
    }
    if (collectionCache.has(event.key)) {
      collectionCache.delete(event.key)
      emit(
        event.key === SYNC_QUEUE_KEY || event.key === SYNC_STATE_KEY
          ? { scope: 'sync' }
          : { scope: 'collection', key: event.key },
      )
    }
  })
}
