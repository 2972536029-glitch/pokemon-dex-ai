// PokeAPI 服务端代理(v3.1 审计 P1-9:第三方数据源必须在自己的可控边界之后)。
//
// 背景:中国用户直连 pokeapi.co 不稳定——项目早已因此把立绘镜像到 jsDelivr,
// 但数据仍直连上游,图鉴/词条/今日精选在弱网下骨架屏到永远。Vercel 函数(US
// 节点)到 pokeapi 快而稳,代理 + 缓存后浏览器只打自己域。
//
// 设计:
// - 路径白名单(pokemon / pokemon-species):不做成开放代理。
// - 进程内 LRU-ish 缓存(24h TTL,1500 条上限):151 只精灵的详情+名单,
//   稳态命中率接近 100%;serverless 多实例各自缓存,可接受。
// - 下发 Cache-Control(浏览器侧 24h):与 immutable 产物同一套缓存纪律。
// - 外呼 10s 预算(v3.1 审计 P1-6 的统一纪律)。

import express from "express";
import { wrap } from "./http.js";

const UPSTREAM = "https://pokeapi.co/api/v2";
const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 1500;

const cache = new Map<string, { at: number; status: number; body: string; contentType: string }>();

function cacheGet(key: string) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // 刷新插入序(Map 迭代序 = 插入序),近似 LRU
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: { status: number; body: string; contentType: string }) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ...entry });
}

/** 只放行前端真正用到的两个资源族;其余一律 404(不做开放代理)。 */
function allowedPath(path: string): boolean {
  return /^\/(pokemon|pokemon-species)(\/[a-z0-9-]{1,32})?$/.test(path);
}

export function mountPoke(): express.Router {
  const router = express.Router();

  router.use(
    "/api/poke",
    wrap("poke", "图鉴数据暂时不可用,请稍后再试", async (req, res) => {
      // router.use 挂载前缀会被 Express 从 req.url 剥掉,但不同版本/嵌套层级
      // 行为有差 —— 防御式归一:无论剥没剥都拿到 /pokemon/25 形态
      const raw = (req.url || req.path).split("?")[0];
      const path = (raw.startsWith("/api/poke") ? raw.slice("/api/poke".length) : raw).replace(/\/+$/, "") || "/";
      if (!allowedPath(path)) {
        res.status(404).json({ error: "not_found", message: "未知的图鉴资源" });
        return;
      }
      const search = (req.url || "").split("?")[1] ?? "";
      const key = search ? `${path}?${search}` : path;

      const hit = cacheGet(key);
      if (hit) {
        res.status(hit.status).setHeader("content-type", hit.contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(hit.body);
        return;
      }
      const upstream = await fetch(`${UPSTREAM}${path}${search ? `?${search}` : ""}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "pokemon-dex-ai/3.1 (proxy)" },
      });
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const body = await upstream.text();
      if (upstream.status === 200) {
        cacheSet(key, { status: upstream.status, body, contentType });
        res.status(200).setHeader("content-type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(body);
      } else {
        // 上游 404 等原样透传状态码但不缓存
        res.status(upstream.status).setHeader("content-type", contentType);
        res.send(body);
      }
    })
  );

  return router;
}
