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

# 验收清单 · M2(首页大厅 + 无限金币测试号 + 战斗健化 + 移动端减负)

> 追加里程碑靶子。每条必须可客观执行/核验。证据:主代理提供构建与回归运行结果。

## I. 通用前置

- [ ] I1 `vite build` + `tsc -p server` 零错误
- [ ] I2 `git ls-files` 无 `.env`/`.env.local`/令牌文件;全仓库无 vcp_ 真值、GLM key 真值
- [ ] I3 `.gitignore` 覆盖 node_modules/dist/.env*/server/dist/.vercel

## II. 首页大厅

- [ ] II1 hash 为空时默认路由 = `#/home`;浏览器标签页标题含「首页」
- [ ] II2 顶部导航含「首页」项;品牌球点击落 `#/home`
- [ ] II3 开屏 CTA 落 `#/home`(登录与未登录一致)
- [ ] II4 首页仅消费 GET 类接口(collection/team/PokeAPI),无写接口调用
- [ ] II5 今日精选按日期确定性:算法 `floor(Date.now()/86400000) % 1010 + 1`,同日同号

## III. 无限金币测试号

- [ ] III1 免费通道仅由环境变量 `UNLIMITED_USER_IDS` 驱动;仓库(含文档)无真实白名单值硬编码
- [ ] III2 白名单用户抽卡:不 `UPDATE users.balance`、不写 wallet_tx;gacha_orders/user_cards 照常写入
- [ ] III3 非白名单用户路径与旧版一致(扣费/余额不足 402/流水)
- [ ] III4 订单幂等两通道一致:同 orderId 重放不重复发卡不重复扣费

## IV. 战斗健化

- [ ] IV1 `/api/battle/active`、`/api/battle/:id/state`、`/start`(resume)读取路径均调用 clampBattleState
- [ ] IV2 clampBattleState 对每只 mon 钳制 `hp ∈ [0, maxHp]`
- [ ] IV3 前端 turn 遇 5xx 自动重试一次;错误行提供重试按钮;服务端失败时事务回滚(重试不双扣/不重复奖励)

## V. 立绘 CDN 与移动端

- [ ] V1 客户端 artworkUrl/pixelSpriteUrl 与服务端 artworkFor 均指向 jsDelivr;无 raw.githubusercontent 立绘残留
- [ ] V2 `≤760px`:topbar/ai-panel/卡片容器 backdrop-filter 停用;body::after 停用;重绘型无限动画(background-position/box-shadow)停用
- [ ] V3 `@supports (min-height:100dvh)` 下 app-shell/battle-pregame/packs-view 使用 dvh

## VI. 安全回归

- [ ] VI1 UNLIMITED 白名单真实值仅存于 Vercel 环境变量;代码/文档/截图脚本中无
- [ ] VI2 聊天/战斗错误文案不内含 HTTP 状态码或内部堆栈
