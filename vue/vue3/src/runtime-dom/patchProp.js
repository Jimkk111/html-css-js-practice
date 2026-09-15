/**
 * patchProp —— 把一个属性/事件「打」到真实 DOM 上。
 *
 * 这是渲染器里最"接地气"的部分，要处理的差异特别多：
 *
 *   1. class   —— 数组/对象要归一化成字符串
 *   2. style   —— 对象/数组/字符串，且必须支持"删除某个样式"
 *   3. 事件    —— onClick 要 addEventListener；更新时必须复用监听器而不是叠加
 *   4. DOM 属性(property) vs HTML 属性(attribute) —— 两者行为不同：
 *                 attribute 是"初始值"，property 是"当前值"。
 *                 <input value="a"> 用户改成 b 之后，attribute 还是 "a"，但 property 已经是 "b"。
 *                 所以 value/checked 这些必须设 property，否则视图不更新。
 *   5. 布尔属性 —— HTML 里「有属性就算 true」，disabled="false" 依然是禁用的。
 *                 因此不能直接赋字符串，要区分「设」和「删」。
 *
 * 编译器已经帮我们跳过了所有静态属性（它们根本不会出现在 patch 里），
 * 这里处理的都是真正会变的动态部分。
 */
import { isArray, isOn, isString } from '../shared/utils.js'
import { normalizeClass, normalizeStyle } from '../shared/normalizeProp.js'

/** 必须走 DOM property 的键（写 attribute 不生效或行为不对） */
const mustUseProp = new Set([
  'value', 'checked', 'selected', 'muted',
  'innerHTML', 'textContent', 'innerText',
])

/** 布尔属性：值只表示"有没有" */
const booleanAttrs = new Set([
  'disabled', 'required', 'readonly', 'checked', 'selected', 'multiple',
  'hidden', 'open', 'loop', 'muted', 'controls', 'autoplay', 'novalidate',
  'itemscope', 'allowfullscreen', 'default', 'ismap',
])

export function patchProp(el, key, prevValue, nextValue) {
  if (key === 'class') return patchClass(el, nextValue)
  if (key === 'style') return patchStyle(el, prevValue, nextValue)
  if (isOn(key)) return patchEvent(el, key, prevValue, nextValue)
  return patchAttr(el, key, nextValue)
}

/** class：归一化成字符串后写 className */
function patchClass(el, value) {
  if (value == null) {
    el.removeAttribute('class')
  } else {
    // ★ 为什么不在编译期归一化？因为归一化需要知道运行时的值，
    //   而 :class 的值只有运行时才知道是什么形态（字符串/数组/对象）。
    //   这就是 Vue 把动态 class 单独用 PatchFlags.CLASS 标记的原因：归一化有成本，要少做。
    el.className = normalizeClass(value)
  }
}

/**
 * style 的更新，难点在「删除」。
 *
 *   旧 { color: 'red', fontSize: '12px' }  →  新 { fontSize: '12px' }
 *
 * 不能整体替换（我们要做的是逐个更新），而且"新对象里没有 color"
 * 意味着必须主动把 color 清掉，否则样式会残留。
 *
 * 处理方式：先设新样式，再遍历旧样式、把新样式里没有的设为空字符串 ——
 * 空串正是 CSSStyleDeclaration 的删除方式。
 */
function patchStyle(el, prevValue, nextValue) {
  const style = el.style

  if (nextValue == null) {
    el.removeAttribute('style')
    return
  }

  if (isString(nextValue)) {
    style.cssText = nextValue // 字符串直接当 cssText 用
    return
  }

  const next = normalizeStyle(nextValue) || {}
  const prev = normalizeStyle(prevValue)

  // 1. 设置 / 更新新样式
  for (const key in next) setStyle(style, key, next[key])

  // 2. 删除新样式里不存在的旧样式
  if (prev && typeof prev === 'object') {
    for (const key in prev) {
      if (!(key in next)) setStyle(style, key, '')
    }
  }
}

function setStyle(style, key, value) {
  if (key.startsWith('--')) {
    style.setProperty(key, value) // CSS 自定义属性必须用 setProperty
  } else if (value == null) {
    style[key] = ''
  } else {
    style[key] = value
  }
}

/**
 * 事件更新。
 *
 * ★ 为什么不能简单地 addEventListener 就完事？
 *   组件每次重新渲染，模板里的 @click="handler" 都会生成一个**全新的函数**
 *   （闭包捕获了这次渲染的最新状态）。如果每次都 addEventListener，
 *   监听器会不断累积 —— 点一次按钮，handler 被调用 N 次。这是最经典的泄漏 bug。
 *
 * Vue 的解法：不直接绑定用户的函数，而是绑定一个稳定的「调用器 invoker」：
 *
 *     el._invokers = { onClick: invoker }
 *     invoker = e => invoker.value(e)     ← 绑定到 DOM 的永远是这一个
 *     invoker.value = 用户的新函数          ← 更新时只换这个
 *
 *   于是无论渲染多少次，DOM 上的监听器始终只有一个。
 */
function patchEvent(el, key, prevValue, nextValue) {
  // props 名 → 真实事件名：
  //   onClick        → click
  //   onMousedown    → mousedown
  // DOM 事件名一律小写，所以这里可以直接 toLowerCase。
  // （组件自定义事件不走这里 —— 它们是组件的 props，由 component.js 的 emit 处理。）
  const name = key.slice(2).toLowerCase()

  const invokers = el._invokers || (el._invokers = Object.create(null))
  let invoker = invokers[name]

  if (nextValue == null) {
    // 新值为空 → 移除监听
    if (invoker) {
      el.removeEventListener(name, invoker)
      invokers[name] = null
    }
    return
  }

  if (!invoker) {
    // ★ 首次绑定：创建稳定的 invoker
    invoker = invokers[name] = e => {
      // 支持数组形式的多个处理器：@click="[fn1, fn2]"
      if (isArray(invoker.value)) {
        for (const fn of invoker.value) fn(e)
      } else {
        invoker.value(e)
      }
    }
    invoker.value = nextValue
    el.addEventListener(name, invoker)
  } else {
    // ★ 更新：只换 value，绝不重新 addEventListener —— 监听器数量恒为 1
    invoker.value = nextValue
  }
}

/** 普通属性 / 布尔属性 */
function patchAttr(el, key, value) {
  const isBoolean = booleanAttrs.has(key)

  if (value == null || value === false || (isBoolean && value === 'false')) {
    // 删除属性
    el.removeAttribute(key)
    if (mustUseProp.has(key) && key in el) {
      // property 不会因为 removeAttribute 复原，要显式清空
      el[key] = typeof el[key] === 'boolean' ? false : ''
    }
    return
  }

  if (isBoolean) {
    // ★ 布尔属性的关键：只要"有属性"就生效，所以设成空串（而不是字符串 'false'）
    el.setAttribute(key, '')
    return
  }

  if (mustUseProp.has(key) && key in el) {
    // value / checked / innerHTML 等必须写 property，否则视图不更新
    el[key] = value
    return
  }

  el.setAttribute(key, value)
}
