// 官方立绘地址:由图鉴 id 直接推导。
// 用 jsDelivr 镜像 PokeAPI/sprites——raw.githubusercontent 在国内又慢又常超时,
// 用户看到的"空卡"大多是它;jsDelivr 是同一仓库的生产级 CDN。
export const artworkUrl = (id) =>
  `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/other/official-artwork/${id}.png`;

export const pixelSpriteUrl = (id) =>
  `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/${id}.png`;
