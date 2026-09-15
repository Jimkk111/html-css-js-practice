/**
 * 组件系统 —— 这是「组件化原理」的核心文件。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一个核心思想：**组件也是一个 vnode，只不过它的 type 是对象而不是字符串。**
 *
 *     <div>      →  createVNode('div', ...)      → type 是字符串 → processElement
 *     <MyComp>   →  createVNode(MyComp, ...)     → type 是对象   → processComponent
 *
 * 所以渲染器在 patch 里分派时，只看 `type` 是不是对象，就决定走哪条路。
 * 组件的所有复杂度（实例、props、setup、生命周期、插槽）都被"封"在 processComponent 内部，
 * 对元素流程完全透明 —— 这就是为什么 Vue 的渲染器可以同时处理两者而不乱。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 组件从「vnode」到「真实 DOM」要经过几步？记住这条主线：
 *
 *   ① mountComponent      创建组件实例，把 vnode.component 指过去
 *   ② setupComponent      执行 setup()，产出「状态」和 render 函数
 *   ③ setupRenderEffect   把 render 包成一个响应式 effect，执行它得到「组件子树 vnode」
 *   ④ patch(subTree)      渲染器接着去渲染这个子树 —— 于是又回到 renderer.js 的流程
 *   ⑤ vnode.el = subTree.el  把子树的 DOM 冒泡给组件 vnode，让父组件把它当成一个"整体"来摆放
 *
 * ★ 第 ③⑤ 两步是理解组件化的钥匙：
 *   - 组件 vnode 自己不是 DOM，它靠「子树的 vnode」间接产生 DOM；
 *   - 对外界（父组件的 diff）来说，一个组件永远只表现为「一个起始 DOM 节点」，
 *     内部有多少层嵌套完全被隐藏了 —— 这就是「封装」在渲染层面的体现。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么组件需要「实例」（instance）而元素不需要？
 *   元素是无状态的：给同样的 props 永远渲染出同样的 DOM，patch 之间不需要记住任何东西。
 *   组件是有状态的：它持有 setup 里的响应式数据、生命周期钩子、与父组件的连接、插槽……
 *   这些必须有个「容器」跨渲染周期存活 —— 那就是 instance。
 *   instance 是我们自己造的对象，它不出现在 DOM 里，但它是组件的"身份证"。
 */
import { ReactiveEffect } from '../reactivity/effect.js'
import { queueJob, nextTick } from '../reactivity/scheduler.js'
import { proxyRefs } from '../reactivity/ref.js'
import { shallowReactive } from '../reactivity/reactive.js'
import { camelize, hasOwn, isArray, isFunction, isObject, toHandlerKey } from '../shared/utils.js'
import { ShapeFlags } from '../shared/shapeFlags.js'
import { Fragment, createVNode, normalizeVNode, setCurrentRenderingInstance } from './vnode.js'
import { getCurrentInstance, setCurrentInstance } from './instance.js'
import { invokeArrayFns } from './lifecycle.js'

/** 组件实例的自增 id。★ 它的用途只有一个：让调度器能保证「父组件先于子组件更新」 */
let uid = 0

/**
 * 运行时编译器（由 src/index.js 注入）。
 *
 * 为什么用「注入」而不是直接 import compiler？
 *   1. 依赖方向：runtime 不应该依赖 compiler。只含运行时的构建里这个变量永远是 null，
 *      树摇时整个 compiler 都不会被打进产物 —— 这正是 runtime-only 版本体积小的原因。
 *   2. 避免循环依赖：compiler 需要 runtimeHelpers，runtime 需要 compile，直接互相 import 会成环。
 *
 * 没注入编译器时，用 template 的组件会得到一条清晰的报错，而不是莫名崩溃。
 */
let runtimeCompiler = null
export function setRuntimeCompiler(compiler) {
  runtimeCompiler = compiler
}

/**
 * 创建组件实例。
 * 这个对象会存活到组件卸载，是组件「有状态」的载体。
 */
export function createComponentInstance(vnode, parent) {
  const instance = {
    uid: uid++,
    vnode, // 当前的组件 vnode
    type: vnode.type, // 组件对象（用户写的那个 { setup, render }）
    parent, // 父组件实例，用于 provide/inject、$parent、emit 冒泡
    appContext: parent ? parent.appContext : vnode.appContext,

    // ---- 渲染相关 ----
    subTree: null, // ★ 组件渲染出的子树 vnode。组件的 DOM 其实来自它
    effect: null, // 渲染 effect（组件级响应式的核心）
    update: null, // 手动触发重新渲染的函数（= effect.run 的包装）
    next: null, // 待更新的新 vnode（父组件更新时塞进来，见 updateComponentPreRender）
    render: null, // 渲染函数
    proxy: null, // 供模板/渲染函数使用的代理对象（this / _ctx）
    renderCache: [], // 编译产物 _cache 的存储（v-once、事件缓存等）

    // ---- 状态 ----
    setupState: {}, // setup() 返回值（可能是 ref，已用 proxyRefs 包过）
    data: {}, // options API 的 data（本实现主要支持组合式，保留字段以便扩展）
    props: {}, // 由父组件传入并经过校验/归一化的 props
    attrs: {}, // 没被 props 声明的属性（会「透传」到根元素上）
    slots: {}, // 插槽（本质是「返回 vnode 数组的函数」的集合）

    // ---- 生命周期钩子容器（类型 → 回调数组）----
    bm: [], m: [], bu: [], u: [], bum: [], um: [],

    // ---- provide / inject ----
    // ★ 用原型链实现：子组件的 provides = Object.create(父组件的 provides)。
    //   于是 inject 只要沿着原型链找就行 —— 天然支持"就近覆盖"和"只有祖先能提供"。
    provides: parent ? parent.provides : Object.create(null),

    // ---- 本地注册的组件（resolveComponent 会查这里）----
    components: {},

    isMounted: false,
    isUnmounted: false,
    // ★ 标记这个实例是"组件"还是"根 App 容器"。渲染函数里的 v-if / v-for 判别会用到
    isComponent: true,
  }

  instance.ctx = { _: instance } // 备用命名空间（真实 Vue 的 ctx 用于 render 内部的临时变量）
  instance.proxy = new Proxy(instance, publicInstanceProxyHandlers)
  return instance
}

/**
 * 组件实例的代理（就是模板里的 `_ctx`，也是选项式写法里的 `this`）。
 *
 * 为什么要代理？因为模板里写 `{{ msg }}`，编译成 `_ctx.msg`，而 msg 可能来自三个地方：
 *   setup() 的返回值、props、或者父组件传下来的 attrs。
 * 代理的 get 按优先级依次查找，让"写模板的人"不用关心数据到底存在哪 —— 这就是「数据来源透明」。
 *
 * 顺带解释了一个常见报错：模板里用一个既不在 setup、也不在 props、也不是全局的属性时，
 * 会得到 "Property xxx was accessed during render but is not defined on instance"。
 */
const publicInstanceProxyHandlers = {
  get(target, key) {
    if (typeof key === 'symbol') return target[key]

    const { setupState, props, data, ctx } = target

    // 1. setup 返回值（最高优先级，组合式 API 的常规通道）
    if (hasOwn(setupState, key)) return setupState[key]
    // 2. props（父组件传进来的）
    if (hasOwn(props, key)) return props[key]
    // 3. data / ctx（选项式 API 的通道）
    if (hasOwn(data, key)) return data[key]
    if (hasOwn(ctx, key)) return ctx[key]

    // 4. 内置的实例方法：$emit / $slots / $props ...
    if (key[0] === '$' && publicPropertiesMap[key]) {
      return publicPropertiesMap[key](target)
    }

    // 5. 兜底：允许访问实例上的字段（比如 render 函数里读 instance.xxx）
    if (key in target) return target[key]

    console.warn(
      `[vue-mini] 渲染时访问了未定义的属性 "${String(key)}"。` +
        '请检查是否忘了从 setup() 返回它。'
    )
  },
  set(target, key, value) {
    const { setupState, props, data } = target
    if (hasOwn(setupState, key)) {
      setupState[key] = value // setupState 本身是 proxyRefs，赋值会自动写进 ref.value
    } else if (hasOwn(props, key)) {
      console.warn(`[vue-mini] 不要直接修改 prop "${String(key)}"，它是父组件的数据，应通过 emit 通知父组件修改`)
      return false
    } else if (hasOwn(data, key)) {
      data[key] = value
    } else if (key[0] === '$') {
      console.warn(`[vue-mini] 不能修改内置属性 "${String(key)}"`)
      return false
    } else {
      target.ctx[key] = value // 新属性放进 ctx，等价于 this.xxx = value
    }
    return true
  },
  /** 支持 `'msg' in _ctx`（编译产物里 v-if 会用到） */
  has(target, key) {
    const { setupState, props, data, ctx } = target
    return (
      hasOwn(setupState, key) || hasOwn(props, key) || hasOwn(data, key) || hasOwn(ctx, key) || key in target
    )
  },
}

/** 组件实例上以 $ 开头的内置 API */
const publicPropertiesMap = {
  $: i => i, // （内部调试用）
  $el: i => i.vnode.el,
  $data: i => i.data,
  $props: i => i.props,
  $attrs: i => i.attrs,
  $slots: i => i.slots,
  $emit: i => i.emit,
  $nextTick: () => nextTick,
  $forceUpdate: i => () => i.update(),
  $options: i => i.type,
  $parent: i => i.parent,
  $root: i => {
    let root = i
    while (root.parent) root = root.parent
    return root
  },
}

// =====================================================================
// setup
// =====================================================================

/**
 * 初始化组件：处理 props / slots，执行 setup。
 * 这是「组件从 vnode 变成有状态的实例」的那一步。
 */
export function setupComponent(instance) {
  const { props, children, shapeFlag } = instance.vnode

  // ① props：把 vnode.props 里的「组件声明的属性」提取出来
  initProps(instance, props)
  // ② slots：把 children 里"是函数的那些"识别为插槽
  initSlots(instance, children)

  // ③ 执行 setup，产出状态与 render
  setupStatefulComponent(instance)
}

/**
 * props 的初始化，做三件事：
 *   1. 区分 props 和 attrs —— 只有组件用 props 选项声明过的才是 props，
 *      没声明的统统进 attrs（attrs 会自动透传到组件的根元素上，这就是"属性继承"）
 *   2. 让 props 变成「浅响应式」—— 组件内部可能用 watch 监听 props 变化，
 *      但 props 对象本身不该被改写（父组件才能改它），所以用 shallowReactive
 *   3. 把 props 也挂到 instance 上，供代理读取
 */
function initProps(instance, rawProps) {
  const props = {}
  const attrs = {}
  const options = instance.type
  const rawPropsValue = rawProps || {}

  // 组件声明的 props：数组 ['msg'] 或对象 { msg: String }
  const declared = options.props
  const propsOptions = {}
  if (isArray(declared)) {
    declared.forEach(key => (propsOptions[camelize(key)] = {}))
  } else if (isObject(declared)) {
    for (const key in declared) {
      propsOptions[camelize(key)] = declared[key]
    }
  }

  for (const key in rawPropsValue) {
    if (key === 'key' || key === 'ref') continue
    const camelKey = camelize(key) // 模板里写 :msg-text，props 里声明 msgText，要能对上
    if (hasOwn(propsOptions, camelKey)) {
      props[camelKey] = rawPropsValue[key]
    } else {
      attrs[key] = rawPropsValue[key]
    }
  }

  // 补齐没有传值的 props（值为 undefined，保证 props 的 key 集合稳定，读取时不会 undefined 报错）
  for (const key in propsOptions) {
    if (!(key in props)) props[key] = undefined
  }

  // ★ shallowReactive：props 的"替换"（父组件传了新对象）要能触发子组件更新，
  //   但 props 内部对象的深层变化不该让子组件重渲染（那是数据本身的响应性负责的）
  instance.props = shallowReactive(props)
  instance.attrs = attrs
}

/**
 * 插槽初始化。
 *
 * ★ 组件化的关键洞察之一：**插槽不是 vnode，而是「返回 vnode 的函数」。**
 *
 *     <MyComp><p>{{ msg }}</p></MyComp>
 *
 * 编译产物大致是：
 *     createVNode(MyComp, null, {
 *       default: withCtx(() => [createVNode('p', null, toDisplayString(msg))]),
 *       //                                        ↑ 注意：msg 属于"父组件作用域"
 *     })
 *
 * 为什么是函数？两个原因，都很重要：
 *   1. 惰性：如果子组件没有渲染 <slot>，这段 vnode 压根不该被创建（省性能）；
 *   2. 作用域：插槽内容的响应式数据属于**父组件**，函数在父组件的实例上下文里执行，
 *      所以求值必须发生在"父组件的 render effect"里 —— 这样父组件的数据变化才能驱动插槽更新。
 *      这就是「作用域插槽」这个名词的真正含义。
 *
 * 函数式 child 会被识别为插槽；其余（比如只有文本）归一化成 default 插槽。
 */
function initSlots(instance, children) {
  const slots = {}
  if (children == null) {
    instance.slots = slots
    return
  }
  if (isObject(children) && !isArray(children) && !children.__v_isVNode) {
    for (const key in children) {
      const value = children[key]
      if (isFunction(value)) {
        // 归一化调用形式：调用时把「作用域插槽的参数」传进去
        slots[key] = (...args) => normalizeSlotValue(value(...args))
      } else {
        slots[key] = () => normalizeSlotValue(value)
      }
    }
  } else {
    // 编译产物不一定总是给对象（例如手写 render 时 children 就是节点）
    const normalized = isArray(children) ? children : [children]
    slots.default = () => normalizeSlotValue(normalized)
  }
  instance.slots = slots
}

/** 插槽返回值统一成数组 —— 渲染器处理 children 时只认数组，不认"单个 vnode 或字符串" */
function normalizeSlotValue(value) {
  return isArray(value) ? value : [value]
}

/**
 * 执行 setup()。
 *
 * setup 的返回值有两种：
 *   1. 对象       → 作为组件的状态（会成为模板里的可用数据），render 从 options.render 取
 *   2. 函数       → 直接当作 render 函数（组合式 API 里更常见的写法是用返回的 h 来手写渲染）
 */
function setupStatefulComponent(instance) {
  const Component = instance.type
  const { setup, render, components } = Component

  if (components) instance.components = components

  if (setup) {
    // ★ 把当前实例设为"全局当前实例"，onMounted/inject/provide 这些 API 才能找到它
    const restore = setCurrentInstance(instance)
    let setupResult
    try {
      // 传给 setup 的两个参数：props 和 context
      setupResult = setup(instance.props, createSetupContext(instance))
    } catch (e) {
      console.error('[vue-mini] setup() 执行出错:', e)
      throw e
    } finally {
      restore() // 无论成功失败都要恢复，避免污染下一个组件的 setup
    }
    if (isFunction(setupResult)) {
      // 返回函数 → 它就是 render
      instance.render = setupResult
    } else if (isObject(setupResult)) {
      // ★ proxyRefs 让模板里能写 count 而不是 count.value
      instance.setupState = proxyRefs(setupResult)
    } else if (setupResult !== undefined) {
      console.warn('[vue-mini] setup() 的返回值应该是对象或函数')
    }
  }

  // render 的来源，按优先级：
  //   1. setup 返回的函数（组合式 API）
  //   2. options.render（手写 render 函数 / 构建时编译好的产物）
  //   3. options.template → 现场编译（运行时编译，见 src/index.js 注入的 compile）
  if (!instance.render) {
    const { template } = Component
    if (template && typeof template === 'string') {
      if (runtimeCompiler) {
        // ★ 这里是「模板 → 渲染函数」的交汇点：
        //   compile 内部走完 tokenize → parse → transform → generate → new Function 五步，
        //   产出一个签名为 (ctx, cache) => vnode 的函数，挂到组件上。
        //   从这一刻起，"模板"这个概念就消失了，一切都变成渲染函数 + vnode。
        if (!Component.render) {
          Component.render = runtimeCompiler(template, {})
        }
        instance.render = Component.render
      } else {
        throw new Error(
          '[vue-mini] 组件使用了 template，但当前构建不包含编译器。\n' +
            '请改用 render 函数（h(...)），或使用带编译器的完整版本。'
        )
      }
    } else {
      instance.render = render || null
    }
  }

  if (!instance.render) {
    console.warn('[vue-mini] 组件缺少 render 函数，也没有可编译的 template:', Component)
  }
}

/**
 * setup 的第二个参数 ctx。
 * 它是"组件与外界通信"的接口：
 *   attrs  —— 未被 props 声明的属性（透传）
 *   slots  —— 插槽
 *   emit   —— 向父组件发事件（★ 组件"向上通信"的标准方式，对应"向下传数据"的 props）
 *   expose —— 暴露给父组件通过 ref 访问的内部方法
 */
function createSetupContext(instance) {
  return {
    attrs: instance.attrs,
    slots: instance.slots,
    emit: instance.emit, // 在 createComponentInstance 之后挂上
    expose: exposed => {
      instance.exposed = exposed
    },
  }
}

// =====================================================================
// emit —— 子组件向父组件"报信"
// =====================================================================

/**
 * 事件名到 props 名的转换：
 *   emit('change')            → 父组件写 @change       → props.onChange
 *   emit('update:modelValue') → 父组件写 @update:modelValue → props['onUpdate:modelValue']
 *
 * 这就是 v-model 的底层机制：v-model 会被编译成
 *   :modelValue + @update:modelValue，子组件 emit('update:modelValue') 就完成了一次双向绑定。
 */
function emit(instance, event, ...args) {
  const props = instance.vnode.props || {}

  const camelEvent = camelize(event)
  const candidates = [
    toHandlerKey(camelEvent), // change        → onChange
    `on${camelEvent[0].toUpperCase()}${camelEvent.slice(1)}`,
    `on${event[0].toUpperCase()}${event.slice(1)}`, // update:modelValue → onUpdate:modelValue
  ]
  let handler
  for (const key of candidates) {
    if (isFunction(props[key])) {
      handler = props[key]
      break
    }
  }
  if (!handler) {
    // 没监听不算错误（父组件可以不监听），但给出提示方便调试
    console.warn(`[vue-mini] 组件 emit 了 "${event}"，但父组件没有监听它`)
    return
  }
  return handler(...args)
}

// =====================================================================
// 渲染 effect —— 组件级响应式
// =====================================================================

/**
 * 渲染组件根节点：调用 render 函数，把结果包装成 vnode。
 */
export function renderComponentRoot(instance) {
  const { render, proxy, renderCache } = instance
  let result

  // ★ 设置「当前正在渲染的组件」，resolveComponent / withCtx 才能找到正确的组件
  const prev = setCurrentRenderingInstance(instance)
  try {
    // 第二个参数是 _cache，供编译产物缓存静态节点/事件处理函数
    result = render.call(proxy, proxy, renderCache)
  } catch (e) {
    console.error('[vue-mini] 组件渲染出错:', e)
    throw e
  } finally {
    setCurrentRenderingInstance(prev)
  }

  // 多根节点 → 包成 Fragment
  if (isArray(result)) {
    result = createVNode(Fragment, null, result)
  }
  const root = normalizeVNode(result)

  // ★ attrs 透传（fallthrough）：组件模板的根节点会"继承"外界传进来、
  //   却没被 props 声明的属性 —— <Child data-id="7"> 的 data-id 直接出现在根 DOM 上。
  //   这就是「属性继承」，Vue 里 class/style 合并、事件合并都基于这个机制。
  //   简化说明：同名属性时根节点自己的优先；class 做字符串拼接；多根节点不透传（真实 Vue 会警告）。
  const { attrs } = instance
  if (attrs && root && root.shapeFlag & ShapeFlags.ELEMENT) {
    const attrKeys = Object.keys(attrs)
    if (attrKeys.length) {
      // props 对象是本渲染刚创建的，直接改它没有共享风险
      root.props = root.props ? { ...root.props } : {}
      for (const key of attrKeys) {
        if (key === 'class') {
          root.props.class = [root.props.class, attrs.class].filter(Boolean).join(' ')
        } else if (key === 'style') {
          root.props.style = [root.props.style, attrs.style].filter(Boolean).join(';')
        } else if (!(key in root.props)) {
          root.props[key] = attrs[key]
        }
      }
    }
  }

  return root
}

/**
 * 挂载组件。
 *
 * ★ 注意第 ⑤ 步：把子树的 el 冒泡给组件 vnode。
 *   对外界来说，组件就"等同于"它的根 DOM —— 父组件的 diff 完全不需要知道
 *   这个组件内部渲染了多少层。这是组件封装性的渲染层表现。
 */
export function mountComponent(renderer, initialVNode, container, anchor, parentComponent) {
  // ① 创建实例，并反向挂到 vnode 上（后续 updateComponent 靠 vnode.component 找回来）
  const instance = (initialVNode.component = createComponentInstance(initialVNode, parentComponent))
  // setup 上下文需要 emit，这里补上（emit 要绑定 instance）
  instance.emit = emit.bind(null, instance)

  // ② props / slots / setup
  setupComponent(instance)

  // ③ 建立渲染 effect
  setupRenderEffect(renderer, instance, initialVNode, container, anchor)
}

/**
 * 建立渲染 effect —— 组件"活起来"的那一刻。
 *
 * 三件事：
 *   1. 把「渲染 + 打补丁」这个动作包成 effect → 模板里用到的响应式数据自动成为它的依赖；
 *   2. 给它配 scheduler = queueJob → 数据变化时不立即渲染，而是进队列等微任务批量处理；
 *   3. 立即执行一次，完成首次挂载。
 *
 * 于是「数据变化 → 组件自动重新渲染」这条链路就闭合了：
 *
 *   state.count++
 *     → Proxy 的 set 拦截 → trigger()
 *     → 发现渲染 effect 依赖了 count
 *     → 调用它的 scheduler → queueJob(update) → 微任务里执行 update()
 *     → effect.run() → render() 重新执行 → 得到新子树 vnode
 *     → patch(旧子树, 新子树) → 只改 DOM 中真正变化的部分
 */
function setupRenderEffect(renderer, instance, initialVNode, container, anchor) {
  const { patch } = renderer

  const componentUpdateFn = () => {
    if (!instance.isMounted) {
      // ============ 首次挂载 ============
      const { bm, m } = instance
      invokeArrayFns(bm) // onBeforeMount

      // ★★ 组件渲染的本质：render() 产出一棵「子树 vnode」，然后递归交给 patch 处理
      const subTree = (instance.subTree = renderComponentRoot(instance))
      patch(null, subTree, container, anchor, instance)

      // ⑤ DOM 冒泡：组件 vnode 的 el 指向子树的 el
      initialVNode.el = subTree.el
      instance.isMounted = true

      invokeArrayFns(m) // onMounted
    } else {
      // ============ 更新 ============
      const { bu, u, next } = instance

      // 父组件重新渲染后会产生一个新的组件 vnode，里面是新的 props / 插槽。
      // 必须先把它同步到 instance 上，本次渲染才能读到新 props（这就是"props 更新"的落地方式）。
      if (next) {
        next.el = instance.vnode.el
        updateComponentPreRender(instance, next)
      }

      invokeArrayFns(bu) // onBeforeUpdate

      const nextTree = renderComponentRoot(instance)
      const prevTree = instance.subTree
      instance.subTree = nextTree

      // ★ 组件更新的本质：新旧「子树」做 patch，和元素更新走的是同一套 diff
      patch(prevTree, nextTree, container, null, instance)

      // 子树根节点类型可能变了（比如 v-if 切换），el 要跟着更新
      initialVNode.el = instance.vnode.el = nextTree.el

      invokeArrayFns(u) // onUpdated
    }
  }

  // ★ 用 ReactiveEffect 而不是 effect() 帮助函数，是为了显式控制 scheduler 与 id
  const effect = new ReactiveEffect(componentUpdateFn, () => queueJob(update))
  const update = () => effect.run()
  update.id = instance.uid // ★ 让调度器按 uid 排序 → 父组件先于子组件更新
  update.effect = effect // 卸载时要靠它 stop
  // 函数的 name 属性默认不可写，要用 defineProperty（调试时能在队列里看到组件名）
  Object.defineProperty(update, 'name', {
    value: `componentUpdate:${instance.type.name || 'anonymous'}`,
    configurable: true,
  })

  instance.effect = effect
  instance.update = update
  effect.run() // 首次执行 → 挂载 + 收集依赖
}

/**
 * 组件更新：父组件重新渲染时，patch 里会走到这里。
 *
 * 关键优化 shouldUpdateComponent：
 *   如果新 vnode 的 props 和插槽跟旧的一模一样，就没必要重新渲染子组件
 *   （常见于父组件状态变化但和子组件无关的情况）。
 *   这一步能省下大量无谓的子树 diff 工作。
 */
export function updateComponent(renderer, n1, n2) {
  const instance = (n2.component = n1.component)

  if (shouldUpdateComponent(instance, n1, n2)) {
    // 先把新 vnode 记下来，等渲染 effect 执行时再应用（见 componentUpdateFn 的 next 分支）
    instance.next = n2
    instance.update()
  } else {
    // 不需要更新：只把 vnode 换掉（保持引用最新），DOM 一点不动
    n2.el = n1.el
    instance.vnode = n2
  }
}

/** props / 插槽有没有变化 */
function shouldUpdateComponent(instance, prevVNode, nextVNode) {
  const { props: prevProps, children: prevChildren } = prevVNode
  const { props: nextProps, children: nextChildren } = nextVNode

  // 插槽是函数，父组件每次渲染都会重新创建 → 引用必然不同。
  // 真实 Vue 用 optimizeSlots 做标记来跳过，这里简化为"有插槽就当需要更新"，
  // 因为插槽内容里可能引用了父组件的响应式数据，确实需要更新。
  if (nextChildren) return true

  if (prevProps === nextProps) return false
  if (!prevProps) return !!nextProps
  if (!nextProps) return true

  return hasPropsChanged(prevProps, nextProps)
}

/** 逐个比较 props 的「值」（不是引用） */
function hasPropsChanged(prevProps, nextProps) {
  const nextKeys = Object.keys(nextProps)
  if (nextKeys.length !== Object.keys(prevProps).length) return true
  for (const key of nextKeys) {
    if (nextProps[key] !== prevProps[key]) return true
  }
  return false
}

/** 把新 vnode 的 props / 插槽同步到实例上（更新真正生效的地方） */
function updateComponentPreRender(instance, nextVNode) {
  instance.vnode = nextVNode
  instance.next = null
  // props 用 shallowReactive，重新赋值即可触发依赖（父组件传了新值 → 子组件重渲染）
  const props = {}
  for (const key in nextVNode.props) {
    if (key === 'key' || key === 'ref') continue
    props[key] = nextVNode.props[key]
  }
  Object.assign(instance.props, props)
  // 插槽也要更新，否则父组件插槽里的内容不会跟着变
  initSlots(instance, nextVNode.children)
}

/**
 * 卸载组件：清理子树、触发卸载钩子、停止渲染 effect。
 *
 * ★ onUnmounted 的触发顺序是「父先子后」，和直觉相反却是 Vue 的真实行为：
 *   卸载是一个"从外往里"的递归（父组件先走到这里），而 onUnmounted 被排进一个
 *   "卸载结束后统一执行"的队列（FIFO），所以父的钩子先入队、先执行。
 *   语义上也更合理：onUnmounted 表示"整个卸载动作已经完成"，应该发生在所有 DOM 摘除之后。
 *
 * ★ 为什么必须 stop(effect)？
 *   组件虽然从 DOM 上移除了，但它的渲染 effect 仍然订阅着那些响应式数据。
 *   如果不停掉，之后任何一次数据变化都会让它重新渲染 ——
 *   而它已经没有容器可 patch，轻则浪费性能，重则报错。这就是最常见的内存泄漏来源之一。
 */
const umQueue = []
let unmountDepth = 0

export function unmountComponent(renderer, vnode, parentComponent, doRemove) {
  const instance = vnode.component
  if (!instance) return

  invokeArrayFns(instance.bum) // onBeforeUnmount：同步、先于 DOM 摘除

  unmountDepth++
  // 先入队（此刻还在最外层 → 父先子后），等整棵子树卸载完再统一执行
  umQueue.push(() => invokeArrayFns(instance.um))

  if (instance.subTree) {
    renderer.unmount(instance.subTree, instance, doRemove)
  }
  if (instance.update && instance.update.effect) {
    instance.update.effect.stop()
  }
  instance.isUnmounted = true

  if (--unmountDepth === 0) {
    const queue = umQueue.splice(0)
    for (const fn of queue) fn()
  }
}

// =====================================================================
// provide / inject —— 跨层级通信
// =====================================================================

/**
 * 解决 props 逐层透传（prop drilling）的问题：
 *   祖先 provide 一个值，任意深度的后代都能 inject 到，中间层完全不用关心。
 *
 * 实现依赖 instance.provides 的原型链：
 *   子实例的 provides = Object.create(父实例的 provides)
 *   于是"我自己 provide 的"覆盖"祖先 provide 的"，而 inject 只要沿原型链向上找。
 */
export function provide(key, value) {
  const instance = getCurrentInstance()
  if (!instance) {
    console.warn('[vue-mini] provide() 只能在 setup() 内同步调用')
    return
  }
  instance.provides[key] = value
}

export function inject(key, defaultValue) {
  const instance = getCurrentInstance()
  if (!instance) {
    console.warn('[vue-mini] inject() 只能在 setup() 内同步调用')
    return isFunction(defaultValue) ? defaultValue() : defaultValue
  }
  // ★ provides 是一条原型链（子 → 父 → 祖父 → ...），
  //   所以一句 `key in provides` 就沿着链找到了最近一次 provide 的值，
  //   "就近覆盖"这个语义是免费得到的。
  if (key in instance.provides) {
    return instance.provides[key]
  }
  return isFunction(defaultValue) ? defaultValue() : defaultValue
}
