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
