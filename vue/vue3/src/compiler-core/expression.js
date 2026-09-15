/**
 * 表达式处理 —— 把模板里的 JS 表达式改写成「渲染函数里能跑的代码」。
 *
 * ── 为什么需要这一步？ ──
 * 用户在模板里写：
 *
 *     <div :id="msg">{{ count + 1 }}</div>
 *
 * 如果直接把这些表达式塞进 render 函数，`msg` 和 `count` 就是未定义的变量。
 * 它们其实都在**组件实例**上。所以必须改写成：
 *
 *     _ctx.msg
 *     _ctx.count + 1
 *
 * 这就是「标识符前缀」（prefixIdentifiers）要干的事。
 *
 * ── 那 Vue 是怎么做的？ ──
 * Vue 有两种模式：
 *   with 模式（运行时编译）：`with(_ctx) { ... }`，让 JS 自己按作用域链去找，
 *        简单但 `with` 在严格模式（ESM）下是非法的，而且会破坏引擎优化。
 *   prefix 模式（SFC 编译，默认）：给每个标识符加上 `_ctx.` 前缀。
 *        需要正确区分「这是变量」还是「这是属性名/关键字」—— 本文件做的就是这件事。
 *
 * ── 难点在哪？ ──
 * 不能无脑给所有标识符加前缀，下面这些都不能加：
 *   a.b           → b 是属性名，不能变成 a._ctx.b
 *   { x: 1 }      → x 是对象键，不能变成 { _ctx.x: 1 }
 *   Math.max(1,2) → Math 是全局对象
 *   i => i * 2    → i 是箭头函数参数（局部变量）
 *   'hello'       → 字符串里的内容
 *
 * 所以本质上要做一次「轻量的 JS 词法分析」。真正的 Vue 用 @babel/parser 拿到
 * 完整 AST 来判断（最准确），这里手写一个够用的扫描器 —— 逻辑更直观，也更能看清原理。
 */

/** JS 关键字 / 字面量 / 全局对象：这些不该加前缀 */
const GLOBALS_WHITE_LIST = new Set([
  // 关键字
  'true', 'false', 'null', 'undefined', 'this', 'typeof', 'instanceof', 'in', 'of',
  'new', 'delete', 'void', 'return', 'if', 'else', 'function', 'var', 'let', 'const',
  'class', 'extends', 'super', 'yield', 'await', 'async', 'do', 'while', 'for',
  'switch', 'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'default',
  'import', 'export', 'from', 'as', 'static', 'get', 'set',
  // 全局对象 / 函数
  'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt', 'Error', 'TypeError',
  'NaN', 'Infinity', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'console', 'window', 'document',
  'globalThis', 'arguments', 'require',
  // 组件实例上的内置属性由代理处理，但要显式排除事件对象和几个模板专用变量
  '$event',
])

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/

/**
 * 从箭头函数参数中提取局部变量名。
 *
 * 为什么需要？`@click="() => count++"`、`v-for` 里用户也可能写箭头函数，
 * 参数名是局部变量，加了 `_ctx.` 前缀就错了。
 *
 * 做法：先全文扫描所有 `=>`，再从每个 `=>` 往前找出它的参数列表，把里面的名字收集起来。
 * 这是一个"够用"的启发式 —— 比真正解析 AST 简单得多，覆盖了模板里 99% 的写法。
 */
function collectArrowParams(code) {
  const locals = new Set()
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '=' || code[i + 1] !== '>') continue

    // 从 '=>' 往前跳过空白，看参数是什么形式
    let j = i - 1
    while (j >= 0 && /\s/.test(code[j])) j--
    if (j < 0) continue

    if (code[j] === ')') {
      // (a, b) => ...  或  ({ x }) => ...
      let depth = 0
      let k = j
      for (; k >= 0; k--) {
        if (code[k] === ')') depth++
        else if (code[k] === '(') {
          depth--
          if (depth === 0) break
        }
      }
      if (k >= 0) extractNames(code.slice(k + 1, j), locals)
    } else {
      // a => ...
      let k = j
      while (k >= 0 && IDENT_PART.test(code[k])) k--
      const name = code.slice(k + 1, j + 1)
      if (name && IDENT_START.test(name[0])) locals.add(name)
    }
  }
  return locals
}

/** 从参数文本里抠出所有标识符名（兼容解构、默认值、剩余参数） */
function extractNames(text, out) {
  const cleaned = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // 去掉字符串字面量，避免把 'a-b' 里的 a b 当成变量
  const noStrings = cleaned.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ')
  const re = /[A-Za-z_$][\w$]*/g
  let m
  while ((m = re.exec(noStrings))) {
    const name = m[0]
    // 跳过 `x = 1` 里的数字、以及 `{ a: b }` 里的 a（那是键，b 才是变量）
    const after = noStrings.slice(m.index + name.length).trimStart()
    if (after.startsWith(':') && !after.startsWith('::')) {
      // `a: b` 形式：a 是键名，跳过它（b 会在下一轮被单独扫到）
      // 但 `{ a }` 简写形式要保留，所以只有跟了 ':' 才跳过
      const nextChar = after.slice(1).trimStart()[0]
      if (nextChar && (IDENT_START.test(nextChar) || nextChar === '{' || nextChar === '[')) continue
    }
    if (GLOBALS_WHITE_LIST.has(name)) continue
    out.add(name)
  }
}

/**
 * 给表达式里的标识符加上 `_ctx.` 前缀。
 *
 * @param {string} code  原始表达式，如 `msg + count`
 * @param {Set<string>} scope 当前作用域的局部变量（v-for 别名、插槽参数等）
 * @returns {string} 如 `_ctx.msg + _ctx.count`
 */
export function prefixIdentifiers(code, scope = new Set()) {
  if (!code) return code

  // 把箭头函数的参数也并入局部作用域
  const locals = new Set(scope)
  for (const name of collectArrowParams(code)) locals.add(name)

  let out = ''
  let i = 0
  const len = code.length
  // 记录「上一个有意义的字符」，用来判断当前标识符的语境
  let prevSignificant = ''

  while (i < len) {
    const c = code[i]

    // ---- 字符串 / 模板字符串：整段照抄，内部不做任何处理 ----
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < len) {
        if (code[j] === '\\') j += 2
        else if (code[j] === quote) break
        else j++
      }
      out += code.slice(i, j + 1)
      prevSignificant = quote
      i = j + 1
      continue
    }

    // ---- 注释：整段照抄 ----
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? len : end
      out += code.slice(i, stop)
      i = stop
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? len : end + 2
      out += code.slice(i, stop)
      i = stop
      continue
    }

    // ---- 标识符：这里是主战场 ----
    if (IDENT_START.test(c)) {
      let j = i
      while (j < len && IDENT_PART.test(code[j])) j++
      const name = code.slice(i, j)

      // ① 前面是 '.' 或 '?.' → 成员访问，绝不动
      const isMemberAccess = prevSignificant === '.'
      // ② 后面（跳过空白）是 ':' 且前面是 '{' 或 ',' → 对象键
      let k = j
      while (k < len && /\s/.test(code[k])) k++
      const nextChar = code[k]
      const isObjectKey =
        nextChar === ':' &&
        code[k + 1] !== ':' &&
        (prevSignificant === '{' || prevSignificant === ',' || prevSignificant === '' || prevSignificant === '(')
      // ③ 后面是 '(' 且前面是 '{' 或 ',' → 对象方法简写，也是键
      const isMethodShorthand = nextChar === '(' && (prevSignificant === '{' || prevSignificant === ',')

      if (isMemberAccess || isObjectKey || isMethodShorthand || locals.has(name) || GLOBALS_WHITE_LIST.has(name)) {
        out += name
      } else if (name.startsWith('_')) {
        // 内部名（_ctx / _cache / _hoisted_1 / _createVNode…）不再加前缀。
        // 这条规则同时让 prefixIdentifiers 变成「幂等」的：
        // 对已经处理过的表达式再跑一次也不会变成 _ctx._ctx.msg —— 这点很重要，
        // 因为 v-model 会先把表达式处理一遍，后面的通用流程还会再处理一遍。
        //
        // ★ 注意 $ 开头的东西【不】在此列：$emit / $slots / $props 都是组件实例的属性，
        //   必须加前缀变成 _ctx.$emit（否则运行时是 ReferenceError）；
        //   唯一的例外是 $event —— 它是事件处理器的参数，已列入白名单。
        out += name
      } else {
        out += `_ctx.${name}`
      }

      prevSignificant = name[name.length - 1]
      i = j
      continue
    }

    out += c
    if (!/\s/.test(c)) prevSignificant = c
    i++
  }

  return out
}

/**
 * 判断一段表达式是不是「静态的」——即编译期就能求值、不依赖组件状态。
 * 例如 `:id="'fixed'"` 或 `:count="42"`。
 * 静态的绑定可以直接编译成字面量，省掉运行时的求值 —— 这也是编译优化的一部分。
 */
export function isStaticExpression(content) {
  const trimmed = content.trim()
  if (trimmed === '') return false
  // 纯字面量：字符串 / 数字 / 布尔 / null
  if (/^(['"`]).*\1$/.test(trimmed)) return true
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return true
  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null' || trimmed === 'undefined') return true
  // 字面量数组 / 对象（不含标识符）
  if (/^\[.*\]$/.test(trimmed) || /^\{.*\}$/.test(trimmed)) {
    // 粗略判断：里面没有裸标识符就算静态（保守起见，只要出现了普通字母就认为动态）
    const inner = trimmed.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '')
    return !/[A-Za-z_$]/.test(inner)
  }
  return false
}

/**
 * 解析一段「字面量」表达式的值（供静态属性/静态提升使用）。
 */
export function parseLiteralExpression(content) {
  const trimmed = content.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (/^(['"`]).*\1$/.test(trimmed)) {
    try {
      // eslint-disable-next-line no-new-func
      return new Function(`return (${trimmed})`)()
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}
