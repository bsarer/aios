/**
 * Draws Astra's sample chat wallpapers (packages/core/wallpapers/*.jpg) with CSS in Chromium.
 * The pictures are original, made here, so they ship under the project's own license.
 * `pnpm --filter @aios/scripts make-wallpapers` writes them again; commit what changes.
 *
 * Chromium: $CHROMIUM_PATH, else `chromium` on PATH.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WALLPAPER_SAMPLES } from '@aios/core';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core', 'wallpapers');

/** A fine grain over every picture, so its gradients don't band once saved as JPEG. */
const GRAIN = `<svg class="grain" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .09 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
const BASE = 'html,body{margin:0;width:100%;height:100%;overflow:hidden}body{position:relative}.grain{position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:overlay}div{position:absolute}';

const ART: Record<string, string> = {
  dusk: `<style>${BASE}
    body{background:linear-gradient(#1d2b64 0%,#5b4b8a 38%,#e0816f 70%,#f6c27a 100%)}
    .sun{left:62%;top:44%;width:210px;height:210px;border-radius:50%;background:radial-gradient(#fff3c4,#ffd27a 60%,#ffb36b00 72%)}
    .h{left:0;right:0;bottom:0}
    .h1{height:52%;background:#7a4f86;clip-path:polygon(0 40%,12% 22%,26% 38%,40% 15%,55% 34%,70% 12%,84% 30%,100% 18%,100% 100%,0 100%)}
    .h2{height:40%;background:#4d3567;clip-path:polygon(0 30%,15% 48%,30% 20%,46% 42%,60% 24%,76% 46%,90% 28%,100% 40%,100% 100%,0 100%)}
    .h3{height:26%;background:#24193a;clip-path:polygon(0 45%,18% 20%,34% 50%,52% 25%,68% 52%,85% 22%,100% 46%,100% 100%,0 100%)}
  </style><div class="sun"></div><div class="h h1"></div><div class="h h2"></div><div class="h h3"></div>`,
  aurora: `<style>${BASE}
    body{background:radial-gradient(120% 80% at 50% 110%,#0b2a3a 0%,#06121f 55%,#03070f 100%)}
    .a{inset:-20%;filter:blur(60px);opacity:.85}
    .a1{background:radial-gradient(40% 18% at 30% 38%,#3ee6a8 0%,#3ee6a800 100%)}
    .a2{background:radial-gradient(45% 14% at 62% 30%,#2fb7d9 0%,#2fb7d900 100%)}
    .a3{background:radial-gradient(30% 12% at 75% 45%,#9b6cf0 0%,#9b6cf000 100%)}
    .stars{inset:0;background-image:radial-gradient(1.5px 1.5px at 12% 18%,#fff9,#0000),radial-gradient(1.5px 1.5px at 33% 9%,#fff8,#0000),radial-gradient(1px 1px at 48% 22%,#fff9,#0000),radial-gradient(1.5px 1.5px at 71% 12%,#fffa,#0000),radial-gradient(1px 1px at 88% 26%,#fff8,#0000),radial-gradient(1px 1px at 22% 6%,#fff7,#0000),radial-gradient(1.5px 1.5px at 93% 7%,#fff9,#0000),radial-gradient(1px 1px at 58% 5%,#fff8,#0000)}
    .ridge{left:0;right:0;bottom:0;height:22%;background:#02060c;clip-path:polygon(0 55%,10% 40%,22% 58%,35% 30%,48% 52%,60% 36%,74% 60%,86% 38%,100% 50%,100% 100%,0 100%)}
  </style><div class="stars"></div><div class="a a1"></div><div class="a a2"></div><div class="a a3"></div><div class="ridge"></div>`,
  tide: `<style>${BASE}
    body{background:linear-gradient(160deg,#0a1f3d 0%,#0f3b5c 45%,#13617a 100%)}
    .w{left:-60%;right:-60%;border-radius:50% 50% 0 0/100% 100% 0 0}
    .w1{bottom:-35%;height:75%;background:linear-gradient(#1b7a8c,#0d4a63);opacity:.55;transform:rotate(-6deg) translateX(8%)}
    .w2{bottom:-40%;height:70%;background:linear-gradient(#1f8f96,#0b3954);opacity:.6;transform:rotate(4deg) translateX(-10%)}
    .w3{bottom:-50%;height:62%;background:linear-gradient(#25a3a0,#082c45);opacity:.7;transform:rotate(-2deg)}
    .glow{left:55%;top:8%;width:620px;height:620px;border-radius:50%;background:radial-gradient(#7fd3e855,#7fd3e800 70%)}
  </style><div class="glow"></div><div class="w w1"></div><div class="w w2"></div><div class="w w3"></div>`,
  ember: `<style>${BASE}
    body{background:#140b0f}
    .b{border-radius:50%;filter:blur(90px)}
    .b1{left:-10%;top:30%;width:60%;height:80%;background:#a3311f}
    .b2{left:45%;top:-20%;width:55%;height:70%;background:#d9752b;opacity:.8}
    .b3{left:60%;top:55%;width:45%;height:60%;background:#6b1d3b}
    .b4{left:20%;top:-25%;width:35%;height:45%;background:#f2b25c;opacity:.5}
  </style><div class="b b1"></div><div class="b b2"></div><div class="b b3"></div><div class="b b4"></div>`,
};

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    for (const s of WALLPAPER_SAMPLES) {
      const art = ART[s.id];
      if (!art) throw new Error(`make-wallpapers: no art for ${s.id}`);
      await page.setContent(`<!doctype html>${art}${GRAIN}`);
      const file = join(out, `${s.id}.jpg`);
      writeFileSync(file, await page.screenshot({ type: 'jpeg', quality: 84 }));
      console.log(`${file}  ${Math.round(statSync(file).size / 1024)} KB`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
