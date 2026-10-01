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
