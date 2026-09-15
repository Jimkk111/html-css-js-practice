# 03 · 渲染器与 Diff：VNode 树是怎么变成真实 DOM 的

> 对应源码：`src/runtime-core/renderer.js`（渲染器本体）、`src/runtime-core/vnode.js`（VNode 与块）、
> `src/runtime-dom/`（浏览器适配层）。可视化演示：`examples/renderer.html`（能看到渲染器每一笔 DOM 操作）。
> 参考书目：《Vue.js 设计与实现》第 8～11 章（渲染器与 diff）、第 16 章（编译优化）。

## 一、VNode：用 JS 对象描述界面

真实 DOM 太贵：创建一个 div 要挂上百个字段，任何插入/删除都可能触发重排。
虚拟 DOM 的思路：先用**轻量 JS 对象**描述"界面应该长什么样"，在内存里算出最小差异，
再一次性落到真实 DOM。

```js
{
  type: 'div',            // 字符串=元素；对象=组件；Text/Comment/Fragment=symbol
  props: { id: 'app' },   // 属性 + 事件（onClick 也在这里）
  children: 'hello',      // 字符串 | vnode 数组 | 插槽对象
  shapeFlag: 33,          // 位掩码：ELEMENT(1) | TEXT_CHILDREN(32)
  key: null,              // diff 的"身份证"
  el: null,               // ★ 挂载后指向真实 DOM —— vnode 与 DOM 之间的桥
  patchFlag: 0,           // 编译器留的更新提示
  dynamicChildren: null,  // 块：只装动态后代（见第四节）
}
```

`shapeFlag` 用位运算把"类型 + children 形态"压进一个数字，
patch 里全部用一次按位与判断分派，比一串 if-else 读字段快得多：

```
ELEMENT(1) TEXT(2) COMMENT(4) FRAGMENT(8) COMPONENT(16)
TEXT_CHILDREN(32) ARRAY_CHILDREN(64) SLOTS_CHILDREN(128)

<div>hello</div>        → 1 | 32 = 33
<div><span/></div>      → 1 | 64 = 65
<MyComp>…</MyComp>      → 16 | 128 = 144（组件 + 插槽对象）
```

**`type 是不是对象`是组件化的分水岭**：渲染器在 patch 里只看这个就决定走"元素流程"
还是"组件流程"，两者的复杂度被完全隔离（组件流程见下一篇）。

## 二、渲染器与平台无关（renderer.js）

渲染器从头到尾没有出现过 `document`。所有 DOM 操作都从 `options` 注入（host 前缀是 Vue 的命名习惯）：

```js
createRenderer({
  createElement, createText, createComment,
  setText, setElementText,
  insert(child, parent, anchor),   // ★ anchor 是"插到谁前面"
  remove, parentNode, nextSibling,
  patchProp,                       // 属性/事件/class/style 的落地
})
```

`runtime-dom/nodeOps.js` 提供浏览器的实现；`tests/mini-dom.js` 提供一个 200 行的假 DOM ——
**同一份渲染器，测试里一个浏览器都没开就跑通了全链路**，这就是平台无关的直接证明。

## 三、两条主线：mount 与 patch

### 3.1 增量更新的地基

```js
function render(vnode, container) {
  const prev = container._vnode || null   // ★ 上一次的 vnode 被存在容器上
  patch(prev, vnode, container)
  container._vnode = vnode                // 这一次的变成"上一次"
}
```

所有"最小化更新"都建立在"上一次的产物被留着"之上。
`patch(n1, n2)` 里 n1 为 null 走挂载，n1 有值走更新。

### 3.2 mountElement：顺序就是性能

```js
① const el = vnode.el = hostCreateElement(type)   // 创建游离节点
② 挂 children（textContent 或递归 mountChildren）
③ 逐个 patchProp
④ hostInsert(el, container, anchor)               // 只插入一次
```

先在游离节点上把子节点和属性全部装好，最后一次性插入 ——
浏览器只需一次布局计算。反过来"先插入再逐个挂子节点"，每个子节点都会触发重排。

### 3.3 patchElement：复用 DOM，只改差异

```js
const el = (n2.el = n1.el)   // ★ 更新的本质：继承旧 vnode 的 DOM，绝不重建
```

之后只有两条路：属性（patchProps / 靶向更新）和子节点（patchChildren / 块）。
什么时候 DOM 才会重建？只有 `isSameVNodeType(n1, n2)` 为 false ——
**type 不同或 key 不同**。这就是 key 的语义：它标识"逻辑上是不是同一个节点"。

> 本项目踩过的坑（测试已覆盖）：vnode 的 key 必须归一化成 `?? null`。
> 一个 vnode 带了 props 但没写 key 时 key 是 undefined，
> 和"没写 props 的 vnode 的 key=null"会被判为不同 → 全部 DOM 重建。

### 3.4 属性落地的细节（runtime-dom/patchProp.js）

| 类别 | 处理 | 原因 |
|---|---|---|
| class | 归一化后写 `el.className` | 数组/对象写法只有运行时知道 |
| style | 先设新样式，再把"新对象里没有的旧键"置空串 | 空串是 CSSStyleDeclaration 的删除方式 |
| `onXxx` | **invoker 机制**：绑定一个稳定函数，更新只换 `invoker.value` | 每次渲染都是新闭包，直接绑定会无限叠加监听器（点 3 次触发 3 次） |
| value/checked | 写 DOM property 而不是 attribute | attribute 是"初始值"，property 是"当前值" |
| disabled 等布尔属性 | 有值 → `setAttribute(key, '')`；false → removeAttribute | HTML 里"有属性就算 true"，`disabled="false"` 依然禁用 |

invoker 值得单独看一眼（patchEvent）：

```js
invoker = e => invoker.value(e)   // 这个函数永远不变，addEventListener 只发生一次
invoker.value = 新处理器            // 每次渲染只换这个引用
```

**靶向更新**：如果 vnode 带 `patchFlag & PROPS` 和 `dynamicProps` 清单
（编译器给的），更新时只对比清单里的属性 —— `class="static"` 之类的静态属性
连比较的机会都没有。手写 vnode（flag=0）才走全量对比。

## 四、children 的 diff（本章主角）

新旧 children 有 文本/数组/空 三种形态，组合出 9 种情况，
`patchChildren` 用两层 shapeFlag 判断把 8 种简单情况处理掉，只剩：

**数组 → 数组：patchKeyedChildren（双端比较 + key 映射）**

```
旧: [a, b, c, d, e]        新: [a, b, e, c, d]
     ① 头-头扫描：a↔a, b↔b 直接 patch（能复用就跳过，不需要任何查找）
                         i=2
     ② 尾-尾扫描：e↔e, d↔d, c↔c 直接 patch
                    e1=1, e2=1 → 全部处理完，收工！
```

头尾扫描处理掉了"两端不变"的最常见场景。剩下的中间乱序区：

```
① keyToNewIndexMap：新节点 key → 新下标 的 Map（O(1) 判断"某个旧节点还要不要"）
② 遍历旧乱序区：
     key 在新列表里找不到 → unmount（这就是"删了一项"）
     找得到 → patch 复用，同时把"新下标"记进 newIndexToOldIndexMap
     ★ 顺手判断要不要移动：映射出的新下标序列若"单调递增"，相对顺序没变，一次都不用挪；
       一旦出现"倒退"，moved = true
③ 从后往前遍历新乱序区（★ 方向是关键：每次插入都能拿"后面那个已就位的节点"当锚点）：
     newIndexToOldIndexMap 里是 -1 → patch(null, 新节点)（新增）
     moved 且位置不对 → hostInsert 挪到锚点前
```

对照源码 `patchKeyedChildren`，逐个验证 `examples/renderer.html` 里的操作：
"整体反转"全靠移动（uid 不变 = DOM 复用）；"全部改名"只有 setText；"随机删除"只有 remove。

**unkeyed 的代价**：`patchUnkeyedChildren` 按下标一一对应 patch。
`[a,b] → [b,a]` 时下标 0 的 a 被拿去当 b 更新 → 两个节点全被重建。
**这就是"列表必须加 key"的全部技术原因**（key 还能让编译器打 KEYED_FRAGMENT 标记）。

**真实 Vue 的进一步优化**：中间乱序区用「最长递增子序列（LIS）」算出
"可以保持不动的那批节点"，让移动次数理论最少（O(n log n)）。
本项目用"当前 DOM 顺序是否已经正确"做廉价近似，正确性一致、移动次数可能略多 ——
这是本实现与真实 Vue 在 diff 上最大的差距，值得作为练习补上。

## 五、Fragment 与"一串节点"

多根模板、v-for 的展开结果都是"一个 vnode 对应多个平级 DOM"。
Fragment 的处理要点：

```js
vnode.el     = 第一个子节点的 DOM
vnode.anchor = 最后一个子节点的 DOM   // "我这一串到哪结束"，移动/插入的锚点
```

`getLastHostNode` 只有 Fragment 和组件需要递归 —— 元素的边界就是它自己（子节点都在内部），
所以复杂度是 O(嵌套层数) 而不是 O(节点总数)。

## 六、块（Block）：让更新与树的深度无关

编译器（见 02 篇）在每个可能含动态后代的地方开块，运行时配合三件套：

```js
openBlock()                       // 压栈一个收集数组
createVNode(...)                  // patchFlag>0 或是组件 → 登记进栈顶数组
createElementBlock → setupBlock   // 把数组挂到 vnode.dynamicChildren，出栈，并把自己登记进父块
```

更新时的快路径（patchElement）：

```js
if (dynamicChildren) patchBlockChildren(n1.dynamicChildren, n2.dynamicChildren, ...)
else patchChildren(...)            // 手写 vnode 没有块 → 完整 diff
```

`patchBlockChildren` 按**下标一一对应** patch（编译器保证新旧块同构），静态子树完全不碰。
十层嵌套一个动态节点 → 更新 O(1)。

两个必须小心正确性的地方（都对应真实 Vue 的做法）：

1. **容器解析**：块里的 Fragment/组件，其 DOM 可能不在"当前元素的 el"里
   （典型：`<div><ul><li v-for/></ul></div>`，列表被收集进 div 的块）。
   patch 时要用"旧节点真实所在的父节点"当容器，否则新节点会被插错父元素。
2. **同构保险**：块的 dynamicChildren 长度由编译器保证，但运行时仍然假设"新旧同下标可对比"。
   v-if 分支必须各自开块、`createCommentVNode('v-if', true)` 也要登记，
   就是为了让"切分支"前后结构稳定。

## 七、卸载与内存

`unmount(vnode, doRemove)`：

- 组件 → unmountComponent：触发钩子、**stop 渲染 effect**（不停的话数据一变它还会更新已不存在的 DOM —— 最典型的泄漏）、递归卸载子树。
- 元素 → **先递归卸载子树里的组件**（让它们的钩子和 effect 走完整流程），再整体 remove DOM（子节点传 doRemove=false，避免逐个 removeChild 的浪费）。
- onUnmounted 通过"卸载深度队列"在整棵树卸载完后按**父先子后**（FIFO）触发 —— 与真实 Vue 一致。

## 八、一次更新的完整旅程（把三篇串起来）

```
state.count++                       ① 响应式：set 拦截 → trigger
  → 渲染 effect 的 scheduler         ② 调度器：job 入队（去重/排序）
  → 微任务 flush → effect.run        ③ render 重新执行 → 新 VNode 树
  → patch(旧树, 新树)                ④ 渲染器：复用 DOM，靶向更新属性
  → patchBlockChildren/patchChildren ⑤ 块 or 双端 diff：只动真正变化的节点
  → setText / patchProp / insert     ⑥ 最少的 DOM 操作
```
