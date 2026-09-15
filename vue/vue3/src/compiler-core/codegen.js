/**
 * codegen —— 编译器流水线的最后一步：把 transform 产出的 JS AST 打印成 render 函数的源码。
 *
 * 输入：带 codegenNode 的 AST + 用到的 helpers + 静态提升的节点
 * 输出：一段可以直接执行的 JS 代码字符串
 *
 * ── 产物长什么样 ──
 *
 *     const _Vue = Vue
 *     const { toDisplayString: _toDisplayString,
 *             createElementVNode: _createElementVNode,
 *             openBlock: _openBlock,
 *             createElementBlock: _createElementBlock } = _Vue
 *
 *     const _hoisted_1 = _createElementVNode("p", { class: "title" }, "静态标题")
 *
 *     __exports.render = function render(_ctx, _cache) {
 *       return (_openBlock(), _createElementBlock("div", null, [
 *         _hoisted_1,
 *         _createElementVNode("span", null, _toDisplayString(_ctx.msg), 1 /* TEXT *\/)
 *       ]))
 *     }
 *
 * ── 为什么要有「解构 helpers」这一步？ ──
 *   1. 体积：`_toDisplayString` 比 `Vue.toDisplayString` 短，模板越多省得越多；
 *   2. 可压缩：压缩器能把 `_toDisplayString` 压成单个字母，`Vue.toDisplayString` 不能；
 *   3. tree-shaking：只有真正用到的函数才出现在解构里，打包体积最小。
 *   解构在**模块顶层**做一次（不是每次渲染），所以没有运行时开销。
 *
 * ── 「用到了哪些 helper」怎么确定？ ──
 *   本实现用一个稳妥的办法：先按 AST 生成代码，再**扫描生成的代码**里出现了哪些
 *   `_xxx(` 形式的调用，与运行时 helper 清单取交集。这样即使某个 transform 忘了
 *   注册 helper，产物也不会引用到不存在的函数（真实 Vue 用的是显式注册 + 断言）。
 */
import { NodeTypes } from './ast.js'
import { printJS, ARRAY, STRING, CALL, IDENT, NUMBER, SEQ, NULL as NULL_EXPR } from './js-ast.js'
import { PatchFlags, describePatchFlag } from '../shared/patchFlags.js'

/**
 * 运行时提供的所有 helper 名字。
 * ★ 这是「编译器」和「运行时」之间的契约清单：
 *   编译器可能生成 `_toDisplayString(...)`，运行时就必须提供 `toDisplayString`。
 *   两边版本不一致时就会报 "toDisplayString is not a function"，这就是原因。
 */
export const HELPER_NAMES = [
  'openBlock',
  'closeBlock',
  'setBlockTracking',
  'createElementBlock',
  'createBlock',
  'createElementVNode',
  'createVNode',
  'createTextVNode',
  'createCommentVNode',
  'createStaticVNode',
  'Fragment',
  'Text',
  'Comment',
  'resolveComponent',
  'renderSlot',
  'renderList',
  'toDisplayString',
  'withModifiers',
  'toHandlers',
  'normalizeClass',
  'normalizeStyle',
  'looseToNumber',
  'withCtx',
  'guardReactiveProps',
  'createSlots',
]

/**
 * 生成渲染函数代码。
 *
 * @param {object} ast parse 的返回值
 * @param {object} context transform 的返回值（含 helpers / hoists）
 * @param {object} options { mode, runtimeGlobalName }
 * @returns {{ code: string, helpers: string[] }}
 */
export function generate(ast, context, options = {}) {
  const { mode = 'module', runtimeGlobalName = 'Vue' } = options

  // ---- ① 生成 render 函数体 ----
  const body = genNode(ast, context, 1)

  // ---- ② 扫描代码，找出真正用到的 helper ----
  const used = new Set(context.helpers)
  const callRe = /_([a-zA-Z][a-zA-Z0-9]*)\s*\(/g
  let m
  while ((m = callRe.exec(body))) {
    if (HELPER_NAMES.includes(m[1])) used.add(m[1])
  }
  // helper 也可能以值的形式出现（如 _Fragment、裸的 _hoisted_1 不算）
  for (const name of HELPER_NAMES) {
    if (new RegExp(`(?<![\\w$])_${name}(?![\\w$])`).test(body)) used.add(name)
  }
  // 静态提升的表达式里也会用到 helper
  const hoistedText = context.hoists.map(h => printJS(h.expr)).join('\n')
  for (const name of HELPER_NAMES) {
    if (new RegExp(`(?<![\\w$])_${name}(?![\\w$])`).test(hoistedText)) used.add(name)
  }

  // ---- ③ helper 解构语句 ----
  // 只有被用到的才解构出来，多余的会让产物变胖
  const helperImports = [...used].sort().map(name => `${name}: _${name}`).join(',\n  ')

  // ---- ④ 静态提升的声明 ----
  const hoistedCode = context.hoists
    .map(({ name, expr }) => `const ${name} = ${printJS(expr, { indent: 0 })}`)
    .join('\n')

  const renderFn = `function render(_ctx, _cache) {\n  return ${body}\n}`

  if (mode === 'function') {
    return { code: renderFn, helpers: [...used].sort(), hoisted: hoistedCode }
  }

  // module 模式：完整可执行代码。浏览器端运行时编译就是用这个
  const parts = [`const _Vue = ${runtimeGlobalName}`]
  if (helperImports) {
    parts.push(`const {\n  ${helperImports}\n} = _Vue`)
  }
  if (hoistedCode) parts.push(hoistedCode)
  parts.push(`__exports.render = ${renderFn}`)

  return { code: parts.join('\n\n'), helpers: [...used].sort(), hoisted: hoistedCode }
}

// =====================================================================
// 递归生成
// =====================================================================

/** 名字沿用 Vue 源码的 `gen` 前缀（genNode / genElement），方便对照阅读 */
function genNode(node, context, indent) {
  if (!node) return 'null'

  switch (node.type) {
    case NodeTypes.ROOT:
      return genRoot(node, context, indent)
    case NodeTypes.ELEMENT:
      return genElement(node, context, indent)
    case NodeTypes.TEXT:
      return JSON.stringify(node.content)
    case NodeTypes.COMMENT:
      return `_createCommentVNode(${JSON.stringify(node.content)})`
    case NodeTypes.COMPOUND_EXPRESSION:
      // 文本合并的产物：多段文本/插值拼成一个表达式（见 transform.js 的 mergeTextChildren）
      return node.content
    case NodeTypes.INTERPOLATION:
      return printJS(node.codegenNode, { indent })
    case NodeTypes.IF:
      return genIf(node, context, indent)
    case NodeTypes.FOR:
      return printJS(node.codegenNode, { indent })
    default:
      if (node.codegenNode) return printJS(node.codegenNode, { indent })
      console.warn('[vue-mini][codegen] 未知节点类型:', node.type)
      return 'null'
  }
}

/**
 * 根节点：children 就是 render 的返回值。
 *
 *   0 个子节点  → 注释占位（v-if 全为假的情况）
 *   1 个子节点  → 直接返回它（★ 不能包 Fragment，否则组件会多一层无意义的嵌套）
 *   多个子节点  → 包一层 Fragment —— 这就是 Vue 3 允许模板有多个根节点的实现方式
 */
function genRoot(node, context, indent) {
  const children = node.children

  if (children.length === 0) {
    return `_createCommentVNode("v-if", true)`
  }

  if (children.length === 1) {
    return genNode(children[0], context, indent)
  }

  // 多根节点 → 包一层 Fragment 块。
  // 这就是 Vue 3 允许模板写多个根节点的实现方式：表面上"没有根"，实际上 Fragment 当根。
  // 注意：这一层直接用字符串拼接 —— genChildExpression 产出的是"代码字符串"，
  // 而 ARRAY() 等构造器是给 JS AST 用的，二者不能混用（否则会打印出空洞数组 [, ,]）。
  const elements = children.map(child => genChildExpression(child, context, indent + 1))
  const pad = '  '.repeat(indent + 1)
  const closePad = '  '.repeat(indent)
  return `(_openBlock(), _createElementBlock(\n${pad}_Fragment,\n${pad}null,\n${pad}[\n${elements
    .map(e => pad + '  ' + e)
    .join(',\n')}\n${pad}],\n${pad}${PatchFlags.STABLE_FRAGMENT}\n${closePad}))`
}

/** children 数组里的单个元素 → 表达式 */
function genChildExpression(child, context, indent) {
  if (child.type === NodeTypes.TEXT) {
    // ★ 数组里的纯文本必须包成 vnode：
    //   不然 `[h('b','x'), 'hello']` 里的字符串在下次 diff 时无法和 vnode 比较。
    return `_createTextVNode(${JSON.stringify(child.content)})`
  }
  if (child.type === NodeTypes.COMMENT) {
    return `_createCommentVNode(${JSON.stringify(child.content)})`
  }
  if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
    // 合并后的文本表达式是字符串，要包成文本 vnode 才能放进 children 数组
    return `_createTextVNode(${child.content})`
  }
  if (child.type === NodeTypes.INTERPOLATION) {
    return printJS(child.codegenNode, { indent })
  }
  if (child.codegenNode) {
    return printJS(child.codegenNode, { indent })
  }
  return 'null'
}

/** 元素：codegenNode 在 transform 阶段已建好，直接打印 */
function genElement(node, context, indent) {
  if (node.codegenNode) return printJS(node.codegenNode, { indent })
  return 'null'
}

/**
 * v-if 的代码生成：嵌套三元表达式。
 *
 *     v-if / v-else-if / v-else
 *     ↓
 *     cond1
 *       ? branch1
 *       : cond2
 *         ? branch2
 *         : branch3          ← v-else 作为兜底值
 *
 * 每个分支都是 `(_openBlock(), _createElementBlock(...))`。
 * ★ 每个分支必须各自开块，因为不同分支的动态节点数量不同 ——
 *   共用块会让 dynamicChildren 结构不稳定，切分支时 diff 就会错位。
 */
function genIf(node, context, indent) {
  const { branches } = node
  const pad = '  '.repeat(indent + 1)

  // 从最后一个分支往前构造，形成右结合的嵌套三元
  let result = 'null'
  for (let i = branches.length - 1; i >= 0; i--) {
    const branch = branches[i]
    const branchExpr = branch.children[0]
      ? genElement(branch.children[0], context, indent + 1)
      : `_createCommentVNode("v-if", true)`

    if (branch.condition == null) {
      result = branchExpr // v-else：无条件，直接兜底
    } else {
      result = `${branch.condition}\n${pad}? ${branchExpr}\n${pad}: ${result}`
    }
  }
  return result
}

/** 内部小工具：把 helper 名转成产物里的标识符 */
function HELPER(name) {
  return `_${name}`
}

// =====================================================================
// 教学用：带注释的产物
// =====================================================================

/**
 * 生成「带 patchFlag 注释」的产物，用于教学展示。
 *
 *     _createElementVNode("span", null, _toDisplayString(_ctx.msg), 1 /* TEXT *\/)
 *
 * 真实 Vue 的编译产物里也带这些注释（在 dev 模式下），
 * 它们不会影响执行，但能让人一眼看出编译器做了什么优化。
 */
export function generateWithAnnotations(ast, context, options = {}) {
  const { code } = generate(ast, context, { ...options, mode: 'function' })
  return annotatePatchFlags(code)
}

export function annotatePatchFlags(code) {
  // 匹配 ", <数字>)" 形式的 patchFlag（只在参数列表末尾出现，所以比较安全）
  return code.replace(/(,\s*)(-?\d+)(\s*\))/g, (match, comma, num, close) => {
    const flag = Number(num)
    // 只对"看起来像 patchFlag"的值加注释，避免把普通数字（比如数组长度）也标注上
    if (!KNOWN_FLAGS.has(flag)) return match
    return `${comma}${num} /* ${describePatchFlag(flag)} */${close}`
  })
}

const KNOWN_FLAGS = new Set([
  1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16, 32, 64, 65, 128, 130, 256, 258, 512, 1024, -1, -2,
])
