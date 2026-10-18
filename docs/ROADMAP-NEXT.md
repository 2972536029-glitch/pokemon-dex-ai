# Pokemon Dex AI — 商业化路线图(工程交接方案书)

> 状态:2026-10-18 制定,基线 = v3.1(85cd814,已上线且生产验证)。
> 与 `ROADMAP.md` 的关系:那份是产品路线图(Phase 0-2 已全部上线);本文档是**工程侧**的下一程——把它丢给任何一个新会话(AI 或人),按本文档自包含开干,不需要额外背景。
> 执行顺序建议:P0 全部 → P1(各等用户一步配合)→ P2 按用户意愿挑选。P3 暂缓。

---

## 0. 项目快照(先读这段)

| 项 | 值 |
|:---|:---|
| 仓库 | github.com/2972536029-glitch/pokemon-dex-ai |
| 本地路径 | `D:\xsolla\pokemon-dex-ai` |
| 线上 | https://pokemon-dex-ai.vercel.app |
| 技术栈 | Express 5 + TypeScript(server/)+ React 19 SPA(.jsx,**不是** .tsx)+ Vite 5;Vercel serverless + Neon Postgres(pooler 端点) |
| 账号 | 仅用户名注册,scrypt(N=2^14, r=8, p=1, 异步),DB 会话(httpOnly SameSite=Lax cookie `dex_session`,7 天,可撤销),登录限流 DB 共享窗口 |
| LLM | 智谱 GLM(llm.ts),三个消费点:agent.ts(聊天)/ battle-ai.ts(对战推演)/ lore.ts(图鉴文案) |
| 运行 | `npm run dev`(前端 5173)+ `npm run dev:ai`(服务端,读 `.env.local`);QA 脚本在 `qa/*.mjs`(node 直跑) |
| CI | `.github/workflows/ci.yml`:postgres service 容器跑全部 QA |

**必须沿用的架构决策**(改动前先确认理解 why,别当遗留代码清掉):

- 服务端权威:客户端只发 action,结算/奖励全在服务端;乐观锁 `UPDATE ... WHERE status='active'`,23505 冲突复用已有对局
- 钱包 append-only `wallet_tx` 账本;PvE 奖励 24h cap(10 场)
- 双战斗引擎:`resolveTurn`(legacy,好友异步 PvP 用)+ `resolveBattleTurn`(v3 意图/能量制,PvE 用)——**别合并**,好友对战依赖 legacy 快照语义
- `DbLike` 执行器模式:事务内一律传 `client`,池级 `q()` 只在事务外(routes-friends.ts 有标准写法)
- `/api/poke/` 白名单代理 + 24h 缓存(中国可用性关键,别让前端直连 PokeAPI)
- Neon pooler:**不能**在 pool 配置里放 `options`(08P01 直接炸),语句超时用事务内 `SET LOCAL statement_timeout=5000`
- CSP/安全头在 `server/src/app.ts` + `vercel.json`;静态资源 /assets immutable
- 前端 hash 路由(#/privacy 这类深链),SPA fallback 已跳过 /api

**文档地图**:`docs/updates/`(每个版本一份变更文档,v2.4→v3.1)+ `qa/findings.md`(QA 台账,QA-0XX 连续编号)+ README(runbook)。

**环境变量**:server 侧 `DATABASE_URL / GLM_API_KEY / MOCK_LLM / RATE_LIMIT_SCALE / DD_API_KEY`(后者只存在 `/d/xsolla/cap-tmp/.env.company`,**绝不进仓库**);前端 `VITE_DD_CLIENT_TOKEN / VITE_DD_APPLICATION_ID / VITE_DD_SITE(=us5) / VITE_DD_ENV`(RUM 未配齐,见 §4)。

---

## 1. 硬性工作纪律(违反=返工)

1. **前端只写 .jsx**,服务端只写 .ts;`.js` 文件里禁止 TS 语法(esbuild 静默失败)。
2. **密钥纪律**:任何 secret 不回显、不进文件、不进 git;DD_API_KEY 只从上述路径读。
3. **每次迭代必须自测**,缺一不可:
   - 五套 QA 全绿:battle(34)/ e2e(40)/ friends(43)/ v23(24)/ telemetry(23),新增逻辑要配新断言;
   - 浏览器实测(本地 5173,走真渲染,不信"编译过");
   - `qa/findings.md` 追加记录(沿用 QA 编号);
   - `docs/updates/vX.md` 写变更文档。
4. **commit 规范**:`feat:`/`fix:`/`chore:`/`docs:` 英文标题;push 后盯 CI 到绿。
5. **工程优先于教科书写法**:状态字段用 TINYINT+常量而非 ENUM;低基数列不建索引;应用层事务而非物理外键;乐观锁而非 FOR UPDATE。动手前问一句"线上要扩展时会痛吗"。
6. **生产验证通道**:本机到 vercel.app 长期断网(见 §4),用 web_reader 类服务端抓取验证 `/api/health` 和关键 API,别因为"打不开"误判线上挂了。
7. 既有代码没有明确要求不动;改动最小化。

---

## 2. 已知坑(每条都真踩过,别再踩)

| 坑 | 症状 | 规避 |
|:---|:---|:---|
| `q as DbLike` 类型断言 | 编译过,运行 `db.query is not a function` | 双重断言=谎言;显式包 `{ query: (t,v)=>q(t,v) }` |
| Neon pooler + startup 参数 | Vercel 构建/连接 08P01 | 超时用事务内 `SET LOCAL`,连接串别带 options |
| mock ≠ 无凭证 | 本地全绿 CI 红 | 复现 CI 要显式 `GLM_API_KEY=""`(loadEnvFile 判"变量存在"不判空) |
| vite modulePreload 签名 | 构建崩溃 | `resolveDependencies(filename, deps)` 首参是文件名 |
| SPA fallback 假绿 | fetch HTML 当 JSON 解析 | 响应解析一律 `.json().catch(()=>null)` + status 判断 |
| node-postgres DATE 时区 | 日期漂一天 | SQL 里 `to_char`,别裸 DATE 进 JS |
| 瞬时 5xx 重试 | 回合被消费两次 | 只在"服务端事务回滚不消费"语义下重试(见 BattleView postTurn 注释) |
| Google Fonts | 中国用户渲染阻塞 | 保持系统字栈,别再引外部字体 |

---

## 3. 任务清单

### P0 — 立即可做,零用户配合

**T1 Lint 与 CI 挡板 + 包体预算**
- 现状:零 lint,CI 只跑 tsc+build+QA;包体 regress 无感知。
- 做:eslint(flat config;前端 .jsx 用 react-hooks 规则集,服务端 .ts 全量)+ CI step;`dist/assets` 体积基线(如 `qa/size-baseline.json`),超基线 +10% 即红。
- 验收:故意引入 unused var / 把大依赖 import 进主包 → CI 红;基线本身绿。

**T2 LLM token 预算与熔断**
- 现状:外呼有超时(45s)但无用量约束,恶意用户可烧钱。
- 做:llm.ts 集中计量(近似 token:字符/2,CJK 友好);每用户每日 token 上限(复用 DB 限流的滚动窗口模式);全局日预算熔断(超限 → 自动降级规则策略 + `pokemon.llm.capped` 指标);`/api/metrics` 暴露 `pokemon.llm.tokens{feature}`。
- 验收:压测单用户触发降级而非 500;指标出现在 flush payload;QA 断言降级路径带 reason 行(历史教训:降级也要有 reason,否则 CI 红)。

**T3 GitHub Actions 定时拨测(runner 在海外,不受本机断网影响)**
- 做:`.github/workflows/probe.yml`,cron 每 30min:GET /api/health(断言 `db:"ok"`)+ /api/poke/pokemon/25(断言 200)+ 首页 HTML(断言含 root div);连续 2 次失败开 issue(先查同类 open issue 去重);支持 workflow_dispatch 手动触发。
- 验收:手动 dispatch 绿;人为断言错值能红并开 issue。

**T4 战斗核心纯函数表驱动单测**
- 现状:battle.ts 的能量/克制/优先级逻辑只被 e2e 间接覆盖。
- 做:`qa/battle-unit.test.mjs`(node:test,零 DB):能量收支表(迅0/强25/重45/极90、guard+35减半、换人+10、弱点命中+20、pain+10、regen 主动+15/替补+5)、克制乘法、同优先级速度裁定、能量不足降级路径;接入 CI。
- 验收:覆盖表全绿;故意改一个能量常数 → 红。

**T5 分享与安装体验:og:image / PWA manifest / icons**
- 做:manifest.webmanifest + 192/512 图标(**自绘**精灵球风格,不抓官方原画,版权);index.html 加 og/twitter 标签 + apple-touch-icon + 1200×630 og 图(同自绘);首屏 LCP 图 `fetchpriority` 优化。
- 验收:分享卡片预览正常;Lighthouse "Installable" 通过。

**T6 Cookie 收紧:`__Host-` 前缀**
- 现状:`dex_session` 已 httpOnly+SameSite=Lax+Secure(prod),差 `__Host-` 前缀(强制 Secure+Path=/+无 Domain,防子域投递)。
- 做:prod 用 `__Host-dex_session`(Vercel HTTPS 满足前置),localhost 不满足 `__Host-` 条件 → 按环境切名(auth.ts 的 sessionCookie 已接收 secure 参数,顺势扩展);上线后所有会话失效一次(可接受,重登即恢复)。
- 验收:prod Set-Cookie 名带前缀且属性齐全;本地 e2e + friends-e2e 全绿。

### P1 — 各需要用户配合一步

**T7 备份流水线 + 恢复演练(商业级分水岭,最高优先的 P1)**
- 用户动作:repo Settings→Secrets 配 `PROD_DATABASE_URL`(或 Neon API key)。
- 做:`.github/workflows/backup.yml` 每日 pg_dump(`--format=custom`)→ 加密 artifact(保留 30 天)+ 推私有备份仓;**每周自动恢复演练**:恢复到 Neon 临时分支(API 建分支)→ 关键 SELECT 校验 → 记录耗时 → 删分支;失败开 issue。
- 验收:一次真实备份 + 一次真实恢复演练日志进 `docs/updates/`;备份不落任何公网可达位置。

**T8 Datadog RUM 收尾(看板闭环的最后一块)**
- 用户动作:登录 us5.datadoghq.com 建 RUM application,拿 clientToken/applicationId。
- 做:`vercel env add VITE_DD_CLIENT_TOKEN / VITE_DD_APPLICATION_ID` → redeploy → 验证 RUM Explorer 出现会话与 Web Vitals;site 固定 `us5`。
- 验收:真实访问 5 分钟后 RUM Explorer 可见 session;CSP 无新违规(connect-src 已含 us5)。

**T9 Sourcemap 上传(配合 T8)**
- 用户动作:CI secret 加 `DD_API_KEY`。
- 做:CI 构建带 sourcemap → datadog-ci 上传 → **部署产物剔除 sourcemap**;RUM 报错即可还原源码行。
- 验收:人为抛错 → RUM 事件显示源码位置而非 minified。

### P2 — 功能演进(按用户意愿挑,建议按序)

**T10 排行榜与赛季**
- battles 聚合(胜场/胜率/连胜),周榜;防刷已由奖励 cap+限流兜底。新 API `/api/leaderboard` + Home 卡片;只统计 finished 对局,同分先到在前;查询加 `LIMIT`+合适索引,别全表聚合。

**T11 好友对战实时化(当前是异步快照制)**
- 推荐**轮询制**:双方进入同一 battle,2s 轮询 `GET /api/battle/:id/state`,轮到谁谁出手(乐观锁天然支持);零新依赖,Vercel 兼容。
- 不推荐先上 WebSocket(Vercel serverless 不支持长连);Ably/Pusher 等轮询证明体验不够再升级。
- 这是 v3 意图预告系统的最佳展示场:对手的意图预告在轮询下自然变成"读心"博弈。

**T12 Datadog 看板 as code + SLO 告警**
- dashboard JSON 进仓(`datadog/dashboards/*.json`)同步;核心图:API p95/错误率、`pokemon.*` 业务指标、RUM Web Vitals、LLM token 消耗;SLO:API 可用率 99%、p95 < 1s,烧穿 → 邮件/webhook。

**T13 PWA 离线壳**
- SW 只缓存静态壳(index/assets),API 永不缓存;断网可看已缓存图鉴页;iOS 主屏图标依赖 T5。

**T14 LLM 成本优化**
- lore 文案按 cardId 缓存(同卡全站共享,命中率高);battle reason 兜底模板多样化;reasoned 分级模型——最后做,依赖 T2 的用量数据。

**T15 反作弊深化**
- telemetry 侧:单用户 turns/min 异常、同 IP 批量注册、奖励领取频率分布;先出指标再定策略,别拍脑袋封。

### P3 — 远期(记录不动)

- 成本治理 admin 页(Vercel 调用/Neon compute hours/LLM 月支出)
- i18n(en)
- 邮箱账号体系(当前 username-only 是文档化的明示取舍,改前先与用户确认)
- 移动端手势/动效打磨

---

## 4. 当前阻塞与既知异常

| 项 | 状态 | 处置 |
|:---|:---|:---|
| Datadog RUM | 等用户登录 us5 建 RUM 应用 | T8 |
| 本机 → vercel.app 网络 | 长期断(curl 000/IAB 错误页),线上本身正常(服务端通道已验证 health `db:"ok"`) | 用 web_reader 通道做生产验证;T3 拨测补持续监控 |
| v23-e2e 偶发 flake | ~1/10-1/15 概率失败后自愈,6+ 连跑未复现,v3 之前就有 | 观察;T4 落地后用隔离单测压缩排查面 |
| 备份 | 完全没有(丢库=丢一切) | T7,做完才算"商业级"及格 |

## 5. 不做清单(和做了什么同样重要)

- 不引状态库(Redux/Zustand)/ORM/微服务——规模未到,复杂度先到
- 不把 .jsx 迁 .tsx、不"顺手重构"既有模块
- 不上 Redis:限流已是 DB 共享窗口,serverless 多实例下工作正常,等规模证明需要
- 不做物理外键/ENUM(见 §1 第 5 条)
- 不抓官方原画做 og 图/图标(版权,T5 用自绘)
- 永不做真实支付(承接产品路线图的既有红线)
