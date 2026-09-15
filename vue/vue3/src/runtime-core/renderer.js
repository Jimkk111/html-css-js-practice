/**
 * renderer —— 渲染器：把 VNode 树变成真实 DOM，并在新旧 VNode 之间做「最小化更新」。
 *
 * 这是整个运行时的心脏，全文围绕两个函数展开：
 *
 *   mount(vnode, container)  —— 首次渲染：vnode → 真实 DOM
 *   patch(n1, n2, container) —— 更新：比较新旧 vnode，只改动有差异的那部分 DOM
 *
 * 一次「首次渲染」的完整调用链（先记住这张图，后面每一节都在展开它的某个环节）：
 *
 *   render(vnode, container)
 *     └─ patch(null, vnode, container)              新节点 → 走挂载
 *          ├─ ELEMENT   → processElement → mountElement
 *          │                                 ├─ hostCreateElement(type)   ← 创建 DOM
 *          │                                 ├─ mountChildren(递归 patch) ← 挂子节点
 *          │                                 ├─ hostPatchProp × n         ← 设属性
 *          │                                 └─ hostInsert                ← 放进容器
 *          ├─ TEXT      → processText   → hostCreateText + hostInsert
 *          ├─ COMMENT   → processComment（v-if 为 false 时的占位）
 *          ├─ FRAGMENT  → processFragment（多根节点 / v-for）
 *          └─ COMPONENT → mountComponent（见 component.js，组件化的入口）
 *
 * 一次「更新渲染」的调用链：
 *
 *   render(newVnode, container)
 *     └─ patch(oldVnode, newVnode, container)
 *          ├─ type 或 key 不同 → 卸载旧的、挂载新的（DOM 被重建）
 *          └─ 相同 → processElement → patchElement
 *                                    ├─ patchProps    只改变化的属性
 *                                    └─ patchChildren diff 子节点（见 patchKeyedChildren）
 *
 * 【为什么渲染器要平台无关】
 * 本文件里没有任何 document / window，所有 DOM 操作都从 options（nodeOps）注入，
 * 函数名统一加 host 前缀表示「宿主环境的操作」。
 * 好处是同一份渲染逻辑可以跑在浏览器（runtime-dom）、小程序、Canvas 甚至服务端。
 * 这也是为什么 createRenderer 是个「工厂函数」：换一份 options 就是另一个渲染器。
 */

import { Comment, Fragment, Text, normalizeVNode } from './vnode.js'
import { ShapeFlags } from '../shared/shapeFlags.js'
import { PatchFlags } from '../shared/patchFlags.js'
import { EMPTY_OBJ, isArray, isString } from '../shared/utils.js'
import { mountComponent, updateComponent, unmountComponent } from './component.js'

/** VNode 的 key/ref 是元信息，不是 DOM 属性，patchProp 时要跳过 */
const isReserved = key => key === 'key' || key === 'ref'

/** 创建一个平台相关的渲染器 */
export function createRenderer(options) {
  const {
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    insert: hostInsert,
    remove: hostRemove,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    patchProp: hostPatchProp,
  } = options

  /**
   * 渲染入口。
   *
   * container._vnode 保存「上一次渲染的 vnode」，它就是下一次 patch 的旧节点。
   * ★ 整个增量更新的地基就是这一行：上一次的产物必须被留着，才有东西可以对比。
   */
  function render(vnode, container, anchor = null) {
    if (vnode == null) {
      // render(null, container) 表示卸载：清空容器
      if (container._vnode) {
        unmount(container._vnode, null, true)
        container._vnode = null
      }
      return
    }
    const prevVNode = container._vnode || null
    patch(prevVNode, vnode, container, anchor)
    container._vnode = vnode
  }

  /**
   * patch —— 渲染器的「交通枢纽」，负责分派。
   *
   *   第一个参数 n1 为 null  → 挂载新节点
   *   第一个参数 n1 有值     → 更新（试图复用 n1 的 DOM）
   */
  function patch(n1, n2, container, anchor = null, parentComponent = null) {
    // ---- 情况 -1：同一个 vnode 对象（静态提升的节点会这样）→ 什么都没变 ----
    // 静态提升的 vnode 是模块级常量，新旧两棵树里是同一个对象。
    // 这种情况直接返回：DOM 已经在那儿了，不需要任何对比。
    if (n1 === n2) return

    // ---- 情况 0：类型不同或 key 不同 → 无法复用，卸载旧的、挂载新的 ----
    // 要复用同一个 DOM，前提是「描述的东西是一样的」：同样是 div、且 key 相同。
    if (n1 && !isSameVNodeType(n1, n2)) {
      // 先记下旧节点的位置，新节点要插到同一个地方，否则 DOM 顺序会乱
      anchor = getNextHostNode(n1)
      unmount(n1, parentComponent, true)
      n1 = null
    }

    const { type, shapeFlag } = n2
    switch (type) {
      case Text:
        processText(n1, n2, container, anchor)
        break
      case Comment:
        processComment(n1, n2, container, anchor)
        break
      case Fragment:
        processFragment(n1, n2, container, anchor, parentComponent)
        break
      default:
        if (shapeFlag & ShapeFlags.ELEMENT) {
          processElement(n1, n2, container, anchor, parentComponent)
        } else if (shapeFlag & ShapeFlags.COMPONENT) {
          // 组件：整个流程独立（有实例、有 setup、有自己的生命周期）
          processComponent(n1, n2, container, anchor, parentComponent)
        } else {
          console.warn('[vue-mini] 不认识的 vnode 类型：', n2)
        }
    }
  }

  // =====================================================================
  // 元素
  // =====================================================================

  function processElement(n1, n2, container, anchor, parentComponent) {
    if (n1 == null) mountElement(n2, container, anchor, parentComponent)
    else patchElement(n1, n2, container, parentComponent)
  }

  /**
   * 挂载元素。三步的顺序是刻意的：
   *   ① 创建 el          —— 先有容器，属性和子节点才有地方放
   *   ② 挂子节点 + 属性   —— 都在「还没进 DOM 的游离节点」上完成
   *   ③ 插入容器          —— 只插入一次
   *
   * 如果顺序颠倒（先插入、再挂子节点），每挂一个子节点浏览器都要重新计算布局，
   * 这就是「文档片段（DocumentFragment）批量插入」被发明出来的原因，而我们这里天然做到了。
   */
  function mountElement(vnode, container, anchor, parentComponent) {
    const { type, props, children, shapeFlag } = vnode
    const el = (vnode.el = hostCreateElement(type)) // ① 创建真实 DOM，建立 vnode → el 的引用

    // ② 挂子节点
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // 字符串子节点直接用 textContent，比"创建一个文本节点再插入"少一次 DOM 操作
      hostSetElementText(el, children)
    } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      mountChildren(children, el, null, parentComponent)
    }
    // SLOTS_CHILDREN 只会出现在组件 vnode 上，元素不会走到这里

    // ③ 设置属性（class / style / 事件 / 普通属性）
    if (props) {
      for (const key in props) {
        if (isReserved(key)) continue
        hostPatchProp(el, key, null, props[key])
      }
    }

    // ④ 插入容器
    hostInsert(el, container, anchor)
  }

  /**
   * 挂载一组子节点。
   * normalizeVNode 把数组里夹杂的字符串/数字/null 变成真正的 vnode，
   * 而且必须「就地写回」（children[i] = …）—— 否则下次更新时，旧 children 里是字符串、
   * 新 children 里是 vnode，isSameVNodeType 就会误判成"类型不同"从而重建 DOM。
   */
  function mountChildren(children, container, anchor, parentComponent) {
    for (let i = 0; i < children.length; i++) {
      const child = (children[i] = normalizeVNode(children[i]))
      patch(null, child, container, anchor, parentComponent)
    }
  }

  /**
   * 更新元素。只有「属性」和「子节点」两条路要改。
   *
   * 执行顺序是刻意安排的，和真实 Vue 的 patchElement 完全一致：
   *
   *   ① 先按 patchFlag 做**靶向更新**（属性 + 文本）
   *        patchFlag > 0 → 编译器已经告诉我们"哪里会变"，只处理那些地方
   *        patchFlag = 0 → 手写 vnode，没有优化信息 → 只能全量对比
   *
   *   ② 再处理子节点
   *        有 dynamicChildren（块）→ 只 patch 动态子节点，静态部分整块跳过
   *        没有（普通 vnode）     → 走完整的 patchChildren
   *
   * ★ 第 ① 步必须在 ② 之前，而且两者是「并列」而不是「互斥」的：
   *   像 <div>{{ msg }}</div> 这种节点，patchFlag 是 TEXT（文本要更新），
   *   同时它的 dynamicChildren 是空数组（文本不是 vnode，不会被收集）。
   *   如果先判断 dynamicChildren 就 return，文本就永远不会更新了 —— 这正是本实现第一版踩过的坑。
   */
  function patchElement(n1, n2, container, parentComponent) {
    // ★ 复用真实 DOM —— 这行就是「更新」而不是「重建」的全部秘密
    const el = (n2.el = n1.el)

    const oldProps = n1.props || EMPTY_OBJ
    const newProps = n2.props || EMPTY_OBJ
    const { patchFlag, dynamicChildren } = n2

    // ============ ① 属性 + 文本的靶向更新 ============
    if (patchFlag > 0) {
      if (patchFlag & PatchFlags.FULL_PROPS) {
        // 属性集合本身是动态的（v-bind="obj"）→ 只能全量对比
        patchProps(el, oldProps, newProps)
      } else if (patchFlag & PatchFlags.PROPS) {
        // 编译器给了动态属性清单 → 只对比清单里的那几个
        const propsToUpdate = n2.dynamicProps
        if (propsToUpdate) {
          for (const key of propsToUpdate) {
            if (isReserved(key)) continue // key / ref 不是 DOM 属性
            if (newProps[key] !== oldProps[key]) {
              hostPatchProp(el, key, oldProps[key], newProps[key])
            }
          }
        } else {
          patchProps(el, oldProps, newProps)
        }
      }

      // class / style 会被单独标记（因为它们的归一化开销大，编译器希望尽量避免全量对比）
      if (patchFlag & PatchFlags.CLASS) {
        if (oldProps.class !== newProps.class) {
          hostPatchProp(el, 'class', oldProps.class, newProps.class)
        }
      }
      if (patchFlag & PatchFlags.STYLE) {
        hostPatchProp(el, 'style', oldProps.style, newProps.style)
      }

      // ★ 纯文本快路径：编译器保证"元素里只有一个动态文本、其余全静态"，
      //   所以直接改 textContent，属性和子节点都不用管。
      if (patchFlag & PatchFlags.TEXT) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children)
        }
      }
    } else if (!dynamicChildren) {
      // 没有优化信息（手写 render 函数生成 vnode）→ 老老实实全量对比属性
      patchProps(el, oldProps, newProps)
    }

    // ============ ② 子节点 ============
    if (dynamicChildren) {
      // ★ 块树快路径：只有 dynamicChildren 里的节点可能变化，静态部分编译器已保证不变。
      //   于是完全跳过 children 的递归 diff，按位置一一 patch 那几个动态节点。
      //   代价从 O(整棵子树) 降到 O(动态节点数)——与树的深度无关。
      patchBlockChildren(n1.dynamicChildren, dynamicChildren, el, parentComponent)
    } else {
      // 普通节点：走完整的 children diff（元素子节点的 anchor 恒为 null，孩子都在 el 内部）
      patchChildren(n1, n2, el, null, parentComponent)
    }
  }

  /**
   * 块树 diff：新旧块的 dynamicChildren 是「同构」的（编译器保证同样的顺序和数量），
   * 所以可以按下标一一对应地 patch，不需要任何查找与匹配。
   *
   * ★ container 的取法有个不小的坑：
   *   大多数时候用 fallback（= 当前元素的 el）就够了。但如果子节点是
   *     Fragment —— 它的 DOM 是"一串"，可能被插到了别的地方
   *     组件     —— 它的 DOM 来自自己的子树
   *     类型变了 —— 旧节点会被卸载、新节点要在旧节点的位置重建
   *   这几种情况必须用「旧节点真实所在的父节点」当容器，否则新节点会被插进错误的父元素里。
   *
   *   典型翻车场景：<div><ul><li v-for></li></ul></div>
   *   v-for 生成的 Fragment 会被收集进 div 的块里，patch 时传进来的 container 是 div.el，
   *   如果直接用它，新插入的 <li> 就会跑到 div 里而不是 ul 里。
   */
  function patchBlockChildren(oldChildren, newChildren, fallbackContainer, parentComponent) {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren && oldChildren[i]
      const newVNode = newChildren[i]

      // 决定这个节点该被 patch 到哪个容器里
      const container =
        oldVNode && oldVNode.el && (oldVNode.type === Fragment || !isSameVNodeType(oldVNode, newVNode))
          ? hostParentNode(oldVNode.el) // 用"旧节点真实所在的父节点"
          : fallbackContainer

      // 锚点：插到"旧节点之后"原来那个位置
      const anchor = oldVNode && oldVNode.el ? getNextHostNode(oldVNode) : null

      patch(oldVNode || null, newVNode, container, anchor, parentComponent)
    }
  }

  /** 全量属性对比：新增/变更的 + 被删除的 */
  function patchProps(el, oldProps, newProps) {
    if (oldProps === newProps) return
    // 1. 遍历新 props：值不一样就更新（包含新增）
    for (const key in newProps) {
      if (isReserved(key)) continue
      const next = newProps[key]
      const prev = oldProps[key]
      if (next !== prev) hostPatchProp(el, key, prev, next)
    }
    // 2. 遍历旧 props：新 props 里没有 → 删除（nextValue 传 null 表示删除）
    if (oldProps !== EMPTY_OBJ) {
      for (const key in oldProps) {
        if (isReserved(key)) continue
        if (!(key in newProps)) hostPatchProp(el, key, oldProps[key], null)
      }
    }
  }

  // =====================================================================
  // 文本 / 注释
  // =====================================================================

  function processText(n1, n2, container, anchor) {
    if (n1 == null) {
      hostInsert((n2.el = hostCreateText(n2.children)), container, anchor)
    } else {
      const el = (n2.el = n1.el)
      if (n2.children !== n1.children) hostSetText(el, n2.children)
    }
  }

  function processComment(n1, n2, container, anchor) {
    if (n1 == null) {
      hostInsert((n2.el = hostCreateComment(n2.children || '')), container, anchor)
    } else {
      n2.el = n1.el // 注释不需要更新内容
    }
  }

  // =====================================================================
  // Fragment（片段）
  // =====================================================================

  /**
   * Fragment 解决什么问题？
   *   1. 组件/模板有多个根节点：<template><div/><div/></template>
   *   2. v-for 展开成一堆平级节点
   * Vue 2 强制单根节点，Vue 3 引入 Fragment 后不再限制。
   *
   * 它的特殊之处：一个 vnode 对应「一串」真实 DOM，所以要记住这一串的边界：
   *   vnode.el     = 第一个子节点对应的 DOM
   *   vnode.anchor = 最后一个子节点对应的 DOM
   */
  function processFragment(n1, n2, container, anchor, parentComponent) {
    if (n1 == null) {
      const children = (n2.children = (n2.children || []).map(normalizeVNode))
      if (children.length === 0) {
        // 空片段（例如 v-for 遍历空数组）：插一个空注释占位，
        // 保证"这个片段在 DOM 里占有一个位置"，否则锚点无从计算
        const el = (n2.el = n2.anchor = hostCreateComment(''))
        hostInsert(el, container, anchor)
        return
      }
      mountChildren(children, container, anchor, parentComponent)
    } else {
      // 更新：把子节点插到「旧片段最后一个节点之后」
      patchChildren(n1, n2, container, getNextHostNode(n1), parentComponent)
    }
    setFragmentRange(n2)
  }

  /** 计算片段的首/尾 DOM，供后续移动与插入当锚点用 */
  function setFragmentRange(fragment) {
    const children = fragment.children
    if (isArray(children) && children.length) {
      fragment.el = getFirstHostNode(children[0])
      fragment.anchor = getLastHostNode(children[children.length - 1])
    }
  }

  /** vnode 对应的第一个真实 DOM */
  function getFirstHostNode(vnode) {
    if (vnode.type === Fragment) return getFirstHostNode(vnode.children[0])
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      return vnode.component ? getFirstHostNode(vnode.component.subTree) : vnode.el
    }
    return vnode.el
  }

  /**
   * vnode 对应的最后一个真实 DOM。
   *
   * ★ 关键洞察：只有「片段」和「组件」需要递归，因为它们的 DOM 是散开的多个节点；
   *   元素节点的边界就是它自己（子节点都在它内部），直接返回 el —— 递归在此终止。
   *   所以这个函数只有 O(嵌套层数) 的复杂度，不是 O(节点总数)。
   */
  function getLastHostNode(vnode) {
    if (vnode.type === Fragment) {
      const children = vnode.children || []
      for (let i = children.length - 1; i >= 0; i--) {
        const node = getLastHostNode(children[i])
        if (node) return node
      }
      return vnode.anchor
    }
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      return vnode.component ? getLastHostNode(vnode.component.subTree) : vnode.el
    }
    return vnode.el
  }

  // =====================================================================
  // children 的 diff —— 渲染器里最复杂也最精彩的部分
  // =====================================================================

  /**
   * 更新子节点。
   *
   * 新旧 children 各有 3 种形态（文本 / 数组 / 空），组合出 9 种情况，但只有一种真正难：
   *
   *   新 children   旧 children     处理方式
   *   ────────────  ────────────    ─────────────────────────────
   *   文本          数组             卸载旧数组 → 设文本
   *   文本          文本             值不同才设文本
   *   数组          文本             清空文本 → 挂载新数组（清空很重要，否则会追在文本后面）
   *   数组          数组             ★ 进入 diff
   *   数组          空               直接挂载
   *   空            数组             全部卸载
   *   空            文本             清空文本
   *   空            空               什么都不做
   */
  function patchChildren(n1, n2, container, anchor, parentComponent) {
    const c1 = n1.children
    const c2 = n2.children
    const prevShapeFlag = n1.shapeFlag
    const shapeFlag = n2.shapeFlag

    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // ---- 新 children 是文本 ----
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        unmountChildren(c1, parentComponent, true) // 先把旧数组对应的 DOM 清掉
      }
      if (c2 !== c1) hostSetElementText(container, c2)
    } else if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // ---- ★ 数组 → 数组：真正的 diff ----
        // 走「keyed」还是「unkeyed」由 children 里有没有 key 决定：
        //   有 key → 双端比较，能跨位置复用 DOM（列表重排时省下大量重建）
        //   无 key → 按下标比对，简单但乱序时全部重建
        // 编译器其实已经把这个信息算进了 Fragment 的 patchFlag，这里运行时再判一次，
        // 是为了兼容手写 render 函数（没有编译器给提示）。
        const isKeyed = c2.some(child => child != null && child.key != null)
        if (isKeyed) {
          patchKeyedChildren(c1, c2, container, anchor, parentComponent)
        } else {
          patchUnkeyedChildren(c1, c2, container, anchor, parentComponent)
        }
      } else {
        // ---- 数组 → 空 ----
        unmountChildren(c1, parentComponent, true)
      }
    } else {
      // ---- 旧 children 是文本或空 ----
      if (prevShapeFlag & ShapeFlags.TEXT_CHILDREN) {
        hostSetElementText(container, '')
      }
      if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        mountChildren(c2, container, anchor, parentComponent)
      }
    }
  }

  /**
   * 卸载一组子节点。
   * @param {boolean} doRemove 是否真的从 DOM 移除。
   *   父节点整体被移除时传 false —— 父节点一走，子节点自然消失，逐个 removeChild 是纯浪费。
   */
  function unmountChildren(children, parentComponent, doRemove = false) {
    for (let i = 0; i < children.length; i++) {
      unmount(children[i], parentComponent, doRemove)
    }
  }

  // ---------------------------------------------------------------------
  // 数组 → 数组 的 diff
  // ---------------------------------------------------------------------

  /**
   * 无 key 的 diff（《Vue.js设计与实现》第 9 章「简单 diff」）。
   *
   * 思路：按下标一一对应地 patch，多的挂载、少的卸载。
   *
   *   旧: [a, b, c]
   *   新: [a, c]
   *   i=0: patch(a, a)  ✓
   *   i=1: patch(b, c)  ✗ 类型不同 → 卸载 b、新建 c
   *
   * 它致命的假设是「下标 i 处的节点永远代表同一个东西」。
   * 一旦列表乱序（[a,b] → [b,a]），下标 0 的 a 会被拿去当 b 更新，两个节点全部重建。
   * 结论：只要列表可能重排/插入/删除，就必须给 key —— 这就是 key 存在的意义。
   *
   * 本实现里，编译器只在「静态列表（无 v-for）」时才会走到这里，
   * v-for 生成的 children 一定带 key（没有显式 key 时用索引兜底），所以下面这个函数基本不会成为瓶颈。
   */
  function patchUnkeyedChildren(c1, c2, container, anchor, parentComponent) {
    const oldLength = c1.length
    const newLength = c2.length
    const commonLength = Math.min(oldLength, newLength)
    let i
    for (i = 0; i < commonLength; i++) {
      patch(c1[i], (c2[i] = normalizeVNode(c2[i])), container, anchor, parentComponent)
    }
    if (newLength > oldLength) {
      mountChildren(c2.slice(commonLength), container, anchor, parentComponent)
    } else if (newLength < oldLength) {
      unmountChildren(c1.slice(commonLength), parentComponent, true)
    }
  }

  /**
   * 带 key 的 diff ——【双端比较】（《Vue.js设计与实现》第 10 章）。
   *
   * ── 前面先做两件"闭眼都能做"的事 ──
   * 阶段一：从头开始扫描，key 相同的直接 patch，遇到不同就停。
   * 阶段二：从尾开始扫描，同上。
   * 这两步处理掉了「列表头部/尾部增删」这种最常见的场景，全程 O(k) 且不需要建 Map。
   *
   *   旧: [a, b, c, d]        新: [a, b, c, e, d]
   *   → 阶段一 patch(a,a) patch(b,b) patch(c,c)，遇到 d/e 停
   *   → 阶段二 patch(d,d) ... 一下就收敛了，中间的 e 当作新增
   *
   * ── 剩下的中间部分（乱序区）──
   * 用「新节点 key → 新下标」的 Map 做索引，然后判断哪些旧节点可以复用、哪些要新建、整体要不要移动。
   *
   * ▸ 判断「要不要移动」的技巧：把每个可复用旧节点映射到它在新列表里的下标，
   *   如果这串下标是单调递增的，说明相对顺序没变，一次移动都不用做；
   *   一旦出现"后面的新下标比前面小"，就说明顺序被打乱了 → moved = true。
   *
   * ▸ 移动时的遍历方向是「从后往前」，因为这样每次插入都能拿"后面那个已经就位的节点"当锚点，
   *   插入位置一定是正确的。这是链表/数组重排类算法的经典技巧。
   *
   * 真实 Vue 在这里更进一步（第 11 章「快速 diff」）：用「最长递增子序列」求出
   * 「可以不动的那批节点」，让移动次数达到理论最小。本实现用"DOM 顺序是否已经正确"做简化判断，
   * 正确性一致，只是移动次数可能略多。详见 docs/02-渲染器与Diff.md 的对比表。
   */
  function patchKeyedChildren(c1, c2, container, anchor, parentComponent) {
    let i = 0
    let e1 = c1.length - 1 // 旧 children 的尾指针
    let e2 = c2.length - 1 // 新 children 的尾指针

    // ---- 阶段一：头对头 ----
    while (i <= e1 && i <= e2) {
      const n1 = c1[i]
      const n2 = (c2[i] = normalizeVNode(c2[i]))
      if (!isSameVNodeType(n1, n2)) break
      patch(n1, n2, container, null, parentComponent)
      i++
    }

    // ---- 阶段二：尾对尾 ----
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1]
      const n2 = (c2[e2] = normalizeVNode(c2[e2]))
      if (!isSameVNodeType(n1, n2)) break
      patch(n1, n2, container, null, parentComponent)
      e1--
      e2--
    }

    if (i > e1) {
      // ---- 情况 A：旧的都处理完了，新的还有剩余 → 挂载新增节点 ----
      if (i <= e2) {
        // 插入锚点 = 新列表里 e2 的下一个节点。它一定已经存在于 DOM 中（阶段一/二处理过），
        // 若不存在说明是"追加到末尾"，那就用外部传入的 anchor。
        const anchorNode = e2 + 1 < c2.length ? c2[e2 + 1].el : anchor
        while (i <= e2) {
          patch(null, (c2[i] = normalizeVNode(c2[i])), container, anchorNode, parentComponent)
          i++
        }
      }
      return
    }

    if (i > e2) {
      // ---- 情况 B：新的都处理完了，旧的还有剩余 → 卸载多余节点 ----
      while (i <= e1) {
        unmount(c1[i], parentComponent, true)
        i++
      }
      return
    }

    // ---- 情况 C：新旧都有剩余，中间是乱序区 → 双端比较的核心 ----
    const s1 = i
    const s2 = i

    // ① 建立「新节点 key → 新下标」映射。用 Map 而不是每次都遍历查找，
    //    把「判断某旧节点是否还要用」从 O(n) 降到 O(1)，这是 keyed diff 能线性复杂度的原因。
    const keyToNewIndexMap = new Map()
    for (let j = s2; j <= e2; j++) {
      const newNode = (c2[j] = normalizeVNode(c2[j]))
      if (newNode.key != null) {
        keyToNewIndexMap.set(newNode.key, j)
      }
    }

    const toBePatched = e2 - s2 + 1
    // 记录每个新节点对应的旧下标（-1 表示"新列表里这个是新建的"）
    const newIndexToOldIndexMap = new Array(toBePatched).fill(-1)
    let patchedCount = 0
    let maxNewIndexSoFar = 0
    let moved = false

    // ② 遍历旧节点的乱序区：能复用的 patch，不能复用的卸载
    for (let j = s1; j <= e1; j++) {
      const prevChild = c1[j]
      let newIndex = prevChild.key != null ? keyToNewIndexMap.get(prevChild.key) : undefined

      // 旧节点没有 key（混用 keyed/unkeyed 时会出现）：只能在新区间里线性查找
      if (newIndex === undefined && prevChild.key == null) {
        for (let k = s2; k <= e2; k++) {
          if (newIndexToOldIndexMap[k - s2] === -1 && isSameVNodeType(prevChild, c2[k])) {
            newIndex = k
            break
          }
        }
      }

      if (newIndex === undefined) {
        // 新列表里没有能对应上的节点 → 这一项被删了
        unmount(prevChild, parentComponent, true)
        continue
      }

      newIndexToOldIndexMap[newIndex - s2] = j
      patchedCount++
      if (newIndex >= maxNewIndexSoFar) {
        maxNewIndexSoFar = newIndex
      } else {
        // ★ 新下标"倒退"了 → 相对顺序被打乱，需要移动 DOM
        moved = true
      }
      patch(prevChild, c2[newIndex], container, null, parentComponent)
    }

    // 全部可复用且顺序没变、也没有新增 → 收工（最常见的"只改了内容"场景，零 DOM 移动）
    if (!moved && patchedCount === toBePatched) return

    // ③ 从后往前处理：新增的挂载，顺序不对的移动
    for (let j = e2; j >= s2; j--) {
      const newChild = c2[j]
      // 锚点 = 新列表里 j 的下一个节点的 DOM；越界说明要放到末尾
      const anchorNode = j + 1 <= e2 ? c2[j + 1].el : anchor

      if (newIndexToOldIndexMap[j - s2] === -1) {
        // 这个新节点没有对应的旧节点 → 新建并插入到正确位置
        patch(null, newChild, container, anchorNode, parentComponent)
      } else if (moved) {
        // 可复用，但顺序需要调整。先看一眼它现在是不是已经站对了位置 ——
        // 站对了就不用动（这一步就是"最少移动"的廉价近似）。
        if (newChild.el.nextSibling !== anchorNode) {
          hostInsert(newChild.el, container, anchorNode)
        }
      }
    }
  }

  /**
   * 两个 vnode 能否复用同一个 DOM？
   * 条件：type 相同 且 key 相同。
   *
   *   <div key="a"> vs <div key="b">  → 类型相同、key 不同 → 视为两个节点，DOM 重建
   *   <div>       vs <span>            → 类型不同 → 必须重建
   */
  function isSameVNodeType(n1, n2) {
    return n1.type === n2.type && n1.key === n2.key
  }

  // =====================================================================
  // 组件（实现放在 component.js，这里只做转发）
  // =====================================================================

  /**
   * 为什么要"转发"而不是直接 import？
   * 组件流程也需要 patch / unmount 这些能力，如果 component.js 反过来 import renderer.js，
   * 两个模块就成了循环依赖。解决办法：把「渲染器实例」当参数传过去，
   * 依赖方向永远单向 —— renderer.js → component.js。
   */
  function processComponent(n1, n2, container, anchor, parentComponent) {
    if (n1 == null) {
      mountComponent(renderer, n2, container, anchor, parentComponent)
    } else {
      updateComponent(renderer, n1, n2)
    }
  }

  // =====================================================================
  // 卸载
  // =====================================================================

  /**
   * 卸载 vnode。
   * @param {boolean} doRemove 是否真的从 DOM 移除（父节点整体被移除时，子节点传 false）
   */
  function unmount(vnode, parentComponent, doRemove = false) {
    const { type, shapeFlag } = vnode

    if (type === Fragment) {
      // 片段是"一串"节点，逐个卸载
      unmountChildren(vnode.children || [], parentComponent, doRemove)
    } else if (shapeFlag & ShapeFlags.COMPONENT) {
      unmountComponent(renderer, vnode, parentComponent, doRemove)
    } else {
      // ★ 元素：先递归卸载子树，再移除自身。
      //   递归不是为了删 DOM（DOM 由最外层整体 remove，子节点传 doRemove=false）——
      //   是为了让散布在子树里的「组件」走完整的卸载流程：触发 beforeUnmount/unmounted、
      //   停止渲染 effect。否则组件从 DOM 上消失后，它的 effect 还订阅着响应式数据，
      //   数据一变它还会试图更新已不存在的 DOM —— 这是最典型的内存泄漏场景。
      if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        unmountChildren(vnode.children, parentComponent, false)
      }
      if (doRemove && vnode.el) hostRemove(vnode.el)
    }
  }

  /**
   * vnode「之后」的那个真实 DOM —— 移动/替换节点时的锚点。
   * 元素和文本只有 1 个 DOM；片段要看它的尾节点。
   */
  function getNextHostNode(vnode) {
    if (vnode.type === Fragment) {
      return vnode.anchor ? hostNextSibling(vnode.anchor) : null
    }
    return vnode.el ? hostNextSibling(vnode.el) : null
  }

  /**
   * 渲染器实例：把内部能力打包，供 component.js 使用。
   * 这就是一个手写的"依赖注入容器"。
   */
  const renderer = {
    options,
    render,
    patch,
    mountElement,
    mountChildren,
    patchChildren,
    patchProps,
    patchElement,
    unmount,
    unmountChildren,
    getFirstHostNode,
    getLastHostNode,
    getNextHostNode,
    isSameVNodeType,
    hostCreateElement,
    hostCreateText,
    hostCreateComment,
    hostSetText,
    hostSetElementText,
    hostInsert,
    hostRemove,
    hostParentNode,
    hostNextSibling,
    hostPatchProp,
  }

  return renderer
}
