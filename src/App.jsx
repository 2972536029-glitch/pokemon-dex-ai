import { Component, Suspense, lazy, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./state/auth.jsx";
// 路由级代码分割:首页/开屏保持首包,业务视图按需加载(首屏体积减半)
const HomeView = lazy(() => import("./views/HomeView.jsx"));
const DexView = lazy(() => import("./views/DexView.jsx"));
const PacksView = lazy(() => import("./views/PacksView.jsx"));
const CollectionView = lazy(() => import("./views/CollectionView.jsx"));
const LoginView = lazy(() => import("./views/LoginView.jsx"));
const BattleView = lazy(() => import("./views/BattleView.jsx"));
const FriendsView = lazy(() => import("./views/FriendsView.jsx"));
const WikiView = lazy(() => import("./views/WikiView.jsx"));
import ChatPanel from "./chat/ChatPanel.jsx";
import Splash from "./views/Splash.jsx";
import { useTheme } from "./hooks/useTheme.js";
import { useFriendPending } from "./hooks/useFriendPending.js";
import "./views/views.css";

// 视图崩溃兜底:商业底线是任何单页异常都不能白屏整站
class ViewErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return (
        <div className="view-narrow">
          <div className="card-box center">
            <p>这个页面出了点问题。</p>
            <button type="button" className="btn-primary" onClick={() => this.setState({ failed: false })}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function useHashRoute() {
  const [route, setRoute] = useState(window.location.hash || "#/home");
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/home");
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

function Header({ route, go, pending }) {
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
      <button type="button" className="brand" onClick={() => go("#/home")}>
        <span className="brand-ball" aria-hidden="true" />
        <span className="brand-name">
          宝可梦图鉴 <b>AI</b>
        </span>
      </button>
      <nav className="topbar-nav">
        {link("#/home", "首页")}
        {link("#/dex", "图鉴")}
        {link("#/packs", "卡包商店")}
        {link("#/collection", "我的收藏")}
        {link("#/battle", "对战")}
        <span className="nav-badge-wrap">
          {link("#/friends", "好友")}
          {pending > 0 && <span className="nav-badge" aria-label={`待处理 ${pending} 项`}>{pending}</span>}
        </span>
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
  "#/home": "首页",
  "#/dex": "图鉴",
  "#/packs": "卡包商店",
  "#/collection": "我的收藏",
  "#/battle": "对战",
  "#/friends": "好友",
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
  const pendingFriends = useFriendPending(me?.id ?? null);
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
  if (route.startsWith("#/wiki/")) {
    view = <WikiView param={decodeURIComponent(route.slice("#/wiki/".length))} go={go} />;
  } else if (route === "#/home") view = <HomeView go={go} />;
  else if (route === "#/packs") view = <PacksView />;
  else if (route === "#/collection") view = <CollectionView onGoLogin={() => go("#/login")} onGoBattle={() => go("#/battle")} />;
  else if (route === "#/login") view = <LoginView onDone={() => go("#/packs")} />;
  else if (route === "#/battle") view = <BattleView onGoLogin={() => go("#/login")} onGoCollection={() => go("#/collection")} />;
  else if (route === "#/friends") view = <FriendsView />;
  else view = <DexView onContextChange={setDexContext} />;

  return (
    <div className={`app-shell ${entered && splashGone ? "app-enter" : ""}`}>
      <Header route={route} go={go} pending={pendingFriends} />
      {/* key=route:切视图时重挂载,触发 view-in 过渡动画 */}
      <main className="view-frame" key={route}>
        <ViewErrorBoundary>
          <Suspense fallback={<div className="view-loading" aria-label="加载中" />}>
            {view}
          </Suspense>
        </ViewErrorBoundary>
      </main>
      <ChatPanel context={me ? dexContext : null} key={me ? `u${me.id}` : "guest"} />
      {/* 移动端底部导航(桌面端由 CSS 隐藏) */}
      <nav className="tabbar" aria-label="底部导航">
        {[
          ["#/home", "首页", "🏠"],
          ["#/dex", "图鉴", "📖"],
          ["#/packs", "商店", "🎴"],
          ["#/collection", "收藏", "🎒"],
          ["#/battle", "对战", "⚔️"],
          ["#/friends", "好友", "🤝"],
        ].map(([hash, label, icon]) => (
          <button
            key={hash}
            type="button"
            className={route === hash ? "tabbar-item is-active" : "tabbar-item"}
            onClick={() => go(hash)}
          >
            <span className="tabbar-icon" aria-hidden="true">
              {icon}
              {hash === "#/friends" && pendingFriends > 0 && (
                <span className="nav-badge" aria-label={`待处理 ${pendingFriends} 项`}>{pendingFriends}</span>
              )}
            </span>
            <span className="tabbar-label">{label}</span>
          </button>
        ))}
      </nav>
      {!splashGone && (
        <Splash
          fading={entered}
          onEnter={() => {
            // 白幕覆盖完成后调用:应用已在下方入场,白幕再缓缓揭开
            setEntered(true);
            go("#/home");
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
