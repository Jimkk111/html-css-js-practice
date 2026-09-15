/**
 * 依赖收集与派发（track / trigger）—— 响应式系统的「账本」。
 *
 * 核心数据结构：
 *
 *   targetMap: WeakMap< 原始对象, Map< 属性名, Set<ReactiveEffect> > >
 *
 *   {
 *     { count: 0 } → {                          ← 一个响应式对象
 *        "count" → Set { effectA, effectB },    ← 读取过 count 的副作用函数
 *        Symbol(iterate) → Set { effectC }      ← for...in / Object.keys 过的
 *     }
 *   }
 *
 * 为什么第一层用 WeakMap：target 不再被引用时可以整体回收，不会内存泄漏。
 *
 * 职责边界：
 *   track   —— 读属性时调用，记录「谁读了我」
 *   trigger —— 写属性时调用，通知「读过我的人重新执行」
 */
import { isArray, isIntegerKey } from '../shared/utils.js'

const targetMap = new WeakMap()

/** 当前正在执行的 effect，也就是「谁在读数据」。为 null 表示在 effect 之外的普通读取，不需要收集 */
let activeEffect = null

/** effect 是允许嵌套的（组件 A 的渲染里渲染组件 B），用栈保证内层跑完能恢复外层 */
const effectStack = []

/**
 * 是否允许收集依赖。
 * push / pop / shift / unshift / splice 这类数组方法内部会「先读 length，再写 length」，
 * 如果正常收集，effect 就会依赖自己刚改的东西 → 无限递归。处理方法：执行这些方法期间临时关掉收集。
 */
let shouldTrack = true

/** for...in / Object.keys() 这类「整体遍历」用的特殊 key */
export const ITERATE_KEY = Symbol('iterate')

/**
 * 触发类型。区分 SET / ADD / DELETE 是因为它们要额外通知的对象不同：
 *   新增属性 → for...in 的结果变了，要通知 ITERATE_KEY 的依赖
 *   删改数组 → 数组长度变了，要通知 length 的依赖
 */
export const TriggerType = {
  SET: 'set',
  ADD: 'add',
  DELETE: 'delete',
}

export function getActiveEffect() {
  return activeEffect
}
export function pauseTracking() {
  shouldTrack = false
}
export function resetTracking() {
  shouldTrack = true
}
export function pushActiveEffect(effect) {
  effectStack.push(effect)
  activeEffect = effect
}
export function popActiveEffect() {
  effectStack.pop()
  activeEffect = effectStack[effectStack.length - 1]
}

/**
 * 收集依赖：把「当前正在执行的 effect」记到 target 的 key 下面。
 */
export function track(target, key) {
  if (!activeEffect || !shouldTrack) return

  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    // 反向记录：effect 也保存「我依赖了哪些 dep」，方便 stop / 重新执行前清理旧依赖
    activeEffect.deps.push(dep)
  }
}

/**
 * 派发更新：让所有依赖了 target[key] 的 effect 重新执行。
 *
 * @param {object} target 原始对象（注意是原始对象，不是 Proxy）
 * @param {string|symbol} key 属性名
 * @param {string} type TriggerType
 * @param {any} newValue 新值，数组 length 变小时需要它来决定哪些下标的依赖要触发
 */
export function trigger(target, key, type = TriggerType.SET, newValue) {
  const depsMap = targetMap.get(target)
  if (!depsMap) return // 这个对象从来没被任何 effect 读过，不需要通知

  const effects = new Set()
  const addEffects = deps => {
    if (deps) deps.forEach(effect => effects.add(effect))
  }

  if (key === 'length' && isArray(target)) {
    // 直接把数组改短了：所有下标 >= 新长度的依赖都必须重新执行（那些元素已经不存在了）
    depsMap.forEach((dep, depKey) => {
      if (depKey === 'length' || depKey >= newValue) addEffects(dep)
    })
  } else {
    if (key !== void 0) addEffects(depsMap.get(key))

    switch (type) {
      case TriggerType.ADD:
        if (!isArray(target)) {
          // 对象新增属性 → for...in / Object.keys 的结果变了
          addEffects(depsMap.get(ITERATE_KEY))
        } else if (isIntegerKey(key)) {
          // 数组新增元素 → 虽然没显式写 length，但 length 客观变了，要通知读 length 的 effect
          // （这就是为什么 arr[2] = 3 能让 {{ arr.length }} 更新）
          addEffects(depsMap.get('length'))
          addEffects(depsMap.get(ITERATE_KEY))
        }
        break
      case TriggerType.DELETE:
        if (!isArray(target)) {
          addEffects(depsMap.get(ITERATE_KEY))
        } else {
          addEffects(depsMap.get('length'))
          addEffects(depsMap.get(ITERATE_KEY))
        }
        break
      case TriggerType.SET:
        if (isArray(target) && isIntegerKey(key)) {
          // 改元素不影响 length，但 for...of 遍历数组时依赖 ITERATE_KEY
          addEffects(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  effects.forEach(effect => {
    // 正在执行的 effect 触发了自己，会造成无限递归（effect 里写了它依赖的属性），直接忽略
    triggerEffect(effect)
  })
}

/** 调试用：打印某个对象当前收集到的依赖关系。
 *  ★ 实现在 reactive.js —— 账本的键是「原始对象」，外部拿到的一般是 Proxy，
 *    需要先 toRaw 再查，而 toRaw 定义在 reactive.js（避免互相 import）。
 *    本文件只提供一个"按原始对象查账本"的内部访问器。
 */
export function peekDepsMap(rawTarget) {
  return targetMap.get(rawTarget)
}

/**
 * 下面两个函数是 track / trigger 的「只操作一个 Set 的版本」。
 *
 * 为什么需要它们？track/trigger 是按「对象 + 属性」组织的（Map<key, Set>），
 * 但有些响应式数据没有「属性」这个概念：
 *   ref    —— 只有一个 .value
 *   计算属性 —— 只有一个 .value
 * 它们自己持有一个 dep（Set），于是直接复用这两个函数，不必硬塞进 targetMap。
 */
export function trackEffects(dep) {
  if (!activeEffect || !shouldTrack) return
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    activeEffect.deps.push(dep)
  }
}

export function triggerEffects(dep) {
  const effects = new Set(dep)
  // 先执行 computed：如果一个渲染 effect 依赖了 computed，而 computed 也依赖了这个数据，
  // 必须先让 computed 重新计算，渲染 effect 才能读到新值。
  effects.forEach(effect => {
    if (effect.computed) triggerEffect(effect)
  })
  effects.forEach(effect => {
    if (!effect.computed) triggerEffect(effect)
  })
}

export function triggerEffect(effect) {
  if (effect !== activeEffect) {
    if (effect.scheduler) effect.scheduler(effect)
    else effect.run()
  }
}
