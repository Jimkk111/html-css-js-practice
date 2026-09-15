/**
 * effect —— 副作用函数，响应式系统的「驱动器」。
 *
 * 一句话原理：effect 把「一个函数」包成「一段可被追踪、可被重新执行的代码」。
 *   effect(fn) 执行时，fn 里读到的所有响应式属性都会被记录到 fn 头上；
 *   将来任何一个被读过的属性发生变化，fn 就会自动重新执行。
 *
 * 这就是「响应式数据驱动视图」的全部秘密：
 *   组件的渲染函数本身就是一个 effect → 模板里用到哪些数据，就自动订阅了哪些数据。
 */
import { popActiveEffect, pushActiveEffect } from './dep.js'
import { isFunction } from '../shared/utils.js'

let uid = 0

export class ReactiveEffect {
  /**
   * @param {Function} fn 要执行的函数，通常是一个「组件的渲染逻辑」
   * @param {Function|null} scheduler 调度器：决定 fn 什么时候执行。
   *        不传 → 依赖变化时同步立刻重新执行；
   *        传入 → 依赖变化时调用 scheduler，由它决定时机（组件的渲染 effect 传的就是「放进异步队列」）
   */
  constructor(fn, scheduler = null) {
    this.fn = fn
    this.scheduler = scheduler
    this.id = uid++ // 自增 id，用于批量更新时给任务排序（父组件必须比子组件先更新）
    this.active = true
    this.deps = [] // 我依赖了哪些 dep（反向索引），用于 stop() 和重新执行前清理
  }

  run() {
    // 已经被 stop 的 effect 不再收集依赖，退化成普通函数调用
    if (!this.active) return this.fn()

    // 重新执行前先清空旧依赖，收集到的依赖永远是「上一次执行真正用到的那批」。
    // 否则 effect 里的 if 分支从 true 变成 false 后，旧分支读过的属性仍然会触发它。
    cleanupEffect(this)

    pushActiveEffect(this)
    let result
    try {
      result = this.fn()
    } finally {
      // 用 finally 保证即使 fn 抛错，activeEffect 也能恢复正确，不影响后续执行
      popActiveEffect()
    }
    return result
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) this.onStop()
      this.active = false
    }
  }
}

function cleanupEffect(effect) {
  const { deps } = effect
  for (let i = 0; i < deps.length; i++) {
    deps[i].delete(effect) // 从「属性 → effect」的集合里把自己删掉
  }
  deps.length = 0
}

/**
 * 创建并（默认立即）执行一个副作用函数。
 *
 * @returns runner 一个可以用 runner() 手动重新执行、用 runner.effect 访问内部状态、用 stop(runner) 停止的函数
 *
 * 支持的能力（都源自 Vue 的 ReactiveEffect）：
 *   lazy       不立即执行，只创建（组件的渲染 effect 就是这么干的，因为要先挂载再收集依赖）
 *   scheduler  自定义触发时机
 *   onStop     停止时的回调
 */
export function effect(fn, options = {}) {
  if (isFunction(options)) options = { scheduler: options } // effect(fn, fn2) 的简写
  const _effect = new ReactiveEffect(fn, options.scheduler)
  if (options.onStop) _effect.onStop = options.onStop
  _effect.lazy = !!options.lazy

  if (!_effect.lazy) _effect.run()

  const runner = _effect.run.bind(_effect)
  runner.effect = _effect
  return runner
}

/** 停止一个 effect：它依赖的数据再变化也不会触发它了（组件的 um 阶段会用到） */
export function stop(runner) {
  runner.effect.stop()
}
