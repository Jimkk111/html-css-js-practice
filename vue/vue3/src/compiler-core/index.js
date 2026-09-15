/**
 * compile —— 编译器对外的统一入口，把四个阶段串起来。
 *
 *     compile(template)
 *       │
 *       ├─ ① tokenize(template)          字符串 → token 流（词法分析）
 *       ├─ ② parse(template)             token 流 → 模板 AST（语法分析）
 *       ├─ ③ transform(ast)              模板 AST → 带 codegenNode 的 AST + 优化信息
 *       ├─ ④ generate(ast, context)      AST → JS 代码字符串
 *       └─ ⑤ new Function(...)           代码字符串 → 真正可执行的渲染函数
 *
 * 这五步就是「模板 → 渲染函数」的完整路径。理解这条路径，就理解了 Vue 的编译时。
 *
 * ── 为什么编译器要能"两用"？ ──
 *   ① 构建时编译（SFC / vite-plugin-vue）：打包阶段就编成 render 函数，
 *      运行时不需要带编译器 → 体积小、启动快。生产环境走这条。
 *   ② 运行时编译（template 选项 / 完整版 vue.js）：浏览器里现场编译，
 *      带的体积大，但能直接在 HTML 里写模板 —— 适合学习和原型开发。
 *   两者共用同一套 parse/transform/generate。编译器之所以设计成「平台无关 + 可插拔」，
 *   就是为了同时服务这两个场景（以及 SSR、自定义渲染器等）。
 */
import { tokenize } from './tokenize.js'
import { parse } from './parse.js'
import { transform } from './transform.js'
import { generate, generateWithAnnotations } from './codegen.js'
import { RUNTIME_HELPERS } from '../runtime-core/runtimeHelpers.js'

/**
 * 编译模板，返回渲染函数。
 *
 * @param {string} template 模板字符串
 * @param {object} options
 *   - showCode 是否在控制台打印完整编译产物（学习时非常有用）
 * @returns {Function} render 函数，签名 (ctx, cache) => vnode
 */
export function compile(template, options = {}) {
  // ---- ①②③④ ----
  const ast = parse(template)
  const context = transform(ast)
  // runtimeGlobalName 必须是 'Vue' —— 与下面 new Function 的第一个参数名对应
  const { code } = generate(ast, context, { mode: 'module', runtimeGlobalName: 'Vue' })

  if (options.showCode && typeof console !== 'undefined') {
    console.log(
      '%c[vue-mini] 编译产物',
      'color:#42b883;font-weight:bold;font-size:13px',
      '\n' + code +
        '\n\n用到的 helper: ' + ([...context.helpers].join(', ') || '（无）') +
        '\n静态提升的节点数: ' + context.hoists.length
    )
    if (typeof window !== 'undefined') {
      // 挂到 window 上，方便在控制台手动把玩中间产物
      window.__lastCompile = { template, ast, context, code }
    }
  }

  // ---- ⑤ 代码字符串 → 函数 ----
  // ★ 为什么用 new Function 而不是 eval？
  //   new Function 创建的函数在**全局作用域**里执行，拿不到我们当前闭包里的变量。
  //   这既是安全隔离（编译产物不会意外读到内部变量），也让依赖关系变得显式：
  //   产物只能用参数传进去的东西（Vue / __exports）。
  //   这正是产物里那行 `const _Vue = Vue` 存在的原因，也是"helper 必须来自契约清单"的原因。
  const exports = {}
  try {
    const factory = new Function('Vue', '__exports', code)
    factory(RUNTIME_HELPERS, exports)
  } catch (e) {
    console.error('[vue-mini] 编译产物执行失败。产物内容：\n' + code, e)
    throw e
  }

  if (typeof exports.render !== 'function') {
    throw new Error('[vue-mini] 编译失败：没有生成 render 函数')
  }

  // 把中间产物挂在函数上，方便测试和调试
  exports.render.__code = code
  exports.render.__ast = ast
  exports.render.__helpers = [...context.helpers]
  exports.render.__hoists = context.hoists.length
  return exports.render
}

/**
 * 只跑到代码生成为止，把每一步的产物都返回 —— 专门给「编译流水线可视化」demo 用。
 *
 * 学习建议：打开 examples/compile-pipeline.html，输入一段模板，
 * 然后按 tokens → ast → code 的顺序逐个对照着看。
 */
export function compileWithSteps(template) {
  const tokens = tokenize(template)
  const ast = parse(template)
  const context = transform(ast)
  const { code, helpers, hoisted } = generate(ast, context, {
    mode: 'module',
    runtimeGlobalName: 'Vue',
  })
  const annotatedCode = generateWithAnnotations(ast, context)

  return { template, tokens, ast, context, code, annotatedCode, helpers, hoisted }
}

/** 单独导出各阶段，方便教学时逐个演示、也方便写单元测试 */
export { tokenize } from './tokenize.js'
export { parse } from './parse.js'
export { transform, parseForExpression } from './transform.js'
export { generate, generateWithAnnotations } from './codegen.js'
export { prefixIdentifiers, isStaticExpression } from './expression.js'
export { printJS } from './js-ast.js'
export { NodeTypes, ElementTypes } from './ast.js'
