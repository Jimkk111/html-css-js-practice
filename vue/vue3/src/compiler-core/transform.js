/**
 * transform —— 编译器流水线的第三步：把「模板 AST」改写成「JS AST」。
 *
 * 这是整个编译器信息量最大的一步。它要做的事，按重要性排序：
 *
 *   ① 语义转换：把模板语法翻译成 JS 语法
 *        v-if   → 三元表达式           v-for  → renderList + Fragment
 *        {{x}}  → _toDisplayString(x)  :id="x" → { id: _ctx.x }
 *        @click="fn" → { onClick: fn } v-model → modelValue + onUpdate:modelValue
 *
 *   ② 编译优化：这是 Vue 3 性能的关键，全部在这一步完成
 *        patchFlag    —— 标记"这个节点哪里会变"，让运行时能靶向更新
 *        dynamicProps —— 标记"具体是哪几个属性会变"
 *        Block Tree   —— 把动态后代平铺收集，让更新成本与树的深度无关
 *        Static Hoist —— 把静态子树提升到 render 函数之外，只创建一次
 *
 *   ③ 标识符处理：模板里的 `msg` → `_ctx.msg`
 *
 * ── 为什么用「遍历 + 访问者」的模式，而不是递归函数？ ──
 * 因为不同阶段要做的处理会越来越多（v-once、v-memo、TS、作用域分析…），
 * 用「节点类型 → 处理函数」的注册表能优雅地扩展，每个处理函数只关心一种节点。
 * Vue 的 transform 就是一个可插拔的 pipeline：
 *
 *     nodeTransforms: [transformElement, transformText, transformIf, transformFor, ...]
 *
 * 本实现沿用这个结构，只是把 pipeline 简化成了两个函数。
 */

import {
  ElementTypes,
  NodeTypes,
  createCompoundExpression,
  createSimpleExpression,
} from './ast.js'
import { PatchFlags } from '../shared/patchFlags.js'
import { camelize, capitalize, isHTMLTag, toHandlerKey } from '../shared/utils.js'
import { isStaticExpression, parseLiteralExpression, prefixIdentifiers } from './expression.js'
import {
  ARRAY,
  ARROW,
  BOOLEAN,
  CALL,
  CACHE,
  CONDITIONAL,
  IDENT,
  NULL,
  NUMBER,
  OBJECT,
  RAW,
  SEQ,
  STRING,
  prop,
  printJS,
} from './js-ast.js'

/**
 * 编译上下文。
 * 所有 transform 函数都通过它共享状态：
 *   helpers      —— 用到哪些运行时函数（决定 codegen 头部解构哪些）
 *   hoists       —— 静态提升的表达式
 *   scope        —— 当前作用域的局部变量（v-for 的 item/index、插槽参数）
 *   inVOnce      —— 是否在 v-once 内部（内部不再做优化）
 *   blockStack   —— 记录"当前这个节点是不是块的根"
 */
function createTransformContext(root, options) {
  const context = {
    root,
    options,
    helpers: new Set(),
    hoists: [],
    hoistIndex: 0,
    scope: new Set(), // 局部变量名（不需要加 _ctx. 前缀）
    inVOnce: 0, // v-once 深度（>0 表示在 v-once 内部，不再做其它优化）
    inFor: 0, // v-for 深度（>0 表示在 v-for 内部，禁止静态提升）
    /** 当前元素是不是「块的根」——由父节点决定，子节点在构建 codegenNode 时读取 */
    isBlockRoot: true,
    /** 需要在整个模板层面处理的 v-if/v-else-if/v-else 分组 */
    ifStack: [],

    helper(name) {
      context.helpers.add(name)
      return `_${name}`
    },

    /** 注册一个静态提升的节点，返回它的引用名（如 _hoisted_1） */
    hoist(expr) {
      const name = `_hoisted_${++context.hoistIndex}`
      context.hoists.push({ name, expr })
      return IDENT(name)
    },
  }
  return context
}

/**
 * 入口。
 *
 * @param {object} root parse() 产出的模板 AST
 * @param {object} options 编译选项
 * @returns 编译上下文（含 helpers / hoists，供 codegen 使用）
 */
export function transform(root, options = {}) {
  const context = createTransformContext(root, options)

  // 根节点默认是块的根：整个 render 返回的 vnode 树需要一个 block 来收集动态后代
  root.children = transformChildren(root.children, context, { isBlockRoot: true })

  // 把 IF / FOR 这类"整组"处理留下的痕迹清掉（这里已经就地替换过了）
  return context
}

/**
 * 转换一组子节点。
 *
 * ★ 这里体现了两个重要的编译器设计：
 *
 *   1. **兄弟节点的分组**：v-if / v-else-if / v-else 是三个独立的元素，
 *      但它们必须被合并成一个「条件表达式」。所以处理 children 时要"向前看"，
 *      在一轮循环里把连续的分支一次性吃掉。这就是为什么不能简单地 map 每个节点。
 *
 *   2. **block root 的判定**：哪些节点要作为「块的根」（即生成 _createElementBlock）？
 *      - 模板的根节点
 *      - v-if / v-for 内部的元素（因为它们的动态子节点数量会随分支/迭代变化）
 *      只有这些节点开块，才能保证每个块的 dynamicChildren 结构稳定 ——
 *      这是块树能正确 diff 的前提。
 *
 * @param {Array} children
 * @param {object} context
 * @param {object} opts { isBlockRoot } 这批子节点是否直接决定块的根
 */
function transformChildren(children, context, opts = {}) {
  const result = []

  for (let i = 0; i < children.length; i++) {
    let node = children[i]

    // ================================================================
    // ① v-if 分组：把 if / else-if / else 三兄弟合并成一个 IF 节点
    // ================================================================
    if (node.type === NodeTypes.ELEMENT && hasDirective(node, 'if')) {
      const branches = []
      let current = node

      // 收集 v-if
      branches.push(buildIfBranch(current, context, 'if'))
      // 向后吃掉所有 v-else-if / v-else
      while (i + 1 < children.length) {
        const next = children[i + 1]
        if (next.type !== NodeTypes.ELEMENT) break
        if (hasDirective(next, 'else-if')) {
          branches.push(buildIfBranch(next, context, 'else-if'))
          i++
        } else if (hasDirective(next, 'else')) {
          branches.push(buildIfBranch(next, context, 'else'))
          i++
          break // v-else 之后不能再有分支
        } else {
          break
        }
      }

      if (branches.length === 1) {
        // 只有 v-if 没有 v-else 是合法的常见写法，不需要警告
      }

      const ifNode = {
        type: NodeTypes.IF,
        branches,
        // ★ 直接把条件表达式构建成 JS AST（嵌套三元）挂到 codegenNode 上。
        //   这样 IF 节点无论出现在什么位置（根、元素的子节点、v-for 内部），
        //   都能像普通节点一样被 codegen 打印 —— 不需要 codegen 阶段再理解 v-if 的结构。
        codegenNode: buildIfCodegen(branches, context),
      }
      result.push(ifNode)
      continue
    }

    // 单独的 v-else-if / v-else（没有前置 v-if）→ 报错并忽略
    if (node.type === NodeTypes.ELEMENT && (hasDirective(node, 'else-if') || hasDirective(node, 'else'))) {
      warnAt(context, node, `v-${hasDirective(node, 'else') ? 'else' : 'else-if'} 前面没有对应的 v-if，已忽略`)
      continue
    }

    // ================================================================
    // ② 普通节点：先处理 v-for（它会包裹整个元素），再递归
    // ================================================================
    if (node.type === NodeTypes.ELEMENT && hasDirective(node, 'for')) {
      node = buildForNode(node, context, { isBlockRoot: opts.isBlockRoot })
      result.push(node)
      continue
    }

    if (node.type === NodeTypes.ELEMENT) {
      result.push(transformElement(node, context, opts))
    } else if (node.type === NodeTypes.INTERPOLATION) {
      result.push(transformInterpolation(node, context))
    } else if (node.type === NodeTypes.TEXT) {
      result.push(node) // 文本不需要转换，codegen 时直接输出字符串
    } else if (node.type === NodeTypes.COMMENT) {
      result.push(node)
    } else {
      result.push(node)
    }
  }

  return result
}

// =====================================================================
// v-if
// =====================================================================

/**
 * 构建一个 v-if 分支。
 *
 * 每个分支内部都开一个新的块 —— 这是必须的：
 *   <div v-if="ok"><span>{{ a }}</span></div>
 *   <p v-else>{{ b }}</p>
 *
 * 两个分支的动态节点数量不同（1 个 vs 1 个，但换成更复杂的模板就会不同）。
 * 如果它们共用一个块，切分支时 dynamicChildren 长度对不上，diff 就会错位。
 * 所以「每个分支 = 一个独立的块」，切换分支时整块替换。
 */
function buildIfBranch(node, context, kind) {
  const dir = findDirective(node, kind)
  // v-else 没有条件表达式
  const condition =
    kind === 'else' ? null : prefixIdentifiers(dir.exp ? dir.exp.content : 'undefined', context.scope)

  // 移除指令，剩下的属性正常处理
  node.props = node.props.filter(p => p !== dir)

  const branch = {
    type: NodeTypes.IF_BRANCH,
    condition,
    // ★ 分支元素必须是「块」且禁止静态提升（noHoist）。
    //
    //   为什么不能提升？看这个模板：
    //     <div><b v-if="ok">yes</b><i v-else>no</i></div>
    //   如果两个分支都被提升成模块级常量，div 的块里就没有任何动态节点，
    //   更新时块 diff 走了个空循环 —— ok 从 true 变 false 后，DOM 永远停在旧分支上。
    //
    //   正确做法（真实 Vue 同款）：每个分支编译成 _openBlock() + _createElementBlock(...)，
    //   分支 vnode 作为"动态节点"登记进父块。切换分支时块 diff 发现类型不同 → 卸载旧分支、挂载新分支。
    //   这也是为什么每个分支要独立开块 —— 见 transformChildren 里的说明。
    children: [transformElement(node, context, { isBlockRoot: true, noHoist: true })],
  }
  return branch
}

/**
 * 把 v-if 分支组构建成嵌套三元表达式的 JS AST。
 *
 *     cond1 ? branch1 : cond2 ? branch2 : branch3(else)
 *
 * ★ 三元表达式是「右结合」的：`a ? b : c ? d : e` 解析为 `a ? b : (c ? d : e)`，
 *   恰好和 v-if / v-else-if / v-else 的嵌套语义一致，所以从后往前构建即可。
 *   printJS 的加括号规则保证了嵌套的三元不会被错误加括号（同优先级不加）。
 */
function buildIfCodegen(branches, context) {
  // v-if 的所有分支都为假时，运行时需要一个"空占位"节点，
  // 保证表达式总是产出一个 vnode（注释节点，几乎零成本）
  const commentFallback = CALL(IDENT(context.helper('createCommentVNode')), [STRING('v-if')])

  let expr = null
  for (let i = branches.length - 1; i >= 0; i--) {
    const branch = branches[i]
    const branchCode =
      branch.children[0] && branch.children[0].codegenNode
        ? branch.children[0].codegenNode
        : commentFallback

    if (branch.condition == null) {
      // v-else：没有条件，作为最内层的兜底值
      expr = branchCode
    } else {
      expr = CONDITIONAL(RAW(branch.condition), branchCode, expr || commentFallback)
    }
  }
  return expr
}

// =====================================================================
// v-for
// =====================================================================

/**
 * v-for 的转换，是整个编译器里语义最复杂的部分：
 *
 *     <li v-for="(item, index) in list" :key="item.id">{{ item.name }}</li>
 *
 * 产物：
 *
 *     (_openBlock(true), _createElementBlock(_Fragment, null,
 *       _renderList(_ctx.list, (item, index) => {
 *         return (_openBlock(), _createElementBlock("li", { key: item.id },
 *           _toDisplayString(item.name), 1 /* TEXT *\/))
 *       }), 128 /* KEYED_FRAGMENT *\/
 *     ))
 *
 * 四个关键点：
 *
 *   ① 必须包一层 Fragment —— 因为 v-for 产生的是「多个平级节点」，
 *      而一个 JS 表达式只能返回一个值。Fragment 就是"一串节点的容器"。
 *
 *   ② `openBlock(true)` 里的 true 会**关闭**当前块的收集。
 *      为什么？v-for 的迭代次数是运行期才知道的（可能是 3 个、也可能 100 个），
 *      如果让每个迭代的动态节点都塞进同一个块，块的内容长度就不固定了。
 *      正确做法：每个迭代项各自作为一个「小方块」，
 *      由 patchChildren 通过 children 数组（而不是 dynamicChildren）来 diff 它们。
 *
 *   ③ item / index 是**局部变量**，必须加进 scope，
 *      否则 `item.name` 会被改写成 `_ctx.item.name`（这是初学者自己写编译器时最常见的 bug）。
 *
 *   ④ PatchFlag 是 KEYED_FRAGMENT（有 key）或 UNKEYED_FRAGMENT（无 key）。
 *      运行时据此决定走 keyed diff 还是简单 diff ——
 *      "有没有 key 影响性能"就在这里被编译器固化下来。
 */
function buildForNode(node, context, opts) {
  const dir = findDirective(node, 'for')
  node.props = node.props.filter(p => p !== dir)

  const expContent = (dir.exp && dir.exp.content) || ''
  const parsed = parseForExpression(expContent)
  if (!parsed) {
    warnAt(context, node, `v-for 表达式无法解析："${expContent}"，正确格式：(item, index) in list`)
    return transformElement(node, context, opts)
  }

  const { item, index, source } = parsed

  // 局部变量加入作用域（用新的 Set 副本，避免污染兄弟节点）
  const childScope = new Set(context.scope)
  if (item) childScope.add(item)
  if (index) childScope.add(index)

  // 递归转换子元素：把子元素当成"块的根"，这样每个迭代项各自成块
  // ★ inFor +1：告诉内部的 canBeHoisted"我们正在 v-for 里，不许做静态提升"
  const childContext = { ...context, scope: childScope, inFor: context.inFor + 1 }
  const child = transformElement(node, childContext, { isBlockRoot: true })

  // 判断是否有 key（有 key 才能用 keyed diff）
  // ★ 注意要同时检查静态属性 key="x" 和动态绑定 :key="item.id" ——
  //   v-for 里几乎总是用动态 key，只查静态属性会漏掉。
  const hasKey = node.props.some(
    p =>
      (p.type === NodeTypes.ATTRIBUTE && p.name === 'key') ||
      (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && p.arg && p.arg.content === 'key')
  )

  const sourceExpr = RAW(prefixIdentifiers(source, context.scope))
  const listHelper = context.helper('renderList')

  // 回调参数：(item, index) => { return <child> }
  const params = []
  if (item) params.push(item)
  if (index) params.push(index)
  const callback = ARROW(params, child.codegenNode)

  const forNode = {
    type: NodeTypes.FOR,
    source: sourceExpr,
    valueAlias: item,
    keyAlias: index,
    hasKey,
    children: [child],
    codegenNode: SEQ([
      // ★ openBlock(true)：把"收集"关掉（详见函数头注释的第 ② 点）
      CALL(IDENT(context.helper('openBlock')), [BOOLEAN(true)]),
      CALL(IDENT(context.helper('createElementBlock')), [
        IDENT(context.helper('Fragment')),
        NULL(),
        CALL(IDENT(listHelper), [sourceExpr, callback]),
        // PatchFlag 告诉运行时：这个列表能不能走 keyed diff
        NUMBER(hasKey ? PatchFlags.KEYED_FRAGMENT : PatchFlags.UNKEYED_FRAGMENT),
      ]),
    ]),
  }
  return forNode
}

/**
 * 解析 v-for 的表达式。
 * 支持的写法：
 *   item in list
 *   (item, index) in list
 *   (item, index) of list        —— "of" 是 ES6 迭代语法，Vue 也支持
 *   item in obj                  —— 遍历对象（value, key, index）
 *   item in 10                   —— 遍历数字 1..10
 *
 * 返回值里 source 是「数据源表达式」，item/index 是局部变量名。
 * （真实 Vue 对对象的 key/index 语义更细，这里保持够用的粒度。）
 */
export function parseForExpression(content) {
  const match = content.match(/^\s*(\(([^)]*)\)|([^\s]+))\s+(?:in|of)\s+([\s\S]+)$/)
  if (!match) return null

  const aliasText = match[2] != null ? match[2] : match[3]
  const source = match[4].trim()
  const aliases = aliasText.split(',').map(s => s.trim()).filter(Boolean)

  return {
    item: aliases[0] || 'item',
    index: aliases[1] || null,
    source,
  }
}

// =====================================================================
// 文本合并（对应真实 Vue 的 transformText 插件）
// =====================================================================

/**
 * 把「连续的文本 + 插值」合并成一个表达式。
 *
 * 判定条件（必须同时满足，否则不合并）：
 *   1. children 里至少有一个插值（纯静态文本不需要合并，让它走静态提升更好）
 *   2. children 里**没有元素/组件**（有元素就必须走数组 + diff 的路径）
 *
 * 合并结果是一个 CompoundExpression，codegen 时按 `+` 拼起来：
 *
 *     [插值 msg, 文本 " - ", 插值 name]
 *        ↓
 *     _toDisplayString(_ctx.msg) + " - " + _toDisplayString(_ctx.name)
 *
 * 为什么不合并成数组里的多个 createTextVNode？因为那样是 3 个文本节点，
 * 更新时要 diff 3 次；合并后是 1 个文本节点，更新时一次 setText 就完成。
 *
 * @returns {{node: object}|null} 合并结果，null 表示不满足合并条件
 */
function mergeTextChildren(children) {
  if (children.length < 2) return null

  let hasInterpolation = false
  for (const child of children) {
    if (child.type === NodeTypes.INTERPOLATION) {
      hasInterpolation = true
    } else if (child.type !== NodeTypes.TEXT) {
      // 出现元素 / 组件 / 注释 / v-if / v-for → 不能合并
      // （注释也可以合并，但为了逻辑清晰这里保守处理）
      return null
    }
  }
  if (!hasInterpolation) return null // 全是静态文本，交给静态提升处理

  // 构造 `A + " - " + B` 形式的复合表达式
  const parts = children.map(child => {
    if (child.type === NodeTypes.TEXT) return JSON.stringify(child.content)
    // 插值节点的 codegenNode 已经是 _toDisplayString(x)
    return printJS(child.codegenNode)
  })

  const node = {
    type: NodeTypes.COMPOUND_EXPRESSION,
    // 存成字符串形式，codegen 时直接输出。
    // 真实 Vue 存的是"字符串与 JS AST 的混合数组"（为了能做进一步的常量折叠），
    // 这里简化为纯字符串，原理一致、更容易看懂。
    content: parts.join(' + '),
    isCompound: true,
  }
  return { node }
}

// =====================================================================
// 元素
// =====================================================================

/**
 * 转换一个元素。这是最核心的函数，产物就是元素的 codegenNode。
 *
 * 步骤：
 *   ① 处理会影响元素本身的指令：v-model / v-html / v-text / v-once / v-slot
 *   ② 分出静态属性 / 动态属性，算出 patchFlag 和 dynamicProps
 *   ③ 递归转换 children
 *   ④ 组装成 createElementVNode / createElementBlock / createVNode(组件) / renderSlot 调用
 *   ⑤ 判断能否静态提升
 */
function transformElement(node, context, opts = {}) {
  const { tagType, tag } = node

  // ---- ① 处理各种指令（会修改 node.props / node.children / node.codegenNode） ----
  const modelDir = findDirective(node, 'model')
  if (modelDir) transformModel(node, context, modelDir)

  const htmlDir = findDirective(node, 'html')
  if (htmlDir) {
    node.props = node.props.filter(p => p !== htmlDir)
    node.children = []
    node.innerHTMLDir = htmlDir // codegen 时生成 innerHTML
  }

  const textDir = findDirective(node, 'text')
  if (textDir) {
    node.props = node.props.filter(p => p !== textDir)
    node.children = []
    node.textContentDir = textDir
  }

  const onceDir = findDirective(node, 'once')
  if (onceDir) {
    node.props = node.props.filter(p => p !== onceDir)
    node.isVOnce = true
    context.inVOnce++
  }

  // v-slot 出现在元素上（<template #foo>）时，说明这个元素的 children 是插槽内容
  const slotDir = findDirective(node, 'slot')

  // ---- ② 分类属性，算 patchFlag ----
  const staticProps = [] // 静态属性 → 直接进对象字面量
  const dynamicProps = [] // 动态属性名（用于 PatchFlags.PROPS + dynamicProps）
  let hasDynamicClass = false
  let hasDynamicStyle = false
  let hasFullProps = false // v-bind 对象展开 → 必须全量对比

  for (const p of node.props) {
    if (p.type === NodeTypes.ATTRIBUTE) {
      // 静态属性：值是字符串，编译期就定死了
      staticProps.push(prop(p.name, STRING(p.value ? p.value.content : '')))
      // 记下静态 class/style 的值 —— 若同时存在动态绑定，两者要合并成一个表达式
      if (p.name === 'class') node.staticClassValue = p.value ? p.value.content : ''
      if (p.name === 'style') node.staticStyleValue = p.value ? p.value.content : ''
      continue
    }

    // 指令
    const { name, arg, exp, modifiers } = p

    if (name === 'bind') {
      if (!arg) {
        // v-bind="obj" 对象展开：属性集合本身是动态的
        hasFullProps = true
        dynamicProps.push(`__spread_${dynamicProps.length}`) // 占位，全量对比时用不到
        p.isSpread = true
        continue
      }
      const argName = arg.content
      const expContent = exp ? exp.content : ''
      // 值在编译期就能确定的绑定（:id="'a'"）→ 当成静态属性
      if (isStaticExpression(expContent)) {
        const value = parseLiteralExpression(expContent)
        if (argName === 'class') {
          staticProps.push(prop('class', STRING(String(value))))
        } else if (argName === 'style') {
          staticProps.push(prop('style', STRING(String(value))))
        } else {
          staticProps.push(prop(argName, STRING(String(value))))
        }
        continue
      }
      const prefixed = prefixIdentifiers(expContent, context.scope)
      if (argName === 'class') {
        // ★ 动态 class / style 单独用 CLASS / STYLE 标记，而**不**进 dynamicProps 清单：
        //   它们的值是数组/对象这类"需要归一化"的形态，运行时归一化开销大，
        //   编译器用独立标志告诉运行时"这里要专门处理"，从而避免和其他属性混在一起做全量对比。
        //   产物长这样：{ class: _normalizeClass(_ctx.cls) }
        hasDynamicClass = true
        node.dynamicClassExp = prefixed
      } else if (argName === 'style') {
        hasDynamicStyle = true
        node.dynamicStyleExp = prefixed
      } else if (argName === 'key') {
        // ★ key 不进 dynamicProps：它是 vnode 的元信息，不是 DOM 属性。
        //   而且 key 一变，isSameVNodeType 立刻判定"不能复用"→ 节点被重建，
        //   所以它永远不会需要被 patch。放进清单只会产生噪音。
      } else if (argName === 'ref') {
        // 同理，ref 由渲染器单独处理
      } else {
        dynamicProps.push(argName)
      }
    } else if (name === 'on') {
      if (p.preBuilt) {
        // v-model 生成的处理器：handlerKey 已经算好，只需登记进动态属性清单。
        // ★ 这一句不能漏！否则 v-model 的 input 事件在组件重新渲染时不会被替换成新闭包，
        //   用户输入后 model 的值更新了，但下一次输入仍然写进旧的闭包 → 表现为"输入框莫名回退"。
        dynamicProps.push(p.handlerKey)
        continue
      }
      // @click → onClick；带修饰符的包一层 _withModifiers
      const eventName = arg ? arg.content : ''
      const prefixed = prefixIdentifiers(exp ? exp.content : '() => {}', context.scope)
      const handlerKey = toHandlerKey(camelize(eventName))
      p.eventName = eventName
      p.handlerKey = handlerKey
      p.handlerExpr = prefixed
      p.modifiers = modifiers
      dynamicProps.push(handlerKey)
    } else if (name === 'model') {
      // transformModel 已经把 v-model 拆成了 modelValue + onUpdate:modelValue，
      // 这里剩下的 model 指令只是占位（已经在上面过滤掉了）
    }
    // v-if / v-for / else 系列已经被处理并移除了
  }

  // ---- ③ 递归转换 children ----
  const isComponent = tagType === ElementTypes.COMPONENT
  const isSlot = tagType === ElementTypes.SLOT
  const isTemplate = tagType === ElementTypes.TEMPLATE

  // ---- ③.0 组件的 <template #name> 具名插槽 ----
  //   <MyComp>
  //     <template #header>…</template>    ← 这些"带 v-slot 的 template"
  //     <p>默认内容</p>                    ← 和散落的普通子节点
  //   </MyComp>
  //   会被整理成一个「插槽对象」作为组件的 children：
  //     { header: _withCtx(() => […]), default: _withCtx(() => […]) }
  //
  //   ★ 插槽内容要在"插槽自己的作用域"里转换：v-slot="scope" 解构出来的名字是局部变量，
  //     不加 _ctx. 前缀（它们由子组件通过 renderSlot 的参数传入）。
  //   ★ 内容函数用 _withCtx 包一层：记录"这段内容属于父组件"，
  //     子组件渲染 <slot> 时临时切回父组件的作用域（组件解析、依赖归属都依赖这一点）。
  const slotEntries = []
  if (isComponent) {
    const loose = []
    for (const child of node.children) {
      const isSlotTemplate =
        child.type === NodeTypes.ELEMENT &&
        child.tagType === ElementTypes.TEMPLATE &&
        hasDirective(child, 'slot')
      if (isSlotTemplate) {
        const dir = findDirective(child, 'slot')
        const name = dir.arg && dir.arg.content ? dir.arg.content : 'default'
        const param = dir.exp && dir.exp.content ? dir.exp.content.trim() : null

        // 插槽作用域：v-slot="{ todo }" 里的解构名是局部变量
        const childScope = new Set(context.scope)
        if (param) {
          for (const m of param.match(/[A-Za-z_$][\w$]*/g) || []) childScope.add(m)
        }

        const tplChildren = transformChildren(
          child.children,
          { ...context, scope: childScope },
          { isBlockRoot: false }
        )
        const fn = ARROW(param ? [param] : [], ARRAY(tplChildren.map(c => childToExpression(c, context))))
        slotEntries.push(prop(name, CALL(IDENT(context.helper('withCtx')), [fn])))
      } else {
        loose.push(child)
      }
    }
    node.children = loose
    node.slotEntries = slotEntries
  }

  node.children = transformChildren(node.children, context, { isBlockRoot: false })

  // ---- ③.5 文本合并（transformText）----
  // ★ 这一步很重要，不只是一个优化，而是**正确性**的需要。
  //
  //    <li>{{ index }} - {{ item.name }}</li>
  //
  //   直觉上 children 是 3 个节点（插值、文本、插值），而插值不是 vnode，
  //   不会被收进 dynamicChildren，patchFlag 也不会被设成 TEXT（因为"只有一个动态文本"不成立）。
  //   结果就是：这个节点的文本永远不更新。
  //
  //   真实 Vue 的做法是把「连续的文本/插值」合并成**一个表达式**：
  //      children = _toDisplayString(index) + " - " + _toDisplayString(item.name)
  //   于是它变成了「一个（动态的）文本子节点」→ 可以打上 PatchFlags.TEXT，
  //   更新时运行时直接 setText 就完事，既正确又高效。
  //
  //   这段逻辑对应真实 Vue 的 transformText 插件。
  const merged = mergeTextChildren(node.children)
  if (merged) {
    node.children = [merged.node]
    node.isTextMerged = true
  }

  // ---- ④ 判断是否为「单一文本子节点」----
  //    <p>{{ msg }}</p> 或合并后的 <li>{{a}} - {{b}}</li>
  //    → patchFlag 打 TEXT，更新时直接改 textContent，不用 diff
  const isSingleTextChild =
    node.children.length === 1 &&
    (node.children[0].type === NodeTypes.INTERPOLATION || node.isTextMerged) &&
    !isComponent &&
    !isSlot

  // ---- ⑤ 算 patchFlag ----
  let patchFlag = 0
  const flags = []
  if (hasFullProps) {
    flags.push('FULL_PROPS')
  } else if (dynamicProps.length) {
    flags.push('PROPS')
  }
  if (hasDynamicClass && !dynamicProps.includes('class')) flags.push('CLASS')
  if (hasDynamicStyle && !dynamicProps.includes('style')) flags.push('STYLE')
  if (isSingleTextChild) flags.push('TEXT')
  patchFlag = flags.reduce((acc, name) => acc | PatchFlags[name], 0)

  node.patchFlag = patchFlag
  node.dynamicProps = [...new Set(dynamicProps)]

  // ---- ⑤.5 静态 class/style 与动态绑定同时存在 → 合并成一个表达式 ----
  //     <b class="todo" :class="{ done: x }">
  //     ↓ 产物必须是【一个】class 键：
  //       class: _normalizeClass(["todo", { done: _ctx.todo.done }])
  //     如果各自生成一份，对象字面量里会出现两个 class 键（后者静默覆盖前者），
  //     静态类就丢了 —— 这是模板编译器一个经典的正确性坑。
  if (hasDynamicClass) mergeStaticAndDynamic(node, staticProps, 'class')
  if (hasDynamicStyle) mergeStaticAndDynamic(node, staticProps, 'style')

    // ---- ⑥ 组装 codegenNode ----
    let codegenNode

    if (isSlot) {
      codegenNode = buildSlotCodegen(node, context)
    } else {
      // ★ 先判断能否静态提升 —— 必须在构建调用之前判断，因为"是不是块的根"要依赖它：
      //   静态子树绝对不会变，没有"动态后代"可收集，因此不应该开块。
      //   （真实 Vue 里静态提升的节点同样用 createElementVNode 创建，不带 patchFlag）
      const canHoist = !opts.noHoist && canBeHoisted(node, context)
      const isBlockRoot = !!opts.isBlockRoot && !canHoist

      // 组件的 type 是 _resolveComponent("Xxx")；元素是字符串
      let typeExpr
      if (isComponent) {
        typeExpr = CALL(IDENT(context.helper('resolveComponent')), [STRING(tag)])
      } else {
        typeExpr = STRING(tag)
      }

      const propsExpr = buildPropsObject(node, context, staticProps)
      let childrenExpr = buildChildrenExpr(node, context)

      // 组件带具名插槽 → children 是「插槽对象」而不是数组
      // （运行时 initSlots 依据 children 的形态区分：对象 = 插槽集合，数组 = default 插槽内容）
      if (isComponent && slotEntries && slotEntries.length) {
        const properties = [...slotEntries]
        if (node.children.length) {
          // 散落的普通子节点归入 default 插槽
          const fn = ARROW([], ARRAY(node.children.map(c => childToExpression(c, context))))
          properties.push(prop('default', CALL(IDENT(context.helper('withCtx')), [fn])))
        }
        childrenExpr = OBJECT(properties)
      }

      // ★ 元素的入口函数 vs 组件的入口函数分开命名：
      //   元素 → createElementVNode / createElementBlock（type 是字符串）
      //   组件 → createVNode / createBlock（type 是 resolveComponent 的结果）
      //   实现几乎一样，分开是为了让产物一眼可读（真实 Vue 也是两套名字）。
      const createName = isComponent
        ? isBlockRoot
          ? 'createBlock'
          : 'createVNode'
        : isBlockRoot
          ? 'createElementBlock'
          : 'createElementVNode'

      const callArgs = [typeExpr, propsExpr, childrenExpr]

      // patchFlag 是第 4 个参数。组件的 props 有动态内容时也要标 PROPS，
      // 因为组件的更新判断（shouldUpdateComponent）依赖它。
      const effectiveFlag =
        patchFlag > 0
          ? patchFlag
          : isComponent && (dynamicProps.length || hasFullProps)
            ? PatchFlags.PROPS
            : canHoist
              ? PatchFlags.HOISTED // ★ -1：告诉运行时"这是提升的节点，可以整个跳过"
              : 0

      if (effectiveFlag !== 0) {
        callArgs.push(NUMBER(effectiveFlag))
        // 第 5 个参数：动态属性清单（仅 PatchFlags.PROPS 且不是全量对比时需要）
        if (effectiveFlag > 0 && !hasFullProps && dynamicProps.length) {
          callArgs.push(ARRAY([...new Set(dynamicProps)].map(n => STRING(n))))
        }
      }

      const call = CALL(IDENT(context.helper(createName)), callArgs)
      // 块的根：先用 openBlock() 开一个收集列表，再由 createXxxBlock 收尾（setupBlock）
      codegenNode = isBlockRoot ? SEQ([CALL(IDENT(context.helper('openBlock')), []), call]) : call

      if (canHoist) {
        node.isStatic = true
        codegenNode = context.hoist(codegenNode)
      }
    }

  node.codegenNode = codegenNode

  if (onceDir) context.inVOnce--

  return node
}

/**
 * 静态与动态 class/style 同时存在时，把静态项从 staticProps 里摘掉。
 * 它的值已存到 node.staticClassValue / node.staticStyleValue 上，
 * 会在 buildPropsObject 里并入合并后的 normalizeClass/normalizeStyle 表达式：
 *
 *     <b class="todo" :class="{ done: x }">
 *        ↓
 *        class: _normalizeClass(["todo", { done: _ctx.todo.done }])
 */
function mergeStaticAndDynamic(node, staticProps, type) {
  const idx = staticProps.findIndex(p => p.key === type)
  if (idx !== -1) staticProps.splice(idx, 1)
}

/** 把元素的属性组装成对象字面量 */
function buildPropsObject(node, context, staticProps) {
  const properties = [...staticProps]

  for (const p of node.props) {
    if (p.type !== NodeTypes.DIRECTIVE) continue

    if (p.name === 'bind') {
      if (!p.arg) {
        // v-bind="obj" 对象展开 → 用展开语法合进对象
        properties.push({
          spread: true,
          value: RAW(prefixIdentifiers(p.exp ? p.exp.content : '{}', context.scope)),
        })
      } else {
        const argName = p.arg.content
        const prefixed = prefixIdentifiers(p.exp ? p.exp.content : 'undefined', context.scope)

        if (argName === 'class') {
          // ★ 静态 class（如果有）与动态绑定合并成一次 normalizeClass 调用
          const parts = []
          if (node.staticClassValue) parts.push(STRING(node.staticClassValue))
          parts.push(RAW(prefixed))
          const argExpr = parts.length > 1 ? ARRAY(parts) : parts[0]
          properties.push(prop('class', CALL(IDENT(context.helper('normalizeClass')), [argExpr])))
        } else if (argName === 'style') {
          const parts = []
          if (node.staticStyleValue) parts.push(STRING(node.staticStyleValue))
          parts.push(RAW(prefixed))
          const argExpr = parts.length > 1 ? ARRAY(parts) : parts[0]
          properties.push(prop('style', CALL(IDENT(context.helper('normalizeStyle')), [argExpr])))
        } else {
          properties.push(prop(argName, RAW(prefixed)))
        }
      }
    } else if (p.name === 'on') {
      properties.push(prop(p.handlerKey, buildEventHandler(p, context)))
    }
    // model / html / text / once / slot 都已被处理并移除，这里无需再管
  }

  // v-html / v-text 通过 innerHTML / textContent 属性传递（运行时 patchProp 会识别为 property）
  if (node.innerHTMLDir) {
    properties.push(
      prop('innerHTML', RAW(prefixIdentifiers(node.innerHTMLDir.exp ? node.innerHTMLDir.exp.content : '""', context.scope)))
    )
  }
  if (node.textContentDir) {
    properties.push(
      prop('textContent', RAW(prefixIdentifiers(node.textContentDir.exp ? node.textContentDir.exp.content : '""', context.scope)))
    )
  }

  if (properties.length === 0) return NULL()
  return OBJECT(properties)
}

/**
 * 构建事件处理器的表达式，处理修饰符。
 *
 *     @click.stop="fn"   →  { onClick: _withModifiers(fn, ["stop"]) }
 *     @click="count++"   →  { onClick: $event => (count++) }
 *
 * 「语句 vs 表达式」的判断很关键：
 *   @click="count++"     是语句 → 必须包成函数
 *   @click="handleClick" 是表达式（一个函数引用）→ 直接传
 * 判据：能构成"合法的单个表达式"就直接用，否则包一层箭头函数。
 */
function buildEventHandler(p, context) {
  // p.handlerExpr 有两种来源：
  //   ① 普通 @click="..." → 上面分类循环里 prefixIdentifiers 处理过的表达式
  //   ② v-model 生成的处理器 → transformModel 里已经拼好的完整箭头函数
  const raw = p.handlerExpr || '() => {}'

  // ★ 判定「是不是函数引用」必须非常保守：
  //   只有裸标识符 / 成员链（_ctx.fn、_ctx.obj.fn）才能直接当处理器传 ——
  //   因为传的是"引用本身"，之后每次触发都调用同一个函数。
  //   带 () 的调用、赋值、$emit(...) 之类的表达式，统统要包一层箭头函数：
  //     @change="$emit('toggle', todo)"  →  onChange: $event => ($emit('toggle', _ctx.todo))
  //   否则就成了"渲染时立刻调用、把返回值当处理器" —— 事件永远绑不上。
  //   （真实 Vue 用 babel 全量解析表达式来判断"语句还是表达式"，这里用保守的正则近似。）
  const trimmed = raw.trim()
  const isMemberRef = /^[$_\w][$\w$.]*$/.test(trimmed)
  const isArrow = trimmed.includes('=>')
  const needsWrap = !isMemberRef && !isArrow

  let expr = needsWrap ? ARROW(['$event'], RAW(raw)) : RAW(raw)

  // 事件修饰符：包一层 _withModifiers
  if (p.modifiers && p.modifiers.length) {
    expr = CALL(IDENT(context.helper('withModifiers')), [expr, ARRAY(p.modifiers.map(m => STRING(m)))])
  }
  return expr
}

/** 构建 children 表达式的参数 */
function buildChildrenExpr(node, context) {
  const children = node.children

  // v-html / v-text 会清空 children，此时第三个参数传 null
  if (node.innerHTMLDir || node.textContentDir) return NULL()

  // 无子节点
  if (children.length === 0) return NULL()

  // 单一的 v-if / v-for → 它们的 codegenNode 就是完整表达式（三元 / renderList 调用）。
  // ★ 必须包一层数组：children 表达式是一个"vnode 或字符串"，
  //   而条件/renderList 的结果也是单个 vnode —— 传给 createVNode 时会被误判成
  //   SLOTS_CHILDREN（对象形态）。包成数组后明确是 ARRAY_CHILDREN，走正常的 diff 路径。
  //   （对照真实 Vue 的产物：<div><span v-if=.../></div> 的 children 同样是 [三元]）
  if (children.length === 1 && (children[0].type === NodeTypes.IF || children[0].type === NodeTypes.FOR)) {
    return ARRAY([children[0].codegenNode])
  }

  // 合并后的文本表达式（见 mergeTextChildren）：
  // children 变成了「一个动态文本」，直接作为第三个参数传进去
  if (children.length === 1 && children[0].type === NodeTypes.COMPOUND_EXPRESSION) {
    return RAW(children[0].content)
  }

  // 单一插值 → _toDisplayString(x)
  if (children.length === 1 && children[0].type === NodeTypes.INTERPOLATION) {
    return children[0].codegenNode
  }

  // 单一文本 → 直接传字符串（运行时 createVNode 会据此设成 TEXT_CHILDREN）
  if (children.length === 1 && children[0].type === NodeTypes.TEXT) {
    return STRING(children[0].content)
  }

  // 单一注释 → 必须生成 vnode（不能返回裸字符串，否则会被当成文本节点）
  if (children.length === 1 && children[0].type === NodeTypes.COMMENT) {
    return CALL(IDENT(context.helper('createCommentVNode')), [STRING(children[0].content)])
  }

  // 多个子节点 → 数组。★ 数组里的纯文本必须用 createTextVNode 包成 vnode，
  // 否则运行时 diff 遇到"字符串 vs vnode"类型对不上会出错。
  return ARRAY(children.map(child => childToExpression(child, context)))
}

/** 把子节点 AST 转成「表达式」（作为数组元素的形式） */
function childToExpression(child, context) {
  if (child.type === NodeTypes.TEXT) {
    // 数组里的纯文本必须包成 vnode
    return CALL(IDENT(context.helper('createTextVNode')), [STRING(child.content)])
  }
  if (child.type === NodeTypes.COMMENT) {
    return CALL(IDENT(context.helper('createCommentVNode')), [STRING(child.content)])
  }
  if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
    // 合并后的文本表达式是字符串，需要包成文本 vnode 才能放进数组
    return CALL(IDENT(context.helper('createTextVNode')), [RAW(child.content)])
  }
  if (child.type === NodeTypes.INTERPOLATION) {
    return child.codegenNode
  }
  if (child.codegenNode) return child.codegenNode
  return NULL()
}

/**
 * 构建 <slot> 的调用。
 *
 *     <slot name="header" :user="user">默认内容</slot>
 *     ↓
 *     _renderSlot(_ctx.$slots, "header", { user: _ctx.user }, () => [ "默认内容" ])
 *
 * 注意插槽内容的求值被包在箭头函数里（fallback 也在箭头函数里），
 * 这样"父组件没传插槽"时这段内容就不会被求值 —— 惰性求值。
 */
function buildSlotCodegen(node, context) {
  // 插槽名的三种来源，按优先级：
  //   1. <slot v-slot:xxx>（少见）   2. <slot name="xxx">（静态属性，最常见）   3. 默认插槽
  const slotDir = findDirective(node, 'slot')
  let name = slotDir && slotDir.arg ? slotDir.arg.content : null
  if (!name) {
    const nameAttr = node.props.find(p => p.type === NodeTypes.ATTRIBUTE && p.name === 'name')
    if (nameAttr) name = nameAttr.value ? nameAttr.value.content : 'default'
  }
  name = name || 'default'

  // <slot> 上的其他属性（:user="user"）作为「作用域插槽的参数」传给父组件的插槽函数
  const propsObj = buildPropsObject(node, context, [])
  node.props = [] // 已消费

  const children = node.children
  let fallback = NULL()
  if (children.length) {
    const expr = buildChildrenExpr(node, context)
    fallback = ARROW([], expr)
  }

  const helper = context.helper('renderSlot')
  return CALL(IDENT(helper), [
    RAW('_ctx.$slots'),
    STRING(name),
    // buildPropsObject 无属性时返回 NULL 节点，这里统一成空对象，保持调用形式稳定
    propsObj && propsObj.type === 'NullLiteral' ? OBJECT([]) : propsObj || OBJECT([]),
    fallback,
  ])
}

/** 插值 → _toDisplayString(expr) */
function transformInterpolation(node, context) {
  const raw = node.content.content
  const prefixed = prefixIdentifiers(raw, context.scope)
  const helper = context.helper('toDisplayString')
  node.codegenNode = CALL(IDENT(helper), [RAW(prefixed)])
  return node
}

// =====================================================================
// v-model —— 一个指令抵两件事
// =====================================================================

/**
 * v-model —— 一个指令抵两件事，是「语法糖」的典型代表。
 *
 * ── 情况一：用在原生表单元素上（input / textarea）──
 *
 *     <input v-model="msg">
 *     ↓ 等价于
 *     <input :value="msg" @input="msg = $event.target.value">
 *
 *   新值要从 $event.target.value 里取，事件是原生的 input。
 *
 * ── 情况二：用在组件上 ──
 *
 *     <MyComp v-model="msg">
 *     ↓ 等价于
 *     <MyComp :modelValue="msg" @update:modelValue="msg = $event">
 *
 *   新值就是 emit 的参数本身，事件名是约定好的 update:modelValue。
 *   这就是「为什么组件 v-model 必须叫 modelValue」的答案 —— 它只是一个编译期约定。
 *   写成 v-model:title="t" 就能用 update:title，名字可自定义，机制完全一样。
 *
 * ── 修饰符 ──
 *   .lazy   把 input 事件换成 change（失焦/回车才同步）
 *   .number 用 _looseToNumber 把字符串转成数字
 *   .trim   赋值前先 trim()
 *
 * ── 实现技巧 ──
 *   转换完成后，我们把它「彻底降级」成两个普通的 bind/on 指令塞回 node.props。
 *   这样后续的 buildPropsObject 完全不需要知道 v-model 存在过 ——
 *   一个特殊情况被翻译成了通用情况，后面的代码只用处理通用情况。
 *   这种"把特殊语法尽早降解成基本语法"的思路，是编译器设计里非常常用的手法。
 */
function transformModel(node, context, dir) {
  const exp = dir.exp ? dir.exp.content : ''
  const isComponent = node.tagType === ElementTypes.COMPONENT
  const modifiers = dir.modifiers || []
  const propName = dir.arg ? dir.arg.content : 'modelValue' // v-model:foo 可以自定义名字

  // 取出「新值」的表达式
  let valueExpr
  if (isComponent) {
    valueExpr = '$event'
  } else if (modifiers.includes('number')) {
    valueExpr = `_looseToNumber($event.target.value)`
    context.helper('looseToNumber')
  } else {
    valueExpr = '$event.target.value'
  }

  // 属性名 / 事件名：原生元素用 value + input，组件用 modelValue + update:modelValue
  const attrName = isComponent ? propName : 'value'
  const eventName = isComponent
    ? `update:${propName}`
    : modifiers.includes('lazy')
      ? 'change'
      : 'input'

  // ★ 必须先把表达式里的标识符加上 _ctx. 前缀，再拼赋值语句 ——
  //   顺序反了的话，prefixIdentifiers 会把我们拼好的 `$event` 也当成普通标识符处理。
  const prefixedExp = prefixIdentifiers(exp, context.scope)

  let handlerExpr
  if (modifiers.includes('trim')) {
    // trim 需要"先取值再 trim"，无法写成单个表达式，所以用代码块
    const raw = isComponent ? '$event' : '$event.target.value'
    handlerExpr = `$event => { ${prefixedExp} = ${raw}.trim() }`
  } else {
    handlerExpr = `$event => (${prefixedExp} = ${valueExpr})`
  }

  // 从 props 里摘掉 v-model，换上等价的 :value + @input（或 :modelValue + @update:modelValue）
  node.props = node.props.filter(p => p !== dir)
  node.props.push(makeBindDirective(attrName, prefixedExp))
  node.props.push({
    type: NodeTypes.DIRECTIVE,
    name: 'on',
    arg: { type: NodeTypes.SIMPLE_EXPRESSION, content: eventName, isStatic: true },
    exp: undefined,
    modifiers: [],
    // 标记：处理器表达式已拼好，buildEventHandler 直接使用
    preBuilt: true,
    handlerKey: toHandlerKey(camelize(eventName)),
    handlerExpr,
    eventName,
  })
}

function makeBindDirective(argName, prefixedExpr) {
  return {
    type: NodeTypes.DIRECTIVE,
    name: 'bind',
    arg: { type: NodeTypes.SIMPLE_EXPRESSION, content: argName, isStatic: true },
    exp: { type: NodeTypes.SIMPLE_EXPRESSION, content: prefixedExpr, isStatic: false },
    modifiers: [],
    preBuilt: true,
  }
}

// =====================================================================
// 静态提升（static hoisting）
// =====================================================================

/**
 * 判断这个元素能否被「静态提升」。
 *
 * 条件（全部满足）：
 *   - 是原生元素（组件不行：它有实例状态，而且 props 可能含响应式值）
 *   - 没有 patchFlag（没有任何动态属性 / 动态文本）
 *   - 没有 v-html / v-text / v-once
 *   - 不在 v-for 里（★ 见下面的说明）
 *   - 整棵子树递归检查后都是静态的
 *
 * ★ 为什么 v-for 里绝对不能提升？
 *   提升后所有迭代项会共享同一个 vnode 对象，而 vnode 上挂着 `el`（真实 DOM 引用）。
 *   第二次赋值 el 就会覆盖第一次的，导致 diff 拿着错误的 DOM 去 patch ——
 *   表现是"列表渲染错乱、节点乱飞"这类极难排查的 bug。
 *   这个概念叫「vnode 必须在一次渲染中唯一」，是手写编译器最容易踩的坑之一。
 *
 * ★ 跨组件实例共享的问题怎么解决？
 *   提升的节点是模块级常量，同一个组件被实例化多次时会被共用 —— 同样有 el 冲突风险。
 *   解决办法在运行时：normalizeVNode 会对「已经挂载过的提升节点」做浅拷贝（cloneIfMounted），
 *   每个使用位置拿到自己的副本。这与真实 Vue 的 cloneIfMounted 完全一致。
 */
function canBeHoisted(node, context) {
  if (context.inVOnce > 0) return false // v-once 内部不再提升
  if (context.inFor > 0) return false // v-for 内部绝对不能提升
  if (node.tagType !== ElementTypes.ELEMENT) return false
  if (node.patchFlag !== 0) return false
  if (node.innerHTMLDir || node.textContentDir) return false
  if (node.isVOnce) return false
  return isSubtreeStatic(node, context)
}

/**
 * 递归判断一棵子树是否完全静态 —— 任何一处动态内容都会让整棵子树"不静态"。
 */
function isSubtreeStatic(node, context, depth = 0) {
  if (depth > 24) return false // 防止极深嵌套导致栈过深

  if (node.type === NodeTypes.TEXT || node.type === NodeTypes.COMMENT) return true
  if (node.type === NodeTypes.INTERPOLATION) return false // 插值是动态的
  if (node.type === NodeTypes.IF || node.type === NodeTypes.FOR) return false

  if (node.type === NodeTypes.ELEMENT) {
    if (node.tagType !== ElementTypes.ELEMENT) return false
    if (node.patchFlag !== 0) return false
    if (node.isVOnce) return false
    // 残留的任何指令都意味着运行时行为，不能提升
    for (const p of node.props) {
      if (p.type === NodeTypes.DIRECTIVE) return false
    }
    if (node.children.length === 0) return true
    return node.children.every(child => isSubtreeStatic(child, context, depth + 1))
  }
  return false
}

// =====================================================================
// 小工具
// =====================================================================

export function findDirective(node, name) {
  if (!node.props) return null
  return node.props.find(p => p.type === NodeTypes.DIRECTIVE && p.name === name) || null
}

export function hasDirective(node, name) {
  return !!findDirective(node, name)
}

function warnAt(context, node, msg) {
  const tag = node.tag || node.type
  console.warn(`[vue-mini][编译警告] <${tag}>: ${msg}`)
}
