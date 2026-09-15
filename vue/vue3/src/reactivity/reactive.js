/**
 * reactive —— 基于 Proxy 的非原始值响应式方案。
 *
 * 为什么是 Proxy 而不是 Object.defineProperty？
 *   1. defineProperty 只能劫持「已存在的属性」，新增属性 / 删除属性 / 数组下标都无能为力，
 *      所以 Vue 2 要额外提供 Vue.set（$set）并且重写数组的 7 个方法；
 *   2. Proxy 拦截的是「整个对象的操作」（get/set/has/deleteProperty/ownKeys...），
 *      新增属性、for...in、in 运算符、数组下标全部天然被覆盖；
 *   3. defineProperty 在初始化时必须递归遍历整个对象，Proxy 是「读到时才代理」（惰性），
 *      大对象初始化更快。
 *
 * 本文件的三个关键点，也是《Vue.js设计与实现》第五章的重点：
 *   1. Reflect + receiver：把「谁在读」正确传递下去，让继承 + 访问器属性也能工作；
 *   2. 数组：length 的联动、遍历、以及 push 等方法的自触发问题；
 *   3. 惰性深层代理：读到的值还是对象，才继续 reactive。
 */
import {
  ITERATE_KEY,
  TriggerType,
  peekDepsMap,
  pauseTracking,
  resetTracking,
  track,
  trigger,
} from './dep.js'
import { hasChanged, hasOwn, isArray, isIntegerKey, isObject } from '../shared/utils.js'

/** 内部标记，用于识别代理对象 & 取回原始对象，避免同一个对象被代理多次 */
const ReactiveFlags = {
  IS_REACTIVE: '__v_isReactive',
  RAW: '__v_raw',
}

/**
 * raw → proxy 的缓存。
 * 作用：同一个原始对象多次 reactive() 必须返回同一个 Proxy。
 * 否则 { a: reactive(obj), b: reactive(obj) } 里两个引用不相等，
 * 依赖收集也会记成两份，导致「改一个另一个不更新」。
 */
const reactiveMap = new WeakMap()

/**
 * 数组方法的「仪表化」（instrumentation）。
 *
 * 要解决两个问题：
 *  A. arr.push(x) 之后，之前的 arr.includes(x) 必须重新执行 —— 因为 push 内部读了 length，
 *     如果不处理，读 length 就收集到了依赖，写 length 又触发自己 → 无限递归。
 *     解决：执行这些方法期间关掉依赖收集（pauseTracking）。
 *  B. 严格相等比较时，代理对象和原始对象不相等：
 *     reactiveArr.includes(原始对象) 会返回 false。解决：兜底用原始对象再找一次。
 */
function createArrayInstrumentations() {
  const instrumentations = {}

  // A. 会修改数组长度的方法：执行期间暂停收集
  ;['push', 'pop', 'shift', 'unshift', 'splice'].forEach(key => {
    instrumentations[key] = function (...args) {
      pauseTracking()
      // 1. toRaw(this)[key] 拿到的是原始 Array.prototype 上的方法（不会二次进入这里，避免递归）
      // 2. apply 的 this 仍然传 Proxy，这样方法内部对元素的读写照旧走代理 → 该触发的依赖照样触发
      const res = toRaw(this)[key].apply(this, args)
      resetTracking()
      return res
    }
  })

  // B. 查找类方法：先把「数组每一项 + length」都收集一遍，再用原始值兜底比较
  ;['includes', 'indexOf', 'lastIndexOf'].forEach(key => {
    instrumentations[key] = function (...args) {
      const arr = toRaw(this)
      for (let i = 0, l = arr.length; i < l; i++) {
        track(arr, i + '') // 数组内容变了要重新执行查找
      }
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // 没找到，可能是"原始对象 vs 代理对象"的差异，用原始值再来一次
        return arr[key](...args.map(toRaw))
      }
      return res
    }
  })

  return instrumentations
}

const arrayInstrumentations = createArrayInstrumentations()

function createHandler(shallow) {
  return {
    /**
     * 读取拦截。
     * 三件事：处理内部标记 → 收集依赖 → 惰性递归代理。
     */
    get(target, key, receiver) {
      // 内部标记不能触发依赖收集，否则会污染依赖关系
      if (key === ReactiveFlags.RAW) return target
      if (key === ReactiveFlags.IS_REACTIVE) return true

      // 数组的特殊方法（push/pop/includes...）走我们包装过的版本
      if (isArray(target) && hasOwn(arrayInstrumentations, key)) {
        return Reflect.get(arrayInstrumentations, key, receiver)
      }

      const res = Reflect.get(target, key, receiver)

      // 数组用 for...of / 展开运算符时读的是 Symbol.iterator，它本身不是业务数据，
      // 但结果依赖「数组长度」，所以收集 ITERATE_KEY：新增/删除元素时能重新执行。
      if (isArray(target) && key === Symbol.iterator) {
        track(target, ITERATE_KEY)
        return res
      }
      // 其他与业务无关的 key（构造函数、原型、非数组上的 symbol）不收集
      if (key === 'constructor' || key === '__proto__' || (typeof key === 'symbol' && !isArray(target))) {
        return res
      }

      track(target, key)

      // 惰性深层代理：只有真正读到的值还是对象时，才继续包一层 Proxy。
      // 好处：不用初始化时递归遍历整个对象；代价：每次读取都要判断。
      if (!shallow && isObject(res)) {
        return reactive(res)
      }
      return res
    },

    /**
     * 写入拦截。
     * 难点是「什么时候该派发更新」：
     *   - 值没变（Object.is 相等）不派发，避免无意义的重渲染；
     *   - 只有操作的是「自己」才派发。比如 const child = Object.create(reactiveParent)，
     *     修改 child 上继承来的属性时，set 会先在子对象上找不到而顺着原型链在父对象上执行，
     *     此时 receiver 是子对象、target 是父对象，不应该触发父对象的依赖。
     */
    set(target, key, value, receiver) {
      const oldValue = target[key]

      // 数组：key 是已存在的下标 → SET，是越界下标 → ADD（会同时改变 length）
      const hadKey = isArray(target) && isIntegerKey(key) ? Number(key) < target.length : hasOwn(target, key)
      const type = hadKey ? TriggerType.SET : TriggerType.ADD

      const result = Reflect.set(target, key, value, receiver)

      // toRaw(receiver) === target 说明这次写入作用在 target 自己身上（而不是它的原型链上）
      if (toRaw(receiver) === target) {
        if (!hadKey) {
          trigger(target, key, TriggerType.ADD, value)
        } else if (hasChanged(value, oldValue)) {
          trigger(target, key, type, value)
        }
      }
      return result
    },

    /** in 运算符：Object 上按 key 收集，数组上按 length 收集（数组内容变化影响 in 的结果） */
    has(target, key) {
      track(target, key)
      return Reflect.has(target, key)
    },

    /** 删除属性：会减少属性数量，for...in 的结果变了 */
    deleteProperty(target, key) {
      const hadKey = hasOwn(target, key)
      const result = Reflect.deleteProperty(target, key)
      if (result && hadKey) {
        trigger(target, key, TriggerType.DELETE)
      }
      return result
    },

    /** for...in / Object.keys / Object.getOwnPropertyNames 的拦截 */
    ownKeys(target) {
      track(target, ITERATE_KEY)
      return Reflect.ownKeys(target)
    },
  }
}

const mutableHandlers = createHandler(false)
const shallowReactiveHandlers = createHandler(true)

/** 浅响应式同样需要 raw → proxy 缓存，理由和深响应式一致 */
const shallowReactiveMap = new WeakMap()

function createReactiveObject(target, handlers, proxyMap) {
  // 只能代理对象
  if (!isObject(target)) {
    return target
  }
  // 已经是代理了，直接用（避免 reactive(reactive(obj)) 多层套娃）
  if (target[ReactiveFlags.IS_REACTIVE]) {
    return target
  }
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  const proxy = new Proxy(target, handlers)
  proxyMap.set(target, proxy)
  return proxy
}

/** 深层响应式对象：任何层级的属性读写都是响应式的 */
export function reactive(target) {
  return createReactiveObject(target, mutableHandlers, reactiveMap)
}

/** 浅响应式对象：只有第一层属性是响应式的（组件的 props 用它） */
export function shallowReactive(target) {
  return createReactiveObject(target, shallowReactiveHandlers, shallowReactiveMap)
}

/** 判断是不是 reactive 产生的代理对象 */
export function isReactive(value) {
  return !!(value && value[ReactiveFlags.IS_REACTIVE])
}

/** 代理对象 → 原始对象；不是代理就原样返回 */
export function toRaw(observed) {
  const raw = observed && observed[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

/**
 * 调试用：查看某个对象收集到了哪些依赖。
 * ★ 账本的键是「原始对象」，而外部一般拿到的是 Proxy —— 必须先 toRaw 再查，
 *   否则永远查不到。（放在本文件而不是 dep.js，就是为了能用 toRaw。）
 */
export function debugDeps(target) {
  const depsMap = peekDepsMap(toRaw(target))
  if (!depsMap) return '（无依赖）'
  const out = {}
  depsMap.forEach((dep, key) => {
    out[String(key)] = [...dep].map(e => `effect#${e.id}`)
  })
  return out
}
