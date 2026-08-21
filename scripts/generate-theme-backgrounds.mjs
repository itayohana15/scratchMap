import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const WIDTH = 1600;
const HEIGHT = 1200;
const OUTPUT_DIR = path.join(process.cwd(), "public/images/themes");

function svg(strings, ...values) {
  return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ""), "");
}

function wrapSvg(content) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none">
      <defs>
        <filter id="blur12"><feGaussianBlur stdDeviation="12" /></filter>
        <filter id="blur24"><feGaussianBlur stdDeviation="24" /></filter>
        <filter id="blur48"><feGaussianBlur stdDeviation="48" /></filter>
        <filter id="paper">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="table" tableValues="0 0.08" />
          </feComponentTransfer>
        </filter>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="table" tableValues="0 0.05" />
          </feComponentTransfer>
        </filter>
        <pattern id="tinyGrid" width="46" height="46" patternUnits="userSpaceOnUse">
          <path d="M 46 0 L 0 0 0 46" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
        </pattern>
        <pattern id="smallDots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.2" fill="rgba(255,255,255,0.16)" />
        </pattern>
      </defs>
      ${content}
    </svg>`
  );
}

function paperTexture(opacity = 0.12) {
  return `<rect width="${WIDTH}" height="${HEIGHT}" fill="white" filter="url(#paper)" opacity="${opacity}" />`;
}

function grainTexture(opacity = 0.1) {
  return `<rect width="${WIDTH}" height="${HEIGHT}" fill="white" filter="url(#grain)" opacity="${opacity}" />`;
}

function softBlob({ cx, cy, rx, ry, color, opacity, rotate = 0, blur = "blur48" }) {
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" opacity="${opacity}" transform="rotate(${rotate} ${cx} ${cy})" filter="url(#${blur})" />`;
}

function circle({ cx, cy, r, color, opacity, blur = "blur12" }) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${opacity}" filter="url(#${blur})" />`;
}

function linePath({ d, stroke, opacity, width = 2, blur, dash }) {
  return `<path d="${d}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ""}${blur ? ` filter="url(#${blur})"` : ""} />`;
}

function mountain({ baseY, color, opacity, peaks }) {
  return `<path d="M0 ${HEIGHT} L0 ${baseY} ${peaks
    .map(([x, y]) => `L${x} ${y}`)
    .join(" ")} L${WIDTH} ${baseY} L${WIDTH} ${HEIGHT} Z" fill="${color}" opacity="${opacity}" />`;
}

function snowCaps({ peaks, color, opacity = 1, size = 26 }) {
  return peaks
    .map(
      ([x, y]) =>
        `<path d="M${x - size} ${y + size * 0.9} L${x} ${y} L${x + size} ${y + size * 0.9} L${x + size * 0.5} ${y + size * 0.5} L${x} ${y + size * 0.95} L${x - size * 0.5} ${y + size * 0.5} Z" fill="${color}" opacity="${opacity}" />`
    )
    .join("");
}

function dune({ color, opacity, baseY, amplitude = 70, phase = 0 }) {
  const steps = 5;
  const segW = WIDTH / steps;
  let d = `M0 ${HEIGHT} L0 ${baseY}`;
  for (let i = 0; i < steps; i += 1) {
    const controlX = segW * i + segW / 2;
    const controlY = baseY - Math.sin(i * 1.3 + phase) * amplitude;
    const endX = segW * (i + 1);
    const endY = baseY - Math.sin((i + 1) * 1.3 + phase) * amplitude * 0.6;
    d += ` Q${controlX} ${controlY} ${endX} ${endY}`;
  }
  d += ` L${WIDTH} ${HEIGHT} Z`;
  return `<path d="${d}" fill="${color}" opacity="${opacity}" />`;
}

function branch({
  d,
  stroke,
  opacity = 1,
  width = 10,
  blossoms = [],
}) {
  return `${linePath({ d, stroke, opacity, width })}${blossoms
    .map(
      ([cx, cy, r, fill, fillOpacity]) =>
        `<g opacity="${fillOpacity}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" /><circle cx="${cx - r * 0.18}" cy="${cy - r * 0.12}" r="${r * 0.55}" fill="rgba(255,255,255,0.16)" /></g>`
    )
    .join("")}`;
}

function stars(color, opacity = 0.5, positions = []) {
  return positions
    .map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${opacity}" />`)
    .join("");
}

function compass({ color = "rgba(101,82,45,0.22)" }) {
  return `
    <g opacity="0.7" transform="translate(1140 180)">
      <circle cx="0" cy="0" r="140" fill="none" stroke="${color}" stroke-width="4" />
      <circle cx="0" cy="0" r="104" fill="none" stroke="${color}" stroke-width="2" />
      <path d="M0 -122 L18 0 0 122 -18 0 Z" fill="${color}" />
      <path d="M-122 0 L0 18 122 0 0 -18 Z" fill="${color}" opacity="0.5" />
    </g>
  `;
}

function routeDots({ color = "rgba(93,120,116,0.22)" }) {
  return `
    <g opacity="0.9">
      <path d="M160 880 C320 760 400 730 560 690 C760 640 840 540 1030 490 C1180 450 1300 470 1450 390" stroke="${color}" stroke-width="5" stroke-dasharray="10 18" fill="none" />
      ${[160, 560, 1030, 1450]
        .map((cx, index) => `<circle cx="${cx}" cy="${[880, 690, 490, 390][index]}" r="${index === 0 ? 10 : 8}" fill="${color}" />`)
        .join("")}
    </g>
  `;
}

function skyline({ color, opacity = 0.18, blocks = [] }) {
  return `<g opacity="${opacity}">${blocks
    .map(
      ([x, y, w, h]) =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w * 0.08, 16)}" fill="${color}" />`
    )
    .join("")}</g>`;
}

function skylineDetailed({ blocks, color, windowColor, opacity = 1 }) {
  return `<g opacity="${opacity}">${blocks
    .map(([x, y, w, h]) => {
      const cols = Math.max(2, Math.floor(w / 26));
      const rows = Math.max(3, Math.floor(h / 34));
      let windows = "";
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          if ((r + c) % 3 === 0) continue;
          const wx = x + 10 + c * (w - 20) / cols;
          const wy = y + 16 + r * (h - 26) / rows;
          windows += `<rect x="${wx}" y="${wy}" width="7" height="10" fill="${windowColor}" opacity="0.55" />`;
        }
      }
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${color}" />${windows}`;
    })
    .join("")}</g>`;
}

function neonTower({ x, y, w, h, edge, glow, windowColor, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(4,2,10,0.7)" stroke="${edge}" stroke-width="2.4" filter="url(#blur12)" />
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${edge}" stroke-width="1.6" />
      <line x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y - 46}" stroke="${edge}" stroke-width="2" />
      <circle cx="${x + w / 2}" cy="${y - 50}" r="4" fill="${glow}" />
      ${[0.25, 0.5, 0.75]
        .map(
          (t, i) =>
            `<rect x="${x + w * t - 6}" y="${y + h * (0.3 + i * 0.2)}" width="12" height="18" fill="${windowColor}" opacity="0.7" />`
        )
        .join("")}
    </g>
  `;
}

function leaves({ color, opacity = 0.12, positions = [] }) {
  return positions
    .map(
      ([cx, cy, rx, ry, rotate]) =>
        `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" opacity="${opacity}" transform="rotate(${rotate} ${cx} ${cy})" filter="url(#blur12)" />`
    )
    .join("");
}

function fallingLeaf({ x, y, scale = 1, rotate = 0, color, opacity = 1 }) {
  return `
    <g opacity="${opacity}" transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})">
      <path d="M0 -20 C13 -13 15 5 0 20 C-15 5 -13 -13 0 -20 Z" fill="${color}" />
      <path d="M0 -17 L0 17" stroke="rgba(0,0,0,0.16)" stroke-width="1.4" />
    </g>
  `;
}

function fallenLeafCluster({ positions, color, opacity = 1 }) {
  return positions
    .map(([x, y, scale, rotate]) => fallingLeaf({ x, y, scale, rotate, color, opacity }))
    .join("");
}

function woodenBridge({ x, y, scale = 1, color, opacity = 1 }) {
  const w = 130 * scale;
  return `
    <g opacity="${opacity}">
      <path d="M${x - w / 2} ${y} Q${x} ${y - 34 * scale} ${x + w / 2} ${y}" stroke="${color}" stroke-width="${8 * scale}" fill="none" />
      <path d="M${x - w / 2 + 4 * scale} ${y + 8 * scale} Q${x} ${y - 26 * scale} ${x + w / 2 - 4 * scale} ${y + 8 * scale}" stroke="${color}" stroke-width="${3 * scale}" fill="none" opacity="0.6" />
      ${[0.2, 0.4, 0.6, 0.8]
        .map((t) => {
          const px = x - w / 2 + w * t;
          const py = y - Math.sin(t * Math.PI) * 34 * scale + 4 * scale;
          return `<line x1="${px}" y1="${py}" x2="${px}" y2="${py + 10 * scale}" stroke="${color}" stroke-width="${2.4 * scale}" opacity="0.6" />`;
        })
        .join("")}
    </g>
  `;
}

function teaGardenPath() {
  return `
    <path d="M180 1200 C310 1020 420 930 610 820 C780 720 860 640 940 510" stroke="rgba(139,123,90,0.24)" stroke-width="120" stroke-linecap="round" fill="none" filter="url(#blur12)" />
    <path d="M220 1200 C340 1040 460 955 630 845 C790 748 880 660 970 520" stroke="rgba(240,236,225,0.58)" stroke-width="54" stroke-linecap="round" fill="none" />
  `;
}

function windingRoad({ d, surface, center, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <path d="${d}" stroke="${surface}" stroke-width="86" stroke-linecap="round" fill="none" filter="url(#blur12)" />
      <path d="${d}" stroke="${center}" stroke-width="4" stroke-dasharray="18 20" fill="none" />
    </g>
  `;
}

function coffeeBeans() {
  return `
    <g opacity="0.18">
      <ellipse cx="1180" cy="350" rx="78" ry="48" fill="rgba(95,53,26,0.4)" transform="rotate(22 1180 350)" />
      <path d="M1166 310 C1188 340 1186 376 1172 400" stroke="rgba(255,242,224,0.24)" stroke-width="4" fill="none" />
      <ellipse cx="1336" cy="420" rx="70" ry="44" fill="rgba(86,49,25,0.34)" transform="rotate(-16 1336 420)" />
      <path d="M1324 382 C1346 413 1346 445 1336 462" stroke="rgba(255,242,224,0.22)" stroke-width="4" fill="none" />
    </g>
  `;
}

/* ---------------------------------------------------------------------- */
/* Expanded illustration primitives                                       */
/* ---------------------------------------------------------------------- */

function pineTree({ x, y, height = 220, color, opacity = 1, trunk = "rgba(60,42,24,0.5)" }) {
  const w1 = height * 0.62;
  const w2 = height * 0.46;
  const w3 = height * 0.3;
  const trunkH = height * 0.14;
  return `
    <g opacity="${opacity}">
      <rect x="${x - height * 0.035}" y="${y - trunkH}" width="${height * 0.07}" height="${trunkH}" fill="${trunk}" />
      <path d="M${x} ${y - height * 0.42} L${x - w3 / 2} ${y - trunkH * 0.9} L${x + w3 / 2} ${y - trunkH * 0.9} Z" fill="${color}" />
      <path d="M${x} ${y - height * 0.68} L${x - w2 / 2} ${y - height * 0.32} L${x + w2 / 2} ${y - height * 0.32} Z" fill="${color}" />
      <path d="M${x} ${y - height} L${x - w1 / 2} ${y - height * 0.55} L${x + w1 / 2} ${y - height * 0.55} Z" fill="${color}" />
    </g>
  `;
}

function pineForest({ baseX, baseY, count, spread, minH, maxH, color, opacity, trunk }) {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = baseX + t * spread;
    const wobble = Math.abs(Math.sin(i * 2.3 + 1));
    const h = minH + (maxH - minH) * wobble;
    out += pineTree({ x, y: baseY - (i % 2) * 6, height: h, color, opacity, trunk });
  }
  return out;
}

function snowyPineTree({ x, y, height, color, snow, opacity = 1, trunk }) {
  return `
    ${pineTree({ x, y, height, color, opacity, trunk })}
    <path d="M${x} ${y - height} L${x - height * 0.22} ${y - height * 0.74} L${x + height * 0.22} ${y - height * 0.74} Z" fill="${snow}" opacity="${opacity * 0.85}" />
    <path d="M${x} ${y - height * 0.62} L${x - height * 0.16} ${y - height * 0.46} L${x + height * 0.16} ${y - height * 0.46} Z" fill="${snow}" opacity="${opacity * 0.6}" />
  `;
}

function cabin({ x, y, scale = 1, wall, roof, opacity = 1, glow }) {
  const w = 150 * scale;
  const h = 92 * scale;
  const roofH = 66 * scale;
  return `
    <g opacity="${opacity}">
      <rect x="${x - w / 2}" y="${y - h}" width="${w}" height="${h}" fill="${wall}" />
      <path d="M${x - w / 2 - 16 * scale} ${y - h + 4 * scale} L${x} ${y - h - roofH} L${x + w / 2 + 16 * scale} ${y - h + 4 * scale} Z" fill="${roof}" />
      <rect x="${x - 15 * scale}" y="${y - h * 0.6}" width="${30 * scale}" height="${h * 0.6}" fill="${roof}" opacity="0.75" />
      <rect x="${x - w * 0.32}" y="${y - h * 0.58}" width="${w * 0.15}" height="${h * 0.3}" fill="${glow ?? roof}" opacity="${glow ? 0.7 : 0.5}" />
      <rect x="${x + w * 0.16}" y="${y - h * 0.58}" width="${w * 0.15}" height="${h * 0.3}" fill="${glow ?? roof}" opacity="${glow ? 0.7 : 0.5}" />
    </g>
  `;
}

function teaHousePavilion({ x, y, scale = 1, color, opacity = 1 }) {
  const w = 200 * scale;
  const h = 70 * scale;
  return `
    <g opacity="${opacity}">
      <rect x="${x - 8 * scale}" y="${y - h}" width="${16 * scale}" height="${h}" fill="${color}" />
      <rect x="${x - w / 2 + 8 * scale}" y="${y - h}" width="${16 * scale}" height="${h}" fill="${color}" />
      <rect x="${x + w / 2 - 24 * scale}" y="${y - h}" width="${16 * scale}" height="${h}" fill="${color}" />
      <path d="M${x - w / 2 - 30 * scale} ${y - h + 10 * scale} Q${x - w / 2} ${y - h - 46 * scale} ${x} ${y - h - 34 * scale} Q${x + w / 2} ${y - h - 46 * scale} ${x + w / 2 + 30 * scale} ${y - h + 10 * scale} L${x + w / 2 - 6 * scale} ${y - h + 4 * scale} Q${x} ${y - h - 22 * scale} ${x - w / 2 + 6 * scale} ${y - h + 4 * scale} Z" fill="${color}" />
    </g>
  `;
}

function cableCar({ x1, y1, x2, y2, cabinT = 0.5, color, opacity = 1 }) {
  const cx = x1 + (x2 - x1) * cabinT;
  const cy = y1 + (y2 - y1) * cabinT;
  return `
    <g opacity="${opacity}">
      <path d="M${x1} ${y1} L${x2} ${y2}" stroke="${color}" stroke-width="3" fill="none" />
      <path d="M${x1} ${y1 + 16} L${x2} ${y2 + 16}" stroke="${color}" stroke-width="2" fill="none" opacity="0.65" />
      <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy + 14}" stroke="${color}" stroke-width="2.4" />
      <rect x="${cx - 20}" y="${cy + 14}" width="40" height="26" rx="5" fill="${color}" />
      <line x1="${cx - 10}" y1="${cy + 14}" x2="${cx - 10}" y2="${cy + 40}" stroke="rgba(0,0,0,0.14)" stroke-width="1.5" />
      <line x1="${cx + 10}" y1="${cy + 14}" x2="${cx + 10}" y2="${cy + 40}" stroke="rgba(0,0,0,0.14)" stroke-width="1.5" />
    </g>
  `;
}

function palmFrond({ cx, cy, angleDeg, length, width, color, opacity = 1 }) {
  const rad = (angleDeg * Math.PI) / 180;
  const droop = (Math.abs(angleDeg + 90) / 90) * length * 0.3;
  const tipX = cx + Math.cos(rad) * length;
  const tipY = cy + Math.sin(rad) * length + droop;
  const midX = cx + Math.cos(rad) * length * 0.55;
  const midY = cy + Math.sin(rad) * length * 0.55;
  const perpX = -Math.sin(rad) * width;
  const perpY = Math.cos(rad) * width;
  return `<path d="M${cx} ${cy} Q${midX + perpX} ${midY + perpY} ${tipX} ${tipY} Q${midX - perpX} ${midY - perpY} ${cx} ${cy} Z" fill="${color}" opacity="${opacity}" />`;
}

function palmTree({ x, y, scale = 1, color, trunk, opacity = 1 }) {
  const trunkH = 150 * scale;
  const topX = x + 6 * scale;
  const topY = y - trunkH;
  const angles = [-172, -144, -116, -90, -64, -36, -8];
  return `
    <g opacity="${opacity}">
      <path d="M${x} ${y} C${x - 26 * scale} ${y - trunkH * 0.45} ${x + 20 * scale} ${y - trunkH * 0.75} ${topX} ${topY}" stroke="${trunk ?? color}" stroke-width="${15 * scale}" fill="none" stroke-linecap="round" />
      ${angles
        .map((angle) =>
          palmFrond({
            cx: topX,
            cy: topY,
            angleDeg: angle,
            length: 130 * scale,
            width: 22 * scale,
            color,
            opacity: 1,
          })
        )
        .join("")}
    </g>
  `;
}

function sailboat({ x, y, scale = 1, hull, sail, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <path d="M${x - 62 * scale} ${y} Q${x} ${y + 24 * scale} ${x + 62 * scale} ${y} L${x + 46 * scale} ${y - 8 * scale} L${x - 46 * scale} ${y - 8 * scale} Z" fill="${hull}" />
      <path d="M${x} ${y - 10 * scale} L${x} ${y - 132 * scale} L${x + 56 * scale} ${y - 10 * scale} Z" fill="${sail}" />
      <path d="M${x - 4 * scale} ${y - 10 * scale} L${x - 4 * scale} ${y - 96 * scale} L${x - 42 * scale} ${y - 10 * scale} Z" fill="${sail}" opacity="0.8" />
    </g>
  `;
}

function ship({ x, y, scale = 1, hull, sail, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <path d="M${x - 130 * scale} ${y} Q${x} ${y + 34 * scale} ${x + 130 * scale} ${y} L${x + 100 * scale} ${y - 16 * scale} L${x - 100 * scale} ${y - 16 * scale} Z" fill="${hull}" />
      <line x1="${x - 40 * scale}" y1="${y - 16 * scale}" x2="${x - 40 * scale}" y2="${y - 160 * scale}" stroke="${hull}" stroke-width="${5 * scale}" />
      <line x1="${x + 46 * scale}" y1="${y - 16 * scale}" x2="${x + 46 * scale}" y2="${y - 128 * scale}" stroke="${hull}" stroke-width="${4 * scale}" />
      <path d="M${x - 40 * scale} ${y - 150 * scale} L${x - 40 * scale} ${y - 40 * scale} L${x + 14 * scale} ${y - 60 * scale} Z" fill="${sail}" />
      <path d="M${x + 46 * scale} ${y - 118 * scale} L${x + 46 * scale} ${y - 34 * scale} L${x + 92 * scale} ${y - 50 * scale} Z" fill="${sail}" opacity="0.86" />
    </g>
  `;
}

function lighthouse({ x, y, scale = 1, body, accent, opacity = 1 }) {
  const h = 210 * scale;
  return `
    <g opacity="${opacity}">
      <path d="M${x - 24 * scale} ${y} L${x - 15 * scale} ${y - h} L${x + 15 * scale} ${y - h} L${x + 24 * scale} ${y} Z" fill="${body}" />
      <rect x="${x - 19 * scale}" y="${y - h * 0.6}" width="${38 * scale}" height="${16 * scale}" fill="${accent}" />
      <rect x="${x - 21 * scale}" y="${y - h * 0.92}" width="${42 * scale}" height="${18 * scale}" fill="${accent}" />
      <path d="M${x - 28 * scale} ${y - h - 6 * scale} L${x} ${y - h - 42 * scale} L${x + 28 * scale} ${y - h - 6 * scale} Z" fill="${body}" />
      <circle cx="${x}" cy="${y - h - 2 * scale}" r="${5 * scale}" fill="${accent}" />
    </g>
  `;
}

function lantern({ x, y, scale = 1, color, glow, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <line x1="${x}" y1="${y - 40 * scale}" x2="${x}" y2="${y - 60 * scale}" stroke="${color}" stroke-width="2" />
      <rect x="${x - 6 * scale}" y="${y - 42 * scale}" width="${12 * scale}" height="${8 * scale}" fill="${color}" />
      <ellipse cx="${x}" cy="${y - 10 * scale}" rx="${26 * scale}" ry="${32 * scale}" fill="${glow}" opacity="0.9" />
      <ellipse cx="${x}" cy="${y - 10 * scale}" rx="${26 * scale}" ry="${32 * scale}" fill="none" stroke="${color}" stroke-width="2" opacity="0.6" />
      <line x1="${x - 26 * scale}" y1="${y - 10 * scale}" x2="${x + 26 * scale}" y2="${y - 10 * scale}" stroke="${color}" stroke-width="1.4" opacity="0.5" />
      <rect x="${x - 5 * scale}" y="${y + 20 * scale}" width="${10 * scale}" height="${6 * scale}" fill="${color}" />
      <line x1="${x}" y1="${y + 26 * scale}" x2="${x}" y2="${y + 40 * scale}" stroke="${color}" stroke-width="1.6" opacity="0.7" />
    </g>
  `;
}

function moonCrescent({ cx, cy, r, moon, shadow, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${moon}" />
      <circle cx="${cx + r * 0.42}" cy="${cy - r * 0.16}" r="${r * 0.92}" fill="${shadow}" />
    </g>
  `;
}

function auroraRibbons({ bands, opacity = 1 }) {
  return `<g opacity="${opacity}">${bands
    .map(({ d, color, width }) => linePath({ d, stroke: color, opacity: 1, width, blur: "blur48" }))
    .join("")}</g>`;
}

function domeBuilding({ x, y, scale = 1, wall, dome, outline, opacity = 1 }) {
  const w = 130 * scale;
  const h = 130 * scale;
  return `
    <g opacity="${opacity}">
      <rect x="${x - w / 2}" y="${y - h}" width="${w}" height="${h}" fill="${wall}" stroke="${outline ?? "none"}" stroke-width="2.5" />
      <path d="M${x - w * 0.28} ${y - h} Q${x - w * 0.28} ${y - h - 46 * scale} ${x} ${y - h - 46 * scale} Q${x + w * 0.28} ${y - h - 46 * scale} ${x + w * 0.28} ${y - h} Z" fill="${dome}" />
      <rect x="${x - 3 * scale}" y="${y - h - 66 * scale}" width="${6 * scale}" height="${20 * scale}" fill="${dome}" />
      <path d="M${x - w * 0.22} ${y - h * 0.36} Q${x - w * 0.22} ${y - h * 0.62} ${x} ${y - h * 0.62} Q${x + w * 0.22} ${y - h * 0.62} ${x + w * 0.22} ${y - h * 0.36} Z" fill="${dome}" opacity="0.5" />
      <rect x="${x - w * 0.4}" y="${y - 10 * scale}" width="${w * 0.16}" height="${10 * scale}" fill="${dome}" opacity="0.6" />
      <rect x="${x + w * 0.24}" y="${y - 10 * scale}" width="${w * 0.16}" height="${10 * scale}" fill="${dome}" opacity="0.6" />
    </g>
  `;
}

function whitewashedRow({ baseX, baseY, count, color, accent, outline, opacity = 1 }) {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    const x = baseX + i * 108;
    const h = 120 + (i % 3) * 30;
    const hasDome = i % 2 === 0;
    out += `<rect x="${x}" y="${baseY - h}" width="86" height="${h}" fill="${color}" stroke="${outline}" stroke-width="2.5" opacity="${opacity}" />`;
    if (hasDome) {
      out += `<path d="M${x + 20} ${baseY - h} Q${x + 20} ${baseY - h - 34} ${x + 43} ${baseY - h - 34} Q${x + 66} ${baseY - h - 34} ${x + 66} ${baseY - h} Z" fill="${accent}" opacity="${opacity}" />`;
    }
    out += `<rect x="${x + 14}" y="${baseY - h * 0.5}" width="18" height="26" fill="${accent}" opacity="${opacity * 0.6}" />`;
  }
  return out;
}

function oliveBranch({ x, y, length = 220, color, opacity = 1, rotate = 0 }) {
  const leafPairs = 6;
  let leaves = "";
  for (let i = 1; i <= leafPairs; i += 1) {
    const t = i / (leafPairs + 1);
    const lx = t * length;
    leaves += `<ellipse cx="${lx}" cy="-10" rx="16" ry="7" fill="${color}" opacity="${opacity}" transform="rotate(-30 ${lx} -10)" />`;
    leaves += `<ellipse cx="${lx + 8}" cy="10" rx="16" ry="7" fill="${color}" opacity="${opacity}" transform="rotate(30 ${lx + 8} 10)" />`;
  }
  return `<g transform="translate(${x} ${y}) rotate(${rotate})"><path d="M0 0 C${length * 0.4} -6 ${length * 0.7} 6 ${length} 0" stroke="${color}" stroke-width="3" fill="none" opacity="${opacity}" />${leaves}</g>`;
}

function bambooGrove({ baseX, baseY, count, height, color, leaf, opacity = 1 }) {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    const x = baseX + i * 46;
    const h = height * (0.72 + (i % 3) * 0.14);
    let nodes = "";
    for (let n = 1; n < 6; n += 1) {
      nodes += `<line x1="${x - 7}" y1="${baseY - (h / 6) * n}" x2="${x + 7}" y2="${baseY - (h / 6) * n}" stroke="rgba(0,0,0,0.14)" stroke-width="2" />`;
    }
    out += `<rect x="${x - 7}" y="${baseY - h}" width="14" height="${h}" rx="6" fill="${color}" opacity="${opacity}" />${nodes}`;
    out += `<path d="M${x} ${baseY - h} Q${x - 46} ${baseY - h - 20} ${x - 70} ${baseY - h - 6}" stroke="${leaf}" stroke-width="10" fill="none" opacity="${opacity * 0.9}" stroke-linecap="round" />`;
    out += `<path d="M${x} ${baseY - h + 8} Q${x + 44} ${baseY - h - 10} ${x + 66} ${baseY - h + 6}" stroke="${leaf}" stroke-width="9" fill="none" opacity="${opacity * 0.8}" stroke-linecap="round" />`;
  }
  return out;
}

function archedBridge({ x, y, scale = 1, color, opacity = 1 }) {
  const w = 220 * scale;
  const h = 70 * scale;
  return `
    <g opacity="${opacity}">
      <path d="M${x - w / 2} ${y} Q${x} ${y - h} ${x + w / 2} ${y}" stroke="${color}" stroke-width="${8 * scale}" fill="none" />
      <path d="M${x - w / 2 + 6 * scale} ${y + 10 * scale} Q${x} ${y - h + 10 * scale} ${x + w / 2 - 6 * scale} ${y + 10 * scale}" stroke="${color}" stroke-width="${3 * scale}" fill="none" opacity="0.6" />
    </g>
  `;
}

function pointedArch({ x, y, w, h, color, opacity = 1 }) {
  return `<path d="M${x} ${y} V${y - h * 0.5} Q${x} ${y - h} ${x + w / 2} ${y - h} Q${x + w} ${y - h} ${x + w} ${y - h * 0.5} V${y}" fill="none" stroke="${color}" stroke-width="14" opacity="${opacity}" />`;
}

function hillTownRow({ baseX, baseY, count, width, wall, roof, opacity = 1 }) {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    const x = baseX + i * width * 0.92;
    const wallH = width * (0.8 + (i % 3) * 0.22);
    const roofH = width * 0.42;
    out += `
      <rect x="${x}" y="${baseY - wallH}" width="${width * 0.82}" height="${wallH}" fill="${wall}" opacity="${opacity}" />
      <path d="M${x - width * 0.08} ${baseY - wallH} L${x + width * 0.41} ${baseY - wallH - roofH} L${x + width * 0.9} ${baseY - wallH} Z" fill="${roof}" opacity="${opacity}" />
      <rect x="${x + width * 0.28}" y="${baseY - wallH * 0.55}" width="${width * 0.16}" height="${wallH * 0.4}" fill="${roof}" opacity="${opacity * 0.6}" />
    `;
  }
  return out;
}

function vintagePlane({ x, y, scale = 1, color, opacity = 1 }) {
  return `
    <g opacity="${opacity}" transform="translate(${x} ${y}) scale(${scale})">
      <ellipse cx="0" cy="0" rx="70" ry="14" fill="${color}" />
      <path d="M-10 -10 L20 -80 L34 -80 L14 -10 Z" fill="${color}" />
      <path d="M-10 10 L20 78 L34 78 L14 10 Z" fill="${color}" opacity="0.85" />
      <path d="M-64 0 L-84 -22 L-84 22 Z" fill="${color}" />
      <circle cx="66" cy="0" r="10" fill="${color}" />
      <line x1="76" y1="-14" x2="76" y2="14" stroke="${color}" stroke-width="4" />
    </g>
  `;
}

function suitcaseIcon({ x, y, scale = 1, color, opacity = 1 }) {
  return `
    <g opacity="${opacity}" transform="translate(${x} ${y}) scale(${scale})">
      <rect x="-46" y="-32" width="92" height="64" rx="8" fill="none" stroke="${color}" stroke-width="5" />
      <path d="M-18 -32 V-46 Q-18 -54 -10 -54 H10 Q18 -54 18 -46 V-32" fill="none" stroke="${color}" stroke-width="5" />
      <line x1="-46" y1="-4" x2="46" y2="-4" stroke="${color}" stroke-width="3" opacity="0.6" />
    </g>
  `;
}

function vanSilhouette({ x, y, scale = 1, body, window, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <path d="M${x - 90 * scale} ${y} V${y - 34 * scale} Q${x - 90 * scale} ${y - 54 * scale} ${x - 66 * scale} ${y - 54 * scale} L${x - 20 * scale} ${y - 54 * scale} Q${x} ${y - 54 * scale} ${x + 10 * scale} ${y - 40 * scale} L${x + 30 * scale} ${y - 20 * scale} H${x + 90 * scale} V${y} Z" fill="${body}" />
      <rect x="${x - 56 * scale}" y="${y - 46 * scale}" width="${34 * scale}" height="${26 * scale}" fill="${window}" opacity="0.7" />
      <rect x="${x - 16 * scale}" y="${y - 44 * scale}" width="${28 * scale}" height="${24 * scale}" fill="${window}" opacity="0.7" />
      <circle cx="${x - 56 * scale}" cy="${y}" r="${14 * scale}" fill="${body}" />
      <circle cx="${x + 50 * scale}" cy="${y}" r="${14 * scale}" fill="${body}" />
    </g>
  `;
}

function birdFlock({ positions, color, opacity = 1 }) {
  return positions
    .map(
      ([x, y, s]) =>
        `<path d="M${x - 14 * s} ${y} Q${x - 6 * s} ${y - 10 * s} ${x} ${y} Q${x + 6 * s} ${y - 10 * s} ${x + 14 * s} ${y}" stroke="${color}" stroke-width="${2.4 * s}" fill="none" stroke-linecap="round" opacity="${opacity}" />`
    )
    .join("");
}

function palaceColumns({ baseX, baseY, count, height, color, opacity = 1 }) {
  let out = `<rect x="${baseX - 20}" y="${baseY - height - 26}" width="${count * 60 + 40}" height="20" fill="${color}" opacity="${opacity}" />`;
  out += `<path d="M${baseX - 40} ${baseY - height - 26} L${baseX + count * 30} ${baseY - height - 90} L${baseX + count * 60 + 40} ${baseY - height - 26} Z" fill="${color}" opacity="${opacity * 0.85}" />`;
  for (let i = 0; i < count; i += 1) {
    const x = baseX + i * 60;
    out += `<rect x="${x}" y="${baseY - height}" width="18" height="${height}" fill="${color}" opacity="${opacity}" />`;
  }
  out += `<rect x="${baseX - 20}" y="${baseY}" width="${count * 60 + 40}" height="12" fill="${color}" opacity="${opacity}" />`;
  return out;
}

function artDecoFan({ cx, cy, r, count, color, opacity = 1 }) {
  let out = "";
  for (let i = 0; i <= count; i += 1) {
    const angle = (Math.PI / 2) * (i / count) + Math.PI;
    const x2 = cx + Math.cos(angle) * r;
    const y2 = cy + Math.sin(angle) * r;
    out += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" opacity="${opacity}" />`;
  }
  out += `<path d="M ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy + r}" stroke="${color}" stroke-width="2" fill="none" opacity="${opacity}" />`;
  return out;
}

function iceCrystal({ cx, cy, r, color, opacity = 1 }) {
  let out = "";
  for (let i = 0; i < 3; i += 1) {
    const angle = (Math.PI / 3) * i;
    const x1 = cx - Math.cos(angle) * r;
    const y1 = cy - Math.sin(angle) * r;
    const x2 = cx + Math.cos(angle) * r;
    const y2 = cy + Math.sin(angle) * r;
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.4" opacity="${opacity}" />`;
    out += `<line x1="${cx + Math.cos(angle) * r * 0.55}" y1="${cy + Math.sin(angle) * r * 0.55}" x2="${cx + Math.cos(angle + 0.5) * r * 0.78}" y2="${cy + Math.sin(angle + 0.5) * r * 0.78}" stroke="${color}" stroke-width="2" opacity="${opacity}" />`;
    out += `<line x1="${cx + Math.cos(angle) * r * 0.55}" y1="${cy + Math.sin(angle) * r * 0.55}" x2="${cx + Math.cos(angle - 0.5) * r * 0.78}" y2="${cy + Math.sin(angle - 0.5) * r * 0.78}" stroke="${color}" stroke-width="2" opacity="${opacity}" />`;
  }
  return out;
}

function glacierBlock({ x, y, w, h, color, opacity = 1 }) {
  return `<path d="M${x} ${y} L${x + w * 0.2} ${y - h} L${x + w * 0.55} ${y - h * 0.7} L${x + w * 0.8} ${y - h * 1.1} L${x + w} ${y - h * 0.5} L${x + w} ${y} Z" fill="${color}" opacity="${opacity}" />`;
}

function mapPin({ x, y, scale = 1, color, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <path d="M${x} ${y} C${x - 16 * scale} ${y - 20 * scale} ${x - 16 * scale} ${y - 40 * scale} ${x} ${y - 44 * scale} C${x + 16 * scale} ${y - 40 * scale} ${x + 16 * scale} ${y - 20 * scale} ${x} ${y} Z" fill="${color}" />
      <circle cx="${x}" cy="${y - 30 * scale}" r="${6 * scale}" fill="rgba(255,255,255,0.7)" />
    </g>
  `;
}

function airplaneIcon({ x, y, scale = 1, rotate = -35, color, opacity = 1 }) {
  return `
    <g opacity="${opacity}" transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})">
      <path d="M0 0 L60 -6 L74 0 L60 6 Z" fill="${color}" />
      <path d="M22 -3 L36 -26 L44 -24 L34 -2 Z" fill="${color}" />
      <path d="M22 3 L36 26 L44 24 L34 2 Z" fill="${color}" />
      <path d="M4 0 L-14 -10 L-14 10 Z" fill="${color}" />
    </g>
  `;
}

function worldMapSilhouette({ blobColor, routeColor, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      ${softBlob({ cx: 260, cy: 260, rx: 170, ry: 110, color: blobColor, opacity: 1, blur: "blur24" })}
      ${softBlob({ cx: 520, cy: 340, rx: 120, ry: 90, color: blobColor, opacity: 0.85, blur: "blur24" })}
      ${softBlob({ cx: 1360, cy: 280, rx: 190, ry: 120, color: blobColor, opacity: 1, blur: "blur24" })}
      ${softBlob({ cx: 1180, cy: 420, rx: 110, ry: 80, color: blobColor, opacity: 0.85, blur: "blur24" })}
      ${linePath({ d: "M300 300 C520 220 780 260 1020 340 C1160 386 1260 340 1380 300", stroke: routeColor, opacity: 0.9, width: 3, dash: "8 12" })}
      ${mapPin({ x: 340, y: 300, scale: 0.9, color: routeColor, opacity: 0.9 })}
      ${mapPin({ x: 1040, y: 350, scale: 0.9, color: routeColor, opacity: 0.9 })}
      ${airplaneIcon({ x: 660, y: 280, scale: 1, rotate: -18, color: routeColor, opacity: 0.9 })}
    </g>
  `;
}

function coffeeCupSteam({ x, y, scale = 1, cup, steam, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <ellipse cx="${x}" cy="${y + 34 * scale}" rx="${58 * scale}" ry="${12 * scale}" fill="${cup}" opacity="0.4" />
      <path d="M${x - 40 * scale} ${y} Q${x - 40 * scale} ${y + 30 * scale} ${x} ${y + 30 * scale} Q${x + 40 * scale} ${y + 30 * scale} ${x + 40 * scale} ${y} Z" fill="${cup}" />
      <path d="M${x + 40 * scale} ${y + 6 * scale} Q${x + 62 * scale} ${y + 6 * scale} ${x + 62 * scale} ${y + 18 * scale} Q${x + 62 * scale} ${y + 30 * scale} ${x + 40 * scale} ${y + 28 * scale}" fill="none" stroke="${cup}" stroke-width="${6 * scale}" />
      <path d="M${x - 14 * scale} ${y - 20 * scale} Q${x - 22 * scale} ${y - 40 * scale} ${x - 10 * scale} ${y - 56 * scale}" stroke="${steam}" stroke-width="${3 * scale}" fill="none" opacity="0.6" />
      <path d="M${x + 12 * scale} ${y - 20 * scale} Q${x + 4 * scale} ${y - 42 * scale} ${x + 16 * scale} ${y - 60 * scale}" stroke="${steam}" stroke-width="${3 * scale}" fill="none" opacity="0.55" />
    </g>
  `;
}

function openJournal({ x, y, scale = 1, page, line, opacity = 1 }) {
  return `
    <g opacity="${opacity}">
      <path d="M${x} ${y} L${x - 120 * scale} ${y + 20 * scale} V${y - 90 * scale} L${x} ${y - 106 * scale} Z" fill="${page}" />
      <path d="M${x} ${y} L${x + 120 * scale} ${y + 20 * scale} V${y - 90 * scale} L${x} ${y - 106 * scale} Z" fill="${page}" opacity="0.92" />
      ${[0.2, 0.36, 0.52, 0.68]
        .map(
          (t) =>
            `<line x1="${x - 100 * scale}" y1="${y - 80 * scale + t * 90 * scale}" x2="${x - 14 * scale}" y2="${y - 84 * scale + t * 90 * scale}" stroke="${line}" stroke-width="2" opacity="0.5" />
             <line x1="${x + 14 * scale}" y1="${y - 84 * scale + t * 90 * scale}" x2="${x + 100 * scale}" y2="${y - 80 * scale + t * 90 * scale}" stroke="${line}" stroke-width="2" opacity="0.5" />`
        )
        .join("")}
      <path d="M${x + 30 * scale} ${y - 20 * scale} C${x + 50 * scale} ${y - 50 * scale} ${x + 70 * scale} ${y - 30 * scale} ${x + 90 * scale} ${y - 46 * scale}" stroke="${line}" stroke-width="2" fill="none" opacity="0.4" stroke-dasharray="4 6" />
    </g>
  `;
}

/* ---------------------------------------------------------------------- */

function pageScene(id) {
  switch (id) {
    case "midnight-gold":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#090909" />
        ${softBlob({ cx: 300, cy: 190, rx: 240, ry: 160, color: "#70531b", opacity: 0.15, blur: "blur48" })}
        ${softBlob({ cx: 1380, cy: 920, rx: 320, ry: 220, color: "#c6a142", opacity: 0.12, blur: "blur48" })}
        ${skylineDetailed({
          blocks: [
            [1120, 640, 90, 380],
            [1230, 520, 110, 500],
            [1360, 600, 90, 420],
            [1470, 460, 100, 560],
          ],
          color: "rgba(212,175,55,0.28)",
          windowColor: "rgba(246,230,184,0.6)",
          opacity: 1,
        })}
        ${artDecoFan({ cx: 0, cy: 0, r: 260, count: 7, color: "rgba(212,175,55,0.36)", opacity: 1 })}
        ${linePath({ d: "M1100 1020 C1220 950 1320 900 1500 760", stroke: "rgba(212,175,55,0.18)", opacity: 1, width: 2, blur: "blur12" })}
        ${stars("rgba(255,229,163,0.7)", 0.34, [[190, 120, 2], [410, 214, 1.6], [1320, 158, 1.8], [1470, 290, 1.2], [1260, 940, 1.6], [1435, 865, 1.2]])}
        ${grainTexture(0.18)}
      `;
    case "arctic-light":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f8fcff" />
        ${softBlob({ cx: 420, cy: 110, rx: 460, ry: 200, color: "#d9eeff", opacity: 0.3 })}
        ${mountain({ baseY: 900, color: "rgba(150,190,222,0.75)", opacity: 1, peaks: [[0, 820], [180, 560], [360, 780], [560, 480], [820, 800], [1080, 520], [1340, 800], [1600, 700]] })}
        ${snowCaps({ peaks: [[180, 560], [560, 480], [1080, 520]], color: "rgba(255,255,255,0.95)", opacity: 1, size: 30 })}
        ${glacierBlock({ x: 1180, y: 980, w: 340, h: 130, color: "rgba(140,190,222,0.65)", opacity: 1 })}
        ${glacierBlock({ x: 60, y: 1040, w: 260, h: 90, color: "rgba(140,190,222,0.55)", opacity: 1 })}
        ${iceCrystal({ cx: 1420, cy: 190, r: 46, color: "rgba(80,145,195,0.65)", opacity: 0.9 })}
        ${iceCrystal({ cx: 150, cy: 260, r: 30, color: "rgba(80,145,195,0.55)", opacity: 0.85 })}
        ${grainTexture(0.08)}
      `;
    case "ocean-breeze":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#eefafd" />
        ${softBlob({ cx: 420, cy: 1040, rx: 520, ry: 220, color: "#95e4f2", opacity: 0.14 })}
        ${linePath({ d: "M0 730 C180 700 300 760 470 730 C650 700 760 640 940 660 C1110 678 1260 750 1600 706", stroke: "rgba(8,145,178,0.32)", opacity: 1, width: 8, blur: "blur12" })}
        ${linePath({ d: "M0 804 C170 776 310 832 470 804 C660 772 772 724 960 742 C1120 756 1260 828 1600 788", stroke: "rgba(8,145,178,0.26)", opacity: 1, width: 5, blur: "blur12" })}
        ${sailboat({ x: 1200, y: 700, scale: 1.05, hull: "rgba(10,80,100,0.55)", sail: "rgba(255,255,255,0.85)", opacity: 0.95 })}
        ${sailboat({ x: 320, y: 780, scale: 0.6, hull: "rgba(10,80,100,0.42)", sail: "rgba(255,255,255,0.7)", opacity: 0.85 })}
        ${lighthouse({ x: 1440, y: 640, scale: 0.9, body: "rgba(8,90,110,0.45)", accent: "rgba(224,110,64,0.55)", opacity: 0.9 })}
        ${grainTexture(0.08)}
      `;
    case "forest-explorer":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#101814" />
        ${softBlob({ cx: 1360, cy: 180, rx: 260, ry: 140, color: "#2d5a40", opacity: 0.22 })}
        ${mountain({ baseY: 970, color: "rgba(13,24,18,0.78)", opacity: 1, peaks: [[0, 880], [150, 780], [290, 860], [430, 730], [560, 880], [760, 720], [910, 860], [1140, 760], [1310, 900], [1490, 760], [1600, 860]] })}
        ${pineForest({ baseX: 60, baseY: 1080, count: 5, spread: 320, minH: 190, maxH: 300, color: "rgba(115,161,120,0.55)", opacity: 1, trunk: "rgba(60,42,24,0.5)" })}
        ${pineForest({ baseX: 1260, baseY: 1080, count: 5, spread: 300, minH: 180, maxH: 280, color: "rgba(115,161,120,0.5)", opacity: 1, trunk: "rgba(60,42,24,0.5)" })}
        ${windingRoad({ d: "M700 1200 C740 1040 780 940 860 820", surface: "rgba(40,30,20,0.3)", center: "rgba(230,220,190,0.4)", opacity: 0.5 })}
        ${birdFlock({ positions: [[1180, 200, 1], [1230, 230, 0.8], [1290, 190, 1.1]], color: "rgba(200,210,190,0.5)", opacity: 0.8 })}
        ${grainTexture(0.12)}
      `;
    case "sakura":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fff8f5" />
        <circle cx="1240" cy="260" r="118" fill="rgba(233,104,109,0.16)" filter="url(#blur24)" />
        ${branch({
          d: "M1040 60 C1140 140 1240 210 1320 312 C1400 414 1480 520 1600 640",
          stroke: "rgba(74,55,44,0.82)",
          opacity: 0.84,
          width: 16,
          blossoms: [
            [1188, 154, 20, "rgba(236,124,165,0.74)", 1],
            [1246, 230, 18, "rgba(241,159,187,0.68)", 1],
            [1316, 310, 22, "rgba(234,92,140,0.68)", 1],
            [1420, 472, 18, "rgba(240,153,183,0.64)", 1],
            [1500, 584, 16, "rgba(234,92,140,0.54)", 1],
          ],
        })}
        ${branch({
          d: "M0 280 C90 300 180 340 246 420 C316 510 380 590 470 680",
          stroke: "rgba(93,72,58,0.52)",
          opacity: 0.72,
          width: 11,
          blossoms: [
            [146, 320, 14, "rgba(245,180,205,0.6)", 1],
            [230, 396, 14, "rgba(239,138,177,0.54)", 1],
            [322, 528, 16, "rgba(241,172,197,0.5)", 1],
          ],
        })}
        ${grainTexture(0.08)}
      `;
    case "cyber-neon":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#07010c" />
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#tinyGrid)" opacity="0.22" />
        ${softBlob({ cx: 350, cy: 170, rx: 240, ry: 110, color: "#00f0ff", opacity: 0.14, rotate: -14 })}
        ${softBlob({ cx: 1260, cy: 880, rx: 320, ry: 180, color: "#ff00ea", opacity: 0.12, rotate: 14 })}
        ${neonTower({ x: 1080, y: 520, w: 90, h: 480, edge: "rgba(0,240,255,0.6)", glow: "rgba(0,240,255,0.9)", windowColor: "rgba(255,0,234,0.7)", opacity: 0.9 })}
        ${neonTower({ x: 1200, y: 440, w: 110, h: 560, edge: "rgba(255,0,234,0.55)", glow: "rgba(255,0,234,0.9)", windowColor: "rgba(0,240,255,0.7)", opacity: 0.9 })}
        ${neonTower({ x: 1340, y: 560, w: 80, h: 440, edge: "rgba(0,240,255,0.5)", glow: "rgba(0,240,255,0.8)", windowColor: "rgba(255,0,234,0.6)", opacity: 0.85 })}
        ${windingRoad({ d: "M0 1160 C300 1120 500 1180 800 1120 C1050 1070 1300 1130 1600 1080", surface: "rgba(20,4,30,0.7)", center: "rgba(0,240,255,0.5)", opacity: 0.85 })}
        ${linePath({ d: "M210 300 H620", stroke: "rgba(0,240,255,0.42)", opacity: 1, width: 4, blur: "blur12" })}
        ${linePath({ d: "M980 220 H1480", stroke: "rgba(255,0,234,0.34)", opacity: 1, width: 3, blur: "blur12" })}
        ${grainTexture(0.14)}
      `;
    case "royal-purple":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#150b25" />
        ${softBlob({ cx: 420, cy: 180, rx: 380, ry: 180, color: "#5b2b7f", opacity: 0.18 })}
        ${softBlob({ cx: 1360, cy: 920, rx: 340, ry: 220, color: "#dfc46e", opacity: 0.08 })}
        ${palaceColumns({ baseX: 1140, baseY: 1080, count: 4, height: 340, color: "rgba(233,196,106,0.34)", opacity: 1 })}
        ${pointedArch({ x: 120, y: 980, w: 220, h: 420, color: "rgba(233,196,106,0.42)", opacity: 1 })}
        ${pointedArch({ x: 340, y: 980, w: 180, h: 340, color: "rgba(233,196,106,0.34)", opacity: 1 })}
        <g opacity="0.2">
          <path d="M146 220 C220 152 296 152 370 220 C296 290 220 290 146 220 Z" stroke="rgba(233,196,106,0.46)" stroke-width="4" fill="none" />
        </g>
        ${grainTexture(0.16)}
      `;
    case "desert-sand":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fbf1e2" />
        ${circle({ cx: 1336, cy: 280, r: 96, color: "#e88a3c", opacity: 0.26, blur: "blur24" })}
        ${mountain({ baseY: 880, color: "rgba(193,98,47,0.14)", opacity: 1, peaks: [[900, 820], [1080, 760], [1260, 830], [1460, 780], [1600, 830]] })}
        ${dune({ color: "rgba(227,183,130,0.4)", opacity: 1, baseY: 860, amplitude: 70, phase: 0.4 })}
        ${dune({ color: "rgba(209,152,99,0.3)", opacity: 1, baseY: 960, amplitude: 90, phase: 2.1 })}
        ${palmTree({ x: 220, y: 940, scale: 0.95, color: "rgba(120,86,44,0.55)", opacity: 0.9 })}
        ${palmTree({ x: 330, y: 990, scale: 0.65, color: "rgba(120,86,44,0.48)", opacity: 0.85 })}
        ${softBlob({ cx: 270, cy: 1020, rx: 140, ry: 30, color: "#7fb6b0", opacity: 0.28, blur: "blur24" })}
        ${grainTexture(0.1)}
      `;
    case "emerald-night":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#06150f" />
        ${moonCrescent({ cx: 1360, cy: 190, r: 62, moon: "rgba(226,244,232,0.6)", shadow: "#06150f", opacity: 0.95 })}
        ${softBlob({ cx: 220, cy: 1080, rx: 380, ry: 220, color: "#2f9c78", opacity: 0.22 })}
        ${leaves({ color: "rgba(140,205,170,0.7)", opacity: 0.4, positions: [[1180, 186, 104, 36, -14], [1290, 272, 92, 32, 12], [1422, 166, 88, 30, 18]] })}
        ${leaves({ color: "rgba(100,175,140,0.65)", opacity: 0.42, positions: [[160, 1000, 170, 62, -8], [280, 1080, 150, 54, 10], [80, 1110, 130, 48, -20], [340, 1150, 120, 40, 24]] })}
        ${mountain({ baseY: 1140, color: "rgba(22,64,46,0.65)", opacity: 1, peaks: [[0, 1080], [260, 980], [520, 1080], [820, 950], [1100, 1080], [1340, 1000], [1600, 1080]] })}
        ${grainTexture(0.14)}
      `;
    case "aurora":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#081024" />
        ${auroraRibbons({
          bands: [
            { d: "M120 300 C360 200 560 260 820 190 C1040 130 1260 200 1500 140", color: "rgba(103,246,204,0.28)", width: 60 },
            { d: "M60 380 C320 300 560 360 840 280 C1080 210 1300 280 1540 220", color: "rgba(137,160,255,0.22)", width: 50 },
            { d: "M200 220 C420 150 660 210 900 150 C1120 96 1320 150 1520 100", color: "rgba(240,138,231,0.2)", width: 40 },
          ],
          opacity: 1,
        })}
        ${mountain({ baseY: 980, color: "rgba(24,38,64,0.9)", opacity: 1, peaks: [[0, 860], [210, 770], [420, 920], [620, 740], [820, 920], [1060, 720], [1260, 860], [1460, 720], [1600, 840]] })}
        ${stars("rgba(255,255,255,0.8)", 0.46, [[160, 140, 1.8], [286, 240, 1.2], [980, 118, 1.6], [1320, 208, 1.4], [1450, 96, 1.6], [1210, 336, 1.1]])}
      `;
    case "nordic-frost":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f7fbff" />
        ${mountain({ baseY: 860, color: "rgba(165,195,218,0.7)", opacity: 1, peaks: [[0, 760], [220, 520], [460, 740], [700, 440], [950, 720], [1210, 470], [1480, 770], [1600, 690]] })}
        ${mountain({ baseY: 960, color: "rgba(150,182,205,0.5)", opacity: 1, peaks: [[0, 870], [260, 700], [520, 860], [760, 620], [1040, 860], [1320, 660], [1600, 850]] })}
        ${pineForest({ baseX: 60, baseY: 1120, count: 4, spread: 260, minH: 130, maxH: 190, color: "rgba(70,110,132,0.6)", opacity: 1, trunk: "rgba(70,110,132,0.7)" })}
        ${pineForest({ baseX: 1320, baseY: 1120, count: 4, spread: 240, minH: 120, maxH: 180, color: "rgba(70,110,132,0.55)", opacity: 1, trunk: "rgba(70,110,132,0.7)" })}
        ${cabin({ x: 760, y: 1080, scale: 0.85, wall: "rgba(120,90,60,0.4)", roof: "rgba(70,50,35,0.5)", opacity: 0.85 })}
        ${softBlob({ cx: 760, cy: 1160, rx: 420, ry: 60, color: "#dcecf6", opacity: 0.5, blur: "blur24" })}
        ${grainTexture(0.08)}
      `;
    case "japanese-ink":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f6f0e6" />
        <circle cx="1260" cy="188" r="78" fill="rgba(186,54,41,0.16)" filter="url(#blur24)" />
        <path d="M120 860 C240 740 340 690 500 650 C640 612 760 532 940 410 C1020 360 1080 350 1130 330" stroke="rgba(28,28,28,0.56)" stroke-width="34" stroke-linecap="round" fill="none" filter="url(#blur24)" />
        <path d="M0 1008 C240 914 480 964 740 846 C920 764 1060 650 1240 552 C1360 488 1450 448 1600 434" stroke="rgba(22,22,22,0.22)" stroke-width="120" stroke-linecap="round" fill="none" filter="url(#blur48)" />
        ${linePath({ d: "M1390 240 C1415 316 1435 378 1448 452", stroke: "rgba(50,50,50,0.64)", opacity: 1, width: 8 })}
        ${linePath({ d: "M1422 278 C1492 280 1540 300 1600 344", stroke: "rgba(50,50,50,0.64)", opacity: 1, width: 8 })}
        <path d="M180 930 L250 620 L320 930 Z" fill="rgba(32,32,32,0.48)" />
        <path d="M224 620 L224 530 L288 530 L288 620" fill="rgba(32,32,32,0.46)" />
        ${paperTexture(0.18)}
      `;
    case "matcha-garden":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f3efe1" />
        ${softBlob({ cx: 1260, cy: 220, rx: 340, ry: 160, color: "#c8d8a5", opacity: 0.16 })}
        ${teaGardenPath()}
        ${bambooGrove({ baseX: 1180, baseY: 1180, count: 5, height: 320, color: "rgba(85,120,58,0.6)", leaf: "rgba(85,120,58,0.6)", opacity: 1 })}
        ${teaHousePavilion({ x: 320, y: 980, scale: 0.9, color: "rgba(70,100,44,0.6)", opacity: 0.9 })}
        ${archedBridge({ x: 780, y: 1080, scale: 1.1, color: "rgba(70,100,44,0.6)", opacity: 0.85 })}
        ${softBlob({ cx: 780, cy: 1130, rx: 220, ry: 50, color: "#a9c98f", opacity: 0.3, blur: "blur24" })}
        ${paperTexture(0.12)}
      `;
    case "mediterranean":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fbf8f1" />
        <rect x="0" y="710" width="${WIDTH}" height="250" fill="rgba(159,219,232,0.22)" />
        ${whitewashedRow({ baseX: 100, baseY: 900, count: 5, color: "rgba(255,255,255,0.9)", accent: "rgba(29,111,165,0.65)", outline: "rgba(150,175,190,0.55)", opacity: 0.95 })}
        ${domeBuilding({ x: 1300, y: 880, scale: 1.2, wall: "rgba(255,255,255,0.9)", dome: "rgba(29,111,165,0.7)", outline: "rgba(150,175,190,0.55)", opacity: 0.95 })}
        ${sailboat({ x: 1420, y: 780, scale: 0.6, hull: "rgba(20,60,90,0.4)", sail: "rgba(255,255,255,0.75)", opacity: 0.85 })}
        ${oliveBranch({ x: 1200, y: 200, length: 220, color: "rgba(102,126,72,0.5)", opacity: 0.8, rotate: 18 })}
        ${grainTexture(0.08)}
      `;
    case "tropical-lagoon":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f5f0e7" />
        ${softBlob({ cx: 1120, cy: 800, rx: 560, ry: 220, color: "#4fb8b3", opacity: 0.32 })}
        ${palmTree({ x: 1360, y: 900, scale: 1.15, color: "rgba(57,124,88,0.55)", opacity: 0.9 })}
        ${palmTree({ x: 1480, y: 960, scale: 0.75, color: "rgba(57,124,88,0.45)", opacity: 0.8 })}
        ${palmTree({ x: 160, y: 300, scale: 0.85, color: "rgba(57,124,88,0.4)", opacity: 0.75 })}
        <path d="M1220 1000 Q1300 960 1380 1000 Q1300 1040 1220 1000 Z" fill="rgba(57,124,88,0.3)" opacity="0.7" />
        ${linePath({ d: "M0 842 C240 760 500 820 760 782 C1040 740 1240 790 1600 706", stroke: "rgba(69,181,191,0.2)", opacity: 1, width: 8, blur: "blur24" })}
        ${grainTexture(0.1)}
      `;
    case "sunset-journey":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#faf0e4" />
        ${softBlob({ cx: 1180, cy: 260, rx: 420, ry: 160, color: "#ffb07a", opacity: 0.2 })}
        ${softBlob({ cx: 980, cy: 340, rx: 380, ry: 160, color: "#f28aa5", opacity: 0.16 })}
        ${circle({ cx: 1080, cy: 420, r: 90, color: "#ffcf8a", opacity: 0.5, blur: "blur24" })}
        ${mountain({ baseY: 880, color: "rgba(165,110,72,0.42)", opacity: 1, peaks: [[0, 810], [250, 700], [450, 810], [700, 660], [920, 800], [1180, 620], [1400, 770], [1600, 720]] })}
        ${windingRoad({ d: "M700 1200 C740 980 800 860 900 700 C960 610 1000 560 1020 500", surface: "rgba(90,60,40,0.4)", center: "rgba(255,247,235,0.7)", opacity: 0.9 })}
        ${vanSilhouette({ x: 820, y: 1040, scale: 1, body: "rgba(126,82,58,0.55)", window: "rgba(255,240,220,0.6)", opacity: 0.9 })}
        ${grainTexture(0.08)}
      `;
    case "terracotta":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f5ecdf" />
        ${hillTownRow({ baseX: 1000, baseY: 1000, count: 7, width: 92, wall: "rgba(224,196,163,0.65)", roof: "rgba(181,96,47,0.55)", opacity: 1 })}
        ${pointedArch({ x: 140, y: 1080, w: 180, h: 380, color: "rgba(181,96,47,0.36)", opacity: 1 })}
        ${pointedArch({ x: 330, y: 1080, w: 140, h: 300, color: "rgba(181,96,47,0.26)", opacity: 1 })}
        <g opacity="0.18">
          <path d="M200 700 H460 M200 640 H460 M200 580 H460" stroke="rgba(156,109,73,0.5)" stroke-width="5" />
        </g>
        ${oliveBranch({ x: 1240, y: 220, length: 200, color: "rgba(90,96,50,0.4)", opacity: 0.75, rotate: -12 })}
        ${grainTexture(0.08)}
      `;
    case "vintage-explorer":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2ead7" />
        ${paperTexture(0.24)}
        ${compass({ color: "rgba(117,98,60,0.4)" })}
        ${routeDots({ color: "rgba(104,122,116,0.4)" })}
        ${vintagePlane({ x: 300, y: 300, scale: 1.1, color: "rgba(117,98,60,0.5)", opacity: 0.9 })}
        ${ship({ x: 1360, y: 1040, scale: 0.85, hull: "rgba(117,98,60,0.55)", sail: "rgba(158,132,82,0.55)", opacity: 0.9 })}
        ${suitcaseIcon({ x: 220, y: 980, scale: 1.1, color: "rgba(117,98,60,0.55)", opacity: 0.85 })}
        <g opacity="0.14">
          <circle cx="260" cy="240" r="120" fill="none" stroke="rgba(158,94,74,0.48)" stroke-width="10" />
          <text x="184" y="248" font-size="42" fill="rgba(158,94,74,0.48)" font-family="Georgia, serif">STAMP</text>
        </g>
      `;
    case "alpine":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f4f7f8" />
        ${mountain({ baseY: 840, color: "rgba(120,160,178,0.6)", opacity: 1, peaks: [[0, 780], [220, 520], [430, 720], [660, 380], [900, 760], [1160, 420], [1410, 740], [1600, 650]] })}
        ${mountain({ baseY: 950, color: "rgba(90,132,118,0.48)", opacity: 1, peaks: [[0, 880], [190, 760], [360, 880], [620, 640], [880, 860], [1120, 680], [1370, 860], [1600, 790]] })}
        ${snowCaps({ peaks: [[220, 520], [660, 380], [1160, 420]], color: "rgba(255,255,255,0.85)", opacity: 1, size: 26 })}
        ${cableCar({ x1: 260, y1: 700, x2: 700, y2: 460, cabinT: 0.55, color: "rgba(31,111,139,0.55)", opacity: 0.9 })}
        ${pineForest({ baseX: 1180, baseY: 1080, count: 5, spread: 340, minH: 150, maxH: 240, color: "rgba(70,120,100,0.4)", opacity: 1, trunk: "rgba(70,90,70,0.5)" })}
        ${cabin({ x: 1000, y: 1000, scale: 0.7, wall: "rgba(120,90,60,0.4)", roof: "rgba(70,50,35,0.5)", opacity: 0.8 })}
        ${grainTexture(0.08)}
      `;
    case "autumn-trail":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f6ece0" />
        <path d="M180 1200 C320 1040 440 938 620 818 C800 698 920 660 1040 612" stroke="rgba(175,120,62,0.2)" stroke-width="140" stroke-linecap="round" fill="none" filter="url(#blur12)" />
        <path d="M210 1200 C350 1050 460 958 634 842 C802 730 920 692 1048 632" stroke="rgba(247,240,230,0.56)" stroke-width="60" stroke-linecap="round" fill="none" />
        ${woodenBridge({ x: 700, y: 900, scale: 1, color: "rgba(140,95,55,0.4)", opacity: 0.85 })}
        ${fallenLeafCluster({
          positions: [
            [1240, 160, 1.7, -22],
            [1330, 238, 1.3, 40],
            [1448, 176, 1.5, 16],
            [1480, 304, 1.1, 100],
            [240, 190, 1.2, -12],
            [140, 280, 0.9, 60],
          ],
          color: "rgba(193,103,50,0.65)",
          opacity: 0.85,
        })}
        ${fallenLeafCluster({
          positions: [
            [520, 1000, 0.6, 20],
            [640, 1060, 0.5, -30],
            [400, 1090, 0.45, 40],
            [760, 1020, 0.4, 10],
            [900, 1080, 0.5, -50],
          ],
          color: "rgba(210,140,40,0.55)",
          opacity: 0.8,
        })}
        ${cabin({ x: 1360, y: 940, scale: 0.7, wall: "rgba(120,80,50,0.4)", roof: "rgba(90,55,32,0.5)", opacity: 0.75 })}
        ${grainTexture(0.1)}
      `;
    case "cherry-blossom-night":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#140f22" />
        ${moonCrescent({ cx: 1320, cy: 200, r: 68, moon: "rgba(245,242,224,0.75)", shadow: "#140f22", opacity: 0.95 })}
        ${branch({
          d: "M1090 40 C1190 120 1290 210 1370 310 C1450 408 1518 500 1600 560",
          stroke: "rgba(180,155,200,0.85)",
          opacity: 0.9,
          width: 16,
          blossoms: [
            [1200, 148, 20, "rgba(245,170,210,0.92)", 1],
            [1290, 254, 20, "rgba(240,135,185,0.88)", 1],
            [1408, 404, 22, "rgba(248,182,221,0.8)", 1],
            [1500, 500, 18, "rgba(240,135,185,0.72)", 1],
          ],
        })}
        ${softBlob({ cx: 110, cy: 900, rx: 140, ry: 260, color: "#4a3a66", opacity: 0.4, blur: "blur48" })}
        <path d="M60 1080 L110 800 L160 1080 Z" fill="rgba(140,124,168,0.5)" opacity="0.9" />
        <path d="M92 800 L92 720 L128 720 L128 800" fill="rgba(140,124,168,0.46)" opacity="0.9" />
        ${lantern({ x: 240, y: 1040, scale: 1.2, color: "rgba(200,180,220,0.7)", glow: "rgba(250,190,130,0.85)", opacity: 1 })}
        ${lantern({ x: 370, y: 990, scale: 0.9, color: "rgba(200,180,220,0.65)", glow: "rgba(250,190,130,0.75)", opacity: 0.95 })}
        ${stars("rgba(255,255,255,0.9)", 0.5, [[160, 126, 1.8], [280, 220, 1.3], [420, 116, 1.6], [1020, 118, 1.4], [1420, 90, 2], [1514, 240, 1.4]])}
        ${grainTexture(0.12)}
      `;
    case "northern-lights":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#07111d" />
        ${auroraRibbons({
          bands: [
            { d: "M40 220 C300 140 540 200 800 130 C1020 76 1240 140 1560 90", color: "rgba(34,197,143,0.3)", width: 56 },
            { d: "M100 300 C340 230 580 290 840 220 C1060 160 1260 220 1520 170", color: "rgba(94,166,255,0.2)", width: 44 },
          ],
          opacity: 1,
        })}
        ${mountain({ baseY: 980, color: "rgba(22,48,58,0.92)", opacity: 1, peaks: [[0, 900], [180, 820], [360, 910], [540, 720], [720, 900], [960, 710], [1210, 880], [1420, 720], [1600, 870]] })}
        ${pineForest({ baseX: 60, baseY: 1140, count: 4, spread: 260, minH: 140, maxH: 200, color: "rgba(38,86,64,0.85)", opacity: 1, trunk: "rgba(38,86,64,0.9)" })}
        ${pineForest({ baseX: 1300, baseY: 1140, count: 4, spread: 260, minH: 140, maxH: 210, color: "rgba(38,86,64,0.85)", opacity: 1, trunk: "rgba(38,86,64,0.9)" })}
        ${cabin({ x: 800, y: 1100, scale: 0.75, wall: "rgba(30,26,20,0.6)", roof: "rgba(18,16,12,0.7)", opacity: 0.85, glow: "rgba(245,190,110,0.6)" })}
        ${stars("rgba(255,255,255,0.9)", 0.46, [[180, 116, 1.6], [340, 182, 1.1], [560, 96, 1.4], [1080, 110, 1.6], [1460, 164, 1.2], [1360, 240, 1.2]])}
      `;
    case "solarized-traveler":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f7f1e5" />
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#tinyGrid)" opacity="0.14" />
        ${worldMapSilhouette({ blobColor: "rgba(63,127,166,0.32)", routeColor: "rgba(63,127,166,0.55)", opacity: 0.95 })}
        <g opacity="0.16">
          <circle cx="280" cy="880" r="110" fill="none" stroke="rgba(180,126,72,0.5)" stroke-width="6" stroke-dasharray="12 16" />
          <circle cx="1280" cy="830" r="96" fill="none" stroke="rgba(94,132,124,0.46)" stroke-width="6" stroke-dasharray="12 16" />
        </g>
        ${paperTexture(0.08)}
      `;
    case "coffee-house":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#efe2d5" />
        ${softBlob({ cx: 1280, cy: 210, rx: 340, ry: 160, color: "#d0aa82", opacity: 0.16 })}
        ${coffeeBeans()}
        ${coffeeCupSteam({ x: 1200, y: 980, scale: 1.3, cup: "rgba(143,92,54,0.5)", steam: "rgba(143,92,54,0.35)", opacity: 0.9 })}
        ${openJournal({ x: 340, y: 1020, scale: 1, page: "rgba(250,244,232,0.85)", line: "rgba(120,80,45,0.45)", opacity: 0.9 })}
        <rect x="1420" y="700" width="140" height="220" rx="8" fill="none" stroke="rgba(118,71,42,0.3)" stroke-width="6" opacity="0.7" />
        <line x1="1490" y1="700" x2="1490" y2="920" stroke="rgba(118,71,42,0.25)" stroke-width="4" opacity="0.6" />
        <line x1="1420" y1="810" x2="1560" y2="810" stroke="rgba(118,71,42,0.25)" stroke-width="4" opacity="0.6" />
        ${grainTexture(0.12)}
      `;
    case "monochrome":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fbfbfb" />
        ${skylineDetailed({
          blocks: [
            [110, 360, 150, 520],
            [250, 220, 210, 660],
            [460, 320, 120, 560],
            [1010, 280, 220, 600],
            [1220, 200, 140, 680],
            [1360, 340, 180, 540],
          ],
          color: "rgba(39,43,48,0.18)",
          windowColor: "rgba(39,43,48,0.38)",
          opacity: 1,
        })}
        ${archedBridge({ x: 780, y: 880, scale: 1.6, color: "rgba(44,48,54,0.3)", opacity: 1 })}
        ${linePath({ d: "M0 880 H1600", stroke: "rgba(44,48,54,0.12)", opacity: 1, width: 5 })}
        ${linePath({ d: "M0 260 H960", stroke: "rgba(44,48,54,0.08)", opacity: 1, width: 4 })}
        <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#tinyGrid)" opacity="0.08" />
        ${grainTexture(0.06)}
      `;
    default:
      throw new Error(`Unknown theme id: ${id}`);
  }
}

const themeIds = [
  "midnight-gold",
  "arctic-light",
  "ocean-breeze",
  "forest-explorer",
  "sakura",
  "cyber-neon",
  "royal-purple",
  "desert-sand",
  "emerald-night",
  "aurora",
  "nordic-frost",
  "japanese-ink",
  "matcha-garden",
  "mediterranean",
  "tropical-lagoon",
  "sunset-journey",
  "terracotta",
  "vintage-explorer",
  "alpine",
  "autumn-trail",
  "cherry-blossom-night",
  "northern-lights",
  "solarized-traveler",
  "coffee-house",
  "monochrome",
];

async function generate() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const id of themeIds) {
    const outputPath = path.join(OUTPUT_DIR, `${id}.webp`);
    const overlay = wrapSvg(pageScene(id));

    await sharp({
      create: {
        width: WIDTH,
        height: HEIGHT,
        channels: 4,
        background: "#ffffff",
      },
    })
      .composite([{ input: overlay }])
      .webp({ quality: 80, effort: 6 })
      .toFile(outputPath);

    const { size } = await fs.stat(outputPath);
    console.log(`${id}.webp\t${Math.round(size / 1024)} KB`);
  }
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
