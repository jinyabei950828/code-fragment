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

//工具类
const util = {
  // 定义方法queryAllNode，参数ignoreTag：需要忽略的标签（如['script','style']，格式由_shouldIgnoreNode决定）
  queryAllNode:function (ignoreTag){
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
  },

  // 定义方法：从DOM节点提取图片地址，入参dom=目标节点，imgFilter=图片过滤规则
  getImgSrcFromDom:function (dom,imgFilter){
  var src 
  // 第一类：显性图片——判断当前节点是否是IMG标签（nodeName转大写避免大小写问题，如<img>/<Img>）
  if(dom.nodeName.toUpperCase()=='IMG'){
    src = dom.getAttribute("src")
  }else{
    // 第二类：隐性图片——非IMG节点，提取背景图地址
    // 获取节点的**计算后样式**（包含行内/外链/默认样式，比dom.style更全面，能拿到真实生效的样式）
    var computedStyle = window.getComputedStyle(dom)
     // 提取背景图样式：优先取background-image，无则取background（background是复合样式，可能包含图片）
    var bgImg = computedStyle.getPropertyValue("background-image")||computedStyle.getPropertyValue('background')
     // 调用内部方法：从背景图样式字符串中解析出真实图片地址（如从url("xxx.jpg")中提取xxx.jpg）
    var tempSrc = this._getImgSrcFromBgImg(bgImg,imgFilter)
    // 双重校验：解析出了临时地址 + 该地址符合图片过滤规则（是有效图片）
    if(tempSrc&&this._isImg(tempSrc,imgFilter)){
      src = tempSrc
    }
  }
  return src
  },

  // 定义方法：判断节点是否在首屏范围内，注释的currentNode是预留入参（实际未使用，用this.currentPos取位置）
  isInFirstScreen:function(){
    // 核心判断1：节点隐藏（display:none/visibility:hidden等）→ top和bottom均为0，直接返回false（隐藏节点无需统计）
    if(!this.currentPos.top&&!this.currentPos.bottom){
      return false
    }

    // 获取浏览器**可视区域高度**、可视区域宽度
    var screenHeight = window.innerHeight
    var scrrenWidth = window.innerWidth

    //页面垂直滚动距离、节点自身的顶部偏移、节点自身的左侧偏移、节点自身的右侧偏移
    var scrollTop = this.currentPos.scrollTop
    var top = this.currentPos.top
    var left  = this.currentPos.left
    var right = this.currentPos.right

    // 核心判断2：结构上是否在首屏内（同时满足垂直+水平条件，缺一不可）
    // 垂直：滚动距离+节点顶部 < 可视区域高度 → 节点顶部在首屏内
    // 水平：节点右侧>0 且 节点左侧<可视宽度 → 节点水平方向和首屏有重叠
    if((scrollTop+top<screenHeight&&right>0&&left<scrrenWidth)){
      return true
    }

    // 不满足，返回false（非首屏）
    return false
  },

  //轮询获取首屏图片的性能时间，入参包含全局对象、图片列表、成功/失败回调
  cycleGettingPerformaceTime:function(_global,firstScreenImages,callbackWithImages,callbackWithoutImages){
    // 轮询次数限制：最多轮询5次（每次1秒，总计5秒超时），避免无限轮询
    var fetchCount = 5

     // 保存当前对象的this → 内部闭包函数中访问当前对象的方法（解决this丢失）
    var that = this
    // 格式化图片地址：去掉协议/前缀（如http/https）→ 便于和performance.getEntries()返回的地址匹配（部分浏览器返回的地址无协议）
    var protocalRemovedFirstScreenImages = that.formateUrlList(firstScreenImages,'remove')

    //有效性能数据时，执行成功回调（封装回调逻辑，避免重复代码）
    var runCallbackWithImages = function(firstScreenImagesDetail){
      // 取最晚完成的图片时间 → 数组已倒序，第一个元素的responseEnd是最大值（首屏图片时间）
      var resultResponseEnd = firstScreenImagesDetail[0].responseEnd

      // 异常数据过滤：过滤无效的responseEnd（避免浏览器兼容问题导致的错误数据）
      // 有效条件：>0（已加载） && <1000*1000（不是时间戳，是相对时长，单位ms）
      if(resultResponseEnd>0&&resultResponseEnd<1000*1000){
        callbackWithImages({
          firstScreenTime:parseInt(resultResponseEnd),// 首屏图片时间（取整，ms）
          firstScreenTimeStamp:parseInt(resultResponseEnd)+_global._originalNavStart,// 绝对时间戳（相对时间+页面导航开始时间）
          firstScreenImagesDetail:firstScreenImagesDetail // 所有首屏图片的性能详情
        })
      }
    }

    //单次获取性能数据的逻辑（轮询时重复执行）
    var getPerformanceTime = function(){
      // 步骤1：获取浏览器所有已加载资源的性能条目 → 包含图片/JS/CSS/接口的加载时间（responseEnd/startTime等）
      var source = performance.getEntries()

      // 步骤2：匹配首屏图片 → 从性能条目中筛选出首屏图片的性能数据（未去重）
      var ununiqueDetail = that._getUnuniqueDetailFromSource(source,protocalRemovedFirstScreenImages,_global.img)
      var firstScreenImagesDetail = []

      // 步骤3：图片去重 → 遍历未去重数据，生成src映射表（key=图片地址，value=性能条目索引）
      var scrMap = that._getSrcMapFromUnuniqueDetail(ununiqueDetail)

      // 步骤4：生成去重后的首屏图片性能详情数组
      var firstScreenImagesDetail = that._getUniquedFirstScreenDetail(ununiqueDetail,srcMap)

      // 步骤5：倒序排序 → 按responseEnd（加载完成时间）从大到小，最晚完成的在第一个
      firstScreenImagesDetail.sort(function(a,b){
        return b.responseEnd - a.responseEnd
      })

      // 步骤6：轮询次数减1
      fetchCount--

      // 分支1：未超时（还有轮询次数）
      if(fetchCount>=0){
        // 所有首屏图片都匹配到性能数据 → 无需继续轮询，清空定时器并执行成功回调
        if(firstScreenImagesDetail.length===protocalRemovedFirstScreenImages.length){
          clearInterval(timer);
          runCallbackWithImages(firstScreenImagesDetail)
        }
      }else{
        // 分支2：已超时（5次轮询结束）
        if(firstScreenImagesDetail.length>0){
          // 虽超时，但匹配到部分图片数据 → 执行成功回调（用已有数据）
          runCallbackWithImages(firstScreenImagesDetail)
        }else{
           // 超时且无任何有效数据 → 执行失败回调
          callbackWithoutImages()
        }
        // 清空定时器，结束轮询
        clearInterval(timer)
      }
    }

     // 步骤7：开启轮询定时器 → 每1000ms执行一次getPerformanceTime，采集性能数据
    var timer = setInterval(getPerformanceTime,1000)

    // 步骤8：立即执行一次 → 无需等待1秒，减少统计延迟
    getPerformanceTime();
  },

  //无图首屏时，获取DOM就绪时间（DOMContentLoaded），入参=全局对象+结果回调
  getDomReadyTime:function(_global,callback){
    //轮询计数器:记录已轮询次数，用于兜底终止
    var count = 0;

    // 定义轮询核心处理函数：判断数据有效性并执行回调
    var handler = function(){
      // 核心判断：DOMContentLoaded事件开始时间是否有效（非0=事件已触发）
      // performance.timing.domContentLoadedEventStart：DOM结构加载完成的时间戳（相对于页面导航开始）
      if(performance.timing.domContentLoadedEventStart!=0){
        callback(performance.timing.domContentLoadedEventStart,'domContentLoadedEventStart')
      }

      // 轮询终止条件：计数器≥50次（总计25秒） OR 数据已有效 → 清空定时器，结束轮询
      if(++count>=50||performance.timing.domContentLoadedEventStart!=0){
        clearInterval(timer)
      }
    }

    // 开启轮询定时器 → 每500ms执行一次handler，采集数据（兼顾实时性和性能）
    var timer = setInterval(handler,500)
    // 立即执行一次handler → 无需等待500ms，减少统计延迟
    handler()
  }

}


// 定义主函数：筛选首屏内的所有有效图片（下划线表示内部私有方法，外部不直接调用）
function _getImgInFirstScreen(){
  // 获取浏览器可视区域高/宽
  var screenHeight = window.innerHeight
  var screenWidth = window.innerWidth

  // 设备信息上报：将屏幕宽高写入全局对象_global，仅执行一次（首屏统计的基础数据）
  _global.device.screenHeight = screenHeight
  _global.device.screenWidth = screenWidth

  // 步骤1：获取DOM节点迭代器 → 调用之前的queryAllNode，过滤掉_global.ignoreTag指定的标签（如script/style）
  var nodeIterator = util.queryAllNode(_global.ignoreTag);
  // 步骤2：初始化迭代器，获取第一个过滤后的有效DOM节点
  var currentNode = nodeIterator.nextNode()
  // 步骤3：声明数组imgList → 存储首屏内的有效图片地址（用于去重和最终返回）
  var imgList = []

  // 定义内部回调：处理找到的图片地址（去重+过滤网络图片
  var onImgSrcFound = function(imgSrc){
    // 解析图片地址的协议（如http/https/ftp/base64）→ 调用util的URL解析方法
    var protocol = util.parseUrl(imgSrc).protocol;
    // 过滤：仅保留http/https开头的**网络图片**（排除base64/dataURL/本地图片，这类无需网络请求）
    if(protocol&&protocol.indexOf('http')===0){
      // 去重：图片地址未在imgList中，才加入（避免同一图片多次统计）
      if(imgList.indexOf(imgSrc)===-1){
        imgList.push(imgSrc)
      }
    }
  }

  // 步骤4：循环遍历所有DOM节点 → nextNode()返回null表示遍历结束
  while(currentNode){
    // 4.1 提取当前节点的图片地址 → 调用getImgSrcFromDom，传入全局图片过滤规则
    var imgSrc = util.getImgSrcFromDom(currentNode,_global.img)

     // 4.2 无有效图片地址 → 跳过当前节点，继续遍历下一个
    if(!imgSrc){
      currentNode = nodeIterator.nextNode();
      continue;
    }

    // 4.3 记录当前节点的位置信息 → 调用util.recordCurrentPos，将位置存入this.currentPos（为isInFirstScreen准备）
    util.recordCurrentPos(currentNode,_global);

    // 4.4 判断节点是否在首屏内 → 调用isInFirstScreen
    if(util.isInFirstScreen(currentNode)){
       // 在首屏内 → 处理图片地址（去重+过滤网络图片）
      onImgSrcFound(imgSrc)
    }else{
      // 非首屏 → 统计非首屏图片信息（存入_global.ignoredImages，用于后续性能分析/上报）
      var currentPos = util.currentPos
      _global.ignoredImages.push({
        src:imgSrc, // 非首屏图片地址      
        screenHeight:screenHeight,  // 设备屏幕高度      
        screenWidth:screenWidth, // 设备屏幕宽度
        scrollTop:currentPos.scrollTop, // 滚动距离   
        top:currentPos.top, // 节点顶部偏移     
        bottom:currentPos.bottom, // 节点底部偏移          
        vertical:(currentPos.scrollTop+currentPos.top)<=screenHeight,//垂直方向是否接近首屏 
        left:currentPos.left, // 节点左侧偏移    
        right:currentPos.right, // 节点右侧偏移  
        horizontal:currentPos.right>=0&&currentPos.left<=screenWidth // 水平方向是否接近首屏
      })
    }

    // 4.5 遍历下一个节点，进入下一次循环
    currentNode = nodeIterator.nextNode()
  }

  // 步骤5：格式化图片列表 → 调用util.formateUrlList，补全协议/去掉多余前缀（为后续匹配performance数据准备）
  return util.formateUrlList(img,'add')
}