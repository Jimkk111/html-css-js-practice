/**
 * JS AST —— 编译器内部的「JS 代码数据结构」。
 *
 * 为什么 transform 阶段不直接拼字符串，而要先生成一棵 JS AST？
 *   1. 结构化的数据可以被检查、被变换、被可视化（我们的 demo 会把它画成树）；
 *   2. 拼接字符串时很容易漏括号、漏逗号，用树结构最后由一个打印器统一处理，可靠性高得多；
 *   3. 真实 Vue 的 transform 输出就是这个东西（它的 codegen 支持两种模式：
 *      生成字符串，或者生成 runtime-agnostic 的 AST 给 SSR 编译器复用）。
 *
 * 这里的节点种类是「够用就好」的子集，覆盖 render 函数会出现的所有语法。
 */

export const JSTypes = {
  Identifier: 'Identifier', // 变量名，如 _ctx
  StringLiteral: 'StringLiteral', // "div"
  NumberLiteral: 'NumberLiteral', // 128
  BooleanLiteral: 'BooleanLiteral', // true
  NullLiteral: 'NullLiteral', // null
  RawExpression: 'RawExpression', // 原样输出的代码片段，如 `_ctx.count + 1`
  ArrayExpression: 'ArrayExpression', // [a, b]
  ObjectExpression: 'ObjectExpression', // { a: 1 }
  CallExpression: 'CallExpression', // fn(a, b)
  ArrowFunction: 'ArrowFunction', // (a) => b
  Conditional: 'Conditional', // a ? b : c
  Logical: 'Logical', // a && b
  Binary: 'Binary', // a === b
  CacheExpression: 'CacheExpression', // _cache[0] || (_cache[0] = <value>)
  Sequence: 'Sequence', // (a, b) —— 逗号表达式，用来写 (_openBlock(), _createElementBlock(...))
}

// ---------------------------------------------------------------------
// 构造器：工厂函数让 transform 阶段的代码可读性高很多
// ---------------------------------------------------------------------

export const IDENT = name => ({ type: JSTypes.Identifier, name })
export const STRING = value => ({ type: JSTypes.StringLiteral, value })
export const NUMBER = value => ({ type: JSTypes.NumberLiteral, value })
export const BOOLEAN = value => ({ type: JSTypes.BooleanLiteral, value })
export const NULL = () => ({ type: JSTypes.NullLiteral })
export const RAW = content => ({ type: JSTypes.RawExpression, content })
export const ARRAY = elements => ({ type: JSTypes.ArrayExpression, elements })
export const OBJECT = properties => ({ type: JSTypes.ObjectExpression, properties })
export const CALL = (callee, args) => ({ type: JSTypes.CallExpression, callee, args })
export const ARROW = (params, body) => ({ type: JSTypes.ArrowFunction, params, body })
export const CONDITIONAL = (test, consequent, alternate) => ({
  type: JSTypes.Conditional,
  test,
  consequent,
  alternate,
})
export const LOGICAL = (operator, left, right) => ({ type: JSTypes.Logical, operator, left, right })
export const BINARY = (operator, left, right) => ({ type: JSTypes.Binary, operator, left, right })
export const CACHE = (index, value) => ({ type: JSTypes.CacheExpression, index, value })
export const SEQ = expressions => ({ type: JSTypes.Sequence, expressions })

/** 对象字面量里的一个属性 */
export const prop = (key, value, computed = false) => ({ key, value, computed })

// ---------------------------------------------------------------------
// 打印器（这部分其实就是 codegen 的核心）
// ---------------------------------------------------------------------

/** 各种表达式的运算符优先级，用于决定「什么时候必须加括号」 */
const PRECEDENCE = {
  Sequence: 1,
  Conditional: 2,
  LogicalOR: 3,
  LogicalAND: 4,
  Binary: 5,
  Call: 10,
  Primary: 12,
}

/** 取一个节点的优先级 */
function precedenceOf(node) {
  switch (node.type) {
    case JSTypes.Sequence:
      return PRECEDENCE.Sequence
    case JSTypes.Conditional:
      return PRECEDENCE.Conditional
    case JSTypes.Logical:
      return node.operator === '&&' ? PRECEDENCE.LogicalAND : PRECEDENCE.LogicalOR
    case JSTypes.Binary:
      return PRECEDENCE.Binary
    case JSTypes.CallExpression:
    case JSTypes.CacheExpression:
      return PRECEDENCE.Call
    default:
      return PRECEDENCE.Primary
  }
}

/**
 * 把 JS AST 打印成代码字符串。
 *
 * @param {object} node
 * @param {object} options
 *   - inline 为 true 时，尽量输出"能直接嵌进一行"的形式（如对象字面量不换行）
 *   - indent 当前缩进层级
 */
export function printJS(node, options = {}) {
  const { indent = 0 } = options
  const pad = '  '.repeat(indent)
  const padIn = '  '.repeat(indent + 1)

  if (!node) return ''

  switch (node.type) {
    case JSTypes.Identifier:
      return node.name
    case JSTypes.StringLiteral:
      return JSON.stringify(node.value)
    case JSTypes.NumberLiteral:
      return String(node.value)
    case JSTypes.BooleanLiteral:
      return String(node.value)
    case JSTypes.NullLiteral:
      return 'null'
    case JSTypes.RawExpression:
      return node.content

    case JSTypes.ArrayExpression: {
      if (node.elements.length === 0) return '[]'
      // 全是短元素 → 一行输出，读起来更像人写的代码
      const parts = node.elements.map(el => printJS(el, { indent: indent + 1 }))
      const oneLine = `[${parts.join(', ')}]`
      if (oneLine.length <= 100 && !oneLine.includes('\n')) return oneLine
      return `[\n${parts.map(p => padIn + p).join(',\n')}\n${pad}]`
    }

    case JSTypes.ObjectExpression: {
      if (node.properties.length === 0) return '{}'
      const parts = node.properties.map(p => {
        // ★ 键名必须符合 JS 标识符规范才能裸写。
        //   像 onUpdate:modelValue（v-model 组件事件）这种带冒号的键，必须加引号，
        //   否则产物直接是语法错误。这也是"先建 AST 再打印"的价值：
        //   这类规则集中在一个地方处理，不会散落在拼接字符串的各处。
        const key = p.computed
          ? `[${printJS(p.key, { indent })}]`
          : /^[A-Za-z_$][\w$]*$/.test(p.key)
            ? p.key
            : JSON.stringify(p.key)
        return `${key}: ${printJS(p.value, { indent: indent + 1 })}`
      })
      const oneLine = `{ ${parts.join(', ')} }`
      if (oneLine.length <= 100 && !oneLine.includes('\n')) return oneLine
      return `{\n${parts.map(p => padIn + p).join(',\n')}\n${pad}}`
    }

    case JSTypes.CallExpression: {
      const callee = printJS(node.callee, { indent })
      const args = node.args.map(a => printJS(a, { indent: indent + 1 }))
      const oneLine = `${callee}(${args.join(', ')})`
      if (oneLine.length <= 100 && !oneLine.includes('\n')) return oneLine
      return `${callee}(\n${args.map(a => padIn + a).join(',\n')}\n${pad})`
    }

    case JSTypes.ArrowFunction: {
      const params = node.params.join(', ')
      const body = printJS(node.body, { indent: indent + 1 })
      const oneLine = `(${params}) => ${body}`
      if (oneLine.length <= 100 && !oneLine.includes('\n')) return oneLine
      return `(${params}) =>\n${padIn}${body}`
    }

    case JSTypes.Conditional: {
      const test = printJS(node.test, { indent })
      const cons = printJS(node.consequent, { indent: indent + 1 })
      const alt = printJS(node.alternate, { indent: indent + 1 })
      const oneLine = `${test} ? ${cons} : ${alt}`
      if (oneLine.length <= 100 && !oneLine.includes('\n')) return oneLine
      return `${test}\n${padIn}? ${cons}\n${padIn}: ${alt}`
    }

    case JSTypes.Logical:
    case JSTypes.Binary: {
      const left = wrap(node.left, node, indent)
      const right = wrap(node.right, node, indent)
      return `${left} ${node.operator} ${right}`
    }

    case JSTypes.Sequence: {
      const parts = node.expressions.map(e => printJS(e, { indent }))
      return `(${parts.join(', ')})`
    }

    case JSTypes.CacheExpression: {
      // _cache[1] || (_cache[1] = <value>)
      return `_cache[${node.index}] || (_cache[${node.index}] = ${printJS(node.value, { indent })})`
    }

    default:
      console.warn('[vue-mini] 未知的 JS AST 节点:', node.type)
      return ''
  }

  /** 子表达式优先级更低时需要加括号，例如 (a || b) && c */
  function wrap(child, parent, indent) {
    const printed = printJS(child, { indent })
    // 括号的规则可以简化成一句：子节点优先级 < 父节点优先级 时就必须加。
    // 否则会生成 `a && b || c` 解析成 `(a && b) || c`，与原本的 `a && (b || c)` 语义不同。
    if (precedenceOf(child) < precedenceOf(parent)) return `(${printed})`
    return printed
  }
}
