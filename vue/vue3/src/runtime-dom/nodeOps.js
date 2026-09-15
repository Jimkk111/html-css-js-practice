/**
 * nodeOps —— 「宿主环境操作」的浏览器实现。
 *
 * 渲染器只调用这一组函数，从不直接碰 document。
 * 把这一组函数换掉，就得到另一个平台的渲染器：
 *   换 Canvas 版本  → 渲染到画布
 *   换 小程序版本   → setData 到小程序
 *   换 测试版本     → 操作一个纯 JS 对象树（本项目 tests/mini-dom.js 就是这么做的）
 *
 * 所以 createRenderer(options) 的 options，本质上就是「平台适配层」。
 */

export const nodeOps = {
  /** 创建元素 */
  createElement(tag) {
    return document.createElement(tag)
  },

  createText(text) {
    return document.createTextNode(text)
  },

  createComment(text) {
    return document.createComment(text)
  },

  /** 修改文本节点的内容（更新 {{ msg }} 时走这里） */
  setText(node, text) {
    node.nodeValue = text
  },

  /**
   * 批量设置元素的文本内容。
   * 更新「纯文本 children」时用它，比逐个文本节点操作快得多。
   * 注意会把已有子节点全部清掉 —— 调用方（patchChildren）负责保证这是想要的行为。
   */
  setElementText(el, text) {
    el.textContent = text
  },

  /**
   * 把 child 插入到 parent 的 anchor 之前；anchor 为 null 表示追加到末尾。
   *
   * ★ anchor 是移动节点时的"定位锚"：
   *   要在 [a, b, c] 里把 c 移到 a 前面 → insertBefore(c, a)
   *   Vue 的 diff 全靠它实现「不重建、只挪位」。
   */
  insert(child, parent, anchor = null) {
    parent.insertBefore(child, anchor)
  },

  remove(child) {
    const parent = child.parentNode
    if (parent) parent.removeChild(child)
  },

  parentNode(node) {
    return node.parentNode
  },

  nextSibling(node) {
    return node.nextSibling
  },
}
