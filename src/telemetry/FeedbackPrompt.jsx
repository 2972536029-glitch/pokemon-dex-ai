// 满意度微调查件(v2.4):CSAT 1-5 emoji + 选填一句话。
//
// 设计约束:
// - 内联卡片而非悬浮球:fixed 元素在移动端要跟 tabbar/安全区抢空间
//   (QA-038 的教训),内联组件零布局风险。
// - 每天每场景最多出现一次:localStorage 按天去重;答过或关掉就不再打扰。
// - 评分即提交(一步到位,转化率优先),评语随后选填——20h 内再次 POST
//   由服务端 upsert 覆盖,不会产生两条记录。
import { useState } from "react";
import { api } from "../api/client.js";
import { telemetryIds, trackAction } from "./telemetry.js";

const FACES = [
  { score: 1, icon: "😞", label: "很差" },
  { score: 2, icon: "🙁", label: "一般" },
  { score: 3, icon: "😐", label: "还行" },
  { score: 4, icon: "🙂", label: "不错" },
  { score: 5, icon: "🤩", label: "太棒了" },
];

// UTC 日期做展示端去重键即可:与服务端 20h 窗口的误差最多影响"明天几点
// 再问一次",不影响数据正确性。
const today = () => new Date().toISOString().slice(0, 10);

export default function FeedbackPrompt({ context, title }) {
  // 惰性读 localStorage:初始化只发生一次,不在每次渲染里碰存储
  const [phase, setPhase] = useState(() => {
    try {
      return localStorage.getItem(`fb:${context}:${today()}`) ? "hidden" : "open";
    } catch {
      return "open";
    }
  });
  const [score, setScore] = useState(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState(null);
  const { anonId, sessionId } = telemetryIds();

  const remember = (value) => {
    try {
      localStorage.setItem(`fb:${context}:${today()}`, value);
    } catch {
      /* 存储不可用就不记忆:最多多看一次,不阻塞主流程 */
    }
  };

  async function submitScore(s) {
    setScore(s);
    setError(null);
    // 双轨埋点:RUM addAction + 自建 usage(每日 KPI 数据源),评分即事件
    trackAction("csat", { context, score: s });
    try {
      await api.post("/api/feedback", { context, score: s, anonId, sessionId });
      setPhase("comment");
    } catch (e) {
      setError(e.message || "提交失败,请重试");
    }
  }

  async function submitComment() {
    setError(null);
    try {
      // 20h 窗口内服务端按 (身份, 场景) upsert:这里补交的是同一份反馈的评语
      await api.post("/api/feedback", { context, score, comment, anonId, sessionId });
      remember("done");
      setPhase("thanks");
    } catch (e) {
      setError(e.message || "提交失败,请重试");
    }
  }

  if (phase === "hidden") return null;

  return (
    <div className="fbp card-box">
      {phase === "open" && (
        <>
          <p className="fbp-title">{title}</p>
          <div className="fbp-faces">
            {FACES.map((f) => (
              <button
                key={f.score}
                type="button"
                className="fbp-face"
                title={f.label}
                aria-label={`${f.label}(${f.score} 分)`}
                onClick={() => submitScore(f.score)}
              >
                {f.icon}
              </button>
            ))}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      )}

      {phase === "comment" && (
        <>
          <p className="fbp-title">谢谢!想多说两句吗?(选填)</p>
          <textarea
            className="fbp-comment"
            value={comment}
            maxLength={200}
            rows={2}
            placeholder="哪里满意、哪里别扭,都可以说"
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="fbp-row">
            <button type="button" className="btn-primary fbp-btn" onClick={submitComment}>
              发送
            </button>
            <button
              type="button"
              className="fbp-skip"
              onClick={() => {
                remember("done");
                setPhase("hidden");
              }}
            >
              不说了
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      )}

      {phase === "thanks" && <p className="fbp-title">已收到,感谢反馈!🎉</p>}
    </div>
  );
}
