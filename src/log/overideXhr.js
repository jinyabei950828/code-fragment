/**
 * 定义劫持XHR的主函数
 * @param {*} onRequestSend 请求发送时触发（首屏统计用）
 * @param {*} afterRequestReturn 请求完成时触发（首屏统计用）
 */
var overideXhr = function(onRequestSend,afterRequestReturn){
   // 1. 获取XMLHttpRequest的原型对象，所有XHR实例都继承此原型，重写原型方法=全局劫持所有XHR
  var XhrProto = XMLHttpRequest.prototype

  // 2. 缓存原生的send方法、open方法
  var oldXhrSend = XhrProto.send
  var oldXhrOpen = XhrProto.open

  // 3. 重写原型上的open方法：核心是「保存请求的method/url」，供后续send阶段使用
  XhrProto.open = function(method,url){
    // 给当前XHR实例挂载自定义属性acfst_http，用于存储请求信息；如果已有_http则复用，否则初始化为空对象
    this.acfst_http = this._http||{};

     // 把open方法的参数（请求方法：GET/POST等\请求地址）存入自定义属性--在xhr上的好处:信息隔离
    this.acfst_http.method = method
    this.acfst_http.http_url = url

    // 调用原生open方法，保证原有功能正常执行：
    // SLICE.call(arguments)：把类数组arguments转为真数组（SLICE是Array.prototype.slice的简写，外部全局定义）
    // apply(this)：保证原生open方法内部的this指向当前XHR实例（否则this会指向window，原生方法执行失败）
    // return：透传原生open方法的返回值（原生open无返回值，实际返回undefined
    return oldXhrOpen.apply(this,SLICE.call(arguments))
  }

   // 4. 重写原型上的send方法：核心是「监听请求发送+完成」，实现首屏统计和API上报
  XhrProto.send = function(){
    // 声明首屏统计的唯一标识，后续用于关联「发送-完成」的请求
    var requestKey;
     // 声明API上报的唯一标识，用于标记每个上报的请求
    var requestTrackKey

    // a.首屏统计判断：调用外部方法判断当前请求url是否是「首屏相关请求」
    if(shouldCatchThisRequest(this.acfst_http.http_url)){        
      // 若是首屏请求,调用传入的回调onRequestSend，传入url和请求类型（xhr），
      // 返回对象中取requestKey（首屏统计的唯一ID）
      requestKey = onRequestSend(this.acfst_http.url,'xhr').requestKey
    }

    // b.API上报判断：调用外部方法判断当前请求url是否需要「接口性能上报」
    if(requestTrackUrlShouldCatch(this.acfst_http.url)){
      // 生成API上报的唯一key：url+时间戳（避免同url多请求重复覆盖
      requestTrackKey = this.acfst_http.url+new Date().getTime()
      // 清空之前的上报定时器（防抖：避免多个请求完成时频繁触发上报）
      if(requestTrackTimer)clearTimeout(requestTrackTimer)
      // 把当前请求的基础信息存入上报池（requestTrackPool是外部全局对象，存储所有待上报的请求信息）
      requestTrackPool[requestTrackKey] = {
        method: this.acfst_http.method,
        url:this.acfst_http.url,
        pageUrl:window.location.href.split("?")[0],
        sendTime:Date.now(),
        state:'send'// 请求状态：标记为已发送 
      }
    }

    // 4.缓存当前XHR实例原生的onreadystatechange回调（业务代码可能自己绑定了该回调，需保留）
    var oldReadyCallback = this.onreadystatechange

    // 5.重写当前XHR实例的onreadystatechange回调：监听请求完成状态（readyState===4）
    this.onreadystatechange = function(){
      // 核心判断：readyState===4 表示XHR请求「完成」（无论成功/失败/跨域，都会进入此状态）
      if(this.readyState === 4){
        //a.首屏统计-请求完成：如果是首屏请求（有requestKey）
        if(requestKey){
           // 把请求的响应数据存入全局首屏请求详情（_global是外部全局对象，存储首屏相关数据）
          _global.requestDetails[requestKey].response = this.response
          // 调用传入的回调afterRequestReturn，通知首屏统计：该请求已完成
          afterRequestReturn(requestKey)
        }

        //API上报-请求完成：如果是需要上报的请求（有requestTrackKey）
        if(requestTrackKey){
          // 更新请求状态为「完成」、记录请求的HTTP状态码（200/404/500等，跨域可能为0）、计算请求耗时：当前时间戳 - 发送时间戳（毫秒）
          requestTrackPool[requestTrackKey].state = 'complete'
          requestTrackPool[requestTrackKey].status = this.status
          requestTrackPool[requestTrackKey].duration = Date.now()-requestTrackPool[requestTrackKey].sendTime
          // 清空之前的上报定时器（再次防抖，避免重复计时）
          if(requestTrackTimer)clearTimeout(requestTrackTimer)
          // 开启500ms防抖定时器：等待500ms后执行上报（避免多个请求连续完成时，多次触发上报接口）
          requestTrackTimer = setTimeout(()=>{
            // 调用外部方法判断：是否所有待上报的请求都已完成
            if(hasAllRequestTrackReturned()){
              // 若全部完成，执行「请求信息过滤+上报」（外部方法，处理并发送上报数据到后台）
              requestInfoFilterAndReport()
            }
          },500)
        }
      }

       // 保留业务代码的原生回调：如果原XHR实例绑定了onreadystatechange，保证其正常执行
      // 判空+判断apply存在：避免业务代码绑定的不是函数，导致执行报错
      if(oldReadyCallback&&oldReadyCallback.apply){
        oldReadyCallback.apply(this,arguments)
      }
    }

     // 6调用原生send方法，发送请求：
    // 同open方法，转arguments为数组+apply保证this指向，透传返回值（原生send无返回值）
    return oldXhrSend.apply(this,SLICE.call(arguments))
  }
}

/**
 * 定义劫持fetch的主函数
 * @param {*} onRequestSend 请求发送时触发（首屏统计用）
 * @param {*} afterRequestReturn 请求完成时触发（首屏统计用）
 */
var overrideFetch = function(onRequestSend,afterRequestReturn){
  // 兼容性前置判断：只有浏览器支持fetch且有Promise时才劫持（fetch基于Promise实现，低版本浏览器无）
  if(window.fetch&&typeof Promise ==='function'){
     // 1.缓存原生fetch方法
    var oldFetch = window.fetch
     // 2.重写全局的window.fetch：后续所有调用fetch()都会执行这个新函数
    window.fetch = function(){
      // 保存当前fetch的this指向（非必须，但兼容特殊场景下的this绑定）
      var that = this
      // 保存fetch调用时的所有参数（类数组），后续透传给原生fetch
      var args = arguments
      // 核心：返回一个新Promise包裹原生fetch，实现「监听执行过程+透传结果」
      return new Promise(function(resolve,reject){
        //存储解析后的请求真实URL、首屏统计唯一标识、API上报唯一标识
        var url
        var requestKey
        var requestTrackKey

        // 解析fetch的入参，提取真实请求URL：fetch有两种传参方式，需兼容
        if(typeof args[0]==='string'){
          // 方式1：fetch('http://xxx.com/api') → 第一个参数直接是URL字符串
          url = args[0]
        }else if(typeof args[0]==='object'){
          // 方式2：fetch(new Request('http://xxx.com/api')) → 第一个参数是Request对象  
          url = args[0].url          
        }

        if(url){
          requestKey = onRequestSend(url,'fetch').requestKey
          if(requestTrackUrlShouldCatch(url)){
            requestTrackKey = url+Date.now()
            // 清空之前的上报防抖定时器（避免多个请求完成时频繁上报）
            if(requestTrackTimer)clearTimeout(requestTrackTimer)

            requestTrackPool[requestTrackKey] = {
              method:args.method||'GET',
              url:url,
              pageUrl:window.location.href.split("?")[0],
              sendTime:Date.now(),
              state:'send',
            }
          }
        }

        // 调用原生fetch方法：透传this和参数，执行真实的网络请求
        oldFetch.apply(that,args).then(function(response){
          if(requestKey){
            afterRequestReturn(requestKey)
          }

          if(requestTrackKey){
            requestTrackPool[requestTrackKey].status = response.status
            requestTrackPool[requestTrackKey].state = 'complete'
            requestTrackPool[requestTrackKey].duration = Date.now() - requestTrackPool[requestTrackKey].sendTime
            if(requestTrackTimer) clearTimeout(requestTrackTimer)
            requestTrackTimer = setTimeout(()=>{
              if(hasAllRequestTrackReturned){
                requestInfoFilterAndReport()
              }
            },500)
          }

          // 透传原生fetch的成功结果：保证业务代码的then回调能拿到正常响应
          resolve(response)
        }).catch(function(err){
          // 首屏统计-请求失败：即使失败，也通知首屏统计该请求已完成（避免首屏统计卡死）
          if(requestKey){
            afterRequestReturn(requestKey)
          }

          if(requestTrackKey){
            // 失败状态码统一标记为0（区分正常状态码）
            requestTrackPool[requestTrackKey].status = 0
            requestTrackPool[requestTrackKey].state = 'complete'
            requestTrackPool[requestTrackKey].duration = Date.now() - requestTrackPool[requestTrackKey].sendTime
            if(requestTrackTimer)clearTimeout(requestTrackTimer)
              
            requestTrackTimer = setTimeout(()=>{
              if(hasAllRequestTrackReturned){
                requestInfoFilterAndReport()
              }
            },500)
          }

          // 透传原生fetch的失败错误：保证业务代码的catch回调能拿到错误信息
          reject(err)
        })
      })
    }
  }
}

/**
 * 定义劫持jsonp的主函数
 */
var overrideJsonp = function(onRequestSend,afterRequestReturn){
  // 全局去重Map：记录已处理过的JSONP script的src，避免重复监听（同一src多次创建script时）
  var requestMap = {}
  // 响应去重Map：记录已完成的首屏请求key，避免重复调用afterRequestReturn
  var responseMap = {}

  // 工具函数1：从DOM节点中提取有效的script地址（仅返回http/https开头的script src）
  var getScriptSrc = function(node){
    // 判断：是script标签 且 src以http开头（排除本地script、内联script、base64script）
    if(/script/i.test(node.tagName)&&/^http/.test(node.src)){
      return node.src
    }
    return ''
  }

  // 工具函数2：JSONP请求「完成/失败/超时」的统一处理函数
  var afterLoadOrErrorOrTimeout = function(requestKey){
    // 去重：该请求未处理过才执行统计回调（避免重复通知首屏统计）
    if(!responseMap[requestKey]){
      responseMap[requestKey] = true
      afterRequestReturn(requestKey)
    }
  }

  // 核心工具函数3：给单个script标签添加「加载/失败/超时」监听（仅处理JSONP的script）
  var addLoadWatcher = function(node){
    // 从node中提取有效src，无则直接返回
    var src = getScriptSrc(node)
    if(!src){return}
    // 过滤JSONP：调用全局的jsonp正则过滤器，判断该src是否是JSONP请求（排除普通js文件）
    if(!_global.jsonpFilter.test(src)){return}
     // 去重：该JSONP的src未处理过才执行后续逻辑
    if(!requestMap[src]){
      // 标记为已处理，避免重复监听   
      requestMap[src] = true
      var requestKey = onRequestSend(src,'jsonp').requestKey
       // 超时兜底：设置3000ms超时，即使JSONP加载失败/无响应，也强制标记为完成（避免首屏统计卡死）
      var timeoutTimer = setTimeout(function(){
        afterLoadOrErrorOrTimeout(requestKey)
        clearTimeout(timeoutTimer)
      },3000)

      // 跨浏览器兼容：监听script的加载状态（IE和现代浏览器的script事件不一致
      if(node.readyState){
        node.addEventListener('readystatechange',function(){
          if(script.readyState=='loaded'||script.readyState=='complete'){
            afterLoadOrErrorOrTimeout(requestKey)
            clearTimeout(timeoutTimer)
          }
        })
      }else{
        // 现代浏览器（Chrome/Firefox/Edge等）：支持load/error事件          
        // 监听script加载**成功**事件
        node.addEventListener('load',function(){
          afterLoadOrErrorOrTimeout(requestKey)
          clearTimeout(timeoutTimer)
        })
        // 监听script加载**失败**事件（网络错误、404、跨域等）
        node.addEventListener('error',function(){
          afterLoadOrErrorOrTimeout(requestKey)
          clearTimeout(timeoutTimer)
        })
      }
    }
  }

  // 工具函数4：查询页面中所有已存在的script标签，逐个执行回调（用于初始化监听已有script）
  var queryScriptNode = function(callback){
    // 获取页面中所有script标签（HTMLCollection类数组）
    var scripts = document.getElementsByTagName('script')
    // 转为真正的数组（SLICE是Array.prototype.slice的简写，外部全局定义）
    var scriptsArray = SLICE.call(scripts,0)
    // 遍历所有script，执行传入的回调（如addLoadWatcher）
    for(let i=0,len=scriptsArray.length;i<len;i++){
      callback(scriptsArray[i])
    }
  }

  // 核心：监听DOM变化，捕获**动态新增**的script标签（JSONP的核心是动态创建script）
  if(MutationObserver){
    // 现代浏览器：使用MutationObserver（原生DOM变化监听API，性能远高于轮询）
    // 全局保存观察者实例，方便后续销毁（如页面卸载时）
    _global.scriptLoadingMutationObserver = new MutationObserver(function(mutations){
      // 遍历所有DOM变化记录（that.forEach是外部全局的遍历方法，兼容Array.prototype.forEach）
      that.forEach(mutations,function(mutations){
        // 只处理「节点新增」的变化（JSONP是新增script，无需处理删除/属性变化）
        if(mutations.addNodes){
          // 遍历所有新增的节点，逐个添加JSONP监听
          that.forEach(mutations.addNodes,function(addNode){
            addLoadWatcher(addNode)
          })
        }
      })
    })

    // 启动观察者：监听document.body的子节点变化，且监听子树（body内部所有层级的节点）
    _global.scriptLoadingMutationObserver.observe(document.body,{
      attributes: false, // 不监听属性变化
      childList: true, // 监听子节点新增/删除
      subtree: true // 监听子树（body内部所有后代节点）
    })

    // 初始化：监听页面中**已存在**的script标签（避免页面加载时已有的JSONP未被监听）
    queryScriptNode(function(scriptNode){
      addLoadWatcher(scriptNode)
    })
  }else{
    // 低版本浏览器（如IE9及以下）：无MutationObserver，用setInterval轮询替代
    // 全局保存轮询定时器，方便后续销毁
    _global.scriptLoadingMutationObserverMockTimer = setInterval(function(){
       // 每200ms查询一次所有script标签，添加监听（轮询间隔兼顾性能和实时性）
      queryScriptNode(function(scriptNode){
        addLoadWatcher(scriptNode)
      })
    },200)
    
    // 初始化：同样监听页面中已存在的script标签
    queryScriptNode(function(scriptNode){
      addLoadWatcher(scriptNode)
    })
  }
}

// 定义方法queryAllNode，参数ignoreTag：需要忽略的标签（如['script','style']，格式由_shouldIgnoreNode决定）
var queryAllNode = function (ignoreTag){
  var that = this
  //创建DOM节点迭代器，赋值给result，这是浏览器原生API，用于高效遍历/过滤DOM节点
  var result = document.createNodeIterator(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    function(node){
      // 注释：判断当前节点及其所有父元素，是否是需要忽略的元素（调用内部方法_shouldIgnoreNode）
      if(!that._shouldIgnoreNode(node,ignoreTag)){
        // 接受该节点：让迭代器保留这个节点，后续可通过nextNode()获取
        return NodeFilter.FILTER_ACCEPT
      }
    }
  )
  // 返回创建好的节点迭代器：外部代码拿到后，可通过result.nextNode()逐个获取过滤后的有效元素节点
  return result
}