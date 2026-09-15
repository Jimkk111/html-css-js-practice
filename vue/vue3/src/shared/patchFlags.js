/**
 * PatchFlags —— 编译器留给运行时的「更新提示」，是「编译优化 / 靶向更新」的核心。
 *
 * 要解决的问题：手写 render 函数生成的 vnode 没有元信息，运行时只能把新旧 props 全量比一遍。
 * 但模板是**可以静态分析**的 —— 编译器一眼就能看出哪些是常量、哪些会变：
 *
 *     <div class="static" :id="dynamicId">hello</div>
 *                        └── 只有 id 是动态的
 *
 * 于是编译产物里给这个 vnode 带上 patchFlag = PROPS 和 dynamicProps = ["id"]。
 * 更新时运行时只需要动 id 一个属性，class 连看都不用看 —— O(属性数) 变成 O(动态属性数)。
 *
 * 命名习惯：真实 Vue 里这些常量值就是下面这些数字，注释里标注出来，
 * 方便你在看编译产物（__file、vue-jsx、SFC playground）时一一对应。
 *
 * 负数不是位掩码，而是「特殊标记」：
 *   HOISTED = -1 → 静态提升的节点，更新时整棵跳过
 *   BAIL    = -2 → 放弃优化，走全量 diff
 */
export const PatchFlags = {
  TEXT: 1, //              1  动态文本子节点
  CLASS: 1 << 1, //        2  动态 class（单独标记，因为归一化开销大）
  STYLE: 1 << 2, //        4  动态 style
  PROPS: 1 << 3, //        8  有动态属性，具体是哪些看 vnode.dynamicProps
  FULL_PROPS: 1 << 4, //  16  属性集合本身是动态的（v-bind="obj" 展开），必须全量对比
  NEED_HYDRATION: 1 << 5, // 32  SSR 注水用（本项目不涉及，保留占位）
  STABLE_FRAGMENT: 1 << 6, // 64 子节点顺序稳定的 fragment
  KEYED_FRAGMENT: 1 << 7, // 128 带 key 的 fragment（v-for 有 key）→ 走 keyed diff
  UNKEYED_FRAGMENT: 1 << 8, // 256 不带 key 的 fragment → 走简单 diff
  NEED_PATCH: 1 << 9, //  512 只需要 patch 自身（带运行时指令、ref 等）
  DYNAMIC_SLOTS: 1 << 10, // 1024 动态插槽
  DEV_ROOT_FRAGMENT: 1 << 11, // 2048 dev 专用

  // 特殊标记
  HOISTED: -1,
  BAIL: -2,
}

/**
 * 把 patchFlag 转成人类可读的名字，方便在 demo / 编译产物里展示。
 * 编译产物里那种 `1 /* TEXT *\/` 的注释就是这么来的。
 */
export function describePatchFlag(flag) {
  if (flag === 0) return '0（无优化信息，需要全量 diff）'
  if (flag < 0) {
    return flag === PatchFlags.HOISTED ? '-1（HOISTED 静态提升）' : '-2（BAIL 放弃优化）'
  }
  const names = Object.entries(PatchFlags)
    .filter(([, v]) => v > 0 && (flag & v) === v)
    .map(([k]) => k)
  return `${flag}（${names.join(' | ') || '未知'}）`
}
