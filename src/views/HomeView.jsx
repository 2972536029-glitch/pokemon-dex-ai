// 首页 · 游戏大厅:品牌 Hero + 功能入口 + 今日精选 + 个人数据。
// 纯展示页,只消费现有 API(collection/team),不新增后端。
import { useEffect, useState } from "react";
import { useAuth } from "../state/auth.jsx";
import { artworkUrl } from "../shared/artwork.js";
import { TYPE_COLORS, typeZh } from "../config/pokemon.js";
import { MAX_ID } from "../config/pokemon.js";

// 今日精选:按天确定性取号,同一天所有人看到同一只,零请求
const dailyId = () => (Math.floor(Date.now() / 86400000) % MAX_ID) + 1;

const ENTRIES = [
  {
    hash: "#/dex",
    name: "智能图鉴",
    desc: "问任何宝可梦,每句回答都经数据核对",
    art: 25,
    tint: "#f7d02c",
  },
  {
    hash: "#/packs",
    name: "卡包商店",
    desc: "三档卡包,概率全公示,抽取必入账",
    art: 133,
    tint: "#2a75bb",
  },
  {
    hash: "#/collection",
    name: "我的收藏",
    desc: "集卡编队,一秒组成你的梦之队",
    art: 6,
    tint: "#e3350d",
  },
  {
    hash: "#/battle",
    name: "对战竞技场",
    desc: "AI 推演对手,真实数值的回合对决",
    art: 150,
    tint: "#7b5cff",
  },
];

export default function HomeView({ go }) {
  const { me } = useAuth();
  const [daily, setDaily] = useState(null);
  const [stats, setStats] = useState(null); // { cards, teamSize }

  // 今日精选:轻量拉取该 id 的属性(主接口不含属性会显示占位)
  useEffect(() => {
    let cancelled = false;
    const id = dailyId();
    fetch(`https://pokeapi.co/api/v2/pokemon/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (cancelled) return;
        setDaily({
          id,
          name: d.name,
          types: (d.types ?? []).map((t) => t.type.name),
          sprite:
            d.sprites?.other?.["official-artwork"]?.front_default ??
            d.sprites?.front_default,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 登录用户的数据条:收藏种数 + 编队人数(两个现有 API)
  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    Promise.all([fetch("/api/collection"), fetch("/api/battle/team")])
      .then(async ([cRes, tRes]) => {
        const c = await cRes.json();
        const t = await tRes.json().catch(() => ({}));
        if (!cancelled) {
          setStats({
            cards: (c.cards ?? []).length,
            kinds: (c.cards ?? []).reduce((n, x) => n + (x.count ?? 1), 0),
            team: (t.cardIds ?? []).length,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [me?.id]);

  return (
    <div className="home-view">
      {/* Hero:开屏同款夜空语言,静态低负担 */}
      <section className="home-hero">
        <div className="home-hero-stars" aria-hidden="true" />
        <img className="home-hero-float" src={artworkUrl(149)} alt="" aria-hidden="true" />
        <p className="home-hero-eyebrow">POKÉMON DEX · AI</p>
        <h1 className="home-hero-title">
          梦幻图鉴<span className="hero-dot">的</span>宝可梦冒险
        </h1>
        <p className="home-hero-sub">查证 · 收藏 · 对战——这只图鉴会思考</p>
        <div className="home-hero-cta">
          <button type="button" className="btn-primary" onClick={() => go("#/dex")}>
            ▶ 随机遇见一只
          </button>
          <button type="button" className="btn-gold" onClick={() => go("#/battle")}>
            ⚔ 直接开战
          </button>
        </div>
      </section>

      {/* 四大入口 */}
      <section className="home-entries">
        {ENTRIES.map((e) => (
          <button
            key={e.hash}
            type="button"
            className="home-entry"
            style={{ "--tint": e.tint }}
            onClick={() => go(e.hash)}
          >
            <span className="home-entry-art">
              <img src={artworkUrl(e.art)} alt="" loading="lazy" />
            </span>
            <span className="home-entry-name">{e.name}</span>
            <span className="home-entry-desc">{e.desc}</span>
            <span className="home-entry-go">进入 →</span>
          </button>
        ))}
      </section>

      {/* 今日精选 + 我的数据 */}
      <section className="home-lower">
        <div className="home-daily card-box">
          <div className="home-sec-title">
            <span className="view-title">今日的宝可梦</span>
            <span className="home-daily-date">
              {new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}
            </span>
          </div>
          {daily ? (
            <button type="button" className="home-daily-card" onClick={() => go("#/dex")}>
              <img
                src={daily.sprite}
                alt={daily.name}
                onError={(e) => {
                  // 立绘加载失败回退链:jsDelivr → pokeapi.co 官方源 → 隐藏
                  const img = e.currentTarget;
                  if (!img.dataset.fb) {
                    img.dataset.fb = "1";
                    img.src = `https://pokeapi.co/media/sprites/pokemon/other/official-artwork/${daily.id}.png`;
                  } else {
                    img.style.display = "none";
                  }
                }}
              />
              <span className="home-daily-no">No.{String(daily.id).padStart(4, "0")}</span>
              <span className="home-daily-name">{daily.name}</span>
              <span className="home-daily-types">
                {daily.types.map((t) => (
                  <span key={t} className="type-chip" style={{ background: TYPE_COLORS[t] }}>
                    {typeZh(t)}
                  </span>
                ))}
              </span>
              <span className="home-daily-hint">去图鉴遇见它 →</span>
            </button>
          ) : (
            <div className="skeleton-card home-daily-skeleton" aria-hidden="true" />
          )}
        </div>

        <div className="home-me card-box">
          <div className="home-sec-title">
            <span className="view-title">我的冒险</span>
          </div>
          {me ? (
            stats ? (
              <div className="home-me-grid">
                <div className="home-me-cell">
                  <b>{me.balance}</b>
                  <span>图鉴币</span>
                </div>
                <div className="home-me-cell">
                  <b>{stats.cards}</b>
                  <span>收藏种类</span>
                </div>
                <div className="home-me-cell">
                  <b>{stats.team}/3</b>
                  <span>对战编队</span>
                </div>
                <div className="home-me-cell">
                  <b>{stats.kinds}</b>
                  <span>累计获得</span>
                </div>
                <button type="button" className="btn-gold home-me-cta" onClick={() => go("#/packs")}>
                  去抽卡扩充收藏
                </button>
              </div>
            ) : (
              <div className="skeleton-card home-me-skeleton" aria-hidden="true" />
            )
          ) : (
            <div className="home-me-guest">
              <p>登录后开启收藏、编队与对战。</p>
              <button type="button" className="btn-primary" onClick={() => go("#/login")}>
                登录 / 注册
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
