/**
 * createApp —— 应用实例，用户接触的第一个 API。
 *
 *     createApp(RootComponent)
 *       .use(plugin)
 *       .component('MyBtn', MyBtn)
 *       .mount('#app')
 *
 * 它做两件事：
 *   1. 维护「应用级配置」——全局组件注册表、全局属性、插件、provide…
 *      为什么要有"应用"这一层而不是全局单例？因为同一个页面里可以挂载多个 Vue 应用，
 *      每个应用有独立的注册表，互不干扰（微前端、SSR 多实例都依赖这一点）。
 *   2. 把根组件渲染进容器：
 *      mount('#app') → 找到 DOM 容器 → render(createVNode(Root), container)
 *
 * 注意 mount 的返回值是根组件实例的 proxy —— 所以你可以
 *
 *     const vm = app.mount('#app')
 *     vm.someExposedMethod()
 */
import { createVNode, setCurrentApp } from '../runtime-core/vnode.js'
import { createRenderer } from '../runtime-core/renderer.js'
import { nodeOps } from './nodeOps.js'
import { patchProp } from './patchProp.js'
import { setCurrentInstance } from '../runtime-core/instance.js'

/** 浏览器平台的渲染器：nodeOps + patchProp 就是这一层全部的平台差异 */
export const renderer = createRenderer({ ...nodeOps, patchProp })

export function createApp(rootComponent, rootProps = null) {
  const context = {
    app: null,
    components: {}, // 全局组件注册表
    config: { globalProperties: {} },
    provides: Object.create(null),
  }

  const app = {
    _context: context,
    _container: null,
    _instance: null,

    /**
     * 注册/获取全局组件。
     *   传两个参数 → 注册
     *   传一个参数 → 获取（resolveComponent 的全局兜底会用到）
     */
    component(name, component) {
      if (!component) return context.components[name]
      context.components[name] = component
      return app
    },

    /** 注册全局属性：模板里可以直接用（本质是加到 proxy 的查找链末尾） */
    config: context.config,

    /** 安装插件：插件可以是一个函数，也可以是带 install 方法的对象 */
    use(plugin, ...options) {
      if (plugin && plugin.install) {
        plugin.install(app, ...options)
      } else if (typeof plugin === 'function') {
        plugin(app, ...options)
      } else {
        console.warn('[vue-mini] 插件必须是一个函数或含有 install 方法')
      }
      return app
    },

    /** 应用级 provide：所有组件都能 inject 到（实现的还是原型链那一套） */
    provide(key, value) {
      context.provides[key] = value
      return app
    },

    /**
     * 挂载。
     * @param {string|Element} container 选择器或 DOM 元素
     */
    mount(container) {
      const el = typeof container === 'string' ? document.querySelector(container) : container
      if (!el) {
        throw new Error(`[vue-mini] 找不到挂载容器: ${container}`)
      }

      // ★ 把根组件也变成一个 vnode —— 组件化的关键前提：
      //   App 组件和其他组件走的是**完全相同**的流程，没有特殊待遇。
      const vnode = createVNode(rootComponent, rootProps)

      // 建立"当前应用"上下文：resolveComponent 的全局查找要靠它
      setCurrentApp(app)
      context.app = app
      vnode.appContext = context

      // 清空容器（真实 Vue 会警告"容器不是空的"，这里直接清掉）
      el.innerHTML = ''

      // 渲染！一切从这里进入 runtime-core
      renderer.render(vnode, el)

      app._container = el
      app._instance = vnode.component
      return vnode.component ? vnode.component.proxy : null
    },

    /**
     * 卸载应用：把渲染 effect 停掉、DOM 清掉。
     * 单页应用里用不到，但在"微前端卸载子应用"、"SSR 客户端切换"场景里必须要有。
     */
    unmount() {
      if (app._container) {
        renderer.render(null, app._container)
        app._container.innerHTML = ''
        app._container = null
      }
    },
  }

  return app
}

/**
 * 让运行时也能拿到一个组件实例的"公开接口"（$el、$emit 等）。
 * 主要给测试和调试用。
 */
export function getInstanceProxy(instance) {
  return instance ? instance.proxy : null
}

export { nodeOps, patchProp }
