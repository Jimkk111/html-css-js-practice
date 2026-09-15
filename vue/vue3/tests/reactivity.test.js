/**
 * 响应式系统测试：effect / reactive / ref / computed / scheduler
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { effect, stop } from '../src/reactivity/effect.js'
import { reactive, shallowReactive, toRaw } from '../src/reactivity/reactive.js'
import { ref, shallowRef, toRefs, toRef, unref, proxyRefs, isRef } from '../src/reactivity/ref.js'
import { computed } from '../src/reactivity/computed.js'
import { nextTick, queueJob } from '../src/reactivity/scheduler.js'
import { ITERATE_KEY } from '../src/reactivity/dep.js'

// =====================================================================
// effect + reactive
// =====================================================================

test('effect 会在依赖变化时重新执行', () => {
  const obj = reactive({ count: 0 })
  let runs = 0
  effect(() => {
    runs++
    obj.count // 读一下，建立依赖
  })
  assert.equal(runs, 1, '首次会立即执行一次')
  obj.count++
  assert.equal(runs, 2, '改 count 后重新执行')
  obj.count = 10
  assert.equal(runs, 3, '再改一次再执行一次')
})

test('effect 只对「真正读过的属性」有反应', () => {
  const obj = reactive({ a: 1, b: 2 })
  let runs = 0
  effect(() => {
    runs++
    obj.a // 只读了 a
  })
  obj.b++ // b 没被读过
  assert.equal(runs, 1, '改未读过的属性不应触发')
  obj.a++
  assert.equal(runs, 2, '改读过的属性才触发')
})

test('嵌套 effect：恢复正确，且只触发内层', () => {
  const obj = reactive({ a: 1, b: 1 })
  const order = []
  effect(() => {
    order.push('outer:' + obj.a)
    effect(() => {
      order.push('inner:' + obj.b)
    })
  })
  assert.deepEqual(order, ['outer:1', 'inner:1'])

  obj.b = 2
  assert.deepEqual(order, ['outer:1', 'inner:1', 'inner:2'], '改 b 只重跑内层')
})

test('stop 之后不再触发，并且支持通过 runner 手动执行', () => {
  const obj = reactive({ n: 0 })
  let runs = 0
  const runner = effect(() => {
    runs++
    obj.n
  })
  assert.equal(runs, 1)

  obj.n++
  assert.equal(runs, 2)

  stop(runner)
  obj.n++
  assert.equal(runs, 2, 'stop 后不再自动执行')

  runner()
  assert.equal(runs, 3, '手动 run 仍然可以（但不再收集依赖）')
})

test('分支切换后旧依赖被清理（不会因已废弃的分支重复触发）', () => {
  const obj = reactive({ ok: true, a: 1, b: 1 })
  let runs = 0
  let value
  effect(() => {
    runs++
    // 三元：只读其中一个分支。注意「读过哪个属性」取决于 obj.ok
    value = obj.ok ? obj.a : obj.b
  })
  assert.equal(runs, 1)
  assert.equal(value, 1)

  obj.ok = false // 切到 b 分支
  const afterSwitch = runs
  assert.equal(afterSwitch, 2, '切分支触发一次')

  obj.a++ // 旧分支读过的 a，现在不该再触发（cleanupEffect 清掉了旧依赖）
  assert.equal(runs, afterSwitch, 'a 的旧依赖已被清理')
  obj.b++
  assert.equal(runs, afterSwitch + 1, 'b 是新依赖，会触发')
})

// =====================================================================
// reactive 的细节
// =====================================================================

test('新增和删除属性都能触发（Proxy 相对 defineProperty 的核心优势）', () => {
  const obj = reactive({ a: 1 })
  let runs = 0
  effect(() => {
    runs++
    // 用 in 运算符检测属性存在与否 → 走 has 拦截
    return 'b' in obj
  })
  assert.equal(runs, 1)
  obj.b = 2 // 新增属性
  assert.equal(runs, 2, 'Object.defineProperty 无法监听新增属性，Proxy 可以')
  delete obj.b
  assert.equal(runs, 3, '删除属性也能触发')
})

test('for...in 遍历：新增/删除属性会触发，修改已有属性的值不会', () => {
  const obj = reactive({ a: 1, b: 2 })
  let runs = 0
  effect(() => {
    runs++
    // eslint-disable-next-line no-unused-vars
    for (const key in obj) {
      /* 遍历本身建立 ITERATE_KEY 依赖 */
    }
  })
  assert.equal(runs, 1)

  obj.a = 100 // 只改值，键集合没变 → 不该触发 for...in
  assert.equal(runs, 1, '仅修改值不改变键集合')

  obj.c = 3 // 新增键
  assert.equal(runs, 2, '新增键改变键集合 → 触发')
  delete obj.a
  assert.equal(runs, 3, '删除键 → 触发')
})

test('数组：改下标、调用 push、读 length 的联动', () => {
  const arr = reactive([1, 2, 3])
  let runs = 0
  effect(() => {
    runs++
    return arr[0] + arr.length
  })
  assert.equal(runs, 1)

  arr[0] = 10
  assert.equal(runs, 2, '改下标触发')

  arr.push(4) // 变了 length
  assert.equal(runs, 3, 'push 会改变 length，而 length 被读过')
})

test('数组的 push 不会造成无限递归（instrumentation 的作用）', () => {
  const arr = reactive([])
  let runs = 0
  effect(() => {
    runs++
    arr.push(1) // 读+写 length 都在同一个 effect 里
  })
  assert.equal(runs, 1, 'push 内部暂停收集，避免了自我触发')
  assert.deepEqual([...toRaw(arr)], [1])
})

test('数组的 includes 能正确匹配「原始对象」（instrumentation 的第二个作用）', () => {
  const raw = { id: 1 }
  const arr = reactive([raw])
  // 用代理对象去查原始对象。没有 instrumentation 时会返回 false
  assert.equal(arr.includes(arr[0]), true)
  assert.equal(arr.indexOf(arr[0]) >= 0, true)
})

test('数组 length 变小会触发被删元素的依赖（Vue 2 的老大难问题）', () => {
  const arr = reactive([1, 2, 3])
  let seen = []
  effect(() => {
    seen = [String(arr[2])] // 依赖下标 2
  })
  assert.deepEqual(seen, ['3'])
  arr.length = 1 // 直接截断
  assert.deepEqual(seen, ['undefined'], 'length 变小后下标 2 的依赖被触发')
})

test('同一个对象多次 reactive 返回同一个代理（缓存的意义）', () => {
  const raw = { a: 1 }
  const p1 = reactive(raw)
  const p2 = reactive(raw)
  assert.equal(p1, p2, '必须引用相等，否则依赖会被记成两份')
  assert.equal(p1.a, 1)
  assert.equal(reactive(p1), p1, 'reactive(reactive(x)) 不套娃')
})

test('toRaw 取回原始对象', () => {
  const raw = { a: 1 }
  assert.equal(toRaw(reactive(raw)), raw)
  assert.equal(toRaw(raw), raw, '不是代理就原样返回')
})

test('shallowReactive 只代理第一层', () => {
  const raw = { nested: { n: 0 } }
  const state = shallowReactive(raw)
  let runs = 0
  effect(() => {
    runs++
    state.nested.n
  })
  assert.equal(runs, 1)
  state.nested.n++ // 深层不是响应式的
  assert.equal(runs, 1, 'shallow 不代理深层')
})

test('惰性代理：没读到的深层对象不会被代理（性能）', () => {
  let accessed = false
  const raw = {
    get deep() {
      accessed = true
      return { n: 1 }
    },
  }
  const state = reactive(raw)
  assert.equal(accessed, false, 'reactive 本身不遍历对象，是惰性的')
  void state.deep
  assert.equal(accessed, true, '读到时才取值')
})

// =====================================================================
// ref
// =====================================================================

test('ref 包裹原始值也能建立响应式', () => {
  const count = ref(0)
  let runs = 0
  effect(() => {
    runs++
    count.value
  })
  assert.equal(runs, 1)
  count.value++
  assert.equal(runs, 2)
})

test('ref 的值没变则不触发（Object.is 比较，NaN 也算没变）', () => {
  const n = ref(1)
  let runs = 0
  effect(() => {
    runs++
    n.value
  })
  n.value = 1
  assert.equal(runs, 1, '同值不触发')
  n.value = NaN
  const afterNaN = runs
  n.value = NaN
  assert.equal(runs, afterNaN, 'NaN → NaN 视为没变')
})

test('ref(对象) 会做深层代理', () => {
  const state = ref({ nested: { n: 0 } })
  let runs = 0
  effect(() => {
    runs++
    state.value.nested.n
  })
  assert.equal(runs, 1)
  state.value.nested.n = 5
  assert.equal(runs, 2, 'ref 内部的对象是 reactive 的')
})

test('ref(原始对象) 再次赋同一个对象不会误触发', () => {
  const raw = { n: 1 }
  const r = ref(raw)
  let runs = 0
  effect(() => {
    runs++
    r.value
  })
  r.value = raw // 值是同一对象引用
  assert.equal(runs, 1, '_rawValue 比较避免了"proxy !== raw"的误触发')
})

test('shallowRef 不对内部对象做深层代理', () => {
  const raw = { n: 0 }
  const r = shallowRef(raw)
  let runs = 0
  effect(() => {
    runs++
    r.value.n
  })
  r.value.n = 1
  assert.equal(runs, 1, 'shallowRef 内部不是响应式的')
  r.value = { n: 2 }
  assert.equal(runs, 2, '替换 .value 本身会触发')
})

test('toRef / toRefs 保持与源对象的双向联动', () => {
  const state = reactive({ x: 1, y: 2 })
  const { x, y } = toRefs(state)
  assert.equal(x.value, 1)

  let runs = 0
  effect(() => {
    runs++
    x.value
  })
  state.x = 10 // 改源对象
  assert.equal(x.value, 10, '源对象变化能同步到 ref')
  assert.equal(runs, 2)

  x.value = 20 // 改 ref
  assert.equal(state.x, 20, 'ref 变化能同步回源对象')

  const single = toRef(state, 'y')
  assert.equal(single.value, 2)
  single.value = 99
  assert.equal(state.y, 99)
})

test('proxyRefs 让模板里不用写 .value', () => {
  const count = ref(0)
  const state = proxyRefs({ count, plain: 'hi' })
  assert.equal(state.count, 0, '读时自动解包')
  state.count = 5 // 写时自动写回 ref.value
  assert.equal(count.value, 5, '写回的是 ref 内部')
  assert.equal(state.plain, 'hi', '非 ref 值原样')
})

test('isRef / unref', () => {
  assert.equal(isRef(ref(1)), true)
  assert.equal(isRef(1), false)
  assert.equal(unref(ref(3)), 3)
  assert.equal(unref(3), 3)
})

// =====================================================================
// computed
// =====================================================================

test('computed 会自动更新，并且有缓存', () => {
  const state = reactive({ a: 1, b: 2 })
  let computeCount = 0
  const sum = computed(() => {
    computeCount++
    return state.a + state.b
  })

  assert.equal(computeCount, 0, '惰性：没人读就不算')
  assert.equal(sum.value, 3)
  assert.equal(computeCount, 1)
  assert.equal(sum.value, 3)
  assert.equal(computeCount, 1, '第二次读用缓存，不重算')

  state.a = 10
  assert.equal(computeCount, 1, '依赖变了也不立刻重算（lazy）')
  assert.equal(sum.value, 12)
  assert.equal(computeCount, 2, '被读取时才重算')
})

test('computed 变化会驱动依赖它的 effect', () => {
  const state = reactive({ n: 1 })
  const double = computed(() => state.n * 2)
  let runs = 0
  let last
  effect(() => {
    runs++
    last = double.value
  })
  assert.equal(last, 2)

  state.n = 5
  assert.equal(runs, 2, 'computed 的依赖变化要通知下游 effect')
  assert.equal(last, 10)
})

test('computed 依赖没变时不会触发下游（缓存链）', () => {
  const state = reactive({ n: 2 })
  const isEven = computed(() => state.n % 2 === 0)
  let runs = 0
  effect(() => {
    runs++
    isEven.value
  })
  assert.equal(runs, 1)
  state.n = 4 // 依然是偶数，computed 值没变
  assert.equal(runs, 2, 'computed 被触发重算')
  assert.equal(isEven.value, true)
})

test('可写 computed（get/set）', () => {
  const state = reactive({ first: 'a', last: 'b' })
  const full = computed({
    get: () => state.first + state.last,
    set: v => {
      state.first = v[0]
      state.last = v.slice(1)
    },
  })
  assert.equal(full.value, 'ab')
  full.value = 'xy'
  assert.equal(state.first, 'x')
  assert.equal(state.last, 'y')
  assert.equal(full.value, 'xy')
})

test('computed 链式依赖', () => {
  const state = reactive({ n: 1 })
  const a = computed(() => state.n + 1)
  const b = computed(() => a.value * 10)
  assert.equal(b.value, 20)
  state.n = 2
  assert.equal(b.value, 30)
})

// =====================================================================
// scheduler
// =====================================================================

test('queueJob 在微任务里批量执行，同一 job 只执行一次', async () => {
  const log = []
  const job = () => log.push('job')
  job.id = 1
  queueJob(job)
  queueJob(job)
  queueJob(job)
  assert.deepEqual(log, [], '同步阶段不执行')
  await nextTick()
  assert.deepEqual(log, ['job'], '同一个 job 去重，只执行一次')
})

test('队列按 id 升序执行（父组件先于子组件更新）', async () => {
  const order = []
  const child = () => order.push('child')
  child.id = 2
  const parent = () => order.push('parent')
  parent.id = 1

  queueJob(child)
  queueJob(parent)
  await nextTick()
  assert.deepEqual(order, ['parent', 'child'], 'id 小的先执行')
})

test('nextTick 能等到 DOM 更新之后', async () => {
  const log = []
  const job = () => log.push('render')
  job.id = 1
  queueJob(job)
  log.push('sync')
  await nextTick()
  log.push('after-tick')
  assert.deepEqual(log, ['sync', 'render', 'after-tick'])
})

test('flush 期间新入队的 job 也会被执行', async () => {
  const log = []
  const second = () => log.push('second')
  second.id = 2
  const first = () => {
    log.push('first')
    queueJob(second) // 执行过程中再入队
  }
  first.id = 1
  queueJob(first)
  await nextTick()
  assert.deepEqual(log, ['first', 'second'])
})

test('无限循环会被检测并抛错', async () => {
  const state = reactive({ n: 0 })
  const job = () => {
    job.id = 1
    state.n++ // 每次执行都改数据 → 不断产生新任务
    queueJob(job)
  }
  job.id = 1
  queueJob(job)
  await assert.rejects(() => nextTick(), /无限更新循环/)
})
