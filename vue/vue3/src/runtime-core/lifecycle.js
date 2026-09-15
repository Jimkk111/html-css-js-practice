/**
 * 生命周期钩子注册。
 *
 * 这个文件能解释一个很多人疑惑的问题：
 *   「为什么 onMounted 可以直接调用，不需要传组件实例？」
 *
 * 答案：组件 setup 执行期间，全局变量 currentInstance 指向当前组件。
 * onMounted(fn) 做的事就是「把 fn 追加到 currentInstance 的某个数组里」。
 * 所以生命周期 API 必须写在 setup() 的同步执行过程中 —— 放进 setTimeout 里，
 * currentInstance 已经被恢复成 null，就会报「生命周期钩子只能在 setup 里调用」。
 */
import { currentInstance } from './instance.js'

/** 钩子名 → 实例上存放回调的数组字段名。用两个字母是为了少占内存（和学习源码的写法一致） */
export const LifecycleHooks = {
  BEFORE_MOUNT: 'bm',
  MOUNTED: 'm',
  BEFORE_UPDATE: 'bu',
  UPDATED: 'u',
  BEFORE_UNMOUNT: 'bum',
  UNMOUNTED: 'um',
}

export function injectHook(type, hook, target = currentInstance, prepend = false) {
  if (!target) {
    console.warn(`[vue-mini] 生命周期钩子 ${type} 只能在 setup() 内同步调用`)
    return
  }
  if (!target[type]) target[type] = []
  if (prepend) target[type].unshift(hook)
  else target[type].push(hook)
  return hook
}

export const onBeforeMount = hook => injectHook(LifecycleHooks.BEFORE_MOUNT, hook)
export const onMounted = hook => injectHook(LifecycleHooks.MOUNTED, hook)
export const onBeforeUpdate = hook => injectHook(LifecycleHooks.BEFORE_UPDATE, hook)
export const onUpdated = hook => injectHook(LifecycleHooks.UPDATED, hook)
export const onBeforeUnmount = hook => injectHook(LifecycleHooks.BEFORE_UNMOUNT, hook)
export const onUnmounted = hook => injectHook(LifecycleHooks.UNMOUNTED, hook)

/**
 * 按顺序执行一组钩子。
 * 用「数组」存钩子而不是单个函数，是因为一个组件可以注册多个同类型钩子，
 * 且要保证注册顺序（内层组件未 mounted 完，外层不会 mounted —— 这条通过调用顺序保证）。
 */
export function invokeArrayFns(fns, arg) {
  if (!fns) return
  for (let i = 0; i < fns.length; i++) {
    fns[i](arg)
  }
}
