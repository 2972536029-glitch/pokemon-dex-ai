# QA 发现台账 · Phase 1

> 唯一台账,只增不改;修复合入后更新状态行。
> 第 1 轮:全新上下文只读评审(2026-09-24)→ 1 P1 + 12 P2;第 2 轮:复核 + 回归猎茬(2026-09-24)→ 13/13 销项,无新问题,3 条 P3 观察(QA-014~016)已同步修复。

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
