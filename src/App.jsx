import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./state/auth.jsx";
import DexView from "./DexView.jsx";
import PacksView from "./views/PacksView.jsx";
import CollectionView from "./views/CollectionView.jsx";
import LoginView from "./views/LoginView.jsx";
import ChatPanel from "./chat/ChatPanel.jsx";
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

  // The assistant follows whoever is logged in: switching accounts mid-chat
  // would leak user A's collection into user B's advisor answers.
  useEffect(() => {
    if (me) window.location.hash = "#/dex";
  }, [me?.id]);

  let view;
  if (route === "#/packs") view = <PacksView />;
  else if (route === "#/collection") view = <CollectionView onGoLogin={() => go("#/login")} />;
  else if (route === "#/login") view = <LoginView onDone={() => go("#/packs")} />;
  else view = <DexView onContextChange={setDexContext} />;

  return (
    <div className="app-shell">
      <Header route={route} go={go} />
      {view}
      <ChatPanel context={me ? dexContext : null} key={me ? `u${me.id}` : "guest"} />
    </div>
  );
};

const App = () => (
  <AuthProvider>
    <Shell />
  </AuthProvider>
);

export default App;
