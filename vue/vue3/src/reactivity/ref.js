/**
 * ref —— 把「原始值」也变成响应式。
 *
 * 为什么需要它？reactive 基于 Proxy，只对「对象」有效：
 *
 *     let count = 0
 *     effect(() => console.log(count))   // 读的是普通变量，Proxy 无从拦截 → 不会更新
 *
 * 但只要把值包进一个对象，读写就会经过 get/set，于是能复用和 reactive 完全相同的 track/trigger 机制：
 *
 *     const count = ref(0)                    // 内部是 { value: 0 }
 *     effect(() => console.log(count.value))  // 读 .value 时收集依赖 → 能更新
 *
 * 两个细节：
 *   1. ref 的值如果是对象，内部会调用 reactive 深层代理（toReactive），
 *      所以 ref({a:1}) 改 .value.a 也能触发更新；
 *   2. 模板里写 {{ count }} 不用写 .value —— 模板编译阶段会自动解包（见 compiler 的 codegen）。
 *      而 JS 里必须写 .value，这曾是 Vue 3 最大的争议点。
 */
import { trackEffects, triggerEffects } from './dep.js'
import { hasChanged, isObject } from '../shared/utils.js'
import { reactive } from './reactive.js'

/**
 * 判断是不是 ref。
 * 用 __v_isRef 这个「品牌标记」而不是 instanceof RefImpl：
 * 在多个 Vue 副本 / 跨模块、跨 iframe 的场景下 instanceof 会失效，标记法永远可靠。
 */
export const isRef = r => !!(r && r.__v_isRef === true)

/** 值如果是对象就转成 reactive，否则原样返回 */
export const toReactive = value => (isObject(value) ? reactive(value) : value)

class RefImpl {
  constructor(value, shallow) {
    this.__v_isRef = true
    this._rawValue = value // 原始值，用于「有没有变」的比较
    this._shallow = shallow
    this._value = shallow ? value : toReactive(value) // 给外部读到的值
    // ref 自己就是一个「依赖容器」：谁读过我的 .value，就存在这里。
    // 用 Set 而不是 Map，因为 ref 只有一个 key（value），不需要按属性区分。
    this.dep = new Set()
  }

  get value() {
    trackEffects(this.dep)
    return this._value
  }

  set value(newVal) {
    // 必须比较 _rawValue 而不是 _value：
    // ref(原始对象) 时 _value 是 Proxy，newVal 是原始对象，比 _value 会永远不相等 → 每次都误触发
    if (hasChanged(newVal, this._rawValue)) {
      this._rawValue = newVal
      this._value = this._shallow ? newVal : toReactive(newVal)
      triggerEffects(this.dep)
    }
  }
}

/** 创建响应式引用：ref(1).value / ref({}).value.a */
export function ref(value) {
  return new RefImpl(value, false)
}

/** 浅 ref：.value 本身是响应式的，但 .value 里的对象属性不是（避免大对象/第三方实例被深度代理） */
export function shallowRef(value) {
  return new RefImpl(value, true)
}

/**
 * 对象属性 → ref 的「转发器」。
 * 它自身不存值，读写都转发给原对象，所以和原对象天然双向联动。
 */
class ObjectRefImpl {
  constructor(object, key) {
    this.__v_isRef = true
    this._object = object
    this._key = key
  }
  get value() {
    return this._object[this._key] // 读原对象 → 由原对象的 Proxy 收集依赖
  }
  set value(newVal) {
    this._object[this._key] = newVal // 写原对象 → 由原对象的 Proxy 派发更新
  }
}

/** 把对象的某个属性变成 ref（值本身就是 ref 的话原样返回） */
export function toRef(object, key) {
  const val = object[key]
  return isRef(val) ? val : new ObjectRefImpl(object, key)
}

/**
 * 把响应式对象的每个属性都变成 ref：
 *   const { x, y } = toRefs(reactive({ x: 1, y: 2 }))
 * 用途：把单个属性解构出来传递 / 返回时，仍然保持响应式。
 * （直接 const { x } = reactiveObj 会把「值」解构出来，立刻失去响应性 —— 这是新手最常见的坑之一。）
 */
export function toRefs(object) {
  const ret = {}
  for (const key in object) {
    ret[key] = toRef(object, key)
  }
  return ret
}

/** 取出 ref 的值；不是 ref 就原样返回 */
export const unref = r => (isRef(r) ? r.value : r)

/**
 * proxyRefs —— 自动「解包」ref 的代理。
 *
 * 生活场景：setup 返回 { count: ref(0) }，但模板里想直接写 {{ count }} 而不是 {{ count.value }}。
 * 于是用一个 Proxy 把「读 get 时解包、写 set 时写回 ref.value」，让 ref 用起来像普通属性。
 *
 *     读：count      → refImpl.value        （自动 .value）
 *     写：count = 1  → refImpl.value = 1    （自动 .value）
 *
 * 组件的 setupState 用的就是这个 —— 所以模板里从来不写 .value，
 * 而 JS 里必须写，这个不一致的根源就在这里。
 */
export function proxyRefs(objectWithRefs) {
  return new Proxy(objectWithRefs, {
    get(target, key, receiver) {
      return unref(Reflect.get(target, key, receiver))
    },
    set(target, key, value, receiver) {
      const oldValue = target[key]
      if (isRef(oldValue) && !isRef(value)) {
        oldValue.value = value // 写回 ref 内部，保持响应式
        return true
      }
      return Reflect.set(target, key, value, receiver)
    },
  })
}
