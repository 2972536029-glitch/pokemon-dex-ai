import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./state/auth.jsx";
import DexView from "./DexView.jsx";
import PacksView from "./views/PacksView.jsx";
import CollectionView from "./views/CollectionView.jsx";
import LoginView from "./views/LoginView.jsx";
import BattleView from "./views/BattleView.jsx";
import ChatPanel from "./chat/ChatPanel.jsx";
import Splash from "./views/Splash.jsx";
import { useTheme } from "./hooks/useTheme.js";
import "./views/splash.css";
import "./views/views.css";

function useHashRoute() {
  const [route, setRoute] = useState(window.location.hash || "#/dex");
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/dex");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

// 余额数字滚动:变化时 600ms 缓动追到新值(rAF 只在动画期间跑)
function useCountUp(value) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return undefined;
    const t0 = performance.now();
    let raf;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 600);
      const eased = 1 - (1 - p) ** 3;
      const current = Math.round(from + (value - from) * eased);
      fromRef.current = current;
      setDisplay(current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return display;
}

function Header({ route, go }) {
  const { me, logout } = useAuth();
  const balance = useCountUp(me?.balance ?? 0);
  const link = (hash, label) => (
    <button
      type="button"
      className={route === hash ? "nav-link is-active" : "nav-link"}
      onClick={() => go(hash)}
    >
      {label}
    </button>
  );
  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => go("#/dex")}>
        <span className="brand-ball" aria-hidden="true" />
        <span className="brand-name">
          宝可梦图鉴 <b>AI</b>
        </span>
      </button>
      <nav className="topbar-nav">
        {link("#/dex", "图鉴")}
        {link("#/packs", "卡包商店")}
        {link("#/collection", "我的收藏")}
        {link("#/battle", "对战")}
      </nav>
      <div className="topbar-user">
        {me ? (
          <>
            <span className="user-chip" title="图鉴币余额">
              <span className="coin-ico" aria-hidden="true" />
              {balance}
            </span>
            <span className="user-name">
              <span className="avatar-bubble" aria-hidden="true">
                {me.username.slice(0, 1).toUpperCase()}
              </span>
              {me.username}
            </span>
            <button type="button" className="nav-link ghost" onClick={logout}>
              退出
            </button>
          </>
        ) : (
          link("#/login", "登录 / 注册")
        )}
      </div>
    </header>
  );
}

const TITLES = {
  "#/dex": "图鉴",
  "#/packs": "卡包商店",
  "#/collection": "我的收藏",
  "#/battle": "对战",
  "#/login": "登录",
};

const Shell = () => {
  const route = useHashRoute();
  // 主题必须在 App 根部应用:只挂在单个视图里时,其余视图会回退浅色
  // (QA 实测:#/battle 准备页曾整页变白)。DexView 里的切换按钮仍独立工作。
  useTheme();
  // 浏览器标签页标题跟随视图
  useEffect(() => {
    const view = TITLES[route];
    document.title = view ? `${view} · 宝可梦图鉴 AI` : "宝可梦图鉴 AI";
  }, [route]);
  const go = (hash) => {
    window.location.hash = hash;
  };
  const [dexContext, setDexContext] = useState(null);
  const { me } = useAuth();
  // 原神式开屏:每次完整加载都先进入沉浸页,点击 CTA 才进业务
  const [entered, setEntered] = useState(false);
  const [splashGone, setSplashGone] = useState(false);

  // After login land on the dex — but never yank users off a route they
  // chose (reload on #/battle must stay on #/battle; QA-lesson: an effect
  // that "fixes" the hash on every me change breaks deep links).
  useEffect(() => {
    if (me && window.location.hash === "#/login") window.location.hash = "#/dex";
  }, [me?.id]);

  let view;
  if (route === "#/packs") view = <PacksView />;
  else if (route === "#/collection") view = <CollectionView onGoLogin={() => go("#/login")} onGoBattle={() => go("#/battle")} />;
  else if (route === "#/login") view = <LoginView onDone={() => go("#/packs")} />;
  else if (route === "#/battle") view = <BattleView onGoLogin={() => go("#/login")} onGoCollection={() => go("#/collection")} />;
  else view = <DexView onContextChange={setDexContext} />;

  return (
    <div className={`app-shell ${entered && splashGone ? "app-enter" : ""}`}>
      <Header route={route} go={go} />
      {/* key=route:切视图时重挂载,触发 view-in 过渡动画 */}
      <main className="view-frame" key={route}>
        {view}
      </main>
      <ChatPanel context={me ? dexContext : null} key={me ? `u${me.id}` : "guest"} />
      {!splashGone && (
        <Splash
          fading={entered}
          onEnter={() => {
            // 白幕覆盖完成后调用:应用已在下方入场,白幕再缓缓揭开
            setEntered(true);
            if (!me) go("#/login");
            else go("#/dex");
            setTimeout(() => setSplashGone(true), 950);
          }}
        />
      )}
    </div>
  );
};

const App = () => (
  <AuthProvider>
    <Shell />
  </AuthProvider>
);

export default App;
