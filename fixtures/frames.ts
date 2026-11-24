/** Photos for the photo frames' e2e checks and screenshots (scripts/src/e2e.ts): original scenes drawn with CSS. */

const scene = (body: string, css: string) => `<!doctype html><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden}
  body{position:relative}
  .a{position:absolute}
  ${css}
</style>${body}`;

export const FRAME_ART: { name: string; html: string }[] = [
  {
    // Sea at sunset.
    name: 'beach.png',
    html: scene(
      '<div class="a sun"></div><div class="a sea"></div><div class="a sand"></div>',
      `body{background:linear-gradient(#f7b267 0%,#f4845f 45%,#f27059 60%)}
       .sun{left:38%;top:30%;width:24%;aspect-ratio:1;border-radius:50%;background:#fff1c1}
       .sea{left:0;right:0;top:52%;height:22%;background:linear-gradient(#5e81ac,#3b5b85)}
       .sand{left:0;right:0;bottom:0;height:28%;background:linear-gradient(#e9c891,#d4a76a);clip-path:polygon(0 25%,40% 8%,100% 30%,100% 100%,0 100%)}`,
    ),
  },
  {
    // A lake under mountains.
    name: 'lake.png',
    html: scene(
      '<div class="a m1"></div><div class="a m2"></div><div class="a lake"></div><div class="a shore"></div>',
      `body{background:linear-gradient(#a8d0e6 0%,#e3f1f8 60%)}
       .m1{left:0;right:0;top:22%;height:40%;background:#6c8ea4;clip-path:polygon(0 100%,22% 20%,38% 60%,58% 0,80% 55%,100% 25%,100% 100%)}
       .m2{left:0;right:0;top:40%;height:24%;background:#3f6476;clip-path:polygon(0 100%,15% 40%,35% 80%,55% 30%,75% 75%,100% 45%,100% 100%)}
       .lake{left:0;right:0;top:64%;height:22%;background:linear-gradient(#5a8aa0,#2f5a6e)}
       .shore{left:0;right:0;bottom:0;height:14%;background:#3d5a3a}`,
    ),
  },
  {
    // Pines on a green hill.
    name: 'forest.png',
    html: scene(
      '<div class="a hill"></div>' + [8, 24, 40, 56, 72].map((x, i) => `<div class="a tree" style="left:${x}%;bottom:${18 + (i % 2) * 6}%"></div>`).join(''),
      `body{background:linear-gradient(#cfe8d5 0%,#f2f7ee 70%)}
       .hill{left:0;right:0;bottom:0;height:38%;background:#6f9a5b;border-radius:60% 60% 0 0/30% 30% 0 0}
       .tree{width:20%;height:46%;background:#2f5d3a;clip-path:polygon(50% 0,90% 100%,10% 100%)}`,
    ),
  },
];
