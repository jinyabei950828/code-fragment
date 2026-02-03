import { transport } from "./transport";

export async function reportData(data) {
  // 1. 如果明确知道没网，直接存本地 (省一次请求)
  if(!NetworkManager.online){
    saveToLocal(data)
    return;
  }

  // 2. 尝试发送
  try{
    await transport(data)
  }catch{
    console.log(`上报请求失败,${err}`)
  }

  // 3. 不管是因为断网、超时、还是服务器挂了
  // 只要没成功，第一件事就是存本地！保证这条日志不丢！
  saveToLocal(data)

  // 4. 然后再来诊断网络，决定后续策略
  // 只有当是网络层面的错误（如 fetch throw Error）才去怀疑网络
  // 如果是 500 错误，其实网是通的，不用 forceOffline
  if(isNetworkError(err)){
    // 5. Ping 确认
    NetworkManager.verify().then(res=>NetworkManager.online = res)
  }
}

/**
 * 判断是否为网络层面的错误
 */
function isNetworkError(err){
  // 原生 fetch 的网络错误通常是 TypeError: Failed to fetch
  // 如果是使用 Axios，则可以通过 !err.response 来判断
  return err instanceof TypeError||(err.request&&!err.response)
}

const RETRY_KEY = 'RETRY_LOGS'
const RETRY_MAX_ITEMS = 1000
function saveToLocal(data){
  const raws = localStorage.getItem(RETRY_KEY)
  const logs = raws?JSON.parse(raws):[]
  logs.push(data)
  //如果有超过最大值，直接取最新的
  if(logs.length>RETRY_MAX_ITEMS){
    logs.splice(0,logs.length - RETRY_MAX_ITEMS)
  }
  localStorage.setItem(RETRY_KEY,JSON.parse(logs))
}