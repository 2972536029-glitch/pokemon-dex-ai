// 品牌资产生成器(ROADMAP-NEXT T5)。Run: node scripts/gen-brand-assets.mjs
//
// 零依赖自绘:PNG 编码(zlib + CRC32)+ 逐像素程序化绘制精灵球。
// 为什么不抓官方原画:版权红线(见 ROADMAP-NEXT §5);为什么不用 SVG 直出:
// PWA 安装条件与 og:image 抓取端对 PNG 的兼容性最稳。
// 产物(public/,构建时被 vite 原样拷贝进 dist/):
//   icon-192.png / icon-512.png        PWA icons(purpose: any,透明底)
//   icon-512-maskable.png              maskable 安全面(暗底 + 球体缩小到安全区)
//   apple-touch-icon.png               iOS 主屏(180,不透明底,iOS 不支持透明)
//   og.png                             分享卡 1200×630
// 改配色/构图:改 draw 里的调色板与几何,重跑本脚本,产物随仓库提交。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// ---- PNG 编码:RGBA8,filter 0,单 IDAT ------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 渲染:2x 超采样 + 简单边缘抗锯齿(命中边界时按圆内覆盖率混色) --------
const PALETTE = {
  bg: [18, 20, 28], // #12141c 站点主题色
  red: [255, 90, 72], // #ff5a48
  white: [244, 246, 251], // #f4f6fb
  dark: [35, 38, 47], // #23262f
};

/**
 * 精灵球逐像素着色。几何与 public/icon.svg 同族:外环 9%R、水平带 9%R、
 * 中央按钮环 28%R/芯 17%R。返回 [r,g,b,a],a=0 表示透明(icon 用)。
 */
function pokeball(px, py, cx, cy, R) {
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d > R) return [0, 0, 0, 0];
  const dark = PALETTE.dark;
  if (d >= R * 0.91) return [...dark, 255]; // 外环
  if (Math.abs(dy) <= R * 0.045) return [...dark, 255]; // 水平带
  if (d <= R * 0.28) return d <= R * 0.17 ? [...PALETTE.white, 255] : [...dark, 255]; // 按钮
  return [...(dy < 0 ? PALETTE.red : PALETTE.white), 255];
}

/** 一帧画布 = 逐像素 shader(x,y → RGBA)。超采样 2x 后盒式降采样。 */
function render(w, h, shader) {
  const S = 2; // 超采样倍率
  const big = new Float64Array(w * S * h * S * 4);
  for (let y = 0; y < h * S; y++) {
    for (let x = 0; x < w * S; x++) {
      const [r, g, b, a] = shader((x + 0.5) / S, (y + 0.5) / S);
      const i = (y * w * S + x) * 4;
      // 预乘 alpha 存储,降采样不做 gamma 修正(视觉差异在小图标上不可辨)
      const A = a / 255;
      big[i] = r * A;
      big[i + 1] = g * A;
      big[i + 2] = b * A;
      big[i + 3] = a;
    }
  }
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * w * S + (x * S + sx)) * 4;
          r += big[i];
          g += big[i + 1];
          b += big[i + 2];
          a += big[i + 3];
        }
      }
      const n = S * S;
      const o = (y * w + x) * 4;
      const A = a / n / 255;
      out[o] = A > 0 ? Math.round(r / n / A) : 0; // 反预乘
      out[o + 1] = A > 0 ? Math.round(g / n / A) : 0;
      out[o + 2] = A > 0 ? Math.round(b / n / A) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const writeFile = (name, buf) => {
  fs.writeFileSync(path.join(publicDir, name), buf);
  console.log(`${name}: ${buf.length} bytes`);
};

// ---- 产物 ------------------------------------------------------------------
/** 透明底 PWA 图标:球体直径 86% 画布。 */
const plainIcon = (size) => render(size, size, (x, y) => pokeball(x, y, size / 2, size / 2, size * 0.43));

/** 不透明底(maskable / iOS):全画布铺暗底,球体缩进 maskable 80% 安全区。 */
const onBg = (size, ballScale) =>
  render(size, size, (x, y) => {
    const ball = pokeball(x, y, size / 2, size / 2, size * ballScale);
    return ball[3] === 0 ? [...PALETTE.bg, 255] : ball;
  });

writeFile("icon-192.png", encodePNG(192, 192, plainIcon(192)));
writeFile("icon-512.png", encodePNG(512, 512, plainIcon(512)));
writeFile("icon-512-maskable.png", encodePNG(512, 512, onBg(512, 0.31)));
// apple-touch-icon:180 不透明(iOS 主屏不处理透明)
writeFile("apple-touch-icon.png", encodePNG(180, 180, onBg(180, 0.38)));

// og 1200×630:暗底 + 右侧大球 + 细描边大圆 + 左上光晕,无文字(自绘不碰版权字体)
writeFile(
  "og.png",
  encodePNG(
    1200,
    630,
    render(1200, 630, (x, y) => {
      const ball = pokeball(x, y, 880, 315, 190);
      if (ball[3] > 0) return ball;
      // 细描边大圆(装饰环):r=262 ±1.5
      const dr = Math.hypot(x - 880, y - 315);
      if (Math.abs(dr - 262) <= 1.5) return [244, 246, 251, 36];
      // 左上角柔光:高斯衰减
      const dl = Math.hypot(x - 220, y - 140);
      const glow = Math.max(0, 1 - dl / 420) ** 2 * 0.14;
      const base = PALETTE.bg.map((c) => Math.round(c + (244 - c) * glow));
      return [...base, 255];
    })
  )
);
