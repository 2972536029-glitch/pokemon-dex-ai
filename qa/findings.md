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
