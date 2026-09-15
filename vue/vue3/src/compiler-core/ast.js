/**
 * AST 节点类型与构造函数 —— 编译器各阶段之间的「通用语言」。
 *
 *   tokenize  产出 token        （扁平的字符片段）
 *        ↓
 *   parse     产出 AST          （有嵌套结构的语法树，本文件定义的就是它）
 *        ↓
 *   transform 改写 AST          （把指令变成表达式、算出 patchFlag、标记静态提升）
 *        ↓
 *   codegen   产出 JS 代码字符串 （render 函数的源码）
 *
 * 为什么要定义这么多节点类型，而不是一开始就用 JS AST？
 * 因为「模板」和「JavaScript」的语义并不一样。
 *   v-if  在模板里是「两个标签二选一」，在 JS 里是三元表达式；
 *   v-for 在模板里是「重复一个元素」，在 JS 里是数组 map + Fragment。
 * 中间用一层「模板语义的 AST」，让转换逻辑可以一小步一小步做（就像把大象放进冰箱分三步），
 * 每一小步都只关心一件事 —— 这就是 Vue 编译器能被理解、被扩展的原因。
 */

export const NodeTypes = {
  ROOT: 'Root', // 模板根
  ELEMENT: 'Element', // 元素 <div>
  TEXT: 'Text', // 纯文本
  COMMENT: 'Comment', // 注释
  INTERPOLATION: 'Interpolation', // 插值 {{ msg }}
  SIMPLE_EXPRESSION: 'SimpleExpression', // 一段 JS 表达式（以字符串形式保存）
  COMPOUND_EXPRESSION: 'CompoundExpression', // 多段拼接（例如 "hello " + _toDisplayString(msg)）
  ATTRIBUTE: 'Attribute', // 静态属性 id="a"
  DIRECTIVE: 'Directive', // 指令 :id="x" / @click / v-if
  TEXT_CALL: 'TextCall', // 文本调用，对应 createTextVNode(...)

  // 转换阶段产生的「高层语义节点」
  IF: 'If', // v-if 整组（含所有分支）
  IF_BRANCH: 'IfBranch', // v-if / v-else-if / v-else 的单个分支
  FOR: 'For', // v-for
}

/** 各种 node 的 shapeFlag，值和 Vue 源码保持一致，便于对照 */
export const ElementTypes = {
  ELEMENT: 0,
  COMPONENT: 1,
  SLOT: 2,
  TEMPLATE: 3,
}

export function createRoot(children = []) {
  return {
    type: NodeTypes.ROOT,
    children,
    helpers: new Set(), // 这个模板用到哪些运行时帮助函数（codegen 时决定 import/解构哪些）
    hoists: [], // 静态提升的节点
    codegenNode: null, // 转换阶段生成的「JS AST」，最终由 codegen 打印成代码
  }
}

export function createElement(tag, props = [], children = [], isSelfClosing = false) {
  return {
    type: NodeTypes.ELEMENT,
    tag,
    tagType: ElementTypes.ELEMENT, // 由 transform 阶段改成 ELEMENT / COMPONENT / SLOT / TEMPLATE
    props,
    children,
    isSelfClosing,
    parent: null, // 解析时补上，便于转换阶段向上查找
    codegenNode: null,
    // 下面这些字段由 transform 阶段填写
    patchFlag: 0,
    dynamicProps: [], // 动态属性名列表
    isStatic: false, // 是否整棵子树都是静态的（可以静态提升）
    hoisted: null, // 提升后的引用名，如 _hoisted_1
  }
}

export function createText(content) {
  return { type: NodeTypes.TEXT, content }
}

export function createComment(content) {
  return { type: NodeTypes.COMMENT, content }
}

export function createInterpolation(content) {
  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      content: content.trim(),
      isStatic: false,
    },
  }
}

/** 静态值表达式：内容就是字符串本身，不需要求值 */
export function createSimpleExpression(content, isStatic = false) {
  return { type: NodeTypes.SIMPLE_EXPRESSION, content, isStatic }
}

export function createCompoundExpression(children) {
  return { type: NodeTypes.COMPOUND_EXPRESSION, children }
}

export function createAttribute(name, value) {
  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value != null ? createSimpleExpression(value, true) : undefined,
  }
}

export function createDirective(name, exp, arg, modifiers = [], isDynamicArg = false) {
  return {
    type: NodeTypes.DIRECTIVE,
    name, // 'if' | 'for' | 'bind' | 'on' | 'model' | 'html' | 'text' | 'slot' | 'once'
    exp: exp ? createSimpleExpression(exp, false) : undefined,
    arg: arg ? createSimpleExpression(arg, true, true) : undefined,
    modifiers,
    isDynamicArg,
  }
}
