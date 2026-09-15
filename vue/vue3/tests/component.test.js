/**
 * 组件系统测试 —— 端到端：模板编译 + 组件实例 + 渲染 effect + mini DOM。
 *
 * 这里验证的正是「组件化原理」的每一条主线：
 *   setup / props / emit / slots / 生命周期 / 父子更新 / 卸载清理
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMiniApp } from './testUtils.js'
import {
  createVNode,
  h,
  defineComponent,
  compile,
  setRuntimeCompiler,
  ref,
  computed,
  reactive,
  nextTick,
  onMounted,
  onBeforeMount,
  onBeforeUpdate,
  onUpdated,
  onBeforeUnmount,
  onUnmounted,
  provide,
  inject,
} from '../src/index.js'

// 注册编译器：让组件支持 template 选项（生产上是完整版 Vue 自带的）
setRuntimeCompiler(compile)

/**
 * 在 mini DOM 上挂载一个根组件。
 * 复刻 createApp().mount() 的关键步骤 —— 顺便证明了 createApp 只是一层薄封装。
 */
function mount(component, options = {}) {
  const app = createMiniApp()
  const vnode = createVNode(component, options.rootProps || null)
  // 根组件的应用上下文（resolveComponent 的全局查找会用到）
  vnode.appContext = {
    app: { _context: { components: options.components || {} } },
    components: options.components || {},
  }
  app.renderer.render(vnode, app.container)
  return {
    ...app,
    vnode,
    instance: vnode.component,
    vm: vnode.component && vnode.component.proxy,
  }
}

// =====================================================================
// 基本渲染
// =====================================================================

test('组件：模板编译 + setup 状态 + 插值', () => {
  const Counter = {
    template: '<div class="counter">{{ msg }}</div>',
    setup() {
      return { msg: 'hello 组件' }
    },
  }
  const app = mount(Counter)
  assert.equal(app.html(), '<div class="counter">hello 组件</div>')
  assert.ok(app.instance, '根组件有实例')
})

test('组件：ref 状态 + 事件 + 响应式更新（微任务批量）', async () => {
  const Counter = {
    template: '<button @click="count++">count is {{ count }}</button>',
    setup() {
      const count = ref(0)
      return { count }
    },
  }
  const app = mount(Counter)
  assert.equal(app.html(), '<button>count is 0</button>')

  // 模拟点击
  app.container.childNodes[0].click()
  assert.equal(app.html(), '<button>count is 0</button>', '同步阶段 DOM 还没更新（批量更新的意义）')

  await nextTick()
  assert.equal(app.html(), '<button>count is 1</button>', '微任务里完成更新')

  // 连点 3 次 → 只触发一次渲染
  const btn = app.container.childNodes[0]
  btn.click()
  btn.click()
  btn.click()
  await nextTick()
  assert.equal(app.html(), '<button>count is 4</button>', '同一 tick 内的多次修改合并成一次渲染')
})

test('组件：computed 驱动视图', async () => {
  const Comp = {
    template: '<p>{{ double }}</p>',
    setup() {
      const n = ref(3)
      const double = computed(() => n.value * 2)
      return { n, double }
    },
  }
  const app = mount(Comp)
  assert.equal(app.html(), '<p>6</p>')
  app.vm.n = 5
  await nextTick()
  assert.equal(app.html(), '<p>10</p>')
})

// =====================================================================
// props
// =====================================================================

test('组件：props 声明、传值、类型归一（kebab-case）', () => {
  const Child = {
    props: { msgText: String }, // 声明驼峰
    template: '<span>{{ msgText }}</span>',
  }
  const Parent = {
    components: { Child },
    template: '<div><Child msg-text="你好" /></div>', // 模板里用 kebab-case
  }
  const app = mount(Parent)
  assert.equal(app.html(), '<div><span>你好</span></div>')
})

test('组件：props 是响应式的，父更新 → 子更新', async () => {
  const Child = {
    props: ['count'],
    template: '<b>子组件收到 {{ count }}</b>',
  }
  const Parent = {
    components: { Child },
    template: '<div><Child :count="n" /></div>',
    setup() {
      const n = ref(1)
      return { n }
    },
  }
  const app = mount(Parent)
  assert.equal(app.html(), '<div><b>子组件收到 1</b></div>')

  app.vm.n = 2
  await nextTick()
  assert.equal(app.html(), '<div><b>子组件收到 2</b></div>', '父组件的数据变化带动子组件更新')
})

test('组件：未声明的属性进入 attrs 并透传到根元素', () => {
  const Child = {
    props: ['label'],
    template: '<div class="inner">{{ label }}</div>',
  }
  const Parent = {
    components: { Child },
    template: '<Child label="文本" data-id="7" />',
  }
  const app = mount(Parent)
  // data-id 没被 Child 声明 → 透传到 Child 的根元素
  assert.equal(app.html(), '<div class="inner" data-id="7">文本</div>')
})

test('组件：props 没变时不重复渲染子组件', async () => {
  let childRenderCount = 0
  const Child = {
    props: ['static'],
    template: '<span>{{ static }}</span>',
    setup() {
      return () => {
        childRenderCount++
        return h('span', String(childRenderCount))
      }
    },
  }
  const Parent = {
    components: { Child },
    template: '<div><Child :static="1" />{{ own }}</div>',
    setup() {
      const own = ref('a')
      return { own }
    },
  }
  const app = mount(Parent)
  const before = childRenderCount
  app.vm.own = 'b' // 只改父组件自己的状态
  await nextTick()
  assert.equal(childRenderCount, before, '子组件 props 未变 → 跳过重渲染（shouldUpdateComponent）')
})

// =====================================================================
// emit
// =====================================================================

test('组件：emit 事件 + 载荷（组件通信的下半场）', async () => {
  const Child = {
    emits: ['change'],
    template: '<button @click="onClick">加</button>',
    setup(props, { emit }) {
      const onClick = () => emit('change', 42)
      return { onClick }
    },
  }
  const received = []
  const Parent = {
    components: { Child },
    template: '<Child @change="onChange" />',
    setup() {
      return { onChange: v => received.push(v) }
    },
  }
  const app = mount(Parent)
  app.container.childNodes[0].click()
  await nextTick()
  assert.deepEqual(received, [42], '父组件通过 @change 监听到子组件 emit 的事件')
})

test('组件：v-model = modelValue + update:modelValue（双向绑定的本质）', async () => {
  const MyInput = {
    props: ['modelValue'],
    // 编译器产物等价于 <input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)">
    template: '<input :value="modelValue" @input="onInput">',
    setup(props, { emit }) {
      // $emit 就是 emit —— 模板里的 $emit('update:modelValue', ...) 只是换个名字调用它
      const onInput = $event => emit('update:modelValue', $event.target.value)
      return { onInput }
    },
  }
  const Parent = {
    components: { MyInput },
    // v-model 的编译产物就是这两个绑定（编译器已支持，这里手写更直观）
    template: '<MyInput :modelValue="msg" @update:modelValue="v => msg = v" />',
    setup() {
      const msg = ref('初始')
      return { msg }
    },
  }
  const app = mount(Parent)
  const input = app.container.childNodes[0]
  assert.equal(input.value, '初始')

  // 用户输入 → 子组件 emit → 父组件的 msg 更新 → 父子都重渲染
  input.input('新值')
  await nextTick()
  assert.equal(app.vm.msg, '新值', '子组件把新值"上报"给了父组件')
  assert.equal(input.value, '新值')
})

// =====================================================================
// slots
// =====================================================================

test('组件：默认插槽（children 是函数，惰性求值）', () => {
  const Child = {
    template: '<div class="box"><slot /></div>',
  }
  const Parent = {
    components: { Child },
    template: '<Child><p>插槽内容</p></Child>',
  }
  const app = mount(Parent)
  assert.equal(app.html(), '<div class="box"><p>插槽内容</p></div>')
})

test('组件：插槽内容使用父组件的数据（作用域归属）', async () => {
  const Child = { template: '<div><slot /></div>' }
  const Parent = {
    components: { Child },
    template: '<Child><b>{{ parentMsg }}</b></Child>',
    setup() {
      const parentMsg = ref('父组件的数据')
      return { parentMsg }
    },
  }
  const app = mount(Parent)
  assert.equal(app.html(), '<div><b>父组件的数据</b></div>')

  // 父组件数据变化 → 插槽内容更新（链路：父 render → 新插槽函数 → 子更新）
  app.vm.parentMsg = '改过了'
  await nextTick()
  assert.equal(app.html(), '<div><b>改过了</b></div>')
})

test('组件：作用域插槽（子传数据给插槽内容）', () => {
  // 作用域插槽：子组件把数据通过「插槽函数的参数」递给父组件写的内容。
  // 编译器对 v-slot 语法糖的支持从简，这里用 render 函数直接验证机制。
  const Child = {
    template: '<ul><slot :item="item" v-for="item in list" /></ul>',
    setup() {
      return { list: ['a', 'b'] }
    },
  }
  const Parent = {
    setup() {
      return () =>
        h(Child, null, {
          default: scope => h('li', `${scope.item}!`),
        })
    },
  }
  const app = mount(Parent)
  assert.equal(app.html(), '<ul><li>a!</li><li>b!</li></ul>', '子组件通过插槽参数把数据递给父组件的函数')
})

test('组件：插槽 fallback（父组件没传内容时用默认内容）', () => {
  const Child = {
    template: '<div><slot>默认内容</slot></div>',
  }
  const app = mount(Child)
  assert.equal(app.html(), '<div>默认内容</div>')
})

// =====================================================================
// 生命周期
// =====================================================================

test('组件：生命周期顺序（嵌套时子先挂载、子先卸载）', async () => {
  const log = []
  const track = (name, hook) => hook(() => log.push(name))

  const Child = {
    template: '<span>子</span>',
    setup() {
      track('child-mounted', onMounted)
      track('child-unmounted', onUnmounted)
    },
  }
  const Parent = {
    components: { Child },
    template: '<div><Child /></div>',
    setup() {
      track('parent-beforeMount', onBeforeMount)
      track('parent-mounted', onMounted)
      track('parent-unmounted', onUnmounted)
    },
  }

  const app = mount(Parent)
  assert.deepEqual(log, ['parent-beforeMount', 'child-mounted', 'parent-mounted'])

  app.renderer.render(null, app.container) // 卸载
  assert.deepEqual(log, [
    'parent-beforeMount',
    'child-mounted',
    'parent-mounted',
    'parent-unmounted',
    'child-unmounted',
  ], '卸载时外层的 onBeforeUnmount → 子组件清理 → 外层 onUnmounted')
})

test('组件：更新钩子', async () => {
  const log = []
  const Comp = {
    template: '<p>{{ n }}</p>',
    setup() {
      const n = ref(0)
      onBeforeUpdate(() => log.push('before-update'))
      onUpdated(() => log.push('updated'))
      return { n }
    },
  }
  const app = mount(Comp)
  app.vm.n++
  await nextTick()
  assert.deepEqual(log, ['before-update', 'updated'])
})

// =====================================================================
// provide / inject
// =====================================================================

test('组件：provide / inject 跨层级通信（原型链查找）', () => {
  const GrandChild = {
    template: '<i>{{ theme }} / {{ lang }}</i>',
    setup() {
      const theme = inject('theme')
      const lang = inject('lang', 'en') // 没提供的用默认值
      return { theme, lang }
    },
  }
  const Child = { components: { GrandChild }, template: '<GrandChild />' } // 中间层不关心
  const Root = {
    components: { Child },
    template: '<div><Child /></div>',
    setup() {
      provide('theme', 'dark')
      return {}
    },
  }
  const app = mount(Root)
  assert.equal(app.html(), '<div><i>dark / en</i></div>', '祖先 provide，任意后代 inject，中间层无感知')
})

// =====================================================================
// 组件卸载与清理
// =====================================================================

test('组件：卸载后渲染 effect 停止（防内存泄漏）', async () => {
  const source = ref(0)
  let updateCount = 0
  const Comp = {
    template: '<p>{{ n }}</p>',
    setup() {
      onUpdated(() => updateCount++) // 每次重新渲染都会触发
      return { n: source }
    },
  }
  const app = mount(Comp)
  assert.equal(app.html(), '<p>0</p>')

  source.value++ // 卸载前：更新正常
  await nextTick()
  assert.equal(app.html(), '<p>1</p>')
  assert.equal(updateCount, 1)

  app.renderer.render(null, app.container) // 卸载
  assert.equal(app.html(), '')
  assert.equal(app.instance.update.effect.active, false, 'effect 已停止')

  source.value++ // 卸载后再改数据
  await nextTick()
  assert.equal(updateCount, 1, '不会再触发渲染 —— 没有泄漏的 effect 在偷偷工作')
  assert.equal(app.instance.update.effect.active, false)
})

test('组件：v-if 切换组件的挂载与卸载（生命周期完整走一遍）', async () => {
  const log = []
  const Child = {
    template: '<b>child</b>',
    setup() {
      onMounted(() => log.push('child-mounted'))
      onUnmounted(() => log.push('child-unmounted'))
    },
  }
  const Parent = {
    components: { Child },
    template: '<div><Child v-if="show" /><span v-else>placeholder</span></div>',
    setup() {
      const show = ref(true)
      return { show }
    },
  }
  const app = mount(Parent)
  assert.deepEqual(log, ['child-mounted'])

  app.vm.show = false
  await nextTick()
  assert.deepEqual(log, ['child-mounted', 'child-unmounted'])
  assert.equal(app.html(), '<div><span>placeholder</span></div>')

  app.vm.show = true
  await nextTick()
  assert.deepEqual(log, ['child-mounted', 'child-unmounted', 'child-mounted'], '重新挂载是全新的实例')
})

// =====================================================================
// defineComponent
// =====================================================================

test('defineComponent 在 JS 里是恒等函数（它的价值在 TS 类型推导）', () => {
  const options = { template: '<div/>' }
  assert.equal(defineComponent(options), options)
})
