#!/usr/bin/env node
// Renders the PNG icons in public/icons/ from the SVG sources next to them.
// Edit public/icons/icon.svg (app icon) and badge.svg (notification badge), then run:
//
//   npm i --no-save @resvg/resvg-js@2.6.2 && npm run icons
//
// The renderer is not a regular dependency, so normal installs and deploys stay small.
import { readFileSync, writeFileSync } from "node:fs";

let Resvg;
try {
  ({ Resvg } = await import("@resvg/resvg-js"));
} catch {
  console.error("Missing renderer. Run: npm i --no-save @resvg/resvg-js@2.6.2 && npm run icons");
  process.exit(1);
}

const dir = new URL("../public/icons/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const render = (svg, size, name) => {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(new URL(name, dir), png);
  console.log(`public/icons/${name} (${size}x${size})`);
};

const icon = read("icon.svg");
render(icon, 192, "icon-192.png");
render(icon, 512, "icon-512.png");
render(icon, 512, "icon-maskable-512.png"); // the runner sits inside the 80% safe zone
render(icon, 180, "apple-touch-icon.png");
render(read("badge.svg"), 96, "badge-96.png");
