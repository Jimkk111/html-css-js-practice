/**
 * computed —— 计算属性：基于依赖「缓存」的派生值。
 *
 * 关键设计：computed 内部也是一个 effect，但它有 scheduler。
 *
 *   getter 里的响应式数据变化时：
 *     普通 effect  → 立刻重新执行（eager，急着算）
 *     computed     → 只把 dirty 标记为 true（lazy，等真的有人来读 .value 才重算）
 *
 * 一次典型的访问链：
 *   render effect 读 computed.value
 *     → 若 dirty 为 true，执行 computed 的 effect 重新计算（此时 render effect 会成为 getter 里那些数据的间接依赖）
 *     → 同时把 render effect 收集进 computed 自己的 dep
 *   getter 依赖的数据变化
 *     → computed 的调度器被调用 → dirty = true → 再把 computed.dep 里的 render effect 全部触发 → 重新渲染
 *
 * 这就同时做到了两件事：
 *   1. 缓存：没人读、或依赖没变 → 一次都不多算；
 *   2. 惰性：依赖变了也不立刻算，等到被读取时才算是「最新值」。
 */
import { ReactiveEffect } from './effect.js'
import { trackEffects, triggerEffects } from './dep.js'
import { isFunction } from '../shared/utils.js'

export function computed(getterOrOptions) {
  // 支持两种写法：computed(fn) / computed({ get, set })（可写计算属性）
  let getter, setter
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
    setter = () => {
      console.warn('[vue-mini] 计算属性是只读的，想修改请传 set 方法')
    }
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set || (() => {})
  }
  return new ComputedRefImpl(getter, setter)
}

class ComputedRefImpl {
  constructor(getter, setter) {
    this.__v_isRef = true // 有 .value，所以它「长得像 ref」
    this.dep = new Set() // 谁读了我（通常是渲染 effect）
    this._setter = setter
    this._value = undefined
    /**
     * _dirty 是缓存的开关：
     *   true  → 下次读 .value 要重新计算
     *   false → 直接用缓存值
     * 初次为 true，保证第一次读取一定会算。
     */
    this._dirty = true

    // 把 getter 包成 effect：getter 读到的响应式数据会触发这个 effect。
    // 重点是 scheduler —— 它不重新执行 getter，而是「作废缓存 + 通知下游」。
    this.effect = new ReactiveEffect(getter, () => {
      if (!this._dirty) {
        this._dirty = true
        triggerEffects(this.dep) // 让读过我的渲染 effect 重新渲染
      }
    })
    this.effect.computed = this // 打标记，供 triggerEffects 优先调度
  }

  get value() {
    trackEffects(this.dep) // 先把自己收集给当前 effect（渲染 effect）
    if (this._dirty) {
      // 重新计算。effect.run() 内部会把「当前 effect」切换成 getter 的 effect，
      // 于是 getter 里读到的数据依赖被记在 computed 上，而不是渲染 effect 上 ——
      // 这正是「渲染 effect 只依赖 computed，不直接依赖那些源数据」的原因，也是缓存能生效的前提。
      this._value = this.effect.run()
      this._dirty = false
    }
    return this._value
  }

  set value(newValue) {
    this._setter(newValue)
  }
}

export const isComputed = r => !!(r && r.__v_isRef === true && r.effect && r.effect.computed)
