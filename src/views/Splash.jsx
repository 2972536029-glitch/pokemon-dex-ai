// 开屏 · 原神式沉浸动态页(v1.3):
// 无实际功能,纯氛围——暮色星空 + 山影 + 光尘 + 宝可梦立绘浮影,
// 中央华丽标题 + 饰边「开启冒险」按钮,点击进入业务。
// 全部 CSS/SVG 原创,无任何第三方美术素材。
import { useEffect, useState } from "react";
import { artworkUrl } from "../shared/artwork.js";
import "./splash.css";

export default function Splash({ onEnter }) {
  const [leaving, setLeaving] = useState(false);

  function enter() {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onEnter, 700); // 白光收束后交给业务
  }

  return (
    <div className={`gh-splash ${leaving ? "is-leaving" : ""}`} role="dialog" aria-label="欢迎来到宝可梦图鉴 AI">
      {/* 天空:暮色渐变 + 月亮 + 星辰 */}
      <div className="gh-sky">
        <div className="gh-moon" />
        <div className="gh-stars" />
        <div className="gh-stars gh-stars-2" />
      </div>

      {/* 远景:宝可梦立绘浮影 */}
      <img className="gh-float gh-float-1" src={artworkUrl(6)} alt="" aria-hidden="true" />
      <img className="gh-float gh-float-2" src={artworkUrl(149)} alt="" aria-hidden="true" />
      <img className="gh-float gh-float-3" src={artworkUrl(25)} alt="" aria-hidden="true" />

      {/* 中景:山影两层 */}
      <svg className="gh-hills gh-hills-far" viewBox="0 0 1440 320" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,220 C240,140 420,190 720,150 C1020,110 1240,180 1440,140 L1440,320 L0,320 Z" />
      </svg>
      <svg className="gh-hills gh-hills-near" viewBox="0 0 1440 320" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,260 C200,200 480,260 760,220 C1040,180 1260,250 1440,210 L1440,320 L0,320 Z" />
      </svg>

      {/* 漂浮光尘 */}
      <div className="gh-motes">
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i} className={`gh-mote gh-mote-${i % 7}`} style={{ left: `${(i * 71 + 13) % 100}%`, animationDelay: `${(i * 1.7) % 9}s` }} />
        ))}
      </div>

      {/* 顶栏:logo 与跳过 */}
      <div className="gh-topbar">
        <span className="gh-logo">
          宝可梦图鉴 <b>AI</b>
        </span>
        <button type="button" className="gh-skip" onClick={enter}>
          跳过 »
        </button>
      </div>

      {/* 中央:版本题 + CTA */}
      <div className="gh-center">
        <div className="gh-version">VER 1.3 · 智能图鉴时代</div>
        <h1 className="gh-title">
          <span>梦</span>
          <span>幻</span>
          <span>图</span>
          <span>鉴</span>
          <em>的</em>
          <span>A</span>
          <span>I</span>
          <span>冒</span>
          <span>险</span>
        </h1>
        <button type="button" className="gh-cta" onClick={enter}>
          <span className="gh-cta-inner">▶ 开启我的宝可梦冒险</span>
        </button>
        <p className="gh-note">查证 · 收藏 · 对战——图鉴会思考,冒险由你开启</p>
      </div>
    </div>
  );
}
