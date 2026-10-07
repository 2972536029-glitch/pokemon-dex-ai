import { useEffect, useState } from "react";

// 好友动作完成后广播一次,导航红点立刻刷新(FriendsView 里调用)
export function bumpFriends() {
  window.dispatchEvent(new Event("friends-pending-changed"));
}

// 导航红点:待处理的好友申请 + 战书数量。
// 只在登录态变化和好友动作后拉取,不挂定时器(避免无谓轮询)。
export function useFriendPending(meId) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!meId) {
      setCount(0);
      return undefined;
    }
    let alive = true;
    const load = async () => {
      try {
        const [fr, bt] = await Promise.all([
          fetch("/api/friends").then((r) => (r.ok ? r.json() : null)),
          fetch("/api/friends/battles").then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!alive) return;
        setCount((fr?.incoming?.length ?? 0) + (bt?.incoming?.length ?? 0));
      } catch {
        // 网络抖动时保留上次计数
      }
    };
    load();
    window.addEventListener("friends-pending-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("friends-pending-changed", load);
    };
  }, [meId]);
  return count;
}
