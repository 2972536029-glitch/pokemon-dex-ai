// 数据看板(v2.4,仅管理员):KPI 卡片 + 手写 CSS 条形图。
//
// 不引图表库:看板是管理员低频页面,为它背 70KB 的 Chart.js 不值;
// 横向条形图用 div + 百分比宽度就够,零依赖且天然响应式。
// 服务端已按 Asia/Shanghai 切天(QA-037 时区教训),前端只做展示。
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

// Web Vitals 判级阈值(Google 口径,p75 达标即页面"良好")
const VITALS_META = {
  LCP: { unit: "ms", good: 2500, zh: "最大内容绘制" },
  INP: { unit: "ms", good: 200, zh: "交互延迟" },
  CLS: { unit: "", good: 0.1, zh: "布局偏移" },
  FCP: { unit: "ms", good: 1800, zh: "首次内容绘制" },
  TTFB: { unit: "ms", good: 800, zh: "首字节时间" },
};

function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`mtr-kpi ${tone ? `mtr-kpi-${tone}` : ""}`}>
      <span className="mtr-kpi-value">{value}</span>
      <span className="mtr-kpi-label">{label}</span>
      {sub && <span className="mtr-kpi-sub">{sub}</span>}
    </div>
  );
}

/** 横向条形列表:data: [{label, value, hint?}] */
function Bars({ data, unit = "" }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="mtr-bars">
      {data.map((d) => (
        <div key={d.label} className="mtr-bar-row" title={d.hint}>
          <span className="mtr-bar-label">{d.label}</span>
          <span className="mtr-bar-track">
            <span className="mtr-bar-fill" style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
          </span>
          <span className="mtr-bar-value">
            {d.value}
            {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

function fmtMs(v) {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

export default function MetricsView() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading"); // loading | ok | forbidden | error
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api
      .get(`/api/metrics/overview?days=${days}`)
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setState("ok");
      })
      .catch((e) => {
        if (cancelled) return;
        setState(e.status === 401 || e.status === 403 ? "forbidden" : "error");
        setErrMsg(e.message || "");
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  if (state === "loading") return <div className="view-loading" aria-label="加载中" />;

  if (state === "forbidden") {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>📊 数据看板仅管理员可见。</p>
          <p className="hint">{errMsg || "请使用管理员账号登录后访问。"}</p>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="view-narrow">
        <div className="card-box center">
          <p>看板加载失败。</p>
          <p className="hint">{errMsg}</p>
        </div>
      </div>
    );
  }

  const { api: apiM, audience, vitals, errors, usage, feedback } = data;
  const pvTotal = audience.daily.reduce((s, r) => s + Number(r.pv), 0);
  const dauLatest = audience.daily.length ? Number(audience.daily[audience.daily.length - 1].dau) : 0;
  const crashFree =
    errors.sessionsTotal > 0
      ? `${(((errors.sessionsTotal - errors.sessionsErrored) / errors.sessionsTotal) * 100).toFixed(1)}%`
      : "—";
  const fbAvg = feedback.avg != null ? Number(feedback.avg).toFixed(2) : "—";

  return (
    <div className="view-wide mtr-view">
      <div className="mtr-head">
        <h2 className="mtr-title">📊 数据看板</h2>
        <div className="mtr-days">
          {[7, 30].map((d) => (
            <button
              key={d}
              type="button"
              className={days === d ? "nav-link is-active" : "nav-link"}
              onClick={() => setDays(d)}
            >
              近 {d} 天
            </button>
          ))}
        </div>
      </div>
      <p className="hint mtr-generated">口径:按北京时间切天;crash-free 为「上报过事件的会话」中的近似值</p>

      <div className="mtr-kpis">
        <Kpi label="页面浏览 (PV)" value={pvTotal} />
        <Kpi label="最新日活 (DAU)" value={dauLatest} />
        <Kpi label="API 请求" value={apiM.total} sub={`p95 ${fmtMs(apiM.daily.length ? apiM.daily[apiM.daily.length - 1].p95_ms : null)}`} />
        <Kpi label="API 错误率" value={`${(apiM.errorRate * 100).toFixed(2)}%`} tone={apiM.errorRate > 0.02 ? "bad" : undefined} />
        <Kpi label="新增注册" value={audience.registrations} />
        <Kpi label="JS 错误" value={errors.top.reduce((s, r) => s + Number(r.n), 0)} tone={errors.top.length ? "warn" : undefined} />
        <Kpi label="Crash-free 会话" value={crashFree} />
        <Kpi label="满意度 (CSAT)" value={`${fbAvg} / 5`} sub={`${feedback.responses} 份反馈`} tone={feedback.avg != null && feedback.avg < 3 ? "warn" : undefined} />
      </div>

      <div className="mtr-grid">
        <section className="card-box mtr-section">
          <h3>每日流量(PV / DAU)</h3>
          {audience.daily.length ? (
            <Bars
              data={audience.daily.map((r) => ({
                label: String(r.day).slice(5),
                value: Number(r.pv),
                hint: `DAU ${r.dau}`,
              }))}
            />
          ) : (
            <p className="hint">暂无数据</p>
          )}
        </section>

        <section className="card-box mtr-section">
          <h3>功能使用 Top</h3>
          {usage.length ? (
            <Bars data={usage.map((u) => ({ label: u.action, value: Number(u.n) }))} />
          ) : (
            <p className="hint">暂无数据</p>
          )}
        </section>
      </div>

      <section className="card-box mtr-section">
        <h3>Web Vitals(p75,Google 判级口径)</h3>
        {vitals.length ? (
          <table className="mtr-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>p75</th>
                <th>良好 / 需改进 / 差</th>
                <th>样本</th>
              </tr>
            </thead>
            <tbody>
              {vitals.map((v) => {
                const meta = VITALS_META[v.name] ?? { unit: "ms", good: Infinity, zh: v.name };
                const val = meta.unit === "" ? Number(v.p75).toFixed(3) : fmtMs(v.p75);
                return (
                  <tr key={v.name}>
                    <td>
                      <b>{v.name}</b> <span className="hint">{meta.zh}</span>
                    </td>
                    <td className={Number(v.p75) <= meta.good ? "mtr-good" : "mtr-bad"}>{val}</td>
                    <td>
                      {v.good} / {v.ni} / {v.poor}
                    </td>
                    <td>{v.samples}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="hint">暂无数据</p>
        )}
      </section>

      <div className="mtr-grid">
        <section className="card-box mtr-section">
          <h3>API 端点 Top(按调用量)</h3>
          {apiM.endpoints.length ? (
            <table className="mtr-table">
              <thead>
                <tr>
                  <th>端点</th>
                  <th>调用</th>
                  <th>p95</th>
                  <th>5xx</th>
                </tr>
              </thead>
              <tbody>
                {apiM.endpoints.map((e) => (
                  <tr key={e.endpoint}>
                    <td className="mtr-endpoint">{e.endpoint}</td>
                    <td>{e.total}</td>
                    <td>{fmtMs(e.p95_ms)}</td>
                    <td className={Number(e.errors) > 0 ? "mtr-bad" : ""}>{e.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">暂无数据</p>
          )}
        </section>

        <section className="card-box mtr-section">
          <h3>JS 错误 Top</h3>
          {errors.top.length ? (
            <ul className="mtr-errlist">
              {errors.top.map((e) => (
                <li key={e.message}>
                  <span className="mtr-err-msg">{e.message}</span>
                  <span className="mtr-bar-value">×{e.n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">没有 JS 错误,很好 🎉</p>
          )}
        </section>
      </div>

      <section className="card-box mtr-section">
        <h3>满意度反馈</h3>
        <div className="mtr-fb-dist">
          {[5, 4, 3, 2, 1].map((s) => (
            <div key={s} className="mtr-bar-row">
              <span className="mtr-bar-label">{"⭐".repeat(s)}</span>
              <span className="mtr-bar-track">
                <span
                  className="mtr-bar-fill"
                  style={{
                    width: `${feedback.responses ? Math.max(2, ((feedback.dist[s] ?? 0) / feedback.responses) * 100) : 2}%`,
                  }}
                />
              </span>
              <span className="mtr-bar-value">{feedback.dist[s] ?? 0}</span>
            </div>
          ))}
        </div>
        {feedback.recent.length > 0 && (
          <ul className="mtr-comments">
            {feedback.recent.map((c, i) => (
              <li key={i}>
                <span className="mtr-comment-meta">
                  {"⭐".repeat(c.score)} · {c.context} · {String(c.created_at).slice(0, 10)}
                </span>
                <span>{c.comment}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
