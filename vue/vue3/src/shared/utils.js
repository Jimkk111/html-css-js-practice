/** 通用工具函数。命名尽量与 Vue 3 源码保持一致，方便对照阅读。 */

/** 开发环境开关（本项目里始终为 true，保留是为了和 Vue 源码结构对齐） */
export const __DEV__ = true

export const EMPTY_OBJ = Object.freeze({})
export const NOOP = () => {}

export const isArray = Array.isArray
export const isFunction = v => typeof v === 'function'
export const isString = v => typeof v === 'string'
export const isSymbol = v => typeof v === 'symbol'
export const isObject = v => v !== null && typeof v === 'object'

const hasOwnProperty = Object.prototype.hasOwnProperty
export const hasOwn = (obj, key) => hasOwnProperty.call(obj, key)

/** 返回一个真正的对象（VNode / 组件对象这类），null 不算 */
export const isPlainObject = v => Object.prototype.toString.call(v) === '[object Object]'

/**
 * 值是否发生变化。
 * 注意用 Object.is 而不是 !==，这样 NaN → NaN 会被认为「没变」，
 * 避免 v-for 里对 NaN 的重复更新。
 */
export const hasChanged = (value, oldValue) => !Object.is(value, oldValue)

/** 'foo-bar' → 'FooBar' */
export const capitalize = str => (str ? str.charAt(0).toUpperCase() + str.slice(1) : str)
/** 'foo-bar' → 'fooBar'（把连字符属性名转成驼峰，用于匹配 props 名） */
export const camelize = str => str.replace(/-(\w)/g, (_, c) => (c ? c.toUpperCase() : ''))
/** 'fooBar' → 'foo-bar' */
export const hyphenate = str => str.replace(/\B([A-Z])/g, '-$1').toLowerCase()
/** 'click' → 'onClick'（事件名 → props 名，这是 emit 的实现基础） */
export const toHandlerKey = str => (str ? `on${capitalize(str)}` : '')

/**
 * 属性名是不是事件监听：onClick / onUpdate:modelValue / onclick 里的 on + 大写/非小写字母。
 * 必须写成 /^on[^a-z]/ 而不能是 /^on/，否则 "once"、"only" 这类普通属性会被误判成事件。
 */
export const isOn = key => /^on[^a-z]/.test(key)

/** 骨架屏/过渡组件会用到：把 onXxx 还原成事件名 */
export const parseEventName = key => hyphenate(key.slice(2))

/** props 里哪些 key 是保留字，不参与 props/attrs 的区分 */
export const isReservedProp = key =>
  key === 'key' || key === 'ref' || key === 'ref_for' || key === 'ref_key'

/** 数组下标形式的 key，例如 "0" / "12"；用于区分数组的「改值」和「追加」 */
export const isIntegerKey = key =>
  isString(key) && key !== 'NaN' && key[0] !== '-' && '' + parseInt(key, 10) === key

/** 在开发环境打印警告，生产环境不输出 */
export function warn(msg, ...args) {
  if (__DEV__) console.warn(`[vue-mini] ${msg}`, ...args)
}

/**
 * 标准 HTML 标签清单。编译器用它区分「原生元素」和「组件」：
 *   <div>      → 在表里 → 原生元素 → createElementVNode
 *   <MyComp>   → 不在表里 → 组件    → resolveComponent + createVNode
 * 这是组件化的第三个伏笔：模板里的标签名要在编译/运行期解析成"组件"。
 */
const HTML_TAGS = new Set(
  (
    'html,body,base,head,link,meta,style,title,address,article,aside,footer,header,h1,h2,h3,h4,h5,h6,' +
    'nav,section,div,dd,dl,dt,figcaption,figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,' +
    'br,cite,code,data,dfn,em,i,kbd,mark,q,rp,rt,ruby,s,samp,small,span,strong,sub,sup,time,u,var,wbr,' +
    'area,audio,map,track,video,embed,object,param,source,canvas,script,noscript,del,ins,caption,col,' +
    'colgroup,table,thead,tbody,td,th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,' +
    'option,output,progress,select,textarea,details,dialog,menu,summary,template,blockquote,iframe,tfoot,' +
    // SVG 常用标签
    'svg,animate,circle,clippath,cursor,defs,desc,ellipse,filter,font-face,foreignobject,g,glyph,image,' +
    'line,marker,mask,missing-glyph,path,pattern,polygon,polyline,rect,switch,symbol,text,textpath,tspan,' +
    'use,view'
  ).split(',')
)

export const isHTMLTag = tag => HTML_TAGS.has(tag)

/** 模板里的标签是组件还是原生元素 */
export const isComponentTag = tag => !isHTMLTag(tag)
