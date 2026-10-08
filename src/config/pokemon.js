// Static configuration for the Pokémon page: API endpoint + display maps.

export const MAX_ID = 1010;
export const POKEAPI_BASE = "https://pokeapi.co/api/v2/pokemon";

export const TYPE_COLORS = {
  normal: "#A8A77A",
  fire: "#EE8130",
  water: "#6390F0",
  electric: "#F7D02C",
  grass: "#7AC74C",
  ice: "#96D9D6",
  fighting: "#C22E28",
  poison: "#A33EA1",
  ground: "#E2BF65",
  flying: "#A98FF3",
  psychic: "#F95587",
  bug: "#A6B91A",
  rock: "#B6A136",
  ghost: "#735797",
  dragon: "#6F35FC",
  dark: "#705746",
  steel: "#B7B7CE",
  fairy: "#D685AD",
};

export const STAT_LABELS = {
  hp: "HP",
  attack: "Attack",
  defense: "Defense",
  "special-attack": "Sp. Atk",
  "special-defense": "Sp. Def",
  speed: "Speed",
};

// 官方中文译名(仅用于展示;过滤/战斗计算仍用英文 key)
export const TYPE_ZH = {
  normal: "一般",
  fire: "火",
  water: "水",
  electric: "电",
  grass: "草",
  ice: "冰",
  fighting: "格斗",
  poison: "毒",
  ground: "地面",
  flying: "飞行",
  psychic: "超能",
  bug: "虫",
  rock: "岩石",
  ghost: "幽灵",
  dragon: "龙",
  dark: "恶",
  steel: "钢",
  fairy: "妖精",
};

export const typeZh = (en) => TYPE_ZH[en] ?? en;

// 能力值中文名(dex 大卡用;PokemonCard 里也有局部映射的旧表,逐步收编到这里)
export const STAT_ZH = {
  hp: "体力",
  attack: "攻击",
  defense: "防御",
  "special-attack": "特攻",
  "special-defense": "特防",
  speed: "速度",
};


// ---- 稀有度呈现常量(v2.3 从 4 个视图收敛) ----
export const RARITY_SHORT = { C: "C", R: "R", UR: "UR" };              // 角标用
export const RARITY_LONG = { C: "常见 (C)", R: "稀有 (R)", UR: "超稀有 (UR)" }; // 完整标签
export const RARITY_DOT = { C: "#98a4b0", R: "#2a75bb", UR: "#d4af37" };     // 概率条圆点
export const RARITY_RANK = { C: 0, R: 1, UR: 2 };                     // 排序权重
export const RARITY_CHIP_CLS = { C: "fr-chip-c", R: "fr-chip-r", UR: "fr-chip-ur" }; // 好友页章样式

/** 稀有度渐变头(卡面头部背景):两属性取前两色 */
export function rarityGradientHead(colors) {
  const g = colors ?? [];
  const a = g[0] ?? "#98a4b0";
  return g.length > 1 ? `linear-gradient(120deg, ${g[0]}, ${g[1]})` : `linear-gradient(120deg, ${a}, ${a}cc)`;
}

/** 属性条/立绘通用的属性缺省色 */
export const TYPE_FALLBACK = "#98a4b0";

/** 数值条配色(PokemonCard 与 WikiView 共享;v2.3 从两份拷贝收敛) */
export function statColor(v) {
  if (v < 50) return "#e0533d";
  if (v < 80) return "#f0a12f";
  return "#4fae4e";
}

/** 数值中文名(WikiView 自带的一份与此处 STAT_ZH 合并) */
export const STAT_LABELS_ZH = { hp: "HP", attack: "攻击", defense: "防御", "special-attack": "特攻", "special-defense": "特防", speed: "速度" };
