/**
 * instance.js —— 「当前正在处理的组件实例」这个全局上下文。
 *
 * 为什么要单独一个文件、而且不 import 任何东西？
 * 因为它是 component.js 和 lifecycle.js 共同的依赖：
 *   component.js 需要设置/读取它；lifecycle.js 需要读取它（onMounted 要挂到当前实例上）。
 * 如果放在 component.js 里，lifecycle.js 就得 import component.js，而 component.js 又要
 * import lifecycle.js 来触发钩子 —— 循环依赖。
 *
 * 把这种「被所有人依赖、自己谁也不依赖」的最小状态单独抽出来，是打破循环依赖最常用的手法。
 * Vue 源码里的 currentInstance 也是这么处理的（放在 component.ts 顶层，lifecycle.ts 反向引用）。
 */
export let currentInstance = null

export function getCurrentInstance() {
  return currentInstance
}

/**
 * 设置当前实例，并返回一个「恢复函数」。
 * 用返回函数而不是成对调用 set/unset，是因为 setup 可能抛错，
 * 调用方可以用 try/finally 保证上下文一定被恢复。
 */
export function setCurrentInstance(instance) {
  const prev = currentInstance
  currentInstance = instance
  return () => {
    currentInstance = prev
  }
}
