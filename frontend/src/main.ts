import { createApp } from 'vue'
import { createPinia } from 'pinia'

import { drainSyncQueue } from '@/api/access-service'
import { migrateAccessV1 } from '@/data/migrations'
import { readSchemaVersion, writeSchemaVersion } from '@/data/local-store'

import App from './App.vue'
import router from './router'
import './styles/global.css'

// 上线台账按 schema 版本迁移；旧版本（0）先跑 v1：门禁存量按检查月份分批对齐。
const CURRENT_SCHEMA = 1
if (readSchemaVersion() < CURRENT_SCHEMA) {
  migrateAccessV1(true)
  writeSchemaVersion(CURRENT_SCHEMA)
}
// 上次断线没走完的同步，启动时从第一条未成功的继续，不拿旧值顶（执行时回读最新正本）。
drainSyncQueue()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
