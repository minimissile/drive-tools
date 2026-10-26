/** Official destinations referenced by the publishing-rights guide. Never accept arbitrary URLs. */
export const zhidaoAccountPages = {
  home: "https://zhidao.baidu.com/",
  answer: "https://zhidao.baidu.com/hd/21th_activity/",
  quota: "https://zhidao.baidu.com/b/batch/batch-upload",
} as const;
export type ZhidaoAccountPage = keyof typeof zhidaoAccountPages;
