/**
 * h() —— 手写渲染函数创建 vnode 的入口，也是「模板」之外的第二条渲染路径。
 *
 *     h('div', { class: 'box' }, 'hello')
 *     h(MyComp, { msg: 'hi' }, { default: () => h('span', 'slot 内容') })
 *     h(Fragment, null, [h('li', 1), h('li', 2)])
 *
 * 参数归一化的必要性：第三个参数可以是 vnode、字符串、数组、插槽对象……
 * 这些差异由 createVNode + normalizeVNode 消化掉，使用者不用纠结。
 *
 * ★ 参数个数决定语义（和真实 Vue 完全一致，这里没有用"猜"的启发式）：
 *   h(type, props, children)   三个参数 → 第二个是 props
 *   h(type, childOrSlots)      两个参数 → 第二个是 children（vnode / 数组 / 插槽对象）
 *   所以「只想传插槽」要写 h(Comp, null, { default: ... })，不能省掉中间的 null。
 */
import { Fragment, Text, createVNode, isVNode } from './vnode.js'
import { currentRenderingInstance, setCurrentRenderingInstance } from './vnode.js'
import { isArray, isObject } from '../shared/utils.js'
import { PatchFlags } from '../shared/patchFlags.js'

export function h(type, propsOrChildren, children) {
  const l = arguments.length

  if (l === 2) {
    if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
      if (isVNode(propsOrChildren)) {
        // h('div', someVNode) → 这个 vnode 是 children，没有 props
        return createVNode(type, null, [propsOrChildren])
      }
      // h('div', { class: 'a' }) → 对象当 props
      return createVNode(type, propsOrChildren)
    }
    // h('div', 'text') / h('div', [...]) → 第二个参数是 children
    return createVNode(type, null, propsOrChildren)
  }

  if (l > 3) {
    // h('div', props, a, b, c) → 多余参数合成数组
    children = Array.prototype.slice.call(arguments, 2)
  } else if (l === 3 && isVNode(children)) {
    children = [children]
  }
  return createVNode(type, propsOrChildren, children)
}

/** 创建文本 vnode 的简写：h(Text, null, 'x') 太啰嗦 */
export const createText = text => createVNode(Text, null, String(text))

/**
 * withCtx —— 插槽函数的「上下文切换器」。这是理解插槽机制最关键的一环。
 *
 * 问题从这里开始：
 *
 *     <!-- 父组件模板 -->
 *     <Child>
 *       <p>{{ parentMsg }}</p>     <!-- 注意：这里用的是**父组件**的数据 -->
 *     </Child>
 *
 * 子组件渲染 <slot> 时才会调用这个插槽函数，而那一刻
 * 「当前正在渲染的组件」已经是**子组件**了。
 * 如果不做处理，模板里解析到的 `_ctx` 就会是子组件 —— `parentMsg` 在子组件上找不到，读成 undefined。
 *
 * ★ withCtx 的解法：在「创建插槽函数的那一刻」（此时当前实例还是父组件）
 *   把父组件实例捕获下来，之后每次调用都先临时切回去，执行完再切回来。
 *
 * 这样带来两个正确的结果：
 *
 *   1. **组件解析正确**：插槽内容里写的 <MyIcon> 会在父组件的注册表里解析，
 *      而不是子组件的 —— 符合"谁写的谁负责"的直觉。
 *
 *   2. **响应式归属正确**：插槽函数体在子组件渲染期间执行，所以它读到的响应式数据
 *      （父组件的 parentMsg）会被收集到**子组件的渲染 effect** 上。
 *      于是 parentMsg 变化 → 子组件重新渲染 → renderSlot 重新调用插槽函数 → 拿到新 vnode → 更新 DOM。
 *      这就是「插槽内容是响应式的」这条链路的全部。
 *      （也解释了 Vue 3 的一个行为：只用在插槽里的数据变化时，重新渲染的是子组件而不是父组件。）
 *
 *   3. 「作用域插槽」的语义也随之清晰：子组件通过参数把数据"递进"父组件的函数里，
 *      而函数体永远在父组件的作用域里执行 —— 这正是"作用域"二字的含义。
 */
export function withCtx(fn) {
  // ★ 在创建时捕获实例。插槽函数是在父组件的 render 执行期间被创建的，
  //   所以这里拿到的就是父组件。
  const ownerInstance = currentRenderingInstance
  const wrapped = (...args) => {
    const prev = setCurrentRenderingInstance(ownerInstance)
    try {
      return fn(...args)
    } finally {
      setCurrentRenderingInstance(prev) // 恢复，别影响子组件剩余部分的渲染
    }
  }
  wrapped._isSlot = true // 标记，供识别"这是一个插槽函数"
  return wrapped
}

/**
 * renderSlot —— 编译产物里对 <slot> 的处理：
 *
 *     <slot name="header" :user="user">默认内容</slot>
 *     ↓
 *     _renderSlot(_ctx.$slots, "header", { user: user }, () => [ "默认内容" ])
 *
 * 逻辑：父组件给了插槽函数 → 调用它（把作用域参数传进去）；没给（或给了空内容）→ fallback。
 *
 * ★ 返回值必须是「带 patchFlag 的 Fragment」而不能是裸数组：
 *   插槽内容是运行期才确定的，编译器无法把它静态收进父元素的块里。
 *   给 Fragment 打上 STABLE_FRAGMENT（>0）后，createVNode 会把它收集进当前块
 *   （编译产物里 <slot> 所在元素的块正好开着）—— 于是块 diff 会按位置 patch 它，
 *   插槽内容的变化才能传导到 DOM。这是真实 Vue 的同款做法。
 *   （裸数组的话：块 diff 发现 dynamicChildren 为空 → 整个跳过 children 对比 → 插槽永不更新，
 *     这正是本实现第一版踩过的坑。）
 */
export function renderSlot(slots, name, props = {}, fallback) {
  const slot = slots[name]
  if (slot) {
    const rendered = slot(props)
    const nodes = isArray(rendered) ? rendered : [rendered]
    // 过滤掉"空占位"（空文本 vnode），这样父组件没传内容时能正常走 fallback
    const meaningful = nodes.filter(node => !(isVNode(node) && node.type === Text && node.children === ''))
    if (meaningful.length) {
      return createVNode(Fragment, null, meaningful, PatchFlags.STABLE_FRAGMENT)
    }
  }
  // fallback 同样包 Fragment：保持「<slot> 永远产出一个 vnode」的稳定形状，
  // 新旧 children 的 diff 才不会因为返回类型变化（数组 vs 无）而走错分支
  return createVNode(
    Fragment,
    null,
    fallback ? [].concat(fallback()) : [],
    PatchFlags.STABLE_FRAGMENT
  )
}

export { Fragment, Text }
