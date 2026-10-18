# QA 发现台账 · Phase 1

> 唯一台账,只增不改;修复合入后更新状态行。
> 第 1 轮:全新上下文只读评审(2026-09-24)→ 1 P1 + 12 P2;第 2 轮:复核销项 13/13 + 3 条 P3 已修;
> 第 3 轮(v1.2.x 回归猎茬,2026-09-24):QA-017~028,其中 P2×3 已修(并发回合乐观锁/AI 阵容 sprite/测试断言反向),P3×11 已修或记录为观察项。

| 编号 | 里程碑 | 级别 | 责任 | 位置 | 描述 | 修法 | 状态 |
|---|---|---|---|---|---|---|---|
| QA-001 | Phase1 | **P1** | 前端 | src/main.jsx:11-15 | 遗留调试脚手架:2 秒后污染 document.title(RENDER TICK/UNCAUGHT 测试钩子) | 整块删除 | 已修复(QA 第2轮复核销项) |
| QA-002 | Phase1 | P2 | 后端 | server/src/tools-user.ts:20 | SELECT 漏 c.zh_name,官方中文名永远到不了模型,只有手写别名生效 | SELECT 补 c.zh_name | 已修复(QA 第2轮复核销项) |
| QA-003 | Phase1 | P2 | 后端 | server/src/auth.ts:41-54 | 限流 Map 只增不删,长期运行无界增长(内存泄漏) | 过期即删 + 容量上限清扫 | 已修复(QA 第2轮复核销项) |
| QA-004 | Phase1 | P2 | 后端 | server/src/gacha.ts:120 | 同一 orderId 真并发:第二笔撞订单 PK → 500 而非重放 | 捕获 23505 走重放分支 | 已修复(QA 第2轮复核销项) |
| QA-005 | Phase1 | P2 | 前端 | src/views/PacksView.jsx | 幂等键绑定"点击"而非"购买意图":响应丢失后再点 = 新键真双扣 | orderId 绑定意图,成功后才轮换 | 已修复(QA 第2轮复核销项) |
| QA-006 | Phase1 | P2 | 前端 | src/views/PacksView.jsx:53-62 | claimDaily 无 catch;granted=false 静默无反馈 | try/catch + 到账提示 | 已修复(QA 第2轮复核销项) |
| QA-007 | Phase1 | P2 | 前端 | src/views/CollectionView.jsx:12-21 | effect 无 cancelled 标志,慢响应可能覆盖新账号列表(竞态) | cancelled 标志 | 已修复(QA 第2轮复核销项) |
| QA-008 | Phase1 | P2 | 前端 | src/chat/useChat.js:15-20 | TOOL_LABELS 缺 3 个新工具,chip 露英文原名 | 补中文标签 | 已修复(QA 第2轮复核销项) |
| QA-009 | Phase1 | P2 | 后端 | server/src/routes-phase1.ts:56-75 | register/login 兜底 catch 把未知 err.message(如 ECONNREFUSED)回给客户端 | 无 status 的错误统一友好文案,详情进日志 | 已修复(QA 第2轮复核销项) |
| QA-010 | Phase1 | P2 | 后端 | server/src/routes-phase1.ts 多处 | /api/me、wallet×2、collection、logout 六个 handler 无 try/catch,DB 中途故障返回默认错误页 | 统一 async 包装捕获 | 已修复(QA 第2轮复核销项) |
| QA-011 | Phase1 | P2 | 后端 | server/src/gacha.ts:48 | 每日奖励硬编码 50,与 AUTH_CONSTANTS.DAILY_BONUS 双份真相 | 引用常量 | 已修复(QA 第2轮复核销项) |
| QA-012 | Phase1 | P2 | 后端 | db/schema.sql:68 | idx_user_cards_user 冗余(PK 前缀已覆盖),纯写放大 | 删除 | 已修复(QA 第2轮复核销项) |
| QA-013 | Phase1 | P2 | 后端 | db/schema.sql:14 | 注释 salt$hash 与实际格式 salt:hash 不符 | 改注释 | 已修复(QA 第2轮复核销项) |

运行时证据(主代理):API E2E 19/19 PASS(脚本 /d/xsolla/qa-e2e.sh,结果 qa-e2e-result.txt);浏览器 UI 登录/商店/收藏/顾问问答实测通过;tsc 与 vite build 零报错。

| QA-014 | Phase1 | P3 | 后端 | server/src/routes-phase1.ts:73/92 | 内层友好文案被 wrap 500 分支覆盖(死代码) | 简化为直接 rethrow | 已修复 |
| QA-015 | Phase1 | P3 | 前端 | src/views/PacksView.jsx | 前端硬编码 +50,未消费 API 下发的 dailyBonus | 消费 API 值 | 已修复 |
| QA-016 | Phase1 | P3 | 前端 | src/views/PacksView.jsx:33 | randomUUID 在 try 外,非安全上下文可能卡死 busy | 移入 try | 已修复 |


## 第 3 轮发现(v1.2.x 推演模式回归猎茬)

| 编号 | 级别 | 责任 | 位置 | 描述 | 修法 | 状态 |
|---|---|---|---|---|---|---|
| QA-017 | P2 | 后端 | routes-battle.ts | 同一战斗并发 turn 的 TOCTOU:双请求双结算,临近胜利奖励双发;与 forfeit 并发可复活已结束战斗 | UPDATE 加 `AND status='active'` + rowCount 判定(乐观锁) | 已修复(复核销项) |
| QA-018 | P2 | 后端 | routes-battle.ts:116 | AI 阵容 SELECT 漏 c.sprite,对手卡牌永远无图 | 补列 | 已修复(复核销项) |
| QA-019 | P2 | 测试 | qa/e2e.mjs:146 | R3 断言逻辑反向:干净的模型理由必然假失败 | 改为"理由与真实 AI 行动同回合配对"断言 | 已修复 |
| QA-020 | P3 | 后端 | battle-ai.ts | JSDoc 声称 Never throws 与实现相反 | 修正注释 | 已修复 |
| QA-021 | P3 | 后端 | routes-battle.ts | 战斗日志回合号取结算后的 turn,编号错位 | 结算前快照 turnNo | 已修复 |
| QA-022 | P3 | 前端 | BattleView.jsx:157 | 胜利横幅 `reward ?? 100` 硬编码兜底(重蹈 QA-015) | 无快照时不显示具体数字 | 已修复 |
| QA-023 | P3 | 前端 | BattleView/CollectionView | startBattle/forfeit/saveTeam 无 catch 或不读错误体,失败静默 | 补 catch + 错误展示 | 已修复 |
| QA-024 | P3 | 后端 | battle-ai.ts | 守卫边界:换人理由不核对、关键词可同义绕过 | 设计即 best-effort,记录备查 | 已记录(观察项) |
| QA-025 | P3 | 后端 | routes-battle.ts | req_abort 空壳信号:客户端断开不取消 LLM 调用(≤12s) | 接 req close → AbortController | 已修复 |
| QA-026 | P3 | 后端 | battle-ai.ts:88 | `as never` 类型洗白绕过 LlmMessage 检查 | buildMessages 标注返回类型 | 已修复 |
| QA-027 | P3 | 前端 | BattleView.jsx | resume 忽略请求的 mode(静默复用旧模式战斗) | 观察项:复用语义已由 resumed 标注 | 已记录(观察项) |
| QA-028 | P3 | 文档 | docs/updates/v1.2-battle-sim.md | 设计稿与实现漂移(表结构/伤害声明核对/非法行动语义) | 补"实现偏差记录"节 | 已修复 |
| QA-029 | P2 | 后端 | routes-battle.ts(QA-017 修复引入) | forfeit 只更新 status 列,漏改 state JSONB 内的 status → GET 返回 lost 战斗却自称 active(第三轮回归抓到) | jsonb_set 同步补丁 | 已修复(36/36 复验) |

# M2 验收(首页大厅 + 无限金币测试号 + 战斗健化 + 移动端减负)· 2026-10-02

> QA 全新上下文只读评审,靶子 docs/acceptance.md「M2」20 条:全部通过。
> 历史抽查 QA-004/005/007/017/029 修复均在,无回归。以下为验收过程新发现:

## QA-030 [P2] 后端 /api/health 公开泄漏 dbError 原文
- 位置:server/src/app.ts:36-44
- 描述:health 响应把数据库驱动错误信息截断 200 字符直出给未认证访客
- 修法:响应只保留 db:"error",细节写日志
- 状态:已修复(799c86e,QA 复核销项确认)

## QA-031 [P3] 文档 design-v1.3.md:45 残留旧立绘 CDN 地址
- 描述:仍记录 raw.githubusercontent,易误导后来者
- 修法:整行替换为 jsDelivr 完整地址,注记置于 URL 外(首修把注记拼进 URL 中间,QA 复核打回后二次修复)
- 状态:已修复(QA 复核销项确认)

## QA-032 [P3] .gitignore 未用 .env* 通配
- 位置:.gitignore:8,13
- 描述:未来新增 .env.production 等不会被忽略
- 修法:改 .env* 并配 !.env.example
- 状态:已修复(799c86e,QA 复核销项确认;QA 备注:原第 11 行残留纯空格行,无害)

## QA-033 [P0] wallet_tx CHECK 约束拒绝 kind='battle' —— 每次对战获胜必 500
- 位置:server/src/schema.ts(建表 CHECK)+ routes-battle.ts:245(获胜奖励插入)
- 发现方式:用户报错后经 CUA 遥控其浏览器 DevTools,控制台证实 /turn 500 ×N;再经 Vercel 面板运行时日志展开拿到完整栈:wallet_tx_kind_check 违约
- 根因:v1.2 加对战奖励时用 kind='battle' 写 wallet_tx,但建表 CHECK 只有 ('signup','daily','gacha');获胜→奖励插入→约束拒绝→事务回滚→500(重试同因再炸)
- 修法:CREATE TABLE 补 'battle';迁移段幂等 DROP+ADD 约束;本地库验证 INSERT kind='battle' 成功
- 状态:已修复(ea5a235)→ 生产端到端验证:probe 号实战获胜,balance +100 入账,零 500 → 销项
- 教训:发奖路径从未被 E2E 覆盖(探测号从未获胜过),检查约束这类 DDL 逻辑改代码时必须同步审

# 对战页内置编队编辑器验收 · 2026-10-07

> 功能:战前页「调整编队」展开内置编辑器(全部收藏卡网格,点选换上/换下,恰好 3 只,保存 POST /api/battle/team 后原地刷新队伍,无需跳转收藏页)。ca3059f 部署生产。

## QA-034 [验收通过] 战前页内置编队编辑器 端到端
- 生产环境(123456 号)IAB 实测:
  1. 「调整编队」→ 面板展开,按钮变「收起编辑器」;网格 30 张收藏卡渲染正常(立绘/中文名/稀有度标签)
  2. 点选 超梦/快龙/喷火龙 → 金色边框 + ✓,「已选 3/3」;保存按钮从 disabled 变可用
  3. 「保存编队」→ POST /api/battle/team 成功,面板自动收起,队伍条原地变为 mewtwo/dragonite/charizard
  4. 「开始对战(规则对手)」→ 战斗以快龙为首发(151/151),替补栏显示 超梦(166/166)+喷火龙(138/138)——服务端编队已落库
- 备注:IAB 验证环境注意——该站开屏动画导致 Playwright actionability 点击恒超时(froze force click 同样),须 CUA 坐标或 evaluate 内 el.click();React 批处理后同步读 DOM 是旧渲染,读状态须待下一帧
- 状态:验收通过,销项

# v2.1 开包仪式 v3 验收(十连的仪式感)· 2026-10-07

> 背景:用户反馈「十连没有单抽的仪式感」。设计文档 docs/updates/v2.1-gacha-ceremony.md,T1-T7 全过。aba8add 部署生产。

## QA-035 [验收通过] 十连撕包仪式 + 稀有度升序揭示 + UR 压轴
- 本地(ceremony1 号,IAB 实测):
  1. 单抽四幕不回归;炸开粒子吃稀有度染色(burst 即挂 ark-r-*,摇晃段保持中性不剧透)
  2. 十连:点下即出包摇晃(请求并行,与单抽同速)→ 点击拆开 → 炸开 → 5×2 卡背阵列(纯 CSS 精灵球卡背)→ C→R→UR 逐张翻开(C 380ms/R 500ms/UR 前心跳停顿 1s)
  3. UR 压轴三件套:全屏金光闪(ten-ur-flash)+ 卡位金环(is-ur-hit::after)+ 屏幕边缘脉冲(stage::before)——截图命中闪光瞬间;传说包十连保底 UR 翻开顺序正确(压轴)
  4. 跳过动画:pack 阶段直达全开(bulk 阶梯 45ms/张);数据未到时先记 skipRef,到达直接全开(竞态已防)
  5. 缺口十连:余额 180 → 3 张 + 文案「金币只够 3 抽,已入账 · 最佳 常见 (C)」
  6. 移动端 390px:5×2 网格不溢出
  7. 连抽多次余额精确递减;E2E 36/36 + 引擎 17/17 回归绿
- 生产(123456 号,传说包十连):点下即出包 → 撕开 → 卡背阵列 → 「翻开中 3/10」→ 完成态「最佳 超稀有 (UR)」10/10(本包 2 张 UR)。验证中本机到 vercel.app 网络两次抖动致页面重载,DOM 证据先行采到
- 过程改进:首版 handleTenPull 在请求返回后才出包(与单抽不一致),重构为请求与摇晃并行——顺带修了"跳过按钮先于数据到达"的竞态
- 状态:验收通过,销项

# v2.2 好友系统验收 · 2026-10-07

> 计划书 docs/updates/v2.2-friends.md(8ec507e 先行推送留痕)。F1-F12 全过,后端 E2E 43 断言(qa/friends-e2e.mjs)。

## QA-036 [验收通过] 双向同意好友 + 赠送/索要 + 异步好友对战
- 后端(qa/friends-e2e.mjs 43/43):单向申请不生效/互发自动通过/重复 409/自加 400;删除好友双向消失且挂起 trade 自动拒绝;赠送-1/+1 交割、编队唯一张拒赠、索要方向正确;非好友 403;未持有卡拒;重复处理幂等;好友战胜负奖励 100/20、平 50、每日 10 场封顶;无关者看不了战报;E2E 36/36 + 引擎 17/17 无回归
- 前端(本地 ceremony1,IAB 实测):好友页五区块;导航「好友」红点=待处理申请+战书;应战→5×N 选卡格(份数角标/稀有度章)→3 只→服务端模拟→战报弹窗(22 行真实回合日志,胜利金章);接受赠送即离场;完赛可回看战报;删除好友带确认
- 生产(123456):#/friends 空态/添加栏/三区块正常(edfde5b 部署 Ready)
- 过程修的三个真 bug:①BIGSERIAL→JS 字符串,`to_uid !== me.id` 严格比较全炸(requireUser 归一 Number);②user_teams.card_ids 是 integer[],`@> to_jsonb()` 报 operator 不存在,改 `ANY()`;③chooseAiAction 写死操作 aiTeam,好友战双方若各调一次会双控被挑战方——重写对称 actionFor
- 已知瑕疵:战报日志 "AI 对手" 措辞沿用 PvE 文案(见 v2.2 文档回填)
- 状态:验收通过,销项

# v2.2 移动端适配 + 奖励封顶修正 · 2026-10-08

## QA-037 [已修复] 移动端三处布局 + PvP 奖励封顶失效 + E2E 两处假绿
- 移动端(390×844 IAB 实测,本地+生产):
  1. 底栏 grid 写死 5 列,加「好友」后第 6 项折到第二行 → repeat(6, 1fr)
  2. 开屏主标题 clamp 下限 38px+6px 字距,390px 屏"冒险"被裁 → 640px 以下 clamp(22px,8vw,38px)+2px 字距,CTA/副标题同步缩
  3. 好友弹窗(选卡/战报)页脚被长网格埋进滚动区 → 弹窗改 flex 列:标题/页脚钉死,网格与日志内部滚动(86dvh);ts-link 窄条不折行
  4. 全站 390px 巡检 home/packs/collection/battle/dex/friends 横向溢出均为 0;编队编辑器 3 列网格、好友行按钮折行正常
- PvP 奖励封顶失效(真 bug):rewardable 用 date_trunc('day', now()) 按**服务器 UTC**取整,UTC+8 用户的"今天"与 UTC 错位,计数永远不满 10 → 改**滚动 24 小时窗口**(now() - interval '24 hours'),速率限制无时区边界可钻
- E2E 假绿两处(friends-e2e):
  1. balance() 调了不存在的 /api/auth/me(SPA fallback 返 HTML)→ 奖励断言空集恒真 → 改 /api/me
  2. 封顶检查用**相对基线的累计差**(前 9 场的增量永远非零,第 11 场不发奖也判不出)→ 改逐场边际差
  - 服务器侧正确性由钱包对账独立证明:13 场完赛恰好 10 笔 battle 入账
- 教训:E2E 断言要防"空集恒真"(先证明度量非空);时区相关的"每日"逻辑在 UTC 服务器上必须显式声明时区或用滚动窗口
- 状态:已修复(79c1f11),生产 390px 复验通过(底栏 6 项单行/开屏标题完整/好友页零溢出),销项

# 主页与底栏重叠修复(用户朋友反馈)· 2026-10-08

## QA-038 [已修复] 移动端主页尾部与底栏/悬浮球交叠 + 主页首屏重排
- 反馈:主页内容和底部导航栏重叠。实测(390×844):内容底部距底栏仅 **4px**(shell 预留 56px vs 栏实高 52px,安全区/系统缩放即穿帮);「问图鉴」悬浮球直接盖住最后的「去抽卡」按钮
- 修复(fb4f76e):
  1. shell 底部预留 56→78px(+safe-area),主页再加 30px 给悬浮球让位——修后按钮距底栏 **80px**,悬浮球不再压按钮(生产 123456 实测)
  2. 主页移动端重排:hero 紧凑化(标题 clamp 20-26px、CTA 加宽),**四宫格入口第一屏完整可见**(原来要滚一屏半);入口卡触屏去装饰(隐藏描述与 hover 专属"进入→",58px 头像)
  3. 桌面端(>760px)零改动:hero 原padding、描述可见、底栏隐藏,已回归确认
- 全站 390px 溢出巡检:home/packs/collection/battle/dex/friends 全 0
- 状态:已修复,生产复验通过,销项

# v2.3 底层优化 + 安全加固 + 高内聚低耦合 · 2026-10-08

> 审计先行(两份子代理事实清单:server 21 文件 4241 行 / src 全量),五阶段推进,全程 4 套件守护(v23 24 + e2e 36 + friends 43/44 + engine 17)。

## QA-039 [已修复/重构完成] 共享内核 + 安全加固 + 性能
### 内聚(阶段1,b40235a)
- server/src/http.ts:HttpError/wrap(domain)/requireUser 收编三份 wrap 拷贝、两种 requireUser、七处内联 401;错误契约规范化({error: 机器码, message}),tenpull "message 当 code" 修复
- auth.ts/GachaError 全部迁 HttpError;GachaError 死字段 __dbg 移除
- wallet.ts addWalletTx 收敛 5 处钱包写点;cards.ts loadCardsByIds/ById 收敛 4 处卡片 SELECT(审计报 6 处,其中 2 处是按稀有度随机池,形状不同,保留)
- battle.ts chooseAiAction 泛化 chooseAction(state, side),删除好友模拟器的对称拷贝
### 安全(阶段2,9f552ce)
- 安全响应头 ×4(XCTO/XFO/Referrer-Policy/Permissions-Policy,生产响应实测 4/4;CSP 暂缓另评)
- clientIp:XFF 最右条目(Vercel 边缘写入,唯一可信)——原登录限流 key 打在代理 IP 上,全站共享一个计数桶
- ratelimit.ts:rate_events 表 + 滚动窗口,挂 chat 20/24h(匿名 GLM 成本入口)/register 10/24h/lore 100/24h(缓存未命中才计)/login 10/15min;RATE_LIMIT_SCALE 本地放大(.env.local);DB 错误 fail-open
- scryptSync → async(登录不再阻塞事件循环 ~100ms);createSession 清扫本用户过期会话 + 5% 全表采样(表无界增长)
- admin/seed 500 不回 err.message;ensureSchema 升全局 /api 门(好友/对战/lore 表冷启动首打 500 修复)
### 性能(阶段3,a44ac7c)
- tenpull:10 次独立事务 → 1 个事务(drawCore 提取),serverless 往返 10→1;缺口/重放语义不变(v23 套件钉死)
- /api/friends 三查询并行;无界查询补 LIMIT(收藏 500/pending 50/trades 200/卡池 200);catalogNames 60s 进程内缓存(chat 每请求全表读)
### 过程抓到的 bug
1. **限流倍率 dotenv 时序**:SCALE 在模块导入时求值,先于 createApp() 的 loadEnvFile → 本地 .env.local 永远读不到,套件 429 → 改惰性读取。教训:模块顶层读 env 的代码,必须保证 env 注入先于导入(dotenv 时序经典)
2. v23-e2e 首版对"缺口订单重放"的预设(10 张)与真实契约(重放 7 张+缺口 3)不符——修正断言以钉死真实行为
3. client.js 复发项目文档坑:.js 内写 TS 参数属性(public status)→ esbuild 静默解析失败
### 验证
- 四套件:v23 24/24 + e2e 36/36 + friends 43/44(限流器上线后扩展了 1 条)+ engine 17/17
- 生产:部署 Ready(r7qg1byus);安全头/登录/抽卡链路经本地等价代码验证;生产浏览器 smoke 因本机到 vercel.app 网络持续中断暂缓,恢复后补做
- 状态:验收通过(生产 smoke 待网络恢复补做一项)

## QA-040 [已修复] #/metrics 看板 390px 横向溢出 10px
- **发现**:v2.4 上线前 390px 全站巡检(QA-038 确立的纪律):`#/metrics` scrollWidth=400,两个含表格的 `.mtr-section` right=400。
- **根因**:CSS grid 子项默认 `min-width:auto`——「API 端点 Top」表(等宽字体端点 + 4 列)的最小内容宽度反向撑破 `1fr` 轨道,把卡片和页面一起撑宽。媒体查询本身没错,是内容最小宽作祟。
- **修法**:`.mtr-section { min-width: 0; overflow-x: auto }`——grid 轨道允许收缩,宽表在卡片内部横向滚动,页面不再出现横向滚动条。
- **回归**:六路由(home/packs/metrics/battle/friends/collection)390px 巡检全 OK;桌面 1280px 回归(KPI 4 列 / grid 2 列,媒体查询未泄漏)OK。
- **状态**:已修复并纳入巡检基线

## v2.5 观测展示面迁移 Datadog(2026-10-17,docs/updates/v2.5-datadog.md)
用户决策:看板不放产品站里。自建管线收窄为业务数据源(CSAT 落库 + 行为埋点),Web Vitals/JS 错误/视图归 Datadog RUM(env 门控,缺 token 自动降级自建兜底),业务 KPI 由 Vercel Cron 每日经 /api/metrics/flush 推 Datadog HTTP API(24h 滚动窗口,pokemon.* 指标族)。站内 #/metrics 页面/路由/requireAdmin/is_admin 代码路径/mtr 样式全删(schema 列保留为运维保留位)。密钥纪律:DD_API_KEY/CRON_SECRET 只进 Vercel Secrets,管道直读本地课程密钥文件,零回显零落盘。

### 过程抓到的坑
1. **SPA fallback 假绿两次复现**:本地 server 用 `tsx`(非 watch)启动,改代码后旧进程仍在服务,新端点 /api/metrics/flush 被包成 200 HTML——套件「先 text 后 JSON」防线全部拦下,但这暴露了"改完代码必须重启 server"是隐性前置,考虑给 dev:ai 换 tsx watch。
2. **套件脚手架盲区**:req() 辅助函数只解构 { body, auth },调用方传 headers 静默被丢——钥匙从未发出导致 403,排查绕了一圈才回到脚手架。教训:测试脚手架的参数面也要按接口对待,多传的参数应该显式忽略或报错。
3. v23 套件出现过一次 FAIL,连续两轮全量重跑未复现(24/24),记录为观察项。
- 状态:本地验收通过;Datadog 侧验证待 RUM 应用创建后补记

## v3.0 战斗系统重做(2026-10-17,docs/updates/v3.0-battle-rework.md)
用户决策:"战斗系统一点也不好玩,先调研好玩的战斗系统再回来改"。调研(独立代理,10 搜索 9 深读,RPS/GDC 访谈、Smogon、Persona/XCOM 分析)产出 13 条带出处原理,落地四件套:**意图预告**(Slay the Spire:AI 行动玩家出手前亮牌)+ **能量经济**(Bravely/StS:四档招式定价,防御=储蓄)+ **弱点回能**(Persona One More 的行动经济转译,双向对称)+ **AI 混合策略**(Smogon:top-3 加权抽样 0.62/0.28/0.10)。双引擎并存:resolveTurn 原语义保留(好友 PvP/存量战斗零波及),新 PvE 走 resolveBattleTurn(version:3)。

### 过程抓到的坑与修正
1. **三处测试期望值算漏对称回能**(引擎是对的):挨打方也回能 +10、防御回合照样吃痛感回能、降档后的迅招打中弱点照样 +20——"双向对称"是设计目标,写断言时却按单向思维算数。修断言钉死真实契约。
2. **e2e V1 前置脆弱(既有问题今日踩中)**:固定抽 2 张凑 3 种在随机卡池下概率性翻车 → 改循环抽到凑够(带上限与余额护栏)。
3. **路由首版逻辑岔**:"意图失效时重新生成"写成了用旧意图转换(结果碰巧能跑)——代码评审自审抓出重写。
4. battle-ai.ts 重写为意图决策(prompt 含能量/防御选项/亮牌语义);旧 reasoned 函数删除,legacy reasoned 战斗降级规则策略(瞬态,记日志)。
5. v23 套件又闪一次(1 FAIL 后七连绿),维持观察项(与 v2.5 记录一致,先于本次改动存在)。
6. 视觉检查打磨:能量条辨识度(加 glow+inset 高光)、禁用态对比(opacity 0.38 + grayscale)。

### 验证
- 引擎 34 断言(旧 17 全保留 + v3 新 17:四档派生/能量结算/迅招先手/防御减半(10 种子统计)/降档/意图生命周期/确定性/全队判胜)
- e2e 40/40(新增 V5b/c、V9b/c:v3 字段、下回合意图、guard 行动);五套件合计 **164 断言全绿**
- 浏览器实测:意图气泡/提示行/费用徽章/防御按钮/双侧能量条/回放弹跳全部就位;AI 混合策略可见多样性(实测第二轮 AI 自选防御蓄力);390px 无溢出
- 生产:部署 Ready(nu5wqg01l);生产浏览器 smoke 因本机到 vercel.app 网络中断暂缓(与 v2.3 同款已知问题,恢复后补做)
- 状态:验收通过(生产 smoke 待网络恢复补做一项)

## v2.4 可观测性(2026-10-17,docs/updates/v2.4-observability.md)
自建 RUM(事件宽表 telemetry_events:webvital/jserror/usage/pageview/api)+ CSAT 满意度反馈(feedback 表,20h upsert)+ 管理员 KPI 看板(#/metrics,requireAdmin + users.is_admin)。选型自建而非 SaaS:零第三方账号、零数据出站,采样/限流/聚合可控可讲。新增 qa/telemetry-e2e.mjs 29 断言,全量回归五套件 149 断言绿(e2e 36 + friends 43 + v23 24 + engine 17 + telemetry 29)。过程抓到的 bug 与断言修正:
1. **计时中间件顺序**:res.on("finish") 钩子必须先于业务路由注册,放路由之后=永远采不到——Express 中间件顺序即生效顺序。
2. **node-postgres DATE 陷阱**:`::date` 列被解析成带时区的 Date,JSON 序列化偏移 8 小时——聚合 SQL 用 `to_char` 直出字符串。
3. **断言两修**(钉死真实契约):脏 anonId 的契约是"消毒降级为匿名"而非拒收(ingest 对元数据宽容、对载荷严格);持久库上看板聚合是 7 天窗口累计,绝对计数断言换结构性断言+边际证明(QA-037 假绿教训的延伸)。
4. QA-040:390px 溢出(grid min-width:auto 教训:媒体查询管轨道,管不住内容最小宽)。
- 状态:本地验收通过,生产部署与 smoke 见 v2.4 文档

## v3.1 生产级加固(2026-10-17,docs/updates/v3.1-production-hardening.md)
用户决策:"到不了商业级别,做全量调研和修改"。三路调研/审计(标准调研+服务端逐行+前端逐行)→ 30 项落地:DB TLS 校验、PvE 奖励 24h cap+限流、并发 start 部分唯一索引、Origin CSRF 纵深、CSP+HSTS、immutable 缓存、池死锁(事务内 q() 全改 client)、外呼超时、保底判定入锁、health 503、fallback 跳过 /api、申请 cap、BattleView 三死路、系统字体、datadog preload 过滤、根边界、会话过期引导、PokeAPI 服务端代理(中国可用性)、GitHub Actions CI(postgres service + 五套件)、法务页、request-id。

### 过程抓到的坑
1. **poolLike 类型谎言**:`const poolLike = q as DbLike` 把函数断言成带 .query 的对象——编译通过、运行即 `db.query is not a function`,抽卡/好友全 500。修法:`{ query: (t, v) => q(t, v) }` 包一层。教训:类型断言是"让编译器闭嘴",不是"让类型成立";as unknown as X 双重断言几乎总是谎言。
2. **reasoned 开局意图忘挂 reason**:理由改为"执行时入日志"后,start 分支没把 reason 存进 intent——R2/R3 两轮定位到。教训:改数据流时列出全部写入点逐个核对。
3. **modulePreload.resolveDependencies 首参是文件名**:(deps)=>deps.filter 直接炸 build——签名是 (filename, deps)。
4. R3 断言更新:v3 AI 行动可为 move/guard/switch(不再是必然出招),配对断言同步扩展。
5. **CI 首跑红(本地绿)**:无 GLM key 的环境(CI/mock)reasoned 战斗走回退,回退路径没有 reason 行 → R2 挂。本地一直绿是因为 .env.local 的 key 仍被注入(MOCK_LLM 只影响 isMock 展示,不等于 key 缺席)。修法:回退路径也写 reason("模型暂时不可用,本轮使用规则策略")。教训:**mock 与"无凭证"是两个环境**,CI 矩阵里必须有无 key 一档;本地复现 CI 要把 key 显式置空(loadEnvFile 按"变量存在"判断,不覆盖已定义的空值)。
- 验证:五套件 164 断言全绿;跨站 POST 403/无 Origin 放行/代理 200/浏览器 CSP 零违规实测通过

## v3.2 P0 工程挡板(2026-10-18,docs/updates/v3.2-p0-hardening.md)
按 docs/ROADMAP-NEXT.md 执行 P0 六项(T1 lint/CI 挡板 + 包体预算、T2 LLM token 预算与熔断、T3 定时拨测、T4 战斗表驱动单测、T5 manifest/og 自绘、T6 __Host- cookie)。新增 qa/battle-unit.test.mjs(node:test 零 DB)与 qa/size-check.mjs(+size-baseline.json 基线);telemetry 套件 +10 断言(E0-E9)。过程抓到的坑:
1. **降档单测首版必然不触发**:AI 迅招先手的痛感 +10 恰好把用户补到 25 能量 = strike 费用,降档分支不进——同优先级场景"谁先手"直接改变能量算术,写能量链断言必须按引擎事件顺序逐项排。
2. **减半单测 RNG 对齐双坑**:同速同优先级掷先手币本身消耗随机数(两条场景序号错一位);ghost/normal 是互免(双方伤害全 0)。修法:攻击方极速走速度分支不掷币 + 电/地/飞行单向免疫组合。
3. **预算闸与记账同桶原则**:chat 的 ident 在 app.ts 一处决定,gate 与 meter 收同一个对象——分桶错位的表现是"预算永远不满",日志极难发现。
4. **E 段全局熔断的用户隔离**:验证用户必须个人桶干净,否则降级可能只是个人桶触发,证明不了全局桶;合成行测后必须删,否则全站 LLM 永久熔断。
5. **probe.yml 评估/落盘顺序**:评估必须直接消费 step outputs,不能读"本轮还没写"的状态文件。
6. eslint 挡板选型:error 级只拦 no-unused-vars 等硬伤 + rules-of-hooks;exhaustive-deps 设 warn(存量 10 处非阻塞)——挡板拦 error,不为过挡板大改 hooks。
- 验证:六套件 185 断言全绿(battle 34 + battle-unit 11 + e2e 40 + friends 43 + v23 24 + telemetry 33);挡板验收(unused-var → exit 1);浏览器实测(manifest/icons/og 200、chat 正常 + 降级 notice 真实渲染)。生产验证待 push(probe dispatch + __Host- Set-Cookie 线上确认)。
