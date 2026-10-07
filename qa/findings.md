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
