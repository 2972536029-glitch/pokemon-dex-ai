// 开屏冒险动画(v1.3 §二):仅首次访问播放完整版。
// 时间轴全部由状态机驱动 CSS 动画;「跳过」与主按钮都会写 localStorage 并淡出。
import { useEffect, useState } from "react";
import "./splash.css";

const STORAGE_KEY = "pdx_adventure";

// 时间轴节点(秒,自挂载起算)——绝对时间,单次调度
const TIMELINE = { wobble: 0.75, flash: 1.5, title: 1.9, ready: 2.7 };

export default function Splash({ onEnter }) {
  const [phase, setPhase] = useState(() =>
    localStorage.getItem(STORAGE_KEY) ? "done" : "ball-drop"
  );

  useEffect(() => {
    if (phase === "done") return undefined;
    // 绝对时间轴:挂载时一次调度全部转场,中途不重置
    const timers = [
      setTimeout(() => setPhase("ball-wobble"), TIMELINE.wobble * 1000),
      setTimeout(() => setPhase("flash"), TIMELINE.flash * 1000),
      setTimeout(() => setPhase("title"), TIMELINE.title * 1000),
      setTimeout(() => setPhase("ready"), TIMELINE.ready * 1000),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  function enter() {
    localStorage.setItem(STORAGE_KEY, "1");
    setPhase("leaving");
    setTimeout(onEnter, 650); // 白光过渡后交给应用
  }

  if (phase === "done") return null;

  return (
    <div className={`splash phase-${phase}`} role="dialog" aria-label="开屏动画">
      {phase === "leaving" && <div className="splash-whiteout" />}

      {(phase === "ball-drop" || phase === "ball-wobble") && (
        <div className={`splash-ball ${phase === "ball-wobble" ? "is-wobbling" : ""}`} />
      )}

      {phase === "flash" && <div className="splash-flash" />}

      {(phase === "title" || phase === "ready" || phase === "leaving") && (
        <>
          <div className="splash-title-wrap">
            <h1 className="splash-title">
              宝可梦图鉴 <span className="splash-title-ai">AI</span>
            </h1>
            <p className="splash-tagline">查证 · 收藏 · 对战——你的 AI 宝可梦冒险</p>
          </div>
          <button
            type="button"
            className={`splash-cta ${phase === "ready" ? "is-pulsing" : ""}`}
            onClick={enter}
          >
            ▶ 开启我的宝可梦冒险
          </button>
          <button type="button" className="splash-skip" onClick={enter}>
            跳过 »
          </button>
        </>
      )}
    </div>
  );
}
