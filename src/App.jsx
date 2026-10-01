import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./state/auth.jsx";
import DexView from "./DexView.jsx";
import PacksView from "./views/PacksView.jsx";
import CollectionView from "./views/CollectionView.jsx";
import LoginView from "./views/LoginView.jsx";
import BattleView from "./views/BattleView.jsx";
import ChatPanel from "./chat/ChatPanel.jsx";
import Splash from "./views/Splash.jsx";
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

function Header({ route, go }) {
  const { me, logout } = useAuth();
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
              🪙 {me.balance}
            </span>
            <span className="user-name">{me.username}</span>
            <button type="button" className="nav-link" onClick={logout}>
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

const Shell = () => {
  const route = useHashRoute();
  const go = (hash) => {
    window.location.hash = hash;
  };
  const [dexContext, setDexContext] = useState(null);
  const { me } = useAuth();
  const [adventureStarted, setAdventureStarted] = useState(() =>
    Boolean(localStorage.getItem("pdx_adventure"))
  );
  // 登录后冒险已开始(注册/登录即视为老练训练师)
  useEffect(() => {
    if (me) {
      localStorage.setItem("pdx_adventure", "1");
      setAdventureStarted(true);
    }
  }, [me?.id]);

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

  const showSplash = !adventureStarted && !me;

  return (
    <div className="app-shell">
      <Header route={route} go={go} />
      {view}
      <ChatPanel context={me ? dexContext : null} key={me ? `u${me.id}` : "guest"} />
      {showSplash && (
        <Splash
          onEnter={() => {
            setAdventureStarted(true);
            go("#/dex");
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
