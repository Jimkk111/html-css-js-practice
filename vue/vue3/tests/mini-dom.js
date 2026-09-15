/**
 * mini-dom —— 一个极小的 DOM 实现，只为在 Node 里跑测试用（约 200 行）。
 *
 * ── 为什么需要它？ ──
 * 渲染器是「平台无关」的：它只调用 nodeOps 里那 9 个函数，从不直接碰 document。
 * 所以我们提供一个"假的 DOM"来实现这 9 个函数，就能在 Node 里验证整条渲染链路，
 * 不需要 jsdom、不需要浏览器 —— 这也顺便证明了「渲染器真的与平台解耦」。
 *
 * 这个假 DOM 只需要满足渲染器真正用到的那些能力：
 *   createElement / createTextNode / createComment
 *   insertBefore / removeChild / parentNode / nextSibling
 *   textContent / nodeValue / setAttribute / removeAttribute / className / style
 *   addEventListener / removeEventListener
 */

let uid = 0

class MiniNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType // 1 元素 / 3 文本 / 8 注释
    this.nodeName = nodeName
    this.uid = ++uid
    this.parentNode = null
    this.childNodes = []
    this._text = ''
    this._attrs = Object.create(null)
    this._listeners = Object.create(null)
  }

  get firstChild() {
    return this.childNodes[0] || null
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.childNodes
    const i = siblings.indexOf(this)
    return i === -1 ? null : siblings[i + 1] || null
  }

  get previousSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.childNodes
    const i = siblings.indexOf(this)
    return i <= 0 ? null : siblings[i - 1]
  }

  /** 只考虑元素节点时的子元素列表（对应真实 DOM 的 children） */
  get children() {
    return this.childNodes.filter(n => n.nodeType === 1)
  }

  insertBefore(newNode, refNode) {
    // 如果节点已在别处，先从原来的位置摘掉（对应真实 DOM 的移动语义）
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode)

    const index = refNode ? this.childNodes.indexOf(refNode) : -1
    if (index === -1) {
      this.childNodes.push(newNode)
    } else {
      this.childNodes.splice(index, 0, newNode)
    }
    newNode.parentNode = this
    return newNode
  }

  appendChild(node) {
    return this.insertBefore(node, null)
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node)
    if (i !== -1) {
      this.childNodes.splice(i, 1)
      node.parentNode = null
    }
    return node
  }

  /** 递归清空（真实 DOM 的 textContent = '' 就是这个效果） */
  _removeAllChildren() {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
  }
}

/** 样式对象：支持 style.color = 'red' 和 style.setProperty('--x', '1') */
class MiniStyle {
  constructor() {
    this._props = Object.create(null)
  }
  setProperty(key, value) {
    if (value === '' || value == null) delete this._props[key]
    else this._props[key] = value
  }
  getPropertyValue(key) {
    return this._props[key] || ''
  }
  /** 供测试断言用：把当前样式序列化成 cssText 形式 */
  get cssText() {
    return Object.entries(this._props)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ')
  }
  set cssText(text) {
    this._props = Object.create(null)
    if (!text) return
    for (const part of String(text).split(';')) {
      const i = part.indexOf(':')
      if (i > 0) this._props[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
  }
}

/** 属性名 → 隐式样式对象的 getter（让 style.color = 'red' 这种写法能工作） */
function createStyleProxy(style) {
  return new Proxy(style, {
    set(target, key, value) {
      if (value === '' || value == null) delete target._props[key]
      else target._props[key] = String(value)
      return true
    },
    get(target, key) {
      if (key in target) return target[key]
      return target._props[key] || ''
    },
  })
}

class MiniElement extends MiniNode {
  constructor(tag) {
    super(1, tag.toUpperCase())
    this.tagName = tag.toUpperCase()
    this.localName = tag
    this.style = createStyleProxy(new MiniStyle())
    /** 渲染器会把事件调用器存在这里（对应真实 DOM 元素上的 _invokers） */
    this._invokers = Object.create(null)
  }

  setAttribute(name, value) {
    this._attrs[name] = String(value)
    // 几个常用属性要同步到 property，否则测试断言不一致
    if (name === 'id') this.id = String(value)
    if (name === 'class') this._className = String(value)
  }

  getAttribute(name) {
    return name in this._attrs ? this._attrs[name] : null
  }

  hasAttribute(name) {
    return name in this._attrs
  }

  removeAttribute(name) {
    delete this._attrs[name]
    if (name === 'id') this.id = ''
    if (name === 'class') this._className = ''
  }

  // ---- className ----
  set className(value) {
    this._className = String(value)
    this._attrs.class = String(value)
  }
  get className() {
    return this._className || ''
  }

  /** 字符串形式的属性清单，测试断言用（真实 DOM 没有这个，纯方便） */
  get attributeString() {
    return Object.entries(this._attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ')
  }

  // ---- textContent：读写都是"整棵子树的纯文本" ----
  get textContent() {
    if (this.childNodes.length === 0) return this._text || ''
    return this.childNodes.map(child => child.textContent).join('')
  }
  set textContent(value) {
    this._removeAllChildren()
    this._text = value == null ? '' : String(value)
  }

  addEventListener(type, handler) {
    ;(this._listeners[type] || (this._listeners[type] = [])).push(handler)
  }

  removeEventListener(type, handler) {
    const list = this._listeners[type]
    if (!list) return
    const i = list.indexOf(handler)
    if (i !== -1) list.splice(i, 1)
  }

  /** 测试用：模拟触发事件 */
  dispatchEvent(event) {
    const list = this._listeners[event.type] || []
    for (const handler of [...list]) handler(event)
  }

  get listenerCount() {
    return Object.values(this._listeners).reduce((acc, list) => acc + list.length, 0)
  }

  // ---- 便捷方法，方便测试构造事件 ----
  click() {
    this.dispatchEvent({ type: 'click', target: this, currentTarget: this })
  }

  input(value) {
    this.value = value
    this.dispatchEvent({ type: 'input', target: this, currentTarget: this })
  }
}

class MiniText extends MiniNode {
  constructor(text) {
    super(3, '#text')
    this._text = String(text)
  }
  get textContent() {
    return this._text
  }
  set textContent(value) {
    this._text = String(value)
  }
  get nodeValue() {
    return this._text
  }
  /** 渲染器的 setText 走这里 */
  set nodeValue(value) {
    this._text = String(value)
  }
  set data(value) {
    this._text = String(value)
  }
  get data() {
    return this._text
  }
}

class MiniComment extends MiniNode {
  constructor(text) {
    super(8, '#comment')
    this._text = String(text || '')
  }
  get textContent() {
    return this._text
  }
  get nodeValue() {
    return this._text
  }
  set nodeValue(value) {
    this._text = String(value)
  }
}

/** 创建一个新的"文档" */
export function createMiniDocument() {
  const doc = {
    createElement: tag => new MiniElement(tag),
    createTextNode: text => new MiniText(text),
    createComment: text => new MiniComment(text),
    querySelector: () => null,
  }
  const root = new MiniElement('div')
  root.ownerDocument = doc
  return { document: doc, root }
}

/** 把一棵 mini DOM 序列化成 HTML 字符串 —— 测试断言时最直观的方式 */
export function serialize(node, depth = 0) {
  if (node.nodeType === 3) return escapeText(node.textContent)
  if (node.nodeType === 8) return `<!--${node.textContent}-->`

  const attrs = node.attributeString ? node.attributeString : ''
  const styleAttr = node.style && node.style.cssText ? ` style="${node.style.cssText}"` : ''
  const open = `<${node.localName}${attrs ? ' ' + attrs : ''}${styleAttr}>`

  // 纯文本元素（textContent 直接挂在自己身上）紧凑输出
  if (node.childNodes.length === 0) {
    const own = node._text || ''
    return node.localName ? `${open}${escapeText(own)}</${node.localName}>` : escapeText(own)
  }
  return `${open}${node.childNodes.map(child => serialize(child)).join('')}</${node.localName}>`
}

function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export { MiniElement, MiniText, MiniComment }
