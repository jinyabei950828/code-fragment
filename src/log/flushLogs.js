import { transport } from "./transport";

async function flushLogs(){
  let logs = JSON.parse(localStorage.getItem("RETRY_LOGS")||'[]')
  if(!logs.length)return;

  console.log(`发现${logs.length}条欠账,开始补传`)

  while(logs.length>0){
    // 1. 每次只取 5 条，小碎步走
    const batch = logs.slice(0,5)
    try{
      // 2. 调用上报中心
      await transport(batch)

      // 3. 只有成功了，才把这 5 条从 logs 里剔除
      logs.splice(0,5)
      localStorage.setItem(RETRY_LOGS,JSON.stringify(logs))
    }catch(err){
      console.log('补传中途失败,保留剩余部分数据')
      break;
    }

    // 2. 歇半秒钟，给正常业务请求让个道
    await new Promise(r=>setTimeout(r,500))
  }
}