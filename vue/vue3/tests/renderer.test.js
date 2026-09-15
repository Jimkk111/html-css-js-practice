/**
 * 渲染器测试：mount / patch / diff —— 全部跑在 mini-dom 上，验证「虚拟 DOM → 真实 DOM」的每条路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMiniApp } from './testUtils.js'
import { h, Fragment, nextTick } from '../src/index.js'
import { reactive, ref } from '../src/reactivity/index.js'

/** 快捷构造 vnode 数组 */
const kids = (...v) => v

test('首次渲染：元素 + 文本 + 属性', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', { id: 'app', class: 'box' }, 'hello'), app.container)
  assert.equal(app.html(), '<div id="app" class="box">hello</div>')
})

test('首次渲染：子元素数组', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('ul', null, kids(h('li', null, 'a'), h('li', null, 'b'))),
    app.container
  )
  assert.equal(app.html(), '<ul><li>a</li><li>b</li></ul>')
})

test('更新：文本变化只改文本节点（DOM 被复用）', () => {
  const app = createMiniApp()
  const v1 = h('div', null, '旧文本')
  app.renderer.render(v1, app.container)
  const el1 = app.container.childNodes[0]
  const textNode1 = el1.childNodes[0]

  const v2 = h('div', null, '新文本')
  app.renderer.render(v2, app.container)
  const el2 = app.container.childNodes[0]

  assert.equal(el2, el1, '元素 DOM 被复用，没有重建')
  assert.equal(el2.childNodes[0], textNode1, '文本节点也被复用（只改了 nodeValue）')
  assert.equal(app.html(), '<div>新文本</div>')
})

test('更新：props 的增删改', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', { id: 'a', class: 'x', title: 't' }, ''), app.container)
  // 改 class、删 title、加 data-x
  app.renderer.render(h('div', { id: 'a', class: 'y', 'data-x': '1' }, ''), app.container)
  const el = app.container.childNodes[0]
  assert.equal(el.className, 'y')
  assert.equal(el.hasAttribute('title'), false, '被删掉的属性应该移除')
  assert.equal(el.getAttribute('data-x'), '1')
})

test('更新：类型不同 → 卸载重建', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', null, 'v1'), app.container)
  const el1 = app.container.childNodes[0]
  app.renderer.render(h('span', null, 'v2'), app.container)
  const el2 = app.container.childNodes[0]
  assert.notEqual(el1, el2, 'div → span 无法复用，必须重建')
  assert.equal(app.html(), '<span>v2</span>')
})

test('事件：重复渲染不会叠加监听器（invoker 机制）', () => {
  const app = createMiniApp()
  let count = 0
  const mk = () => h('button', { onClick: () => count++ }, 'btn')

  app.renderer.render(mk(), app.container)
  const btn = app.container.childNodes[0]
  assert.equal(btn.listenerCount, 1, '初始只有 1 个监听器')

  // 重渲染 3 次：每次都是新的处理函数
  app.renderer.render(mk(), app.container)
  app.renderer.render(mk(), app.container)
  app.renderer.render(mk(), app.container)
  assert.equal(btn.listenerCount, 1, '依然是 1 个监听器（复用 invoker，只换了 value）')

  btn.click()
  assert.equal(count, 1, '点一次只触发一次 —— 这是 patchEvent 最核心的保证')
})

test('事件：处理器更新后执行的是新函数', () => {
  const app = createMiniApp()
  const log = []
  app.renderer.render(h('button', { onClick: () => log.push('旧') }, 'b'), app.container)
  const btn = app.container.childNodes[0]
  btn.click()
  app.renderer.render(h('button', { onClick: () => log.push('新') }, 'b'), app.container)
  btn.click()
  assert.deepEqual(log, ['旧', '新'])
})

test('事件：置空后监听器被移除', () => {
  const app = createMiniApp()
  app.renderer.render(h('button', { onClick: () => {} }, 'b'), app.container)
  const btn = app.container.childNodes[0]
  app.renderer.render(h('button', null, 'b'), app.container)
  assert.equal(btn.listenerCount, 0)
})

test('class 归一化：数组与对象写法', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', { class: ['a', { b: true, c: false }] }, ''), app.container)
  assert.equal(app.container.childNodes[0].className, 'a b')
})

test('style 对象更新：修改与删除', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('div', { style: { color: 'red', fontSize: '12px' } }, ''),
    app.container
  )
  const el = app.container.childNodes[0]
  assert.equal(el.style._props.color, 'red')

  // 更新：fontSize 删除、color 修改
  app.renderer.render(h('div', { style: { color: 'blue' } }, ''), app.container)
  assert.equal(el.style._props.color, 'blue')
  assert.equal(el.style._props.fontSize, undefined, '新 style 里没有的旧样式要被清掉')
})

// =====================================================================
// keyed diff —— 列表渲染的核心
// =====================================================================

/** 用 uid 追踪 DOM 复用情况 */
function uidOf(el) {
  return el.uid
}

test('keyed diff：尾部追加', () => {
  const app = createMiniApp()
  app.renderer.render(h('ul', null, kids(h('li', { key: 1 }, '1'))), app.container)
  const first = app.container.childNodes[0].childNodes[0]
  app.renderer.render(
    h('ul', null, kids(h('li', { key: 1 }, '1'), h('li', { key: 2 }, '2'))),
    app.container
  )
  const ul = app.container.childNodes[0]
  assert.equal(ul.childNodes[0], first, '原有的 li 被复用')
  assert.equal(app.html(), '<ul><li>1</li><li>2</li></ul>')
})

test('keyed diff：头部插入', () => {
  const app = createMiniApp()
  app.renderer.render(h('ul', null, kids(h('li', { key: 1 }, '1'))), app.container)
  const oldLi = app.container.childNodes[0].childNodes[0]
  app.renderer.render(
    h('ul', null, kids(h('li', { key: 0 }, '0'), h('li', { key: 1 }, '1'))),
    app.container
  )
  const ul = app.container.childNodes[0]
  assert.equal(ul.childNodes[0].textContent, '0')
  assert.equal(ul.childNodes[1], oldLi, 'key=1 的 li 还是原来的 DOM（没有重建）')
})

test('keyed diff：中间删除', () => {
  const app = createMiniApp()
  const lis = [1, 2, 3, 4].map(i => h('li', { key: i }, String(i)))
  app.renderer.render(h('ul', null, lis), app.container)
  const ulBefore = app.container.childNodes[0]
  const li3 = ulBefore.childNodes[2] // key=3 的 DOM
  const li4 = ulBefore.childNodes[3] // key=4 的 DOM

  const lis2 = [1, 3, 4].map(i => h('li', { key: i }, String(i)))
  app.renderer.render(h('ul', null, lis2), app.container)
  const ul = app.container.childNodes[0]
  assert.equal(ul.childNodes.length, 3)
  assert.equal(ul.childNodes[1], li3, 'key=3 复用它原来的 DOM，只是位置左移')
  assert.equal(ul.childNodes[2], li4, 'key=4 同样复用')
  assert.equal(app.html(), '<ul><li>1</li><li>3</li><li>4</li></ul>')
})

test('keyed diff：整体反转 —— 全部复用，只移动不重建', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('ul', null, [1, 2, 3, 4].map(i => h('li', { key: i }, String(i)))),
    app.container
  )
  const before = app.container.childNodes[0].childNodes.map(uidOf)

  app.renderer.render(
    h('ul', null, [4, 3, 2, 1].map(i => h('li', { key: i }, String(i)))),
    app.container
  )
  const ul = app.container.childNodes[0]
  const after = ul.childNodes.map(uidOf)

  assert.deepEqual(after, [...before].reverse(), '所有 DOM 都被复用，只是顺序反了')
  assert.equal(app.html(), '<ul><li>4</li><li>3</li><li>2</li><li>1</li></ul>')
})

test('keyed diff：部分乱序移动', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('ul', null, ['a', 'b', 'c', 'd'].map(k => h('li', { key: k }, k))),
    app.container
  )
  const before = app.container.childNodes[0].childNodes.map(uidOf)
  // d b a c：经典的"乱序区"场景
  app.renderer.render(
    h('ul', null, ['d', 'b', 'a', 'c'].map(k => h('li', { key: k }, k))),
    app.container
  )
  const ul = app.container.childNodes[0]
  assert.deepEqual(
    ul.childNodes.map(n => n.textContent),
    ['d', 'b', 'a', 'c'],
    '顺序正确'
  )
  // 所有节点都必须是复用的（uid 集合一致）
  assert.deepEqual(
    [...ul.childNodes.map(uidOf)].sort(),
    [...before].sort(),
    '没有节点被重建'
  )
})

test('keyed diff：头部节点移到尾部', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('ul', null, ['a', 'b', 'c'].map(k => h('li', { key: k }, k))),
    app.container
  )
  const a = app.container.childNodes[0].childNodes[0]
  app.renderer.render(
    h('ul', null, ['b', 'c', 'a'].map(k => h('li', { key: k }, k))),
    app.container
  )
  const ul = app.container.childNodes[0]
  assert.equal(ul.childNodes[2], a, 'a 被移动到了末尾，DOM 还是原来那个')
})

test('keyed diff：内容变化 + 位置移动同时发生', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('ul', null, ['a', 'b', 'c'].map(k => h('li', { key: k }, `${k}-旧`))),
    app.container
  )
  app.renderer.render(
    h('ul', null, ['c', 'a', 'b'].map(k => h('li', { key: k }, `${k}-新`))),
    app.container
  )
  assert.equal(app.html(), '<ul><li>c-新</li><li>a-新</li><li>b-新</li></ul>')
})

test('unkeyed diff：按下标对应，多挂少卸', () => {
  const app = createMiniApp()
  app.renderer.render(h('ul', null, kids(h('li', null, 'a'), h('li', null, 'b'), h('li', null, 'c'))), app.container)
  app.renderer.render(h('ul', null, kids(h('li', null, 'a'), h('li', null, 'c'))), app.container)
  // 无 key 时按下标 patch：b 的 DOM 被 c 的内容更新复用，末尾的 c 被卸载
  assert.equal(app.html(), '<ul><li>a</li><li>c</li></ul>')
})

// =====================================================================
// children 形态互转
// =====================================================================

test('children：数组 → 文本', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', null, kids(h('span', null, 'x'))), app.container)
  app.renderer.render(h('div', null, '纯文本'), app.container)
  assert.equal(app.html(), '<div>纯文本</div>')
})

test('children：文本 → 数组', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', null, '纯文本'), app.container)
  app.renderer.render(h('div', null, kids(h('span', null, 'x'))), app.container)
  assert.equal(app.html(), '<div><span>x</span></div>')
})

test('children：文本 → 空', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', null, 'x'), app.container)
  app.renderer.render(h('div', null, null), app.container)
  assert.equal(app.html(), '<div></div>')
})

// =====================================================================
// Fragment
// =====================================================================

test('Fragment：多根节点渲染与更新', () => {
  const app = createMiniApp()
  app.renderer.render(
    h(Fragment, null, kids(h('p', null, '1'), h('p', null, '2'))),
    app.container
  )
  assert.equal(app.html(), '<p>1</p><p>2</p>')
  app.renderer.render(
    h(Fragment, null, kids(h('p', null, '1'), h('p', null, '3'))),
    app.container
  )
  assert.equal(app.html(), '<p>1</p><p>3</p>')
})

test('Fragment：空片段渲染注释占位', () => {
  const app = createMiniApp()
  app.renderer.render(h(Fragment, null, kids()), app.container)
  assert.equal(app.html(), '<!---->')
})

// =====================================================================
// 卸载
// =====================================================================

test('render(null) 卸载整棵树', () => {
  const app = createMiniApp()
  app.renderer.render(h('div', null, kids(h('span', null, 'x'))), app.container)
  assert.notEqual(app.html(), '')
  app.renderer.render(null, app.container)
  assert.equal(app.html(), '')
  assert.equal(app.container._vnode, null)
})

test('嵌套结构整体卸载（children 不需要逐个 remove）', () => {
  const app = createMiniApp()
  app.renderer.render(
    h('div', { id: 'root' }, kids(h('ul', null, kids(h('li', null, 'x'), h('li', null, 'y'))))),
    app.container
  )
  app.renderer.render(null, app.container)
  assert.equal(app.html(), '')
})

// =====================================================================
// 手写 vnode + 响应式的完整闭环（没有编译器参与）
// =====================================================================

test('响应式数据 + effect + 渲染器 = 手动版 Vue', async () => {
  const app = createMiniApp()
  const state = reactive({ count: 0 })
  let firstEl

  const { effect } = await import('../src/reactivity/effect.js')
  effect(() => {
    // 每次重新执行都生成新 vnode，交给渲染器打补丁
    const next = h('div', null, String(state.count))
    app.renderer.render(next, app.container)
    if (!firstEl) firstEl = app.container.childNodes[0]
  })
  assert.equal(app.html(), '<div>0</div>')

  state.count++
  // effect 是同步的，所以这里立刻就能看到
  assert.equal(app.html(), '<div>1</div>')
  assert.equal(app.container.childNodes[0], firstEl, 'DOM 元素被复用，只有文本内容变了')

  state.count = 100
  assert.equal(app.html(), '<div>100</div>')
})
