// 图鉴词条 AI 小传:基于 species 事实让 GLM 写一段短背景故事,
// 数值声明逐项与事实表核对(不符则剔除该句),结果进程内缓存。
// 灵感与守卫原则同 agent.ts/guard.ts:宁缺毋错。
import express from "express";
import { chatComplete, GLM_CONFIG } from "./llm.js";

const cache = new Map(); // id -> { lore, checked, warnings }

interface SpeciesFacts {
  zhName: string;
  enName: string;
  genus: string;
  flavor: string;
  heightM: number;
  weightKg: number;
  types: string[];
}

interface PokemonStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadFacts(id: number): Promise<Required<SpeciesFacts> & { stats: PokemonStats }> {
  const poke = await fetchJson(`https://pokeapi.co/api/v2/pokemon/${id}`);
  const species = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${id}`);
  const stat = (name: string) =>
    Number((poke.stats ?? []).find((s: any) => s.stat.name === name)?.base_stat ?? 0);
  const zhName =
    (species.names ?? []).find((n: any) => n.language.name === "zh-Hans")?.name ??
    poke.name;
  const genus =
    (species.genera ?? []).find((g: any) => g.language.name === "zh-Hans")?.genus ?? "";
  const flavor =
    (species.flavor_text_entries ?? [])
      .filter((f: any) => f.language.name === "zh-Hans")
      .slice(-1)[0]?.flavor_text?.replace(/\s+/g, " ") ?? "";
  return {
    zhName,
    enName: poke.name,
    genus,
    flavor,
    heightM: (poke.height ?? 0) / 10,
    weightKg: (poke.weight ?? 0) / 10,
    types: (poke.types ?? []).map((t: any) => t.type.name),
    stats: {
      hp: stat("hp"),
      attack: stat("attack"),
      defense: stat("defense"),
      speed: stat("speed"),
    },
  };
}

/** 抽取文本中的数字,与事实不符的句子整句剔除(宁缺毋错) */
function guardNumbers(text: string, facts: { heightM: number; weightKg: number; stats: PokemonStats }): { text: string; checked: number; warnings: number } {
  const allowed = new Set<number>([
    facts.heightM,
    facts.weightKg,
    facts.stats.hp,
    facts.stats.attack,
    facts.stats.defense,
    facts.stats.speed,
  ]);
  let checked = 0;
  let warnings = 0;
  const sentences = text.split(/(?<=[。!?!?])/).filter(Boolean);
  const kept = sentences.map((sentence) => {
    const nums = [...sentence.matchAll(/\d+(\.\d+)?/g)].map((m) => Number(m[0]));
    if (nums.length === 0) return sentence;
    checked += nums.length;
    const bad = nums.filter((n) => !allowed.has(n));
    if (bad.length > 0) {
      warnings++;
      return "";
    }
    return sentence;
  });
  return { text: kept.join(""), checked, warnings };
}

export function mountLore(): express.Router {
  const router = express.Router();

  // TEMP DEBUG (QA-033 验证用,验证完删除): 只返回长度与存在性,不泄值
  router.get("/api/debug-pity-env", (_req, res) => {
    const v = process.env.UNLIMITED_USER_IDS;
    res.json({ set: v !== undefined, len: (v ?? "").length, matchesTest888: v === "test888" });
  });

  router.get("/api/lore/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 1010) {
      res.status(400).json({ error: "bad id" });
      return;
    }
    if (cache.has(id)) {
      res.json(cache.get(id));
      return;
    }
    if (!GLM_CONFIG.apiKey) {
      res.status(503).json({ error: "unavailable", message: "模型未配置" });
      return;
    }
    try {
      const facts = await loadFacts(id);
      const prompt = `你是宝可梦图鉴的编辑。基于以下【事实】为${facts.zhName}(${facts.enName},${facts.genus})写一段 80 字以内的中文背景介绍。
要求:只使用事实中出现的信息与数字,不得编造任何数值或设定;语言自然,不要逐条罗列。
【事实】身高 ${facts.heightM}m;体重 ${facts.weightKg}kg;HP ${facts.stats.hp};攻击 ${facts.stats.attack};防御 ${facts.stats.defense};速度 ${facts.stats.speed}。官方说明:${facts.flavor}`;
      const lore = await chatComplete(
        [
          { role: "system", content: "你是严谨的宝可梦图鉴编辑,只依据给定事实写作,绝不编造数字。" },
          { role: "user", content: prompt },
        ],
        { signal: AbortSignal.timeout(20_000), maxTokens: 300, temperature: 0.5 }
      );
      const g = guardNumbers(lore, facts);
      const payload = {
        lore: g.text.trim() || facts.flavor,
        checked: g.checked,
        warnings: g.warnings,
      };
      cache.set(id, payload);
      res.json(payload);
    } catch (err: any) {
      console.error("[lore] failed:", err?.message);
      res.status(503).json({ error: "unavailable", message: "生成失败,请稍后再试" });
    }
  });

  return router;
}
