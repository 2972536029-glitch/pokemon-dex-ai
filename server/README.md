# 宝可梦图鉴 AI 版 — 面试讲解手册

> 这份文档是给**你自己**用的:面试官问"具体怎么做的?为什么这么做?"时,
> 每个答案都能在这里找到落点。代码里的英文注释是行级说明,这里是设计层的 why。

## 一句话定位

在已上线的宝可梦图鉴上加了一个 AI 问答助手:用户用自然语言提问,模型通过
**Function Calling** 实时调 PokeAPI 查数据后回答,回答流式输出,并有一层
**幻觉校验**对数值做机械核对。

## 架构(30 秒版)

```
浏览器 (React)                Node/Express 服务端                 外部
┌─────────────┐   POST /api/chat   ┌──────────────┐   tools    ┌─────────┐
│ useChat      │◀────SSE 流────────│ agent.ts 循环 │──────────▶│ PokeAPI │
│ (手写SSE解析)│    delta/tool/... │  ↓ 每个 tool  │            └─────────┘
└─────────────┘                    │  结果进事实表  │   chat      ┌─────────┐
                                   │ guard.ts 校验 │◀──stream───│ GLM API │
                                   └──────────────┘             └─────────┘
```

key 只在服务端。前端只渲染 SSE 事件流,不参与工具编排。

## 必考问题 & 答法

### 1. 工具 schema 怎么设计的?为什么是这 4 个?

`get_pokemon` / `get_evolution_chain` / `get_type_matchup` / `list_pokemon_of_type`。

- **枚举消除一类幻觉**:type 参数用 JSON Schema `enum`(18 属性全列),模型
  根本没机会传 "electrico" 这种不存在的值。参数越自由,校验负担越重——能用
  枚举的绝不裸 string。
- **工具按"问题类型"切,不按接口切**:查数据(get_pokemon)、查进化(要多级
  串接,工具内部消化掉 species→chain 的两次跳转)、查克制(回答"什么克水")、
  找候选(回答"推荐几只")。模型面对的问题语言到工具的映射越短,出错越少。
- **返回值裁剪**:PokeAPI 一只宝可梦的原始 JSON 有 50+ 字段,我只回 8 个——
  噪声少 = token 少 = 模型更难"看走眼"。这是上下文经济(context economy)。
- **错误是数据不是异常**:404 回给模型 `{error:"not_found", hint:"用英文名"}`,
  模型可以自己重试(比如把中文名换掉),循环不至于崩。

### 2. Agent 循环怎么跑的?怎么防止失控?

`agent.ts`:发消息 → 模型要么给文本要么给 tool_calls → 执行工具(并行的,
`Promise.all`,比较类问题天然多查几只)→ 结果以 `role:"tool"` 追加 → 重新调用
模型 → 直到模型给出最终回答。

三道闸:
1. **MAX_ROUNDS = 4**:模型反复要工具的"失控螺旋"被硬切断;
2. **AbortSignal 全链路**:用户关面板/断网,`req.on("close")` 触发 abort,
   LLM 流和飞行中的 PokeAPI 请求一起取消,不为没人看的答案付费;
3. **历史裁剪保安全边界**:只带最近 12 条,且裁剪点必须落在 user 消息上——
   把 assistant(tool_calls) 和它的 tool 结果裁开会产出"孤儿 tool 消息",
   API 直接 400。

### 3. 幻觉校验怎么做的?(本项目的差异化)

痛点:提示词("只用工具数据")能降低但不能消灭编造数值。所以校验是**机械的**,
不是祈祷式的:

1. 每个工具结果登记进事实表(facts);
2. 最终回答按句切分,找「提到某只宝可梦 + 出现数值属性关键词(HP/攻击/体重…)
   + 句中数字」三元组,拿数字对事实表;
3. 不一致 → 带着"正确值"重新生成**一次**(工具被禁用,逼它改文本而不是再查);
4. 还不一致 → 流式追加"⚠️ 部分数据与图鉴不符"的可见警示。

两条保守原则:**宁漏判不误判**(解析不了的数字记为"未核对"而不是"错",
误判会触发不必要的重生成);**比较句直接跳过**("比皮卡丘重 3 公斤"里的 3
是差值不是图鉴值,核对它必误报)。

边界要诚实:只核对数值断言,类型克制这类语义断言 v1 没做(那需要 NLP 或
结构化输出约束,是明确的后续方向)。被问到就说:校验器管的是最容易被编、
也最容易机械验证的那部分。

### 4. SSE 流式怎么实现的?

- 服务端 `text/event-stream` + `no-transform` + `X-Accel-Buffering: no`
  (防 nginx/CDN 缓冲把打字机效果缓冲成一大块),15s 一次 `: ping` 心跳
  (防代理掐掉"空闲"连接);
- **断连检测的坑**:Node 的 `req` 的 `close` 事件在请求体读完时就触发,
  不是客户端断开——拿它当断连信号会把每个请求秒 abort。要用 `res` 的
  `close` + `writableEnded` 区分"正常结束"和"客户端跑了";
- 前端不用 EventSource(它只支持 GET,聊天要 POST JSON),用 fetch +
  ReadableStream 手写解析:**chunk 会把一个事件劈成两半**,必须缓冲后按
  `\n\n` 切——这是 SSE 最经典的坑,前后端各写了一遍解析;
- 事件是类型化的:`delta`(文本增量)/ `tool`(工具状态) / `replace`
  (校正后整段替换)/ `error` / `done`(带校验结果)。

### 5. 失败兜底?

分层兜底,每层用户都能看懂:
- PokeAPI 404 → `{error:"not_found"}` 喂回模型 → 模型自己说"查不到";
- PokeAPI 超时/5xx → `upstream_unavailable`,模型如实转告;
- GLM 401/403/429/5xx → 映射成人话("模型限流了,请稍等")走 `error` 事件;
- 流中途断(服务重启)→ 前端兜底:不留"转圈中"的僵尸气泡,标记中断;
- 用户主动停止 → AbortError → 气泡标"已停止回答"。

### 6. 为什么不用 LangChain / Vercel AI SDK?

需要的 API 面就一个 endpoint + 一个工具循环,手写约 700 行拿回全部可解释性;
SDK 会把 tool_calls 分片拼装、SSE 解析、循环控制藏起来——而那些恰恰是这个
项目要展示的东西。反过来也答得出"什么时候该用 SDK":产品化、多模型路由、
复杂 RAG 链时,自研维护成本不划算。

### 7. mock 模式是干嘛的?

`MOCK_LLM=1` 或未配 key 时自动进入:mock 模型生成脚本化的 tool_call,但
**工具层走真实 PokeAPI**,回答文本从真实工具结果里拼——整条链路(循环、
SSE、校验、UI)都被真实演练,只是不花模型的钱。无 key 演示、回归测试都用它。

## 本地跑通

```bash
npm install
npm run dev:ai        # 终端1:AI 服务 :5178(无 key 自动 mock 模式)
npm run dev           # 终端2:Vite :5177(/api 代理到 5178)

# 真实模型:复制 .env.example 为 .env.local,填 GLM_API_KEY(bigmodel.cn 免费)
npm run build         # 产物:dist/ + server/dist/
npm start             # 单进程生产模式:Express 托管静态 + API
```

## 部署

单进程 Express(静态 + API 一个端口),任选:
- 任意 VPS:`docker build -t pokedex-ai . && docker run -p 3000:3000 -e GLM_API_KEY=xxx .`
- PaaS(Node 运行时):build 命令 `npm run build`,start 命令 `npm start`
- 静态已托管 EdgeOne 的话,把 API 单独部署后给前端配 `/api` 反代或 `ALLOW_ORIGIN`
