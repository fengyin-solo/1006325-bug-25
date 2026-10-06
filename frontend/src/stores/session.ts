import { defineStore } from 'pinia'

// 可切换的值班身份：门禁安防的提交/整改动作按「岗位 + 出入口」做归属校验。
export type SessionProfile = {
  name: string
  post: string
}

export const SESSION_PROFILES: SessionProfile[] = [
  { name: '值班管理员', post: '值班管理员' },
  { name: '周建国', post: '东区安防一班' },
  { name: '孙立峰', post: '东区安防二班' },
  { name: '李慧', post: '西区安防一班' },
  { name: '赵启明', post: '南区安防班' },
  { name: '陈默', post: '中区安防班' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    operatorPost: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    profile: (state): SessionProfile => ({ name: state.operator, post: state.operatorPost }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchProfile(profile: SessionProfile) {
      this.operator = profile.name
      this.operatorPost = profile.post
    },
  },
})
