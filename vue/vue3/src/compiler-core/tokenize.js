/**
 * 词法分析（tokenize）—— 编译器流水线的第一步。
 *
 * 输入：`<div id="a">hello {{ msg }}</div>` 这样一串字符
 * 输出：一串「token」（词法单元），每个 token 表示一个有意义的片段
 *
 *     [
 *       { type: 'OPEN_TAG', name: 'div', attrs: [{name:'id', value:'a'}], selfClosing: false },
 *       { type: 'TEXT', value: 'hello ' },
 *       { type: 'INTERPOLATION', value: ' msg ' },
 *       { type: 'CLOSE_TAG', name: 'div' },
 *     ]
 *
 * ── 为什么要用「有限状态机」？ ──
 * 逐个字符扫描时，同一个字符在不同语境下含义完全不同：
 *   `>`   在文本里是普通字符，在标签里表示标签结束
 *   `{{`  在文本里是插值开始，在属性值里就是两个普通的左花括号
 * 所以必须靠「当前状态」来决定怎么处理。这就是状态机的全部意义。
 *
 * 状态转移图（简化版）：
 *
 *            ┌────────────────────────── '<' + 字母 ─────────────────────────┐
 *            ▼                                                                │
 *   ┌──────────────┐  空白   ┌───────────────┐   '='   ┌────────────────┐     │
 *   │ Text   文本  │────────►│ BeforeAttrName│────────►│ BeforeAttrValue│     │
 *   └──────────────┘   '>'   └───────────────┘         └────────────────┘     │
 *        ▲  ▲                     ▲                          │                │
 *        │  │                     └──── 引号闭合 ─────────────┘                │
 *        │  └── '}}' ── Interpolation（插值）                                   │
 *        └────────────────── '>' 结束标签 ◄──── InTagName ◄─── InTagName ──────┘
 */

/** 所有状态。用字符串而不是数字，调试时 console.log 出来能直接看懂 */
export const State = {
  Text: 'Text', // 普通文本（标签之外）
  BeforeTagName: 'BeforeTagName', // 刚读到 '<'，看下一个字符决定是什么
  InTagName: 'InTagName', // 正在读标签名
  BeforeClosingTagName: 'BeforeClosingTagName', // 刚读到 '</'
  InClosingTagName: 'InClosingTagName', // 正在读结束标签的名字
  BeforeAttrName: 'BeforeAttrName', // 标签内、属性名之前（跳空白）
  InAttrName: 'InAttrName', // 正在读属性名
  BeforeAttrValue: 'BeforeAttrValue', // 刚读到 '='，等待值的开始
  InAttrValueQuoted: 'InAttrValueQuoted', // 正在读引号包裹的属性值
  InAttrValueUnquoted: 'InAttrValueUnquoted', // 正在读没有引号的属性值
  BeforeSelfClosing: 'BeforeSelfClosing', // 刚读到 '/'，等待 '>'
  Comment: 'Comment', // 注释 <!-- ... -->
  BogusComment: 'BogusComment', // <!DOCTYPE> 这类，直接跳到 '>'
  Interpolation: 'Interpolation', // 插值内部 {{ ... }}
}

/** 自闭合标签（HTML 里没有结束标签的那些） */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const isWhitespace = c => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f'
const isAlpha = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')

/**
 * 判断一个字符能不能出现在属性名里。
 * 注意要放行 Vue 特有的前缀和修饰符字符： : @ # . - [ ]
 */
const isAttrNameChar = c =>
  isAlpha(c) || (c >= '0' && c <= '9') || c === ':' || c === '@' || c === '#' || c === '.' || c === '-' || c === '_' || c === '[' || c === ']' || c === '$'

/**
 * 主函数：把模板字符串切成 token 数组。
 *
 * 实现要点：只用一个 for 循环逐个字符推进，用 state 变量记录当前语境。
 * 好处是复杂度 O(n)，且遇到任何非法输入都能马上给出「在第几个字符出错」。
 */
export function tokenize(source) {
  const tokens = []
  const len = source.length

  let state = State.Text
  let i = 0

  // ---- 各种缓冲区：状态机里"跨字符"的信息都存这里 ----
  let textBuf = '' // 正在累积的文本
  let interpolationBuf = '' // {{ ... }} 里的内容
  let tagNameBuf = '' // 正在读的标签名
  let attrs = [] // 当前标签已解析出的属性
  let attrNameBuf = '' // 正在读的属性名
  let attrValueBuf = '' // 正在读的属性值
  let attrQuote = '' // 属性值用的引号字符（' 或 "）
  let attrValueIsQuoted = false
  let commentBuf = ''
  let hasAttrName = false // 是否已经开始读某个属性名（用于处理 <div a b> 和 <div a="1">）

  const flushText = () => {
    if (textBuf) {
      tokens.push({ type: 'TEXT', value: textBuf, start: i - textBuf.length })
      textBuf = ''
    }
  }

  /** 一个属性读完了：收集起来 */
  const flushAttr = () => {
    if (hasAttrName) {
      attrs.push({
        name: attrNameBuf,
        value: attrValueBuf,
        // 记录"值是不是引号包裹的"。没写值的属性（<input disabled>）值是空串
        hasValue: attrValueBuf !== '' || attrValueIsQuoted,
        start: i,
      })
      attrNameBuf = ''
      attrValueBuf = ''
      attrQuote = ''
      attrValueIsQuoted = false
      hasAttrName = false
    }
  }

  /** 整个开始标签读完了：产出一个 OPEN_TAG token */
  const flushTag = selfClosing => {
    flushAttr()
    tokens.push({ type: 'OPEN_TAG', name: tagNameBuf, attrs, selfClosing, start: i })
    tagNameBuf = ''
    attrs = []
  }

  for (; i < len; i++) {
    const c = source[i]

    switch (state) {
      // ================================================================
      // 文本状态：一直吃到 '<' 或 '{{'
      // ================================================================
      case State.Text: {
        if (c === '<') {
          const next = source[i + 1]
          // 只有「<字母」或「</」或「<!」才可能是标签，否则 '<' 就是普通字符
          // （例如 `a < b` 这种表达式文本，必须原样保留）
          if (next && (isAlpha(next) || next === '/' || next === '!')) {
            flushText()
            state = State.BeforeTagName
          } else {
            textBuf += c
          }
        } else if (c === '{' && source[i + 1] === '{') {
          flushText()
          i++ // 跳过第二个 '{'
          interpolationBuf = ''
          state = State.Interpolation
        } else {
          textBuf += c
        }
        break
      }

      // ================================================================
      // 刚读到 '<'：判断这是开始标签、结束标签、还是注释
      // ================================================================
      case State.BeforeTagName: {
        if (c === '/') {
          state = State.BeforeClosingTagName
        } else if (c === '!') {
          if (source[i + 1] === '-' && source[i + 2] === '-') {
            i += 2 // 跳过 '--'
            commentBuf = ''
            state = State.Comment
          } else {
            // <!DOCTYPE html> 之类，直接跳到 '>' 忽略掉
            state = State.BogusComment
          }
        } else if (isAlpha(c) || c === '_') {
          tagNameBuf = c
          state = State.InTagName
        } else {
          // 只是普通的 '<'，当文本处理
          textBuf += '<' + c
          state = State.Text
        }
        break
      }

      // ================================================================
      // 标签名内部
      // ================================================================
      case State.InTagName: {
        if (isWhitespace(c)) {
          state = State.BeforeAttrName
        } else if (c === '/') {
          state = State.BeforeSelfClosing
        } else if (c === '>') {
          flushTag(false)
          state = State.Text
        } else {
          tagNameBuf += c
        }
        break
      }

      // ================================================================
      // 结束标签 </div>
      // ================================================================
      case State.BeforeClosingTagName: {
        if (isWhitespace(c)) {
          break // 允许 `</ div>` 这种写法
        }
        tagNameBuf = c
        state = State.InClosingTagName
        break
      }

      case State.InClosingTagName: {
        if (c === '>') {
          tokens.push({ type: 'CLOSE_TAG', name: tagNameBuf.trim(), start: i })
          tagNameBuf = ''
          state = State.Text
        } else {
          tagNameBuf += c
        }
        break
      }

      // ================================================================
      // 属性区：跳空白，然后读属性名
      // ================================================================
      case State.BeforeAttrName: {
        if (isWhitespace(c)) break
        if (c === '>') {
          flushTag(false)
          state = State.Text
        } else if (c === '/') {
          state = State.BeforeSelfClosing
        } else {
          attrNameBuf = c
          hasAttrName = true
          state = State.InAttrName
        }
        break
      }

      case State.InAttrName: {
        // 属性名允许的字符很宽：v-bind:msg-text.prop、@click.stop、:class、#header、[dynamic]
        if (isAttrNameChar(c)) {
          attrNameBuf += c
          break
        }
        // 属性名读完了。★ 注意这里不能立刻 flushAttr()：
        // 如果接下来是 '='，属性值还没读，得等值读完再一起提交。
        if (c === '=') {
          attrValueBuf = ''
          attrValueIsQuoted = false
          state = State.BeforeAttrValue
        } else {
          // 没有值的属性（<input disabled>）在此提交
          flushAttr()
          if (isWhitespace(c)) {
            state = State.BeforeAttrName
          } else if (c === '>') {
            flushTag(false)
            state = State.Text
          } else if (c === '/') {
            state = State.BeforeSelfClosing
          } else {
            // 未知字符，容错处理：回去继续找属性
            state = State.BeforeAttrName
          }
        }
        break
      }

      // ================================================================
      // 属性值：先看是不是引号
      // ================================================================
      case State.BeforeAttrValue: {
        if (isWhitespace(c)) break // 允许 `a = "1"`
        if (c === '"' || c === "'") {
          attrQuote = c
          attrValueIsQuoted = true
          attrValueBuf = ''
          state = State.InAttrValueQuoted
        } else {
          attrValueBuf = c
          attrValueIsQuoted = false
          state = State.InAttrValueUnquoted
        }
        break
      }

      case State.InAttrValueQuoted: {
        if (c === attrQuote) {
          flushAttr()
          state = State.BeforeAttrName
        } else {
          attrValueBuf += c
        }
        break
      }

      case State.InAttrValueUnquoted: {
        if (isWhitespace(c)) {
          flushAttr()
          state = State.BeforeAttrName
        } else if (c === '>') {
          flushTag(false)
          state = State.Text
        } else {
          attrValueBuf += c
        }
        break
      }

      // ================================================================
      // 自闭合标签的 '/'
      // ================================================================
      case State.BeforeSelfClosing: {
        if (c === '>') {
          flushTag(true)
          state = State.Text
        } else if (isWhitespace(c)) {
          break // 允许 `<div / >`
        } else {
          // 容错：`<div /foo>` 当作普通属性处理
          attrNameBuf = c
          hasAttrName = true
          state = State.InAttrName
        }
        break
      }

      // ================================================================
      // 注释 <!-- ... -->
      // ================================================================
      case State.Comment: {
        if (c === '-' && source[i + 1] === '-' && source[i + 2] === '>') {
          tokens.push({ type: 'COMMENT', value: commentBuf.trim(), start: i })
          commentBuf = ''
          i += 2 // 跳过 '->'
          state = State.Text
        } else {
          commentBuf += c
        }
        break
      }

      case State.BogusComment: {
        if (c === '>') state = State.Text
        break
      }

      // ================================================================
      // 插值 {{ ... }}
      // ================================================================
      case State.Interpolation: {
        if (c === '}' && source[i + 1] === '}') {
          tokens.push({ type: 'INTERPOLATION', value: interpolationBuf, start: i })
          interpolationBuf = ''
          i++ // 跳过第二个 '}'
          state = State.Text
        } else {
          interpolationBuf += c
        }
        break
      }
    }
  }

  // ---- 收尾：文件在中间结束也要把缓冲区里的东西吐出来 ----
  if (state === State.Text) {
    flushText()
  } else if (state === State.Interpolation) {
    console.warn(`[vue-mini] 模板末尾有未闭合的插值：{{${interpolationBuf}`)
  } else if (state === State.InTagName || state === State.BeforeAttrName || state === State.InAttrName) {
    console.warn('[vue-mini] 模板末尾有未闭合的标签')
    flushTag(false)
  }

  return tokens
}

export { VOID_TAGS }
