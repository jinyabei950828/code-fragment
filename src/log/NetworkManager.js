const NetworkManager = {
  online:navigator.onLine,

  init(onBackOnline){
    window.addEventListener('online',async()=>{
      //先看看是不是真的能上网
      const realWait = await verify()
      if(realWait){
        this.online = true
        // 真的回网了，赶紧补传！
        onBackOnline()
      }
    })
    window.addEventListener('offline',()=>this.online = false)
  },

  async verify(){
    try{
      // 请求个 favicon 或者 1x1 图片，只要响应了说明网通了
      await fetch("/favicon",{method:'HEAD',cache:'no-store'})
    }catch{
      return false
    }
  }
}