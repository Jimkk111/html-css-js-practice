/**
 * VNode —— 虚拟节点。
 *
 * 为什么要有「虚拟」这一层？真实 DOM 的操作是昂贵的：
 *   - 创建/删除节点会触发浏览器的样式计算、布局、绘制；
 *   - DOM 节点上挂着大量属性，一个 div 对象可能有上百个字段，创建成本远高于普通 JS 对象。
 *
 * 虚拟 DOM 换成：用轻量的 JS 对象描述「界面应该长什么样」，
 * 在内存里比较新旧两棵树的差异（diff），最后只对真正变化的部分操作真实 DOM。
 *
 *     const vnode = {
 *       type: 'div',              // 描述「是什么」
 *       props: { id: 'app' },     // 描述「有哪些属性」
 *       children: 'hello',        // 描述「有哪些子节点」
 *       shapeFlag: 33,            // 位标记，快速判断类型与 children 形态
 *       el: null,                 // 挂载后指向对应的真实 DOM
 *     }
 *
 * 关键字段说明：
 *   type     —— 字符串('div') = 原生元素；对象 = 组件；Text/Comment/Fragment 是特殊 symbol
 *   props    —— 属性 + 事件 + 组件的 props/attrs，编译产物里统一放这里
 *   children —— 字符串 | vnode 数组 | 插槽对象
 *   key      —— 打补丁时的「身份标识」，让 diff 能复用相同节点（列表渲染的关键）
 *   el       —— 真实 DOM 的引用。这是 vnode 与 DOM 之间的桥梁，也是 patch 的入口
 *   anchor   —— 插入位置参考节点（Fragment / 组件等需要"插在哪"的场景）
 *   component —— 组件实例的引用（渲染组件时挂上）
 *   patchFlag / dynamicProps —— 编译器留下的更新提示（靶向更新用）
 */
import { ShapeFlags } from '../shared/shapeFlags.js'
import { PatchFlags } from '../shared/patchFlags.js'
import { isArray, isString, isObject, isFunction } from '../shared/utils.js'

// =====================================================================
// 块树（Block Tree）—— Vue 3 编译优化的运行期一半
// =====================================================================
//
// 问题：即使有了 patchFlag，更新时仍然要「逐层递归」才能找到那些动态节点。
//
//     <div>                            ← 根
//       <section>                      ← 静态，但还是要走进去
//         <p>hello</p>                 ← 静态
//         <span>{{ msg }}</span>       ← 动态，只有它需要更新
//
//   diff 从根开始，一层层 patch 下来才碰到 span，中间的静态节点全被"路过"了一遍。
//
// 解法：让编译器在「可能有动态后代」的地方开一个「块」（block），
// 运行期把**所有**动态后代平铺收集到当前块的 dynamicChildren 数组里：
//
//     div.dynamicChildren = [span]     ← 一步直达，与层级深度无关
//
//   更新时 renderer 只看这个数组，静态子树连比较都不需要：
//     10 层嵌套里只有 1 个动态节点 → 更新成本从 O(整棵树) 降到 O(1)。
//
// 三个配套函数（和真实 Vue 完全同构）：
//   openBlock()           开块：往栈上压一个新的收集列表
//   closeBlock()          关块：出栈，恢复到父块
//   setupBlock(vnode)     收尾：把收集到的列表挂到 vnode 上，并把自己登记进父块
//
// 「块」可以嵌套：内层块作为一个整体被登记进外层块，于是形成一棵只含动态节点的树。
// 这也是编译器里 v-if / v-for 必须各开一个块的原因 ——
// 否则一个块里的动态节点数量会随分支/迭代次数变化，新旧 dynamicChildren 对不上，diff 就错位了。

/** 是否启用块树收集。>0 表示启用；设为负数可以临时关闭（v-for 内部就用这个技巧） */
let isBlockTreeEnabled = 1
/** 块栈，保证嵌套块能正确恢复 */
const blockStack = []
/** 当前正在收集动态节点的块 */
let currentBlock = null
const EMPTY_ARRAY = []

export function openBlock(disableTracking = false) {
  // disableTracking=true 时压入 null：表示"这一层不收集"，
  // 同时它本身作为一个块（v-for 的 Fragment）由调用方挂进父块。
  blockStack.push((currentBlock = disableTracking ? null : []))
}

export function closeBlock() {
  blockStack.pop()
  currentBlock = blockStack[blockStack.length - 1] || null
}

/**
 * 关闭当前块，并把 vnode 作为「块」返回。
 *
 * 三步，一步都不能少：
 *   ① 把收集到的动态子节点挂到 vnode.dynamicChildren 上 —— 这就是"块"的本体
 *   ② 出栈，恢复到父块（★ 必须在 ① 之后，因为 ① 读的就是当前块）
 *   ③ 把 vnode 登记进**父**块 —— 于是内层块在外层看来就是一个动态节点，
 *      层层嵌套构成一棵只含动态节点的「块树」
 */
export function setupBlock(vnode) {
  vnode.dynamicChildren = isBlockTreeEnabled > 0 ? currentBlock || EMPTY_ARRAY : null
  closeBlock()
  if (isBlockTreeEnabled > 0 && currentBlock) {
    // ★ 这里读的是"出栈后"的 currentBlock，也就是父块
    currentBlock.push(vnode)
  }
  return vnode
}

/**
 * 临时开启/关闭块收集，返回一个恢复函数。
 * v-for 内部会用它把收集关掉（整条列表作为一个块处理，不需逐项收集）。
 */
export function setBlockTracking(value) {
  isBlockTreeEnabled += value
}

/** 创建「块级元素」：编译产物里 _createElementBlock 对应的实现 */
export function createElementBlock(type, props, children, patchFlag, dynamicProps) {
  // 第 6 个参数 true 告诉 createVNode：我自己就是块，不要偷偷把自己收集进自己
  return setupBlock(createVNode(type, props, children, patchFlag, dynamicProps, true))
}

/** 创建「块级 vnode」（组件作为块时用，或根节点是组件） */
export function createBlock(type, props, children, patchFlag, dynamicProps) {
  return setupBlock(createVNode(type, props, children, patchFlag, dynamicProps, true))
}

/** 元素 vnode 的专用入口。和 createVNode 是同一个函数 ——
 *  拆成两个名字只是为了让编译产物读起来更清楚（对照真实 Vue 的 createElementVNode）。 */
export const createElementVNode = createVNode

/**
 * 创建静态 vnode（对应 v-html 之外的大段静态内容优化）。
 * 真实 Vue 用它把整段静态 HTML 字符串一次性 setInnerHTML，本实现保留简化版。
 */
export function createStaticVNode(content, numberOfNodes) {
  const vnode = createVNode(Comment, null, '')
  vnode.isStatic = true
  vnode.staticContent = content
  vnode.staticCount = numberOfNodes
  return vnode
}

/** 判断一个值是不是块（有 dynamicChildren 就是块） */
export const isBlock = vnode => !!(vnode && isArray(vnode.dynamicChildren))


/** 文本节点的 type 标记。用 Symbol 避免和标签名 'div' 之类的字符串冲突 */
export const Text = Symbol('Text')
/** 注释节点的 type 标记 */
export const Comment = Symbol('Comment')
/** 片段：一个 vnode 对应「多个根节点」，例如 <template>...</template>、v-for 展开后的结果 */
export const Fragment = Symbol('Fragment')

export function isVNode(value) {
  return value ? value.__v_isVNode === true : false
}

/**
 * 创建一个 VNode。
 * 所有分支（元素 / 组件 / 文本 / 注释 / 片段）最终都收敛到这个函数。
 *
 * @param {string|Object|Symbol} type 元素标签名 / 组件对象 / Text|Comment|Fragment
 * @param {Object|null} props 属性
 * @param {any} children 子节点：string | VNode[] | 插槽对象
 * @param {number} patchFlag 编译器的更新提示
 * @param {string[]|null} dynamicProps 动态属性名列表（配合 PatchFlags.PROPS 使用）
 */
export function createVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, isBlockNode = false) {
  const shapeFlag = isString(type)
    ? ShapeFlags.ELEMENT
    : isObject(type)
      ? ShapeFlags.COMPONENT
      : type === Text
        ? ShapeFlags.TEXT
        : type === Comment
          ? ShapeFlags.COMMENT
          : type === Fragment
            ? ShapeFlags.FRAGMENT
            : 0

  const vnode = {
    __v_isVNode: true,
    type,
    props,
    // ★ 注意 ?? 而不是 || 或直接取值：
    //   props 存在但没写 key 时，props.key 是 undefined，必须归一化成 null ——
    //   否则 "无 key 的 vnode(key=null)" 和 "带 props 但没 key 的 vnode(key=undefined)"
    //   会被 isSameVNodeType 判成 key 不同，导致明明可以复用的 DOM 被销毁重建。
    key: (props && props.key != null ? props.key : null),
    children,
    shapeFlag,
    patchFlag,
    dynamicProps,
    dynamicChildren: null, // ★ 块树：只装「会变的」后代，diff 时按它走
    el: null, // 挂载后指向真实 DOM（组件的 vnode 指向其子树根 DOM）
    anchor: null, // 需要"我这一串节点到哪结束"的场景（Fragment）用
    component: null, // 组件实例引用
  }

  // 根据 children 的实际形态补上 children 部分的 shapeFlag。
  // 算完之后，patch 就能用一次位运算分派到正确的处理流程。
  if (children !== null && children !== undefined) {
    if (isString(children) || typeof children === 'number') {
      vnode.shapeFlag |= ShapeFlags.TEXT_CHILDREN
      vnode.children = String(children)
    } else if (isArray(children)) {
      vnode.shapeFlag |= ShapeFlags.ARRAY_CHILDREN
    } else if (isObject(children)) {
      // 对象形态的 children 只可能出现在组件上，它是「插槽对象」
      vnode.shapeFlag |= ShapeFlags.SLOTS_CHILDREN
    }
  }

  // ★ 块树收集：如果当前有打开的块，就把自己登记进去。
  //   收集条件「patchFlag > 0 或者是组件」= 「这个节点的 DOM 将来可能会变」。
  //   静态节点 patchFlag 为 0，不会被收集 —— 这就是"更新时跳过静态子树"的实现方式。
  //
  //   `!isBlockNode` 是为了避免「块把自己收集进自己的块里」：
  //   _createElementBlock 的执行顺序是 openBlock() 然后创建 vnode，
  //   如果不排除，vnode.dynamicChildren 里会出现它自己，diff 时就乱了。
  if (
    isBlockTreeEnabled > 0 &&
    !isBlockNode &&
    currentBlock &&
    (patchFlag > 0 || shapeFlag & ShapeFlags.COMPONENT) &&
    patchFlag !== PatchFlags.HOISTED
  ) {
    currentBlock.push(vnode)
  }

  return vnode
}

/** 创建纯文本 vnode（{{ msg }} 编译后就是 _createTextVNode(_toDisplayString(msg))） */
export function createTextVNode(text = '') {
  return createVNode(Text, null, String(text))
}

/** 创建注释 vnode（v-if 为 false 时编译成 createCommentVNode('v-if', true) 占位） */
export function createCommentVNode(text = '', asBlock = false) {
  // ★ 第二个参数 asBlock 为什么存在？
  //   v-if 的假分支必须是一个「会被登记进父块」的节点。
  //   否则动态节点数量会随分支变化（true 时 1 个、false 时 0 个），
  //   新旧 dynamicChildren 长度对不上，切分支时就会漏更新。
  return asBlock
    ? (openBlock(), setupBlock(createVNode(Comment, null, text)))
    : createVNode(Comment, null, text)
}

/**
 * 规范化 children：
 *   把「vnode 数组里夹杂的字符串 / null / 数字」统一转成 vnode 数组。
 *
 * 为什么需要？因为手写 render 函数时会出现这些情况：
 *   h('div', [h('span'), '纯文本', null, 0])
 * 运行时必须能把 '纯文本' 也变成 vnode（Text 类型），否则后续 diff 会把它当对象处理而出错。
 */
export function normalizeChildren(children) {
  if (isArray(children)) {
    return children.map(child => normalizeVNode(child))
  }
  return children
}

/** 把一个「可能是 vnode / 字符串 / 数字 / null / 数组」的值统一成 vnode */
export function normalizeVNode(child) {
  if (child === null || child === undefined || typeof child === 'boolean') {
    return createCommentVNode('') // 空占位：保证数组长度稳定，diff 时下标不会错位
  }
  if (isString(child) || typeof child === 'number') {
    return createTextVNode(child)
  }
  // ★ 数组：数组出现在 children 里的情况是「插槽 / 嵌套表达式」。
  //   例如 <div><slot/></div> 编译出的 children 是 [ [_renderSlot(...)] ] —— 里层是个数组。
  //   包成 Fragment 后，它就和其他 vnode 一样可以被 diff、被移动、被卸载。
  if (isArray(child)) {
    return createVNode(Fragment, null, child)
  }
  if (isVNode(child)) {
    return cloneIfMounted(child)
  }
  // 普通对象 / 函数等：当作组件或未知值，原样包一层（真实 Vue 会报警告）
  return createVNode(child)
}

/**
 * ★ cloneIfMounted —— 静态提升带来的「共享 vnode」问题的解药。
 *
 * 问题：静态提升的节点是**模块级常量**。同一个组件被实例化多次时（比如 v-for 里用组件），
 * 或者模板里同一个提升节点被用在多处时，这些位置会共享同一个 vnode 对象。
 * 而 vnode 上挂着 `el`（真实 DOM 引用），共享就会互相覆盖：
 *
 *     _hoisted_1  → 第一次挂载把 el 设成 domA
 *                 → 第二次挂载把 el 覆盖成 domB
 *                 → 组件 A 下次更新时拿着 domB 去 patch → DOM 错乱
 *
 * 解法：在「使用位置」上做一次浅拷贝，让每个位置拥有自己的 vnode。
 *
 *   - 本次渲染刚创建的普通 vnode（el 为 null）→ 直接用，不拷贝（零开销）
 *   - HOISTED 节点 → 共享常量，拷贝一份
 *   - 已经挂载过的（el !== null，比如 v-once 缓存的 vnode）→ 必须拷贝
 *
 * 代价是每次渲染多几个浅拷贝，相比"复用 props 对象、避免重建整棵子树"的收益非常划算。
 */
export function cloneIfMounted(child) {
  return (child.el === null && child.patchFlag !== PatchFlags.HOISTED) || child.memo
    ? child
    : cloneVNode(child)
}

/**
 * 浅拷贝一个 vnode。
 * 注意 el / anchor 也会被带过去 —— 这是刻意的：拷贝的目的是让「每个使用位置」
 * 拥有独立的 vnode 对象（这样各自写回 el 不会互相干扰），而不是要重置挂载状态。
 */
export function cloneVNode(vnode) {
  return {
    ...vnode,
    props: vnode.props ? { ...vnode.props } : vnode.props,
    children: isArray(vnode.children) ? vnode.children.slice() : vnode.children,
    __v_skip: true, // 标记"这是拷贝"，避免某些场景下重复处理
  }
}

/**
 * 把「模板里写的标签名」解析成真正的组件对象。
 *
 *     <MyButton @click="onClick">点我</MyButton>
 *     ↓ 编译产物
 *     _createVNode(_resolveComponent("MyButton"), { onClick: onClick }, "点我")
 *
 * 为什么不在编译期直接确定？因为同一个模板可能被多个组件复用，
 * 而「MyButton 从哪来」要看运行时的注册情况：
 *   1. 组件自己注册的局部组件（components 选项 / setup 返回的对象）
 *   2. 祖先链上注册的（父组件注册了，子组件模板里可以直接用）
 *   3. app.component('MyButton', ...) 全局注册的
 *
 * 查找顺序就是上面这个顺序，从近到远 —— 就近覆盖，符合直觉。
 * 这个函数是「组件化」的最后一块拼图：模板里的标签名 ↔ 运行时组件对象的转换点。
 */
export function resolveComponent(name) {
  const instance = currentRenderingInstance
  if (!instance) {
    console.warn(`[vue-mini] 在组件渲染之外调用了 resolveComponent("${name}")`)
    return name
  }

  // 1. 自己的局部注册（含 setup 返回的组件对象）
  let found = lookupFromInstance(instance, name)
  if (found) return found

  // 2. 沿父链向上找
  let parent = instance.parent
  while (parent) {
    found = lookupFromInstance(parent, name)
    if (found) return found
    parent = parent.parent
  }

  // 3. 全局注册表
  const app = instance.appContext && instance.appContext.app
  if (app && app._context.components[name]) {
    return app._context.components[name]
  }

  // 4. 找不到就退回成同名元素，保证至少不崩（真实 Vue 会警告 Failed to resolve component）
  console.warn(
    `[vue-mini] 无法解析组件 "${name}"。请检查是否遗漏了注册：` +
      '① setup 里返回它 ② components 选项声明 ③ app.component() 全局注册'
  )
  return name
}

/** 在一个实例上查找局部注册的组件 */
function lookupFromInstance(instance, name) {
  const { setupState, components } = instance
  if (setupState && setupState[name]) return setupState[name]
  if (components && components[name]) return components[name]
  return null
}

/**
 * 「当前正在渲染的组件实例」/「当前应用」这两个全局上下文。
 *
 * 用模块级变量而不是参数层层传递，因为它们会被 vnode.js / component.js / h.js 共享，
 * 塞进参数会污染一大票函数签名（真实 Vue 的 currentRenderingInstance 也是同样思路）。
 *
 * 语义：只在「当前这次 render 的同步执行期间」有效。
 * 所以 setXxx 返回"恢复函数"而不是提供 unset —— 配合 try/finally 保证异常时也能还原。
 */
export let currentRenderingInstance = null
export let currentApp = null

export function setCurrentRenderingInstance(instance) {
  const prev = currentRenderingInstance
  currentRenderingInstance = instance
  return prev
}

export function getCurrentRenderingInstance() {
  return currentRenderingInstance
}

export function setCurrentApp(app) {
  currentApp = app
}

export function getCurrentApp() {
  return currentApp
}
