/**
 * src/index.js —— 对外出口（相当于 npm 包 `vue` 的入口）。
 *
 * 用户写的那行 `import { createApp, ref } from 'vue'`，指的就是这里。
 * 本文件做三件事：
 *   1. 重新导出 runtime-core / runtime-dom / reactivity / compiler 的全部公共 API；
 *   2. 把「编译器」注入运行时 —— 这样任何组件写 template 都能被现场编译；
 *   3. 提供 defineComponent（纯粹为了类型推导和 IDE 提示的空壳函数）。
 */
import { createApp, renderer, nodeOps, patchProp } from './runtime-dom/index.js'
import { compile } from './compiler-core/index.js'
import { setRuntimeCompiler } from './runtime-core/component.js'

/**
 * defineComponent —— 运行时它什么也不做，只是把参数原样返回。
 *
 * 存在的意义有两个，都很实际：
 *   1. 类型推导：让 TypeScript 知道 setup 的返回值与模板、props 之间的对应关系；
 *   2. IDE 提示：编辑器看到它就知道这是个组件对象，能给出补全。
 *
 * 所以「不用 defineComponent 行不行」的答案是：在 JS 里它就是恒等函数，
 * 写成普通对象完全等价；但在 TS 项目里值得用。
 */
export function defineComponent(options) {
  if (typeof options === 'function') {
    // 函数式组件：函数本身就是 render
    return { render: options, __isFunctional: true }
  }
  return options
}

/**
 * ★ 把编译器交给运行时。
 *
 * 这一行是「模板 → DOM」在应用层面的开关：
 * 运行时（component.js）在渲染一个组件时，如果发现它「没有 render 但有 template」，
 * 就会回调这里注册的 compile，把模板编成 render 函数。
 *
 * 真实 Vue 也是这样分层的：
 *   vue.runtime.esm-browser.js       只有运行时，没有编译器 → 用 template 会报错，体积小
 *   vue.esm-browser.js（完整版）      额外带上编译器        → 支持 template，体积大
 * 区别仅仅在于有没有执行这一行「注册编译器」。
 */
setRuntimeCompiler(compile)

// ---- 重新导出所有公共 API ----
export { createApp, renderer, nodeOps, patchProp }
export { compile, compileWithSteps } from './compiler-core/index.js'
export * from './runtime-dom/index.js'
export * from './runtime-core/vnode.js'
export * from './runtime-core/h.js'
export * from './runtime-core/component.js'
export * from './runtime-core/lifecycle.js'
export * from './runtime-core/instance.js'
export * from './runtime-core/runtimeHelpers.js'
export * from './reactivity/index.js'
export * from './compiler-core/index.js'
