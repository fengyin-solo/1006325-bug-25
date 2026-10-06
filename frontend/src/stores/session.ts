import { defineStore } from 'pinia'

// 岗位口径：门禁安防的写入授权按「出入口 -> 安防责任岗位」判定（见 api/access-domain.ts）。
export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    post: '一号口安防值班岗',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setPost(post: string) {
      this.post = post
    },
  },
})
