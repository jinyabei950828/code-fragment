import { transport } from "./transport"

let queue = []
let timer = null
const QUEUE_MAX = 10
const QUEUE_WAIT = 5000

function flush(){
  if(!queue.length)return

  // 1. 把当前队列的数据复制出来
  const batch = queue.slice()

  // 2. 清空队列与定时器
  queue.length = 0;
  clearTimeout(timer)
  timer = null

  // 3. 利用空闲时间发送（性能优化点）
  if('requestIdleCallback' in window){
    requestIdleCallback(()=>transport(batch),{timeout:2000})
  }else{
    // 降级兼容
    setTimeout(()=>transport(batch,0))
  }

}

export function report (log,immediate = false){
  // 1. 紧急情况：绕过队列，直接发
  if(immediate){
    transport(log)
    return
  }

  // 2. 普通情况：进入队列（如 点击、PV）
  queue.push({...log,ts:Date.now()})

  // 3. 检查触发条件（双重保险）
  if(queue.length>=QUEUE_MAX){
    flush();
  }else if(!timer){
    timer = setTimeout(flush,QUEUE_WAIT)
  }
}

// 4. 临终兜底：页面关闭/隐藏时，强制把剩下的都发走
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='hidden')flush();
})
window.addEventListener('pagehide',flush)