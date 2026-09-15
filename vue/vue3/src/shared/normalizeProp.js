import { isArray, isObject, isString } from './utils.js'

/**
 * class 的归一化：字符串 / 数组 / 对象 三种写法最终都变成字符串。
 *
 *   'a b'                → 'a b'
 *   ['a', { b: true }]   → 'a b'
 *   { a: true, b: false } → 'a'
 *
 * 为什么要在运行时归一化而不是编译期？因为 `<div :class="cls">` 里的 cls 是运行时的值，
 * 编译器只知道"这里有个动态 class"，不知道它具体是什么形态。
 * 这也是为什么 Vue 会把动态 class 单独用 PatchFlags.CLASS 标记：归一化有成本，要尽可能少做。
 */
export function normalizeClass(value) {
  let res = ''
  if (isString(value)) {
    res = value
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeClass(value[i])
      if (normalized) res += normalized + ' '
    }
  } else if (isObject(value)) {
    for (const name in value) {
      if (value[name]) res += name + ' '
    }
  }
  return res.trim()
}

/**
 * style 的归一化：数组 / 对象 / 字符串。
 *   [{ color: 'red' }, { fontSize: '12px' }] → 合并成一个对象
 *   'color: red'                              → 原样返回字符串（直接写 cssText）
 * 归一化后会剔除 null / undefined / 空字符串的项，方便 patchStyle 里做「删除」判断。
 */
export function normalizeStyle(value) {
  if (isArray(value)) {
    const res = {}
    for (let i = 0; i < value.length; i++) {
      const item = normalizeStyle(value[i])
      if (!item) continue
      if (isString(item)) {
        // 纯字符串没法合并，保持原样交给上层处理
        return value
      }
      Object.assign(res, item)
    }
    return res
  } else if (isString(value)) {
    return value
  } else if (isObject(value)) {
    const res = {}
    for (const key in value) {
      const val = value[key]
      if (val != null && val !== '') res[key] = val
    }
    return res
  }
  return ''
}
