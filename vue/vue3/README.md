# vue-mini · 最小可用 Vue 3（学习项目）

跟着《Vue.js 设计与实现》手写的一个最小可用 Vue 3：**零依赖、纯 ESM**。
回答一个核心问题 —— **模板字符串如何一步步变成真实 DOM，并且在数据变化时只更新必要的部分？**

```
模板 ──tokenize──► token ──parse──► AST ──transform──► JS AST ──generate──► render 函数
                                                                            │ 执行
数据变化 ──trigger──► 调度队列 ──flush──► effect.run ──► 新 VNode 树         ▼
              ▲                                                        VNode 树
              └── track（谁读了我）                                   patch(old, new)
                                                                     │ diff
                                                                     ▼
                                                            最小化的真实 DOM 操作
```

## 快速开始

```bash
cd vue/vue3
node server.mjs     # 打开 http://localhost:5173/（四个可视化演示）
npm test            # 114 个单元测试（跑在自制的 mini-dom 上，无需浏览器）
```

| 演示页面 | 对应文档 | 回答的问题 |
|---|---|---|
| `examples/compile-pipeline.html` | [docs/02-模板编译.md](./docs/02-模板编译.md) | 模板怎么变成 render 函数？（token/AST/产物实时可视化） |
| `examples/renderer.html` | [docs/03-渲染器与Diff.md](./docs/03-渲染器与Diff.md) | VNode 怎么变成 DOM？diff 到底省了多少操作？（真实操作日志） |
| `examples/reactivity.html` | [docs/01-响应式原理.md](./docs/01-响应式原理.md) | 数据变化时函数为什么自动重跑？（track/trigger/批量更新） |
| `examples/components.html` | [docs/04-组件化原理.md](./docs/04-组件化原理.md) | 组件怎么实现？（Todo 应用：props/emit/slots/生命周期） |

总览入口：[docs/00-总览.md](./docs/00-总览.md)。

## 已实现的能力

**编译器**（`src/compiler-core/`）：词法分析（有限状态机）、语法分析（栈）、
`v-if / v-else-if / v-else`、`v-for`（key/非key）、`v-model`（元素/组件/修饰符）、
`@event` 与全部事件修饰符、`v-html / v-text / v-once`、`v-bind` 对象展开、
动态与静态 class/style 合并、`<slot>` 与 `<template #name>` 具名/作用域插槽、
`prefixIdentifiers`（`_ctx.` 前缀化）、**patchFlag 靶向更新标记、静态提升、Block Tree**。

**渲染器**（`src/runtime-core/`）：VNode、mount/patch、属性 diff、事件 invoker、
双端 keyed diff（头部/尾部扫描 + key 映射 + 从后往前移动）、Fragment、文本合并、
块树快路径（dynamicChildren 靶向更新）、卸载清理。

**响应式**（`src/reactivity/`）：effect（依赖清理/嵌套/stop）、reactive（五个 trap、
惰性深层代理、数组仪表化）、ref/shallowRef/toRefs/proxyRefs、computed（缓存+惰性+可写）、
调度器（去重、父先子后排序、nextTick、无限循环守卫）。

**组件系统**：实例与 `_ctx` 代理、setup、props/attrs 拆分与透传、emit（v-model 的底层）、
插槽（withCtx 作用域切换）、provide/inject（原型链）、六组生命周期、shouldUpdateComponent 跳过、
运行时模板编译注入（"完整版"开关）。

**测试**：`tests/` 下 114 个用例跑在自制的 `mini-dom`（200 行假 DOM）上 ——
同一份渲染器，Node 里不开浏览器跑通全链路，本身就是"渲染器平台无关"的证明。

## 目录

```
src/
├── shared/          位标记（ShapeFlags/PatchFlags）、class/style 归一化
├── reactivity/      dep（账本）effect reactive ref computed scheduler
├── runtime-core/    vnode renderer component h lifecycle runtimeHelpers
├── runtime-dom/     nodeOps patchProp createApp
├── compiler-core/   tokenize parse transform expression js-ast codegen
└── index.js         对外出口（把编译器注入运行时）
examples/            四个可视化演示 + 静态服务器 server.mjs
docs/                五篇长文讲解（建议按 00 → 01 → 02 → 03 → 04 顺序读）
tests/               mini-dom + 114 个 node --test 用例
```

## 源码阅读建议

每个文件头部都有"为什么这么设计"的注释，正文里 `★` 标记的是关键洞察。
推荐两条阅读路径：

- **顺着数据流**：`reactivity/dep.js` → `effect.js` → `scheduler.js` →
  `runtime-core/renderer.js`（render/patch）→ `component.js`（setupRenderEffect）
- **顺着模板**：`compiler-core/index.js` 的 compile() 五步 → `tokenize.js` →
  `parse.js` → `transform.js` → `codegen.js` → 回到 `runtime-core/renderer.js`

与真实 Vue 的差距清单见 [docs/00-总览.md](./docs/00-总览.md) 第五节。
