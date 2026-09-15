/**
 * 运行时帮助函数 —— 编译产物里那些 `_xxx(...)` 调用的实现。
 *
 * 编译器把模板翻译成 JS 代码，但有些工作需要运行时才知道答案，于是留成函数调用：
 *
 *     {{ msg }}          →  _toDisplayString(_ctx.msg)
 *     v-for="i in list"  →  _renderList(_ctx.list, (i) => ...)
 *     @click.stop="fn"   →  _withModifiers(_ctx.fn, ["stop"])
 *
 * 这些函数就是「编译产物」与「运行时」之间的接口契约 ——
 * 它们必须成对演进：编译器生成了什么调用，运行时就得提供什么实现。
 * 这也是为什么 Vue 的 @vue/compiler-core 和 @vue/runtime-core 版本号必须严格一致。
 */
import { isArray, isObject, isString, camelize } from '../shared/utils.js'
import { normalizeStyle as _normalizeStyle } from '../shared/normalizeProp.js'
import {
  Fragment,
  Text,
  Comment,
  createVNode,
  createBlock,
  createElementBlock,
  createElementVNode,
  createTextVNode,
  createCommentVNode,
  createStaticVNode,
  normalizeVNode,
  openBlock,
  setBlockTracking,
  resolveComponent,
} from './vnode.js'
import { renderSlot, withCtx } from './h.js'

/**
 * 插值的显示转换：{{ msg }}
 *
 * 为什么不能直接 String(msg)？因为要处理三类特殊值：
 *   null / undefined → 空字符串（直接显示 "undefined" 既丑也不符合预期）
 *   对象             → JSON.stringify（不然显示 [object Object]，完全没用）
 *   Symbol           → String() 对对象会抛错，对 Symbol 要用 toString()
 */
export function toDisplayString(value) {
  if (value == null) return ''
  if (isString(value)) return value
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * v-for 的运行时实现：把各种可迭代数据统一成「数组」，然后逐项渲染。
 *
 *   数组   → 逐项，参数 (item, index)
 *   数字 n → 1..n，参数 (value, index)    <li v-for="i in 5"> 得到 1..5
 *   字符串 → 逐字符
 *   对象   → 逐属性，参数 (value, key, index)   ★ 参数顺序和数组不一样
 *   可迭代 → 展开成数组（Map/Set）
 *
 * 返回值是 vnode 数组，外层会套一个 Fragment（一个 JS 表达式只能返回一个值）。
 * 每项的 key 由 v-for 的 :key 提供 —— 这就是 keyed diff 的输入。
 */
export function renderList(source, renderItem) {
  let ret
  if (isArray(source) || isString(source)) {
    ret = new Array(source.length)
    for (let i = 0, l = source.length; i < l; i++) {
      ret[i] = renderItem(source[i], i)
    }
  } else if (typeof source === 'number') {
    ret = new Array(source)
    for (let i = 0; i < source; i++) {
      ret[i] = renderItem(i + 1, i)
    }
  } else if (isObject(source)) {
    if (typeof source[Symbol.iterator] === 'function') {
      const arr = Array.from(source)
      ret = new Array(arr.length)
      for (let i = 0, l = arr.length; i < l; i++) {
        ret[i] = renderItem(arr[i], i)
      }
    } else {
      const keys = Object.keys(source)
      ret = new Array(keys.length)
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i]
        ret[i] = renderItem(source[key], key, i)
      }
    }
  } else {
    ret = []
  }
  return ret
}

/**
 * 事件修饰符的实现：@click.stop.prevent="fn" → _withModifiers(fn, ["stop", "prevent"])
 *
 * 返回一个包装函数：先按修饰符决定「要不要执行」，通过了才调用原处理器。
 *   stop / prevent   阻止冒泡 / 阻止默认行为
 *   self             e.target === e.currentTarget 才执行
 *   once             只执行一次（用闭包里的状态记录）
 *   ctrl/alt/shift/meta  对应的系统键必须按下
 *   enter/esc/tab/space/up/down/left/right/delete  按 e.key 匹配
 *   left/right/middle    按 e.button 匹配（鼠标键）
 *   capture/passive  是"注册期"语义，由 addEventListener 处理，这里忽略
 */
const KEY_MODIFIERS = {
  esc: 'Escape',
  space: ' ',
  up: 'ArrowUp',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  down: 'ArrowDown',
  delete: 'Backspace',
  enter: 'Enter',
  tab: 'Tab',
}
const isKeyModifier = mod => mod in KEY_MODIFIERS
const isSystemModifier = mod => ['ctrl', 'alt', 'shift', 'meta'].includes(mod)

export function withModifiers(fn, modifiers) {
  // once 需要"只执行一次"的状态，所以每次调用都返回一个带闭包的新函数
  const guard = { called: false }

  return function (event, ...args) {
    for (const mod of modifiers) {
      if (mod === 'once') {
        if (guard.called) return
        guard.called = true
        continue
      }
      if (isKeyModifier(mod)) {
        if (String(event.key) !== KEY_MODIFIERS[mod]) return
        continue
      }
      if (isSystemModifier(mod) && !event[`${mod}Key`]) return
      if (mod === 'exact') continue

      switch (mod) {
        case 'stop':
          event.stopPropagation()
          break
        case 'prevent':
          event.preventDefault()
          break
        case 'self':
          if (event.target !== event.currentTarget) return
          break
        case 'left':
        case 'right':
        case 'middle': {
          const button = mod === 'left' ? 0 : mod === 'middle' ? 1 : 2
          if ('button' in event && event.button !== button) return
          break
        }
      }
    }
    return fn(event, ...args)
  }
}

/** v-model.number 用：把输入值转成数字（转不动就保持原样） */
export function looseToNumber(val) {
  const n = parseFloat(val)
  return isNaN(n) ? val : n
}

export function toNumber(val) {
  return looseToNumber(val)
}

/**
 * class 的归一化（编译产物在生成 props 时会先调用一次，
 * 见 transform.js 里 :class 的处理 —— 运行时 patchProp 拿到的已经是字符串）。
 */
export function normalizeClass(value) {
  if (isString(value)) return value
  if (isArray(value)) {
    let res = ''
    for (const v of value) {
      const n = normalizeClass(v)
      if (n) res += (res ? ' ' : '') + n
    }
    return res
  }
  if (isObject(value)) {
    let res = ''
    for (const k in value) if (value[k]) res += (res ? ' ' : '') + k
    return res
  }
  return value == null ? '' : String(value)
}

/**
 * RUNTIME_HELPERS —— 「编译器 ↔ 运行时」契约的具体形式。
 * 编译产物里的 `_toDisplayString` 就是从这张表里取值的。
 * 新增一个编译特性时，必须同时在编译器和这张表里加东西，
 * 否则就会出现 "xxx is not a function" 这类版本不匹配错误。
 */
export const RUNTIME_HELPERS = {
  openBlock,
  closeBlock: () => {}, // 块由 setupBlock 统一收尾，这里留个空实现
  setBlockTracking,
  createElementBlock,
  createBlock,
  createElementVNode,
  createVNode,
  createTextVNode,
  createCommentVNode,
  createStaticVNode,
  Fragment,
  Text,
  Comment,
  resolveComponent,
  renderSlot,
  withCtx,
  renderList,
  toDisplayString,
  withModifiers,
  normalizeClass,
  normalizeStyle: _normalizeStyle,
  looseToNumber,
  guardReactiveProps: props => (isObject(props) ? props : null),
}

export { Fragment, createVNode, createTextVNode, createCommentVNode, normalizeVNode }
