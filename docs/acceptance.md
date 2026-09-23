# 验收清单 · Phase 1(账号 + 钱包 + 卡包 + AI 顾问)

> 本文件是 Phase 1 的唯一验收靶子。每条必须可客观执行/核验。
> 状态:✅ 通过 / ❌ 未过 / ⚠️ 有条件通过(附条件)

## A. 通用前置

- [ ] A1 `tsc --noEmit` 与 `vite build` 零报错
- [ ] A2 `git ls-files` 无 `.env`、`.env.local`、真实密钥(grep vcp_/GLM_API_KEY=具体值/密码)
- [ ] A3 `.gitignore` 覆盖 node_modules/dist/.env*/server/dist/.vercel
- [ ] A4 未登录访问受保护 API 返回 401,不泄漏堆栈

## B. 认证与会话

- [ ] B1 注册:用户名 3-20 位 `[A-Za-z0-9_]`,密码 6-100 位;违规 → 400 + 中文原因
- [ ] B2 注册成功 → 300 注册奖励入账,流水记录 kind=signup
- [ ] B3 重名注册 → 409「该用户名已被使用」
- [ ] B4 登录:正确凭证 → 200 + Set-Cookie(dex_session, HttpOnly, SameSite=Lax)
- [ ] B5 登录:错误用户名/密码 → 401,消息统一为「用户名或密码错误」(不区分哪种错)
- [ ] B6 同 IP 连续 10 次登录失败后 → 429(限流)
- [ ] B7 会话 7 天有效;登出后 Cookie 失效,再访问 /api/me → user:null
- [ ] B8 Cookie 属性:生产环境带 Secure;始终 HttpOnly、SameSite=Lax

## C. 钱包

- [ ] C1 每日奖励:当日首次领取 +50 且入流水;当日重复领取 granted=false 不重复加钱
- [ ] C2 流水接口返回最近 20 条,金额符号正确(收入正/扣费负)
- [ ] C3 余额不可为负(schema CHECK + 应用层双保险)

## D. 卡包与抽卡

- [ ] D1 GET /api/packs 返回 3 个卡包及公示概率,概率之和 = 1
- [ ] D2 抽卡成功:扣对应价格、user_cards 入库、wallet_tx 记录、返回卡牌
- [ ] D3 幂等:同一 orderId 重放 → 返回同一张卡、余额不变、replay=true
- [ ] D4 余额不足 → 402 + 友好中文提示,余额分毫不动
- [ ] D5 非法 orderId(超长/非 hex)→ 400
- [ ] D6 不存在的卡包 id → 404

## E. 收藏

- [ ] E1 只返回当前会话用户自己的卡(换账号不可见他人卡)
- [ ] E2 重复抽到同卡 → count +1 而非新行
- [ ] E3 按 BST 降序返回

## F. AI 顾问(登录态)

- [ ] F1 组队问题 → 模型先调 get_my_cards 再回答
- [ ] F2 推荐 ⊆ 收藏:推荐了未拥有的卡 → 守卫检出 → 自动纠错一轮 → 仍不符 → 流式警示
- [ ] F3 未登录时:用户状态工具不出现在工具列表,普通图鉴问答不受影响
- [ ] F4 模型/请求不可用时的错误不影响图鉴主功能(503 降级仅限 Phase1 路由)

## G. 安全回归

- [ ] G1 AI 工具不收用户 ID 参数;服务端从会话注入(IDOR 红线)
- [ ] G2 密码 scrypt 加盐存储,库里无明文
- [ ] G3 无敏感值(gcp/vcp 令牌、GLM key、密码)进日志
- [ ] G4 React 渲染用户输入无 XSS 注入面(无 dangerouslySetInnerHTML)

## H. 生产就绪

- [ ] H1 无 DATABASE_URL 时:图鉴 + AI 问答正常,Phase1 路由 503 + 中文提示(不崩整个应用)
- [ ] H2 生产环境 DATABASE_URL 接入 Neon 后数据持久(重启/冷启动不丢)
