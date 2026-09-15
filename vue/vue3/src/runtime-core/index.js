/**
 * src/runtime-core/index.js —— 运行时核心统一出口（对应 Vue 的 @vue/runtime-core 包）。
 * 编译器产出的代码里引用的那些 _xxx 帮助函数，绝大部分在这里导出。
 */
export * from './vnode.js'
export * from './renderer.js'
export * from './component.js'
export * from './h.js'
export * from './lifecycle.js'
export * from './instance.js'
export { nextTick, queueJob } from '../reactivity/scheduler.js'
