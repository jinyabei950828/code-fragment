const REPORT_URL = 'https://log.your-domain.com/collet';
const MAX_URL_LENGTH = 2048
const MAX_BEACON_BYTES = 64*2048

function byteLen(s){
  try{
    //获取UTF-8实际的字节数
    return new TextEncoder().encode(s).length
  }catch(e){
    return s.length
  }
}

/**
 * 通用上报函数
 * @param {Object|Array} data  上报数据
 * @returns {Promise<void>} --成功 resolve 失败reject
 */
function transports(data){
  const isArray = Array.isArray(data)
  const json = JSON.stringify(data)

  return new Promise((resolve,reject)=>{
    //注意：sendBeacon 是同步入队，返回 true 仅代表入队成功，不一定是发送成功
    if(navigator.sendBeacon&&byteLen(json)<=MAX_BEACON_BYTES){
      //把数据封装成可识别的二进制对象
      const blob = new Blob([json],{type:'text/plain'})
      if(navigator.sendBeacon(REPORT_URL,blob)){
        resolve()
        return
      }
      console.warn("[Beacon]入队失败,尝试降级")
    }

    //单条小数据尝试 Image (GET)
    if(!isArray){
      const params = new URLSearchParams(data)
      params.append("_ts",String(Date.now()));
      const qs = params.toString()
      const seq = REPORT_URL.includes("?")?'&':'?'
      if(REPORT_URL.length+seq.length+qs.length<MAX_URL_LENGTH){
        const img = new Image()
        img.onload = ()=>resolve()
        img.onerror = ()=>reject(new Error("Image上报失败"))
        img.src = REPORT_URL+seq+qs
        return;
      }
    }

    if(window.fetch){
      fetch(REPORT_URL,{
        method:'post',
        headers:{'Content-Type':'text/plain'},
        body:json,
        keepalive:true,
      }).then((res)=>{
        if(res.ok) resolve()
        else reject(new Error(`Fetch失败:${res.status}`))
      }).catch(reject)
    }else{
      //Ie兼容
      const xhr = new XMLHttpRequest()
      xhr.open("POST",REPORT_URL,true)
      xhr.setRequestHeader('Content-Type','text/plain')
      xhr.onload = ()=>{
        if(xhr.status>=200&&xhr.status<300)resolve()
        else reject(new Error(`xhr 失败 ${xhr.status}`))
      }
      xhr.onerror = ()=>reject(new Error("网络错误"))
      xhr.send(json)
    }
  })
}