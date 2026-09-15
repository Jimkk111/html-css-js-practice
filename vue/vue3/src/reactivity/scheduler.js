/**
 * 调度器（scheduler）—— 把「多次数据变化」合并成「一次渲染」。
 *
 * 没有调度器会发生什么？
 *
 *     state.a = 1
 *     state.b = 2
 *     state.c = 3
 *
 * 如果每次赋值都同步重新渲染，屏幕会白白刷新 3 次（浏览器合并了视觉结果，但 JS 做了 3 倍的工作量）。
 * Vue 的做法：数据变化只把「渲染任务」丢进队列，然后**在微任务里**统一执行一次。
 *
 *     同步代码执行完（同一个 tick 内的所有修改）
 *        ↓
 *     微任务队列执行 → flushJobs() → 每个组件只重新渲染一次
 *
 * 这种「异步批量更新」是 Vue 的核心体验：watch 回调、$nextTick、DOM 更新都落在同一个微任务里。
 *
 * 本文件要处理的三件事：
 *   1. 去重 —— 同一个组件的渲染任务只入队一次（靠 job.id 判断）
 *   2. 排序 —— 按 id 升序执行。id 小的先创建，也就是父组件先于子组件更新，
 *              否则子组件会带着旧 props 渲染一遍，父组件更新后又要再渲染一遍
 *   3. 循环 —— 执行期间可能产生新任务（父组件更新改动了子组件 props），要跑完为止
 */
const resolvedPromise = Promise.resolve()

/** 任务队列，始终按 id 升序 */
const queue = []
/** 去重集合：同一个 job 连续入队多次只保留一份 */
const pendingSet = new Set()

let isFlushing = false
let currentFlushPromise = null

/** job id 分配器。组件用它实现「父先子后」的排序 */
let uid = 0
export function nextJobId() {
  return ++uid
}

/**
 * 渲染任务的调度器本体。挂到 effect.scheduler 上：
 *
 *     数据变化 → trigger 发现 effect.scheduler 存在 → scheduler(job) → job 入队 → 微任务统一 flush
 */
export function queueJob(job) {
  if (!pendingSet.has(job)) {
    pendingSet.add(job)
    // 二分查找插入位置，保持队列有序
    const index = findInsertionIndex(job)
    if (index < 0) queue.push(job)
    else queue.splice(index, 0, job)
    queueFlush()
  }
}

/** 在有序队列里二分查找插入点；返回 -1 表示插到末尾 */
function findInsertionIndex(job) {
  if (queue.length === 0 || !job.id) return -1
  let start = 0
  let end = queue.length - 1
  while (start <= end) {
    const mid = (start + end) >> 1
    const midId = queue[mid].id
    if (!midId) {
      // 没 id 的任务永远排在有 id 的任务前面
      end = mid - 1
      continue
    }
    if (job.id > midId) start = mid + 1
    else end = mid - 1
  }
  return start
}

/** 把真正执行队列的动作推迟到微任务 —— 这是「批量」得以成立的关键 */
function queueFlush() {
  if (!currentFlushPromise && !isFlushing) {
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

/**
 * nextTick(fn)：等 DOM 更新完成之后再执行。
 *
 * 原理很朴素：DOM 更新发生在 flushJobs 这个微任务里，
 * 那我只要再 .then 一次，就一定排在它后面 —— 此时 DOM 已经是新的了。
 *
 *     count.value++
 *     console.log(el.textContent)   // 旧值！更新还没发生（异步批量更新）
 *     await nextTick()
 *     console.log(el.textContent)   // 新值
 */
export function nextTick(fn) {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(fn) : p
}

/**
 * 执行队列。
 * 注意 for 循环的条件是 `i < queue.length` 而不是固定长度：
 * flush 期间新入队的 job 会追加到 queue 末尾，这样能被同一轮循环自然吃掉。
 */
function flushJobs() {
  isFlushing = true
  let guard = 0
  try {
    for (let i = 0; i < queue.length; i++) {
      // 无限循环保护：渲染函数里写了它自己读的状态时，会不断产生新任务。
      // 与其把页面卡死，不如明确报错（真实 Vue 也会给出 "Maximum recursive updates" 警告）。
      if (++guard > 1000) {
        queue.length = 0
        pendingSet.clear()
        throw new Error(
          '[vue-mini] 检测到无限更新循环：渲染函数很可能修改了它自己读取的响应式数据。' +
            '若确实需要派生状态，请使用 computed。'
        )
      }
      const job = queue[i]
      // 执行前先从去重集合里移除，允许它在执行期间（间接）再次入队，
      // 这样「父组件更新 → 子组件 props 变化 → 子组件再更新」不会被丢掉。
      pendingSet.delete(job)
      if (job.active !== false) {
        job()
      }
    }
  } finally {
    queue.length = 0
    pendingSet.clear()
    isFlushing = false
    currentFlushPromise = null
  }
}

/** 调试用 */
export const isFlushingJobs = () => isFlushing

/** 调试用：当前队列里的任务 id 列表 */
export const jobQueueSnapshot = () => queue.map(job => `${job.name || 'job'}#${job.id ?? '-'}`)
