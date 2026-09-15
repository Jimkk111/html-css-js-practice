/**
 * 测试工具：把「mini DOM」接到渲染器上，得到一个能在 Node 里跑的 Vue。
 *
 * 这个文件本身就是「渲染器平台无关」这个设计的最强证据 ——
 * 只提供 9 个 DOM 操作函数，渲染器就能完整工作，连 jsdom 都不需要。
 */
import { createRenderer } from '../src/runtime-core/renderer.js'
import { createMiniDocument, serialize } from './mini-dom.js'
import { normalizeClass, normalizeStyle } from '../src/shared/normalizeProp.js'
import { isOn, isArray, isString } from '../src/shared/utils.js'

/** 在 mini DOM 节点上实现 patchProp —— 逻辑和 runtime-dom 的版本一致，只是操作对象换了 */
export function createMiniPatchProp() {
  const booleanAttrs = new Set(['disabled', 'checked', 'selected', 'muted', 'readonly', 'required'])
  const mustUseProp = new Set(['value', 'checked', 'selected', 'muted', 'innerHTML', 'textContent'])

  return function patchProp(el, key, prevValue, nextValue) {
    if (key === 'class') {
      if (nextValue == null) el.removeAttribute('class')
      else el.className = normalizeClass(nextValue)
      return
    }
    if (key === 'style') {
      if (nextValue == null) {
        el.style.cssText = ''
        return
      }
      const next = isString(nextValue) ? null : normalizeStyle(nextValue) || {}
      if (isString(nextValue)) {
        el.style.cssText = nextValue
        return
      }
      for (const k in next) {
        if (k.startsWith('--')) el.style.setProperty(k, next[k])
        else el.style[k] = next[k]
      }
      const prev = isString(prevValue) ? null : normalizeStyle(prevValue)
      if (prev && typeof prev === 'object') {
        for (const k in prev) {
          if (!(k in next)) {
            if (k.startsWith('--')) el.style.setProperty(k, '')
            else el.style[k] = ''
          }
        }
      }
      return
    }
    if (isOn(key)) {
      const name = key.slice(2).toLowerCase()
      const invokers = el._invokers || (el._invokers = Object.create(null))
      let invoker = invokers[name]
      if (nextValue == null) {
        if (invoker) {
          el.removeEventListener(name, invoker)
          invokers[name] = null
        }
        return
      }
      if (!invoker) {
        invoker = invokers[name] = e => {
          if (isArray(invoker.value)) invoker.value.forEach(fn => fn(e))
          else invoker.value(e)
        }
        invoker.value = nextValue
        el.addEventListener(name, invoker)
      } else {
        invoker.value = nextValue
      }
      return
    }

    if (nextValue == null || nextValue === false) {
      el.removeAttribute(key)
      if (mustUseProp.has(key)) {
        el[key] = typeof el[key] === 'boolean' ? false : ''
      }
      return
    }
    if (booleanAttrs.has(key)) {
      el.setAttribute(key, '')
      return
    }
    if (mustUseProp.has(key)) {
      el[key] = nextValue
      return
    }
    el.setAttribute(key, nextValue)
  }
}

const miniNodeOps = {
  createElement: el => el.ownerDocument ? el.ownerDocument.createElement(el) : null,
}

/**
 * 创建一个跑在 mini DOM 上的渲染器 + 挂载容器。
 * 返回 { renderer, container, doc, html() }
 */
export function createMiniApp() {
  const { document, root } = createMiniDocument()

  const nodeOps = {
    createElement: tag => document.createElement(tag),
    createText: text => document.createTextNode(text),
    createComment: text => document.createComment(text),
    setText: (node, text) => {
      node.nodeValue = text
    },
    setElementText: (el, text) => {
      el.textContent = text
    },
    insert: (child, parent, anchor) => {
      parent.insertBefore(child, anchor || null)
    },
    remove: child => {
      if (child.parentNode) child.parentNode.removeChild(child)
    },
    parentNode: node => node.parentNode,
    nextSibling: node => node.nextSibling,
    patchProp: createMiniPatchProp(),
  }

  const renderer = createRenderer(nodeOps)
  const container = document.createElement('div')

  return {
    renderer,
    container,
    document,
    /** 把容器里的内容序列化成 HTML 字符串 */
    html: () => container.childNodes.map(node => serialize(node)).join(''),
  }
}

/** 一个极简的 mock 运行时全局对象，供 compile 产物的 new Function 使用 */
export function createMockRuntime(overrides = {}) {
  return overrides
}

export { serialize }
