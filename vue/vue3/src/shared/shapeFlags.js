/**
 * ShapeFlags —— 用「位运算」给 VNode 打标签，描述它到底是什么、children 是什么形态。
 *
 * 为什么用位运算而不是多个布尔字段？
 *   1. 一个数字就能表达多个布尔信息（相当于 Set<Flag>）；
 *   2. 判断只需一次按位与：shapeFlag & ShapeFlags.ELEMENT，比读多个字段更快；
 *   3. VNode 是很"热"的对象（一次渲染会创建成百上千个），字段越少内存越省。
 *
 * VNode 的 shapeFlag 由两部分「或」起来：
 *   前半段（类型）：ELEMENT / TEXT / COMMENT / FRAGMENT / COMPONENT —— 决定 patch 时分派到哪个流程
 *   后半段（children）：TEXT_CHILDREN / ARRAY_CHILDREN / SLOTS_CHILDREN —— 决定 children 怎么处理
 *
 * 例：<div>hello</div>  →  ELEMENT | TEXT_CHILDREN  =  1 | 32 = 33
 * 例：<div><span/></div> →  ELEMENT | ARRAY_CHILDREN =  1 | 64 = 65
 * 例：<MyComp>...</MyComp> → COMPONENT | SLOTS_CHILDREN = 16 | 128 = 144
 */
export const ShapeFlags = {
  // ---- 类型部分：这个 vnode 代表什么 ----
  ELEMENT: 1 << 0, // 1    原生元素，vnode.type 是字符串 "div"
  TEXT: 1 << 1, // 2    文本节点，vnode.type 是 Text 这个 symbol
  COMMENT: 1 << 2, // 4    注释节点，vnode.type 是 Comment
  FRAGMENT: 1 << 3, // 8    虚拟片段（多根节点模板、v-for、v-if 的空分支都会用到）
  COMPONENT: 1 << 4, // 16   组件，vnode.type 是组件对象（这就是组件化的第一个伏笔：type 不再只是字符串）

  // ---- children 形态部分 ----
  TEXT_CHILDREN: 1 << 5, // 32   children 是一个字符串（对应 DOM 的 textContent）
  ARRAY_CHILDREN: 1 << 6, // 64   children 是 vnode 数组（要递归 diff）
  SLOTS_CHILDREN: 1 << 7, // 128  children 是插槽对象（组件专属：children 是"函数"而不是"节点"）
}

/**
 * 判断某个 vnode 的 type 是不是组件（vnode.type 为对象）。
 * 这是组件化的第二个伏笔：渲染器只认"字符串 = 元素 / 对象 = 组件"，其余逻辑全部收在组件自己的流程里。
 */
export const isComponent = vnode => !!(vnode.shapeFlag & ShapeFlags.COMPONENT)
export const isElement = vnode => !!(vnode.shapeFlag & ShapeFlags.ELEMENT)
