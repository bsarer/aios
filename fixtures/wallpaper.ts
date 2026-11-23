/** The chat wallpaper's e2e checks and screenshots (scripts/src/e2e.ts, e2e-setup.ts). */

/** An original picture for the wallpaper checks: dusk over layered hills, drawn with CSS. */
export const WALLPAPER_ART = `<!doctype html><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden}
  body{background:linear-gradient(#1d2b64 0%,#5b4b8a 38%,#e0816f 70%,#f6c27a 100%);position:relative}
  .sun{position:absolute;left:62%;top:44%;width:180px;height:180px;border-radius:50%;background:radial-gradient(#fff3c4,#ffd27a 60%,#ffb36b00 72%)}
  .h{position:absolute;left:0;right:0;bottom:0}
  .h1{height:52%;background:#7a4f86;clip-path:polygon(0 40%,12% 22%,26% 38%,40% 15%,55% 34%,70% 12%,84% 30%,100% 18%,100% 100%,0 100%)}
  .h2{height:40%;background:#4d3567;clip-path:polygon(0 30%,15% 48%,30% 20%,46% 42%,60% 24%,76% 46%,90% 28%,100% 40%,100% 100%,0 100%)}
  .h3{height:26%;background:#24193a;clip-path:polygon(0 45%,18% 20%,34% 50%,52% 25%,68% 52%,85% 22%,100% 46%,100% 100%,0 100%)}
</style><div class="sun"></div><div class="h h1"></div><div class="h h2"></div><div class="h h3"></div>`;
