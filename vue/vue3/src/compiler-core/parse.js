/**
 * 语法分析（parse）—— 编译器流水线的第二步：token 流 → AST。
 *
 * 词法分析只给了我们一串"扁平的片段"：
 *   [OPEN_TAG div, TEXT 'hello', CLOSE_TAG div]
 * 但模板的真正含义在于**嵌套关系**：哪个元素是谁的孩子。
 *
 * 恢复嵌套关系靠一个「栈」：
 *   遇到 OPEN_TAG   → 创建元素节点，压栈（它成为当前节点）
 *   遇到 CLOSE_TAG  → 弹栈（回到它的父节点）
 *
 * 这就是「递归下降 / 栈式解析」的核心 ——
 * HTML 是"上下文无关文法"，用栈就能还原树形结构。
 *
 * 顺带把属性也解析成两类节点：
 *   <div id="a">        → ATTRIBUTE（静态属性，值就是字符串本身，编译期可以完全确定）
 *   <div :id="x">       → DIRECTIVE（指令，值是 JS 表达式，必须运行时求值）
 *   <div @click="fn">   → DIRECTIVE name=on
 *   <div v-if="ok">     → DIRECTIVE name=if
 *
 * ★ 「静态 vs 动态」这个区分是整个编译器优化的地基：
 *   静态的东西可以在编译期定死、可以静态提升、可以整棵跳过；
 *   只有动态的部分才需要 patchFlag 和运行时 diff。
 */

import { VOID_TAGS, tokenize } from './tokenize.js'
import {
  ElementTypes,
  NodeTypes,
  createAttribute,
  createComment,
  createDirective,
  createElement,
  createInterpolation,
  createRoot,
  createSimpleExpression,
  createText,
} from './ast.js'
import { isComponentTag } from '../shared/utils.js'

/**
 * 把原始属性名解析成「指令结构」。
 *
 *   原始写法              解析结果
 *   ───────────────────  ──────────────────────────────────────────────
 *   id="a"               Attribute { name:'id', value:'a' }
 *   :id="x"              Directive { name:'bind', arg:'id',  exp:'x' }
 *   v-bind:id="x"        同上
 *   @click="fn"          Directive { name:'on',   arg:'click', exp:'fn' }
 *   v-on:click.stop="fn" Directive { name:'on',   arg:'click', exp:'fn', modifiers:['stop'] }
 *   v-model.trim="m"     Directive { name:'model', exp:'m', modifiers:['trim'] }
 *   v-if="ok"            Directive { name:'if',   exp:'ok' }
 *   #header="{ x }"      Directive { name:'slot', arg:'header', exp:'{ x }' }
 */
function parseAttribute(raw) {
  const { name, value, hasValue } = raw
  const exp = hasValue ? value : undefined

  // ---- 普通静态属性 ----
  if (!name.startsWith('v-') && !name.startsWith(':') && !name.startsWith('@') && !name.startsWith('#')) {
    return createAttribute(name, exp)
  }

  /** 把剩下的部分拆成 「主体 + 修饰符」 */
  const splitModifiers = str => {
    const parts = str.split('.')
    return { main: parts[0], modifiers: parts.slice(1).filter(Boolean) }
  }

  // ---- @click / v-on:click ----
  if (name.startsWith('@') || name.startsWith('v-on')) {
    const rest = name.startsWith('@') ? name.slice(1) : name.slice('v-on:'.length)
    const { main, modifiers } = splitModifiers(rest)
    return createDirective('on', exp, main, modifiers)
  }

  // ---- :id / v-bind:id ----
  if (name.startsWith(':') || name.startsWith('v-bind')) {
    const rest = name.startsWith(':') ? name.slice(1) : name.slice('v-bind:'.length)
    const { main, modifiers } = splitModifiers(rest)
    const isDynamicArg = main.startsWith('[') && main.endsWith(']')
    const arg = isDynamicArg ? main.slice(1, -1) : main
    return createDirective('bind', exp, arg, modifiers, isDynamicArg)
  }

  // ---- #header / v-slot:header ----
  if (name.startsWith('#') || name.startsWith('v-slot')) {
    const rest = name.startsWith('#') ? name.slice(1) : name.slice('v-slot:'.length)
    const { main, modifiers } = splitModifiers(rest)
    return createDirective('slot', exp, main || 'default', modifiers)
  }

  // ---- v-if / v-for / v-model / v-html ... ----
  if (name.startsWith('v-')) {
    const rest = name.slice(2)
    const { main, modifiers } = splitModifiers(rest)
    // 支持 v-bind:xxx 这种带参数的写法（上面已处理），这里处理无参数的：
    //   v-if / v-else-if / v-else / v-for / v-model / v-html / v-text / v-once
    let dirName = main
    let arg
    if (main.includes(':')) {
      const idx = main.indexOf(':')
      dirName = main.slice(0, idx)
      arg = main.slice(idx + 1)
    }
    return createDirective(dirName, exp, arg, modifiers)
  }

  // 兜底
  return createAttribute(name, exp)
}

/**
 * 解析整个模板。
 *
 * @param {string} template 模板字符串
 * @returns AST 的根节点
 */
export function parse(template) {
  const tokens = tokenize(template)
  const root = createRoot()

  /**
   * 元素栈：栈底永远是 root。
   * current() 就是"当前正在往里塞孩子的节点"。
   */
  const stack = [root]
  const current = () => stack[stack.length - 1]

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const parent = current()

    switch (token.type) {
      case 'TEXT': {
        // ---- 空白处理（对应 Vue 的 whitespace: 'condense' 策略）----
        // 模板里为了可读性写的换行缩进不应该变成真实的空白文本节点，
        // 但 <b>加粗</b> 空格 <i>斜体</i> 中间那个空格是有意义的，必须保留。
        let content = token.value
        if (/[\r\n]/.test(content)) {
          // 含换行的空白：要么整体是空白（缩进）→ 直接丢掉；
          // 要么文本被换行"断开" → 折叠成一个空格
          if (content.trim() === '') break
          content = content.replace(/[\r\n]+\s*/g, ' ')
        } else if (content.trim() === '') {
          content = ' ' // 纯空格保留一个
        }

        const text = createText(content)
        text.parent = parent
        parent.children.push(text)
        break
      }

      case 'INTERPOLATION': {
        const node = createInterpolation(token.value)
        node.parent = parent
        parent.children.push(node)
        break
      }

      case 'COMMENT': {
        const node = createComment(token.value)
        node.parent = parent
        parent.children.push(node)
        break
      }

      case 'OPEN_TAG': {
        const el = createElement(
          token.name,
          token.attrs.map(parseAttribute),
          [],
          token.selfClosing
        )
        el.parent = parent
        parent.children.push(el)

        // ★ 自闭合标签 和 HTML 的空元素（<br> <img>）不压栈 —— 它们没有子节点也没有结束标签，
        //   压栈会导致后面的内容全被当成它的孩子
        const isVoid = VOID_TAGS.has(token.name.toLowerCase())
        if (!token.selfClosing && !isVoid) {
          stack.push(el)
        }
        break
      }

      case 'CLOSE_TAG': {
        // 找到匹配的标签：正常情况就是栈顶
        const name = token.name.toLowerCase()
        let matchedIndex = -1
        for (let j = stack.length - 1; j >= 1; j--) {
          if (stack[j].tag.toLowerCase() === name) {
            matchedIndex = j
            break
          }
        }

        if (matchedIndex === -1) {
          // 多出来的结束标签，忽略
          console.warn(`[vue-mini] 多余的结束标签 </${token.name}>`)
          break
        }

        if (matchedIndex !== stack.length - 1) {
          // 有标签没写结束标签（浏览器会自动补全），这里容错处理：自动关闭中间未闭合的标签
          console.warn(
            `[vue-mini] 标签 <${stack[stack.length - 1].tag}> 没有关闭就遇到了 </${token.name}>，已自动闭合`
          )
        }
        // 一次性弹出到匹配位置（顺带闭合所有未闭合的内层标签）
        stack.length = matchedIndex
        break
      }
    }
  }

  if (stack.length > 1) {
    console.warn(`[vue-mini] 以下标签没有闭合：${stack.slice(1).map(el => el.tag).join(', ')}`)
  }

  // ---- 标记「标签类型」：是原生元素、组件、还是 <slot> ----
  markElementTypes(root)

  return root
}

/**
 * 遍历 AST，给每个元素打上 tagType。
 * 这个标记决定了后面走哪条路：
 *   ELEMENT   → createElementVNode("div", ...)
 *   COMPONENT → createVNode(_resolveComponent("MyComp"), ...)
 *   SLOT      → renderSlot(...)
 *   TEMPLATE  → 不生成节点，只是分组（v-if/v-for 用）
 */
function markElementTypes(node) {
  if (node.type === NodeTypes.ELEMENT) {
    const tag = node.tag
    if (tag === 'slot') {
      node.tagType = ElementTypes.SLOT
    } else if (tag === 'template') {
      node.tagType = ElementTypes.TEMPLATE
    } else if (isComponentTag(tag)) {
      // 不在标准 HTML 标签表里 → 当作组件
      // （自定义元素 <my-el> 也算组件，用户可以通过 app.config.isCustomElement 排除，这里省略）
      node.tagType = ElementTypes.COMPONENT
    } else {
      node.tagType = ElementTypes.ELEMENT
    }
  }
  if (node.children) {
    for (const child of node.children) markElementTypes(child)
  }
}
