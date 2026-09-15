/**
 * 编译器测试：tokenize → parse → transform → generate，以及最终 compile() 的产物可执行性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tokenize } from '../src/compiler-core/tokenize.js'
import { parse } from '../src/compiler-core/parse.js'
import { transform } from '../src/compiler-core/transform.js'
import { generate } from '../src/compiler-core/codegen.js'
import { compile, compileWithSteps } from '../src/compiler-core/index.js'
import { prefixIdentifiers } from '../src/compiler-core/expression.js'
import { NodeTypes } from '../src/compiler-core/ast.js'
import { RUNTIME_HELPERS } from '../src/runtime-core/runtimeHelpers.js'
import { PatchFlags } from '../src/shared/patchFlags.js'

// =====================================================================
// 词法分析
// =====================================================================

test('tokenize：基本标签结构', () => {
  const tokens = tokenize('<div id="a">hello</div>')
  assert.deepEqual(
    tokens.map(t => t.type),
    ['OPEN_TAG', 'TEXT', 'CLOSE_TAG']
  )
  const open = tokens[0]
  assert.equal(open.name, 'div')
  assert.equal(open.attrs[0].name, 'id')
  assert.equal(open.attrs[0].value, 'a')
  assert.equal(tokens[1].value, 'hello')
})

test('tokenize：插值被识别为独立 token', () => {
  const tokens = tokenize('hello {{ msg }}!')
  assert.deepEqual(
    tokens.map(t => t.type),
    ['TEXT', 'INTERPOLATION', 'TEXT']
  )
  assert.equal(tokens[1].value, ' msg ')
})

test('tokenize：文本里的 < 不是标签（比较运算符）', () => {
  const tokens = tokenize('<span>a < b</span>')
  const texts = tokens.filter(t => t.type === 'TEXT')
  assert.equal(texts.length, 1)
  assert.equal(texts[0].value, 'a < b')
})

test('tokenize：无值属性与自闭合', () => {
  const tokens = tokenize('<input disabled/><br>')
  assert.equal(tokens[0].selfClosing, true)
  assert.equal(tokens[0].attrs[0].name, 'disabled')
  assert.equal(tokens[0].attrs[0].hasValue, false)
  assert.equal(tokens[1].name, 'br')
})

test('tokenize：注释', () => {
  const tokens = tokenize('<!-- 说明文字 -->')
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].type, 'COMMENT')
  assert.equal(tokens[0].value, '说明文字')
})

test('tokenize：带修饰符的指令属性', () => {
  const tokens = tokenize('<div v-on:click.stop="fn" :class="cls"></div>')
  const names = tokens[0].attrs.map(a => a.name)
  assert.deepEqual(names, ['v-on:click.stop', ':class'])
})

// =====================================================================
// 语法分析
// =====================================================================

test('parse：还原嵌套结构', () => {
  const ast = parse('<div><p>你好</p><span>x</span></div>')
  assert.equal(ast.type, NodeTypes.ROOT)
  assert.equal(ast.children.length, 1)
  const div = ast.children[0]
  assert.equal(div.type, NodeTypes.ELEMENT)
  assert.equal(div.children.length, 2)
  assert.equal(div.children[0].tag, 'p')
  assert.equal(div.children[0].children[0].content, '你好')
})

test('parse：属性分为静态 ATTRIBUTE 与指令 DIRECTIVE', () => {
  const ast = parse('<div id="a" :idx="n" @click="fn" v-if="ok"></div>')
  const props = ast.children[0].props
  assert.equal(props[0].type, NodeTypes.ATTRIBUTE)
  assert.equal(props[0].name, 'id')
  assert.equal(props[1].type, NodeTypes.DIRECTIVE)
  assert.equal(props[1].name, 'bind')
  assert.equal(props[1].arg.content, 'idx')
  assert.equal(props[2].name, 'on')
  assert.equal(props[2].arg.content, 'click')
  assert.equal(props[3].name, 'if')
})

test('parse：标签类型标记（元素 vs 组件 vs slot）', () => {
  const ast = parse('<div/><MyComp/><slot/>')
  assert.equal(ast.children[0].tagType, 0) // ELEMENT
  assert.equal(ast.children[1].tagType, 1) // COMPONENT
  assert.equal(ast.children[2].tagType, 2) // SLOT
})

// =====================================================================
// 标识符前缀
// =====================================================================

test('prefixIdentifiers：普通标识符加 _ctx. 前缀', () => {
  assert.equal(prefixIdentifiers('msg'), '_ctx.msg')
  assert.equal(prefixIdentifiers('a + b'), '_ctx.a + _ctx.b')
})

test('prefixIdentifiers：成员访问、对象键、字符串内容不加前缀', () => {
  assert.equal(prefixIdentifiers('a.b'), '_ctx.a.b')
  assert.equal(prefixIdentifiers("{ x: 1, y: a }"), '{ x: 1, y: _ctx.a }')
  assert.equal(prefixIdentifiers("a + 'msg'"), "_ctx.a + 'msg'")
  assert.equal(prefixIdentifiers('Math.max(1, 2)'), 'Math.max(1, 2)')
})

test('prefixIdentifiers：箭头函数参数是局部变量', () => {
  assert.equal(prefixIdentifiers('() => count++'), '() => _ctx.count++')
  assert.equal(prefixIdentifiers('item => item.name'), 'item => item.name')
  assert.equal(prefixIdentifiers('(a, b) => a + b + c'), '(a, b) => a + b + _ctx.c')
})

test('prefixIdentifiers：幂等（同一作用域下重复处理结果不变）', () => {
  const scope = new Set(['item'])
  const once = prefixIdentifiers('msg + item.name', scope)
  assert.equal(once, '_ctx.msg + item.name')
  assert.equal(prefixIdentifiers(once, scope), once, '重复处理不会出现 _ctx._ctx')
  // 内部名（_ 开头）永远不会被加前缀 —— 这是幂等的关键
  assert.equal(prefixIdentifiers('_ctx.msg'), '_ctx.msg')
})

// =====================================================================
// 代码生成
// =====================================================================

test('generate：静态子树被提升，并带 HOISTED 标记', () => {
  const ast = parse('<div><p class="title">静态标题</p></div>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /const _hoisted_1 = _createElementVNode\("p", \{ class: "title" \}, "静态标题", -1\)/)
})

test('generate：动态文本打 TEXT 标记（靶向更新）', () => {
  const ast = parse('<p class="static">{{ msg }}</p>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  // patchFlag = 1 (TEXT)，且没有 dynamicProps 数组
  assert.match(code, /_createElementBlock\("p", \{ class: "static" \}, _toDisplayString\(_ctx\.msg\), 1\)/)
})

test('generate：连续文本+插值合并成一个表达式，同样打 TEXT 标记', () => {
  const ast = parse('<li>{{ a }} - {{ b }}</li>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /_toDisplayString\(_ctx\.a\) \+ " - " \+ _toDisplayString\(_ctx\.b\), 1\)/)
})

test('generate：动态属性产生 PROPS 标记与 dynamicProps 清单', () => {
  const ast = parse('<div :id="x">t</div>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  // PROPS = 8
  assert.match(code, /, 8, \["id"\]\)/)
})

test('generate：动态 class/style 归一化并打 CLASS|STYLE 标记', () => {
  const ast = parse('<div :class="cls" :style="sty">x</div>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /class: _normalizeClass\(_ctx\.cls\)/)
  assert.match(code, /style: _normalizeStyle\(_ctx\.sty\)/)
  // CLASS(2) | STYLE(4) = 6
  assert.match(code, /,\s*6\s*\)/)
})

test('generate：v-for 生成 renderList + Fragment + KEYED 标记', () => {
  const ast = parse('<ul><li v-for="(item, i) in list" :key="item.id">{{ item.name }}</li></ul>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /_renderList\(\s*_ctx\.list,\s*\(item, i\) =>/)
  assert.match(code, /_createElementBlock\(\s*_Fragment,\s*null,\s*_renderList/, 'v-for 产生 Fragment')
  // KEYED_FRAGMENT = 128
  assert.match(code, /,\s*128\s*\)/)
})

test('generate：v-for 没有 key 时用 UNKEYED_FRAGMENT', () => {
  const ast = parse('<li v-for="i in list">x</li>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  // UNKEYED_FRAGMENT = 256
  assert.match(code, /,\s*256\s*\)/)
})

test('generate：v-if / v-else-if / v-else 编译为嵌套三元，分支各自开块', () => {
  const ast = parse('<div><span v-if="a">1</span><b v-else-if="b">2</b><i v-else>3</i></div>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /_ctx\.a\s*\?/)
  assert.match(code, /_ctx\.b\s*\?/)
  // 分支是块（_openBlock + _createElementBlock），并且不能被静态提升
  assert.match(code, /_openBlock\(\), _createElementBlock\("span"/)
  assert.match(code, /_openBlock\(\), _createElementBlock\("i"/)
  assert.doesNotMatch(code, /_hoisted/, '分支元素禁止提升，否则切换分支会失效')
})

test('generate：v-model 展开成 value + onInput', () => {
  const ast = parse('<input v-model="msg">')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /value: _ctx\.msg/)
  assert.match(code, /onInput: \$event => \(_ctx\.msg = \$event\.target\.value\)/)
})

test('generate：v-model 在组件上用 modelValue + update:modelValue', () => {
  const ast = parse('<MyComp v-model="t"/>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /modelValue: _ctx\.t/)
  // ★ 带冒号的键必须加引号，否则是语法错误
  assert.match(code, /"onUpdate:modelValue": \$event => \(_ctx\.t = \$event\)/)
})

test('generate：v-model:foo 自定义参数名', () => {
  const ast = parse('<MyComp v-model:title="t"/>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /title: _ctx\.t/)
  assert.match(code, /"onUpdate:title"/)
})

test('generate：@click 事件与 .stop 修饰符', () => {
  const ast = parse('<button @click="fn">x</button>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /onClick: _ctx\.fn/)

  const ast2 = parse('<button @click.stop="fn">x</button>')
  const ctx2 = transform(ast2)
  const code2 = generate(ast2, ctx2).code
  assert.match(code2, /_withModifiers\(_ctx\.fn, \["stop"\]\)/)
})

test('generate：组件用 resolveComponent 解析', () => {
  const ast = parse('<MyComp :msg="m"/>')
  const context = transform(ast)
  const { code } = generate(ast, context)
  assert.match(code, /_resolveComponent\("MyComp"\)/)
})

test('generate：多根模板包 Fragment', () => {
  const steps = compileWithSteps('<div/><span/>')
  assert.match(steps.code, /_createElementBlock\(\s*_Fragment/)
})

// =====================================================================
// compile：端到端（产物真的能跑）
// =====================================================================

/** 执行编译产物，返回 render 函数 */
function runCompiled(template, ctx = {}) {
  const render = compile(template)
  return render(ctx, [])
}

test('compile：静态模板返回 vnode', () => {
  const vnode = runCompiled('<div class="a">hello</div>')
  assert.equal(vnode.type, 'div')
  assert.equal(vnode.props.class, 'a')
  assert.equal(vnode.children, 'hello')
})

test('compile：插值求值 + _ctx 注入', () => {
  const vnode = runCompiled('<span>{{ msg }} - {{ 1 + 1 }}</span>', { msg: 'hi' })
  assert.equal(vnode.children, 'hi - 2')
})

test('compile：块 vnode 收集了动态子节点（block tree）', () => {
  const vnode = runCompiled('<div><p class="t">静态</p><span>{{ msg }}</span></div>', { msg: 'x' })
  // 根是块：dynamicChildren 只包含动态的 span，静态的 p 不在里面
  assert.ok(Array.isArray(vnode.dynamicChildren), '根 vnode 是块')
  assert.equal(vnode.dynamicChildren.length, 1)
  assert.equal(vnode.dynamicChildren[0].type, 'span')
  assert.equal(vnode.children.length, 2, 'children 仍然完整')
})

test('compile：静态提升的 vnode 是共享常量，挂载时按位置拷贝', () => {
  const render = compile('<div><p class="t">静态</p><span>{{ msg }}</span></div>')
  const v1 = render({ msg: 'a' }, [])
  const v2 = render({ msg: 'b' }, [])
  // render 只是"描述"界面：两次描述里的静态 p 是同一个对象 —— 这正是提升的意义（复用描述）
  assert.equal(v1.children[0], v2.children[0], '提升节点跨渲染共享')
  // 真正的"拷贝"发生在挂载时（normalizeVNode → cloneIfMounted），在渲染器测试里验证
})

test('compile：v-for 产出 Fragment + renderList 结果', () => {
  const vnode = runCompiled(
    '<ul><li v-for="(item, i) in list" :key="item.id">{{ i }}:{{ item.name }}</li></ul>',
    { list: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }
  )
  const frag = vnode.children[0]
  assert.equal(frag.children.length, 2)
  assert.equal(frag.children[0].children, '0:a')
  assert.equal(frag.children[1].children, '1:b')
  assert.equal(frag.children[0].key, 1, 'key 来自 :key 绑定')
})

test('compile：v-if 分支切换产出不同 vnode', () => {
  const render = compile('<div><b v-if="ok">yes</b><i v-else>no</i></div>')
  assert.equal(render({ ok: true }, []).children[0].type, 'b')
  assert.equal(render({ ok: false }, []).children[0].type, 'i')
})

test('compile：v-if 全为假时产出注释占位 vnode', () => {
  const vnode = runCompiled('<div><b v-if="ok">yes</b></div>', { ok: false })
  assert.equal(vnode.children[0].type.toString().startsWith('Symbol'), true)
})

test('compile：事件修饰符产物（withModifiers）真的能拦截事件', () => {
  const render = compile('<button @click.stop="onTap">x</button>')
  const calls = []
  const vnode = render({ onTap: () => calls.push('tap') }, [])
  const handler = vnode.props.onClick
  const stoppable = {
    stopPropagation() {
      this.stopped = true
    },
  }
  handler(stoppable)
  assert.deepEqual(calls, ['tap'])
  assert.equal(stoppable.stopped, true)
})

test('compile：showCode 选项与 __code 调试字段', () => {
  const render = compile('<div>{{ msg }}</div>')
  assert.ok(typeof render.__code === 'string')
  assert.ok(render.__code.includes('toDisplayString'))
  assert.ok(Array.isArray(render.__helpers))
})
