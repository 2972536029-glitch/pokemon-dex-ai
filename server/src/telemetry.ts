// v2.4 可观测性:RUM 遥测采集 + 满意度反馈 + KPI 聚合看板。
//
// 为什么自建而不是接 Sentry/PostHog:这个站需要的是 web-vitals、JS 错误、
// 功能埋点、CSAT 四类信号,一张事件宽表 + 两个端点就能覆盖——零第三方
// 账号、零数据出站,且采样、限流、聚合 SQL 每一环都可控可讲。
//
// 工程决策:
// - 采集与查询分离:POST /api/telemetry 只写(多行单语句 INSERT),GET
//   /api/metrics/overview 只读聚合;看板是管理员低频页面,不设缓存层。
// - 匿名可写的端点按最坏输入设计:字段白名单 + 长度截断 + IP 限流
//   (telemetry 90/15min、feedback 10/15min,复用 DB 背书的滚动窗口)。
// - 45 天保留期:ingest 时 5% 采样触发限量清理(与 sessions 同款思路,
//   不引入定时任务),表不无界增长。

import express from "express";
import { q } from "./db.js";
import { wrap, requireAdmin, clientIp, bad } from "./http.js";
import { allowRate } from "./ratelimit.js";
import { userFromRequest } from "./auth.js";

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
      // 满意度趋势曲线是看板的核心输出。两步式存在并发双击竞态,最坏多一行,
      // 由 IP 限流兜底——不为旁路数据上事务锁。
      const upd = await q(
        `UPDATE feedback SET score = $2, comment = $3, created_at = now()
         WHERE ident = $1 AND context = $4 AND created_at > now() - interval '20 hours'`,
        [ident, score, comment, context]
      );
      let updated = (upd.rowCount ?? 0) > 0;
      if (!updated) {
        await q(
          `INSERT INTO feedback (ident, context, score, comment) VALUES ($1, $2, $3, $4)`,
          [ident, context, score, comment]
        );
      }
      res.json({ ok: true, updated });
    })
  );

  // ---- KPI 聚合:管理员看板 -------------------------------------------------
  router.get(
    "/api/metrics/overview",
    wrap("metrics", "服务暂时不可用,请稍后再试", async (req, res) => {
      await requireAdmin(req);
      const days = req.query.days === "30" ? 30 : 7;
      // 全部聚合共用这一个时间窗参数
      const win = "created_at > now() - make_interval(days => $1::int)";

      // QA-037 时区教训:「天」按用户时区切,不用服务器的 UTC——否则
      // UTC+8 用户看到的日报整体偏移 8 小时。
      const [apiDaily, endpoints, audience, vitals, errTop, sessions, usage, fbSummary, fbRecent, regs] =
        await Promise.all([
          q<{ day: string; total: number; errors: number; p95_ms: number | null }>(
            `SELECT to_char((created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
                    count(*)::int AS total,
                    count(*) FILTER (WHERE value >= 500)::int AS errors,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY value)::float AS p95_ms
             FROM telemetry_events WHERE type = 'api' AND ${win}
             GROUP BY day ORDER BY day`,
            [days]
          ),
          q<{ endpoint: string; total: number; p95_ms: number | null; errors: number }>(
            `SELECT name AS endpoint, count(*)::int AS total,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY value)::float AS p95_ms,
                    count(*) FILTER (WHERE value >= 500)::int AS errors
             FROM telemetry_events WHERE type = 'api' AND ${win}
             GROUP BY name ORDER BY total DESC LIMIT 10`,
            [days]
          ),
          q<{ day: string; dau: number; pv: number }>(
            `SELECT to_char((created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
                    count(DISTINCT COALESCE(user_id::text, NULLIF(anon_id, ''), NULLIF(session_id, '')))::int AS dau,
                    count(*) FILTER (WHERE type = 'pageview')::int AS pv
             FROM telemetry_events WHERE ${win}
             GROUP BY day ORDER BY day`,
            [days]
          ),
          q<{ name: string; p75: number; samples: number; good: number; ni: number; poor: number }>(
            `SELECT name,
                    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)::float AS p75,
                    count(*)::int AS samples,
                    count(*) FILTER (WHERE meta->>'rating' = 'good')::int AS good,
                    count(*) FILTER (WHERE meta->>'rating' = 'needs-improvement')::int AS ni,
                    count(*) FILTER (WHERE meta->>'rating' = 'poor')::int AS poor
             FROM telemetry_events WHERE type = 'webvital' AND value IS NOT NULL AND ${win}
             GROUP BY name`,
            [days]
          ),
          q<{ message: string; n: number }>(
            `SELECT name AS message, count(*)::int AS n
             FROM telemetry_events WHERE type = 'jserror' AND ${win}
             GROUP BY name ORDER BY n DESC LIMIT 8`,
            [days]
          ),
          // crash-free 会话是近似:只统计上报过事件的会话(从未上报的会话
          // 本来就不可见),看板注释里如实标注口径。
          q<{ total: number; errored: number }>(
            `SELECT count(DISTINCT NULLIF(session_id, ''))::int AS total,
                    count(DISTINCT CASE WHEN type = 'jserror' THEN NULLIF(session_id, '') END)::int AS errored
             FROM telemetry_events WHERE ${win}`,
            [days]
          ),
          q<{ action: string; n: number }>(
            `SELECT name AS action, count(*)::int AS n
             FROM telemetry_events WHERE type = 'usage' AND ${win}
             GROUP BY name ORDER BY n DESC LIMIT 12`,
            [days]
          ),
          q<{ responses: number; avg_score: number | null; s1: number; s2: number; s3: number; s4: number; s5: number }>(
            `SELECT count(*)::int AS responses, avg(score)::float AS avg_score,
                    count(*) FILTER (WHERE score = 1)::int AS s1,
                    count(*) FILTER (WHERE score = 2)::int AS s2,
                    count(*) FILTER (WHERE score = 3)::int AS s3,
                    count(*) FILTER (WHERE score = 4)::int AS s4,
                    count(*) FILTER (WHERE score = 5)::int AS s5
             FROM feedback WHERE ${win}`,
            [days]
          ),
          q<{ context: string; score: number; comment: string; created_at: string }>(
            `SELECT context, score, comment, created_at
             FROM feedback WHERE ${win} AND comment <> ''
             ORDER BY created_at DESC LIMIT 8`,
            [days]
          ),
          q<{ n: number }>(
            `SELECT count(*)::int AS n FROM users WHERE ${win}`,
            [days]
          ),
        ]);

      const apiTotal = apiDaily.rows.reduce((s, r) => s + Number(r.total), 0);
      const apiErrors = apiDaily.rows.reduce((s, r) => s + Number(r.errors), 0);

      res.json({
        days,
        generatedAt: new Date().toISOString(),
        api: {
          daily: apiDaily.rows,
          endpoints: endpoints.rows,
          total: apiTotal,
          errors: apiErrors,
          errorRate: apiTotal > 0 ? apiErrors / apiTotal : 0,
        },
        audience: { daily: audience.rows, registrations: Number(regs.rows[0]?.n ?? 0) },
        vitals: vitals.rows,
        errors: {
          top: errTop.rows,
          sessionsTotal: Number(sessions.rows[0]?.total ?? 0),
          sessionsErrored: Number(sessions.rows[0]?.errored ?? 0),
        },
        usage: usage.rows,
        feedback: {
          responses: Number(fbSummary.rows[0]?.responses ?? 0),
          avg: fbSummary.rows[0]?.avg_score ?? null,
          dist: {
            1: Number(fbSummary.rows[0]?.s1 ?? 0),
            2: Number(fbSummary.rows[0]?.s2 ?? 0),
            3: Number(fbSummary.rows[0]?.s3 ?? 0),
            4: Number(fbSummary.rows[0]?.s4 ?? 0),
            5: Number(fbSummary.rows[0]?.s5 ?? 0),
          },
          recent: fbRecent.rows,
        },
      });
    })
  );

  return router;
}
