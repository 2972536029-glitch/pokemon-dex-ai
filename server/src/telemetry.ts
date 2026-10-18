// v2.5 可观测性:RUM 遥测采集 + 满意度反馈 + 每日指标推送 Datadog。
//
// v2.4 → v2.5 的演进(用户决策):看板不放产品站里,展示面归 Datadog。
// 自建管线收窄为「业务数据源」:CSAT 评语必须落库,行为埋点是每日 KPI 的
// 聚合来源;性能/错误/会话明细由前端 Datadog RUM SDK 原生采集。
//
// 工程决策:
// - 采集与推送分离:POST /api/telemetry 只写(多行单语句 INSERT),GET
//   /api/metrics/flush 由 Vercel Cron 每日调用,把 24h 滚动窗口的聚合
//   经 Datadog HTTP API 推成自定义指标(serverless 无 agent,API 推送
//   是这条链路上唯一可行的口子)。
// - 匿名可写的端点按最坏输入设计:字段白名单 + 长度截断 + IP 限流
//   (telemetry 90/15min、feedback 10/15min,复用 DB 背书的滚动窗口)。
// - 45 天保留期:ingest 时 5% 采样触发限量清理(与 sessions 同款思路,
//   不引入定时任务),表不无界增长。

import express from "express";
import { q } from "./db.js";
import { wrap, clientIp, bad, HttpError } from "./http.js";
import { allowRate } from "./ratelimit.js";
import { userFromRequest } from "./auth.js";
import { GLM_CONFIG } from "./llm.js";

const EVENT_TYPES = new Set(["webvital", "jserror", "usage", "pageview"]);
const FEEDBACK_CONTEXTS = new Set(["pack_open", "battle", "general", "chat"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EVENTS_PER_CALL = 25;
const RETENTION_DAYS = 45;

/** 控制字符清洗 + 截断:遥测输入是不可信的,入库前统一过这里。 */
function cleanText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * /api 请求计时钩子(app.ts 的 /api 中间件调用)。
 * 尽力而为采集:fast path 不 await(serverless 在响应后冻结会丢少量样本,
 * 采集允许有损);本地 Express 下 100% 落库。
 * /api/telemetry 自身的流量由前端采样间隔驱动,是合成流量,不计入——
 * 否则会淹没真实业务请求的 KPI。
 */
export function recordApiSample(req: express.Request, res: express.Response): void {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path === "/api/telemetry") return;
    // 路由模板(/api/wiki/:name)而非原始路径:聚合按端点分组,参数不炸维度
    const route = (req.route?.path ?? req.path) as string;
    const name = cleanText(`${req.baseUrl}${route}`, 80);
    q(
      `INSERT INTO telemetry_events (type, name, path, value, meta)
       VALUES ('api', $1, $1, $2, $3)`,
      [name, Date.now() - t0, JSON.stringify({ status: res.statusCode, method: req.method })]
    ).catch((err: unknown) => {
      console.warn("[telemetry] api sample dropped:", (err as Error).message);
    });
  });
}

/** 5% 采样 + 每分钟最多一次的保留期清理,把维护成本摊薄到正常写入里。 */
let lastPrune = 0;
async function maybePrune(): Promise<void> {
  if (Math.random() >= 0.05) return;
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  try {
    await q(
      `DELETE FROM telemetry_events WHERE id IN (
         SELECT id FROM telemetry_events
         WHERE created_at < now() - make_interval(days => $1)
         LIMIT 500)`,
      [RETENTION_DAYS]
    );
  } catch (err) {
    console.warn("[telemetry] prune failed:", (err as Error).message);
  }
}

interface IncomingEvent {
  type?: unknown;
  name?: unknown;
  value?: unknown;
  meta?: unknown;
  path?: unknown;
}

/** Cron 鉴权:Vercel Cron 自动带 Authorization: Bearer $CRON_SECRET;
 *  手工运维调用走 x-seed-key(与 /api/admin/seed 同款钥匙,零新密钥)。 */
function flushAuthorized(req: express.Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && String(req.headers.authorization ?? "") === `Bearer ${secret}`) return true;
  const opsKey = GLM_CONFIG.apiKey;
  return Boolean(opsKey) && String(req.headers["x-seed-key"] ?? "") === opsKey;
}

interface Datum {
  metric: string;
  value: number;
  type: "gauge" | "rate";
  tags?: string[];
}

/** 24h 滚动窗口聚合(不打断 QA-037 的时区纪律:不看「天」,只看滚动窗)。 */
async function collectWindow(): Promise<Datum[]> {
  const win = "created_at > now() - interval '24 hours'";
  const [usage, apiAgg, dau, fb, llm] = await Promise.all([
    q<{ action: string; n: number }>(
      `SELECT name AS action, count(*)::int AS n
       FROM telemetry_events WHERE type = 'usage' AND ${win}
       GROUP BY name`,
      []
    ),
    q<{ total: number; errors: number; p95_ms: number | null }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE value >= 500)::int AS errors,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY value)::float AS p95_ms
       FROM telemetry_events WHERE type = 'api' AND ${win}`,
      []
    ),
    q<{ dau: number }>(
      `SELECT count(DISTINCT COALESCE(user_id::text, NULLIF(anon_id, ''), NULLIF(session_id, '')))::int AS dau
       FROM telemetry_events WHERE ${win}`,
      []
    ),
    q<{ responses: number; avg_score: number | null }>(
      `SELECT count(*)::int AS responses, avg(score)::float AS avg_score
       FROM feedback WHERE ${win}`,
      []
    ),
    // v3.2:LLM token 用量与熔断次数(按消费点拆分,pokemon.llm.tokens{feature})
    q<{ feature: string; tokens: number; capped: number }>(
      `SELECT feature, COALESCE(sum(tokens), 0)::int AS tokens,
              count(*) FILTER (WHERE capped)::int AS capped
       FROM llm_usage WHERE ${win}
       GROUP BY feature`,
      []
    ),
  ]);

  const tags = ["service:pokemon-dex-ai", "env:prod"];
  const data: Datum[] = [
    { metric: "pokemon.dau", value: Number(dau.rows[0]?.dau ?? 0), type: "gauge", tags },
    { metric: "pokemon.api.requests", value: Number(apiAgg.rows[0]?.total ?? 0), type: "rate", tags },
    { metric: "pokemon.api.errors", value: Number(apiAgg.rows[0]?.errors ?? 0), type: "rate", tags },
    { metric: "pokemon.api.p95_ms", value: Number(apiAgg.rows[0]?.p95_ms ?? 0), type: "gauge", tags },
    { metric: "pokemon.feedback.count", value: Number(fb.rows[0]?.responses ?? 0), type: "rate", tags },
    { metric: "pokemon.feedback.avg_score", value: Number(fb.rows[0]?.avg_score ?? 0), type: "gauge", tags },
  ];
  for (const u of usage.rows) {
    data.push({
      metric: `pokemon.usage.${cleanText(u.action, 40).replace(/[^a-z0-9_]/gi, "_")}`,
      value: Number(u.n),
      type: "rate",
      tags,
    });
  }
  for (const l of llm.rows) {
    // feature 拼进 tag 而非指标名:Datadog 侧一张图按 feature 分组即可,不用枚举指标
    const fTags = [...tags, `feature:${cleanText(l.feature, 20).replace(/[^a-z0-9_]/gi, "_")}`];
    data.push({ metric: "pokemon.llm.tokens", value: Number(l.tokens), type: "rate", tags: fTags });
    if (l.capped > 0) {
      data.push({ metric: "pokemon.llm.capped", value: Number(l.capped), type: "rate", tags: fTags });
    }
  }
  return data;
}

/** 聚合结果推 Datadog(org/site/key 全部来自环境变量,密钥永不进代码)。 */
async function pushDatadog(data: Datum[]): Promise<{ pushed: boolean; reason?: string }> {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return { pushed: false, reason: "dd_api_key_missing" };
  const site = process.env.DD_SITE || "datadoghq.com";
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(`https://${site}/api/v1/series`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000), // v3.1:外呼预算,不拖 cron
    headers: { "DD-API-KEY": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      series: data.map((d) => ({
        metric: d.metric,
        points: [[now, d.value]],
        type: d.type,
        tags: d.tags,
      })),
    }),
  });
  if (!res.ok) {
    // 密钥无效/配额问题:响应体只进日志(可能含敏感信息),调用方拿到布尔
    const body = await res.text().catch(() => "");
    console.error(`[telemetry] datadog push ${res.status}:`, body.slice(0, 200));
    return { pushed: false, reason: `dd_http_${res.status}` };
  }
  return { pushed: true };
}

export function mountTelemetry(): express.Router {
  const router = express.Router();

  // ---- RUM 采集:批量写入 --------------------------------------------------
  router.post(
    "/api/telemetry",
    wrap("telemetry", "服务暂时不可用,请稍后再试", async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const events = Array.isArray(body.events) ? (body.events as IncomingEvent[]) : [];
      if (events.length < 1 || events.length > MAX_EVENTS_PER_CALL) {
        bad(`events 数量需在 1-${MAX_EVENTS_PER_CALL} 之间`);
      }
      const anonId = typeof body.anonId === "string" && ID_RE.test(body.anonId) ? body.anonId : "";
      const sessionId =
        typeof body.sessionId === "string" && ID_RE.test(body.sessionId) ? body.sessionId : "";

      if (!(await allowRate(`telemetry:${clientIp(req)}`, 90, 900))) {
        res.status(429).json({ error: "rate_limited", message: "上报过于频繁,请稍后再试" });
        return;
      }

      // 会话 cookie 随请求同源携带(sendBeacon 同样带),能认就认,认不出按匿名
      const user = await userFromRequest(req).catch(() => null);

      const rows: unknown[][] = [];
      for (const e of events) {
        if (!e || typeof e !== "object" || !EVENT_TYPES.has(String(e.type))) bad("未知的事件类型");
        const value =
          e.value === undefined || e.value === null ? null : Number(e.value);
        if (value !== null && !Number.isFinite(value)) bad("value 需为有限数值");
        let meta = "{}";
        if (e.meta && typeof e.meta === "object") {
          const json = JSON.stringify(e.meta);
          // 超限 meta 直接丢弃换占位:截断的 JSONB 比超尺度的更可控
          meta = json.length > 500 ? '{"_dropped":true}' : json;
        }
        rows.push([
          String(e.type),
          cleanText(e.name, 60),
          user?.id ?? null,
          anonId,
          sessionId,
          cleanText(e.path, 120),
          value,
          meta,
        ]);
      }

      // 多行单语句:25 行 × 8 列 = 200 参数,远低于协议上限,一次往返
      const placeholders = rows
        .map((_, i) => {
          const base = i * 8;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
        })
        .join(",");
      await q(
        `INSERT INTO telemetry_events (type, name, user_id, anon_id, session_id, path, value, meta)
         VALUES ${placeholders}`,
        rows.flat()
      );
      maybePrune();
      res.status(204).end();
    })
  );

  // ---- 满意度反馈:20h 窗口 upsert ------------------------------------------
  router.post(
    "/api/feedback",
    wrap("feedback", "服务暂时不可用,请稍后再试", async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const context = String(body.context ?? "");
      const score = Number(body.score);
      if (!FEEDBACK_CONTEXTS.has(context)) bad("未知的反馈场景");
      if (!Number.isInteger(score) || score < 1 || score > 5) bad("评分需为 1-5 的整数");
      const comment = cleanText(body.comment, 200);

      if (!(await allowRate(`feedback:${clientIp(req)}`, 10, 900))) {
        res.status(429).json({ error: "rate_limited", message: "提交太频繁,请稍后再试" });
        return;
      }

      const user = await userFromRequest(req).catch(() => null);
      const anonRaw = typeof body.anonId === "string" && ID_RE.test(body.anonId) ? body.anonId : "";
      const ident = user ? `u:${user.id}` : `a:${anonRaw || "unknown"}`;

      // 同身份同场景 20h 内改口 = 覆盖最新一条(不刷屏);跨窗口保留历史,
      // 满意度趋势是 Datadog 看板的核心曲线。两步式存在并发双击竞态,最坏
      // 多一行,由 IP 限流兜底——不为旁路数据上事务锁。
      const upd = await q(
        `UPDATE feedback SET score = $2, comment = $3, created_at = now()
         WHERE ident = $1 AND context = $4 AND created_at > now() - interval '20 hours'`,
        [ident, score, comment, context]
      );
      const updated = (upd.rowCount ?? 0) > 0;
      if (!updated) {
        await q(
          `INSERT INTO feedback (ident, context, score, comment) VALUES ($1, $2, $3, $4)`,
          [ident, context, score, comment]
        );
      }
      res.json({ ok: true, updated });
    })
  );

  // ---- 每日指标推送(Vercel Cron 调用) -------------------------------------
  router.get(
    "/api/metrics/flush",
    wrap("metrics-flush", "服务暂时不可用,请稍后再试", async (req, res) => {
      if (!flushAuthorized(req)) throw new HttpError(403, "forbidden", "forbidden");
      const data = await collectWindow();
      const dd = await pushDatadog(data).catch((err: unknown) => {
        console.error("[telemetry] datadog push failed:", (err as Error).message);
        return { pushed: false, reason: "dd_fetch_error" } as const;
      });
      // 返回聚合明细:本地无 DD_API_KEY 也能验证聚合正确性(指标有据可查)
      res.json({
        ok: true,
        window: "24h",
        generatedAt: new Date().toISOString(),
        metrics: data,
        dd,
      });
    })
  );

  return router;
}
