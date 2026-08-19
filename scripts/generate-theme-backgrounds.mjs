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

function linePath({ d, stroke, opacity, width = 2, blur }) {
  return `<path d="${d}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${opacity}"${blur ? ` filter="url(#${blur})"` : ""} />`;
}

function mountain({ baseY, color, opacity, peaks }) {
  return `<path d="M0 ${HEIGHT} L0 ${baseY} ${peaks
    .map(([x, y]) => `L${x} ${y}`)
    .join(" ")} L${WIDTH} ${baseY} L${WIDTH} ${HEIGHT} Z" fill="${color}" opacity="${opacity}" />`;
}

function dune({ color, opacity, startY, c1, c2, endY }) {
  return `<path d="M0 ${HEIGHT} L0 ${startY} C ${c1.join(" ")} ${c2.join(
    " "
  )} ${WIDTH} ${endY} L${WIDTH} ${HEIGHT} Z" fill="${color}" opacity="${opacity}" />`;
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

function arches({ color, accent, opacity = 0.16 }) {
  return `
    <g opacity="${opacity}">
      <path d="M110 1080 V520 Q110 400 230 400 H430 Q550 400 550 520 V1080" fill="none" stroke="${color}" stroke-width="26" />
      <path d="M1040 1080 V430 Q1040 300 1170 300 H1400 Q1530 300 1530 430 V1080" fill="none" stroke="${accent}" stroke-width="20" />
      <path d="M650 1080 V610 Q650 520 740 520 H860 Q950 520 950 610 V1080" fill="none" stroke="${color}" stroke-width="16" />
    </g>
  `;
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

function leaves({ color, opacity = 0.12, positions = [] }) {
  return positions
    .map(
      ([cx, cy, rx, ry, rotate]) =>
        `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" opacity="${opacity}" transform="rotate(${rotate} ${cx} ${cy})" filter="url(#blur12)" />`
    )
    .join("");
}

function teaGardenPath() {
  return `
    <path d="M180 1200 C310 1020 420 930 610 820 C780 720 860 640 940 510" stroke="rgba(139,123,90,0.24)" stroke-width="120" stroke-linecap="round" fill="none" filter="url(#blur12)" />
    <path d="M220 1200 C340 1040 460 955 630 845 C790 748 880 660 970 520" stroke="rgba(240,236,225,0.58)" stroke-width="54" stroke-linecap="round" fill="none" />
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

function pageScene(id) {
  switch (id) {
    case "midnight-gold":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#090909" />
        ${softBlob({ cx: 300, cy: 190, rx: 240, ry: 160, color: "#70531b", opacity: 0.15, blur: "blur48" })}
        ${softBlob({ cx: 1380, cy: 920, rx: 320, ry: 220, color: "#c6a142", opacity: 0.12, blur: "blur48" })}
        ${linePath({ d: "M120 260 C300 220 410 300 540 246 C620 212 720 150 860 178", stroke: "rgba(212,175,55,0.26)", opacity: 1, width: 3, blur: "blur12" })}
        ${linePath({ d: "M1050 130 C1110 190 1180 220 1280 220 C1376 220 1450 196 1520 128", stroke: "rgba(212,175,55,0.2)", opacity: 1, width: 2 })}
        ${linePath({ d: "M1100 1020 C1220 950 1320 900 1500 760", stroke: "rgba(212,175,55,0.18)", opacity: 1, width: 2, blur: "blur12" })}
        ${stars("rgba(255,229,163,0.7)", 0.34, [[190, 120, 2], [410, 214, 1.6], [1320, 158, 1.8], [1470, 290, 1.2], [1260, 940, 1.6], [1435, 865, 1.2]])}
        ${grainTexture(0.18)}
      `;
    case "arctic-light":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f8fcff" />
        ${softBlob({ cx: 420, cy: 110, rx: 460, ry: 200, color: "#d9eeff", opacity: 0.3 })}
        ${softBlob({ cx: 1320, cy: 980, rx: 400, ry: 220, color: "#f0f7ff", opacity: 0.38 })}
        <g opacity="0.22">
          <path d="M140 220 L260 120 420 160 500 90 660 150 610 310 420 370 220 330 Z" fill="rgba(221,236,248,0.56)" />
          <path d="M1130 210 L1260 110 1440 158 1510 310 1340 378 1120 320 Z" fill="rgba(221,236,248,0.42)" />
        </g>
        <path d="M0 870 C220 820 310 760 520 780 C770 804 930 744 1120 710 C1300 682 1430 712 1600 648 V1200 H0 Z" fill="rgba(212,233,248,0.24)" />
        ${grainTexture(0.1)}
      `;
    case "ocean-breeze":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#eefafd" />
        ${softBlob({ cx: 420, cy: 1040, rx: 520, ry: 220, color: "#95e4f2", opacity: 0.16 })}
        ${softBlob({ cx: 1360, cy: 170, rx: 360, ry: 140, color: "#ccf4f7", opacity: 0.24 })}
        ${linePath({ d: "M0 730 C180 700 300 760 470 730 C650 700 760 640 940 660 C1110 678 1260 750 1600 706", stroke: "rgba(8,145,178,0.16)", opacity: 1, width: 8, blur: "blur24" })}
        ${linePath({ d: "M0 804 C170 776 310 832 470 804 C660 772 772 724 960 742 C1120 756 1260 828 1600 788", stroke: "rgba(8,145,178,0.14)", opacity: 1, width: 5, blur: "blur12" })}
        ${linePath({ d: "M980 220 C1120 178 1248 166 1410 212", stroke: "rgba(72,175,192,0.18)", opacity: 1, width: 4 })}
        ${grainTexture(0.1)}
      `;
    case "forest-explorer":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#101814" />
        ${softBlob({ cx: 1360, cy: 180, rx: 260, ry: 140, color: "#2d5a40", opacity: 0.22 })}
        ${mountain({ baseY: 970, color: "rgba(13,24,18,0.78)", opacity: 1, peaks: [[0, 880], [150, 780], [290, 860], [430, 730], [560, 880], [760, 720], [910, 860], [1140, 760], [1310, 900], [1490, 760], [1600, 860]] })}
        <g opacity="0.26">
          ${[70, 140, 220, 300, 1320, 1400, 1490, 1560]
            .map((x, index) => `<path d="M${x} 1080 L${x + 26} ${700 - index * 18} L${x + 52} 1080 Z" fill="rgba(115,161,120,0.6)" />`)
            .join("")}
        </g>
        ${leaves({ color: "rgba(118,150,99,0.44)", opacity: 0.16, positions: [[1180, 210, 86, 38, -24], [1290, 264, 72, 28, 18], [1450, 156, 68, 26, 32], [138, 154, 76, 32, -18]] })}
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
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#tinyGrid)" opacity="0.28" />
        ${softBlob({ cx: 350, cy: 170, rx: 240, ry: 110, color: "#00f0ff", opacity: 0.18, rotate: -14 })}
        ${softBlob({ cx: 1260, cy: 880, rx: 320, ry: 180, color: "#ff00ea", opacity: 0.16, rotate: 14 })}
        ${linePath({ d: "M210 300 H620", stroke: "rgba(0,240,255,0.42)", opacity: 1, width: 4, blur: "blur12" })}
        ${linePath({ d: "M980 220 H1480", stroke: "rgba(255,0,234,0.34)", opacity: 1, width: 3, blur: "blur12" })}
        ${linePath({ d: "M1080 760 L1410 420", stroke: "rgba(54,191,255,0.22)", opacity: 1, width: 2 })}
        ${linePath({ d: "M260 1020 L640 640", stroke: "rgba(255,0,234,0.22)", opacity: 1, width: 2 })}
        ${grainTexture(0.14)}
      `;
    case "royal-purple":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#150b25" />
        ${softBlob({ cx: 420, cy: 180, rx: 380, ry: 180, color: "#5b2b7f", opacity: 0.18 })}
        ${softBlob({ cx: 1360, cy: 920, rx: 340, ry: 220, color: "#dfc46e", opacity: 0.08 })}
        <g opacity="0.2">
          <path d="M146 220 C220 152 296 152 370 220 C296 290 220 290 146 220 Z" stroke="rgba(233,196,106,0.46)" stroke-width="4" fill="none" />
          <path d="M250 220 C324 152 400 152 474 220 C400 290 324 290 250 220 Z" stroke="rgba(233,196,106,0.38)" stroke-width="4" fill="none" />
          <path d="M1180 940 C1260 860 1360 860 1440 940 C1360 1020 1260 1020 1180 940 Z" stroke="rgba(233,196,106,0.3)" stroke-width="4" fill="none" />
        </g>
        ${grainTexture(0.16)}
      `;
    case "desert-sand":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fbf1e2" />
        ${dune({ color: "rgba(227,183,130,0.28)", opacity: 1, startY: 820, c1: [240, 720, 460, 760], c2: [860, 880, 1180, 760], endY: 860 })}
        ${dune({ color: "rgba(209,152,99,0.22)", opacity: 1, startY: 920, c1: [340, 850, 560, 910], c2: [940, 1020, 1230, 900], endY: 980 })}
        <path d="M1120 870 C1200 750 1300 688 1440 648" stroke="rgba(176,114,72,0.18)" stroke-width="6" fill="none" filter="url(#blur12)" />
        ${circle({ cx: 1336, cy: 228, r: 88, color: "#f2c485", opacity: 0.16, blur: "blur24" })}
        ${grainTexture(0.1)}
      `;
    case "emerald-night":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#06150f" />
        ${softBlob({ cx: 320, cy: 240, rx: 260, ry: 140, color: "#4cd2a4", opacity: 0.16 })}
        ${softBlob({ cx: 1320, cy: 1060, rx: 320, ry: 170, color: "#61c7a9", opacity: 0.12 })}
        ${leaves({ color: "rgba(120,190,154,0.5)", opacity: 0.14, positions: [[1180, 186, 104, 36, -14], [1290, 272, 92, 32, 12], [1422, 166, 88, 30, 18]] })}
        ${linePath({ d: "M180 940 C320 860 420 860 570 900", stroke: "rgba(116,198,170,0.2)", opacity: 1, width: 3, blur: "blur12" })}
        ${grainTexture(0.14)}
      `;
    case "aurora":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#081024" />
        ${softBlob({ cx: 480, cy: 260, rx: 420, ry: 120, color: "#67f6cc", opacity: 0.18, rotate: -10 })}
        ${softBlob({ cx: 820, cy: 180, rx: 360, ry: 120, color: "#89a0ff", opacity: 0.14, rotate: -14 })}
        ${softBlob({ cx: 1130, cy: 280, rx: 320, ry: 110, color: "#f08ae7", opacity: 0.14, rotate: -6 })}
        ${mountain({ baseY: 980, color: "rgba(6,12,24,0.86)", opacity: 1, peaks: [[0, 860], [210, 770], [420, 920], [620, 740], [820, 920], [1060, 720], [1260, 860], [1460, 720], [1600, 840]] })}
        ${stars("rgba(255,255,255,0.8)", 0.46, [[160, 140, 1.8], [286, 240, 1.2], [980, 118, 1.6], [1320, 208, 1.4], [1450, 96, 1.6], [1210, 336, 1.1]])}
      `;
    case "nordic-frost":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f7fbff" />
        ${mountain({ baseY: 860, color: "rgba(216,229,238,0.46)", opacity: 1, peaks: [[0, 760], [220, 520], [460, 740], [700, 440], [950, 720], [1210, 470], [1480, 770], [1600, 690]] })}
        ${mountain({ baseY: 960, color: "rgba(203,220,232,0.34)", opacity: 1, peaks: [[0, 870], [260, 700], [520, 860], [760, 620], [1040, 860], [1320, 660], [1600, 850]] })}
        <g opacity="0.18">
          <path d="M170 226 L256 172 L340 226 L256 278 Z" fill="rgba(209,232,243,0.54)" />
          <path d="M1310 168 L1388 118 L1470 168 L1388 220 Z" fill="rgba(209,232,243,0.4)" />
        </g>
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
        ${leaves({ color: "rgba(89,122,59,0.5)", opacity: 0.18, positions: [[1300, 200, 120, 34, -16], [1410, 298, 94, 28, 12], [1500, 144, 90, 24, 18], [180, 240, 82, 24, -12]] })}
        ${linePath({ d: "M122 1080 C200 990 240 880 256 760", stroke: "rgba(73,93,48,0.22)", opacity: 1, width: 12, blur: "blur12" })}
        ${paperTexture(0.12)}
      `;
    case "mediterranean":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fbf8f1" />
        <rect x="0" y="710" width="${WIDTH}" height="250" fill="rgba(159,219,232,0.22)" />
        <g opacity="0.34">
          <rect x="120" y="560" width="170" height="190" rx="18" fill="rgba(255,255,255,0.9)" />
          <rect x="250" y="470" width="220" height="280" rx="20" fill="rgba(255,255,255,0.94)" />
          <rect x="430" y="520" width="180" height="230" rx="20" fill="rgba(255,255,255,0.88)" />
          <rect x="880" y="540" width="240" height="210" rx="20" fill="rgba(255,255,255,0.88)" />
        </g>
        ${linePath({ d: "M0 760 C220 742 440 784 620 760 C880 720 1120 792 1600 740", stroke: "rgba(55,155,180,0.18)", opacity: 1, width: 5, blur: "blur12" })}
        ${leaves({ color: "rgba(102,126,72,0.46)", opacity: 0.14, positions: [[1360, 160, 88, 26, -22], [1450, 228, 74, 20, 10], [1508, 296, 70, 20, 20]] })}
        ${grainTexture(0.08)}
      `;
    case "tropical-lagoon":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f5f0e7" />
        ${softBlob({ cx: 1120, cy: 760, rx: 560, ry: 240, color: "#7ed7d4", opacity: 0.22 })}
        ${softBlob({ cx: 1450, cy: 220, rx: 320, ry: 180, color: "#89cf94", opacity: 0.18 })}
        ${leaves({ color: "rgba(57,124,88,0.55)", opacity: 0.16, positions: [[1260, 160, 124, 38, -20], [1370, 264, 110, 34, 8], [1510, 198, 108, 32, 18], [188, 250, 104, 30, -18]] })}
        ${linePath({ d: "M0 842 C240 760 500 820 760 782 C1040 740 1240 790 1600 706", stroke: "rgba(69,181,191,0.16)", opacity: 1, width: 8, blur: "blur24" })}
        ${grainTexture(0.1)}
      `;
    case "sunset-journey":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#faf0e4" />
        ${softBlob({ cx: 1180, cy: 260, rx: 420, ry: 160, color: "#ffb07a", opacity: 0.18 })}
        ${softBlob({ cx: 980, cy: 340, rx: 380, ry: 160, color: "#f28aa5", opacity: 0.16 })}
        ${mountain({ baseY: 880, color: "rgba(195,146,110,0.2)", opacity: 1, peaks: [[0, 810], [250, 700], [450, 810], [700, 660], [920, 800], [1180, 620], [1400, 770], [1600, 720]] })}
        <path d="M742 1200 C756 980 768 860 784 720" stroke="rgba(126,82,58,0.18)" stroke-width="26" fill="none" filter="url(#blur12)" />
        <path d="M706 1200 C720 980 736 860 748 720" stroke="rgba(255,251,242,0.2)" stroke-width="5" fill="none" />
        <path d="M808 1200 C820 980 832 860 848 720" stroke="rgba(255,251,242,0.16)" stroke-width="5" fill="none" />
        ${grainTexture(0.08)}
      `;
    case "terracotta":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f5ecdf" />
        ${arches({ color: "rgba(167,103,68,0.34)", accent: "rgba(206,153,111,0.24)", opacity: 0.38 })}
        <g opacity="0.14">
          <path d="M260 1060 H760 M260 980 H760 M260 900 H760" stroke="rgba(156,109,73,0.44)" stroke-width="6" />
          <path d="M1140 1060 H1500 M1140 980 H1500 M1140 900 H1500" stroke="rgba(156,109,73,0.36)" stroke-width="6" />
        </g>
        ${grainTexture(0.08)}
      `;
    case "vintage-explorer":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2ead7" />
        ${paperTexture(0.24)}
        ${compass({ color: "rgba(117,98,60,0.24)" })}
        ${routeDots({ color: "rgba(104,122,116,0.24)" })}
        <g opacity="0.14">
          <circle cx="260" cy="240" r="120" fill="none" stroke="rgba(158,94,74,0.48)" stroke-width="10" />
          <text x="184" y="248" font-size="42" fill="rgba(158,94,74,0.48)" font-family="Georgia, serif">STAMP</text>
        </g>
      `;
    case "alpine":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f4f7f8" />
        ${mountain({ baseY: 840, color: "rgba(168,195,205,0.34)", opacity: 1, peaks: [[0, 780], [220, 520], [430, 720], [660, 380], [900, 760], [1160, 420], [1410, 740], [1600, 650]] })}
        ${mountain({ baseY: 950, color: "rgba(125,158,146,0.26)", opacity: 1, peaks: [[0, 880], [190, 760], [360, 880], [620, 640], [880, 860], [1120, 680], [1370, 860], [1600, 790]] })}
        <g opacity="0.22">
          ${[120, 220, 320, 1340, 1430, 1500].map((x) => `<path d="M${x} 1060 L${x + 24} 820 L${x + 48} 1060 Z" fill="rgba(61,105,71,0.6)" />`).join("")}
        </g>
        ${grainTexture(0.08)}
      `;
    case "autumn-trail":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f6ece0" />
        <path d="M180 1200 C320 1040 440 938 620 818 C800 698 920 660 1040 612" stroke="rgba(175,120,62,0.2)" stroke-width="140" stroke-linecap="round" fill="none" filter="url(#blur12)" />
        <path d="M210 1200 C350 1050 460 958 634 842 C802 730 920 692 1048 632" stroke="rgba(247,240,230,0.56)" stroke-width="60" stroke-linecap="round" fill="none" />
        ${leaves({ color: "rgba(193,103,50,0.56)", opacity: 0.18, positions: [[1240, 160, 88, 28, -22], [1330, 238, 74, 22, 8], [1448, 176, 78, 24, 16], [1480, 304, 58, 18, 28], [240, 190, 60, 18, -12]] })}
        ${softBlob({ cx: 1380, cy: 860, rx: 300, ry: 160, color: "#e6ba82", opacity: 0.12 })}
        ${grainTexture(0.1)}
      `;
    case "cherry-blossom-night":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#140f22" />
        <circle cx="1320" cy="200" r="106" fill="rgba(245,242,224,0.12)" filter="url(#blur24)" />
        ${branch({
          d: "M1090 40 C1190 120 1290 210 1370 310 C1450 408 1518 500 1600 560",
          stroke: "rgba(76,57,93,0.9)",
          opacity: 0.9,
          width: 18,
          blossoms: [
            [1200, 148, 18, "rgba(240,168,209,0.46)", 1],
            [1290, 254, 18, "rgba(235,132,183,0.42)", 1],
            [1408, 404, 20, "rgba(246,180,219,0.34)", 1],
          ],
        })}
        ${stars("rgba(255,255,255,0.82)", 0.34, [[160, 126, 1.6], [280, 220, 1.1], [420, 116, 1.4], [1020, 118, 1.2], [1420, 90, 1.8], [1514, 240, 1.2]])}
        ${softBlob({ cx: 1320, cy: 960, rx: 340, ry: 180, color: "#ff6cb9", opacity: 0.12 })}
        ${grainTexture(0.12)}
      `;
    case "northern-lights":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#07111d" />
        ${softBlob({ cx: 440, cy: 210, rx: 420, ry: 110, color: "#4ff2cb", opacity: 0.18, rotate: -6 })}
        ${softBlob({ cx: 810, cy: 160, rx: 340, ry: 100, color: "#5ea6ff", opacity: 0.16, rotate: -10 })}
        ${softBlob({ cx: 1180, cy: 240, rx: 360, ry: 110, color: "#986eff", opacity: 0.14, rotate: -4 })}
        ${mountain({ baseY: 980, color: "rgba(7,18,24,0.9)", opacity: 1, peaks: [[0, 900], [180, 820], [360, 910], [540, 720], [720, 900], [960, 710], [1210, 880], [1420, 720], [1600, 870]] })}
        ${[80, 160, 1260, 1340, 1460].map((x) => `<path d="M${x} 1080 L${x + 24} 860 L${x + 48} 1080 Z" fill="rgba(24,54,42,0.52)" />`).join("")}
        ${stars("rgba(255,255,255,0.9)", 0.46, [[180, 116, 1.6], [340, 182, 1.1], [560, 96, 1.4], [1080, 110, 1.6], [1460, 164, 1.2], [1360, 240, 1.2]])}
      `;
    case "solarized-traveler":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#f7f1e5" />
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#tinyGrid)" opacity="0.16" />
        ${routeDots({ color: "rgba(61,117,104,0.22)" })}
        <g opacity="0.16">
          <circle cx="280" cy="280" r="110" fill="none" stroke="rgba(180,126,72,0.5)" stroke-width="6" stroke-dasharray="12 16" />
          <circle cx="1280" cy="830" r="96" fill="none" stroke="rgba(94,132,124,0.46)" stroke-width="6" stroke-dasharray="12 16" />
        </g>
        ${paperTexture(0.08)}
      `;
    case "coffee-house":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#efe2d5" />
        ${softBlob({ cx: 1280, cy: 210, rx: 340, ry: 160, color: "#d0aa82", opacity: 0.18 })}
        ${coffeeBeans()}
        <g opacity="0.18">
          <path d="M420 1020 C426 930 408 872 370 816" stroke="rgba(143,92,54,0.46)" stroke-width="14" fill="none" filter="url(#blur12)" />
          <path d="M472 1020 C492 920 480 850 438 786" stroke="rgba(143,92,54,0.34)" stroke-width="12" fill="none" filter="url(#blur12)" />
          <path d="M522 1020 C554 928 550 854 514 792" stroke="rgba(143,92,54,0.28)" stroke-width="10" fill="none" filter="url(#blur12)" />
        </g>
        <path d="M0 1020 C260 980 520 1010 760 970 C980 934 1230 974 1600 922 V1200 H0 Z" fill="rgba(118,71,42,0.14)" />
        ${grainTexture(0.12)}
      `;
    case "monochrome":
      return svg`
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#fbfbfb" />
        ${skyline({
          color: "rgba(39,43,48,0.08)",
          opacity: 1,
          blocks: [
            [110, 360, 150, 520],
            [250, 220, 210, 660],
            [460, 320, 120, 560],
            [1010, 280, 220, 600],
            [1220, 200, 140, 680],
            [1360, 340, 180, 540],
          ],
        })}
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
