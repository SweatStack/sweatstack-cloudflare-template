// <training-chart>: the one chart component. The server renders it with its data in an attribute;
// this file draws it with uPlot (public/vendor). Colours come from the CSS tokens in app.css.
//
//   <training-chart type="bars" data='{"labels":["1 Sep",...],"series":[{"label":"Training time","unit":"h","color":"accent","values":[...]}]}'>
//   <training-chart type="line" data='{"series":[{"label":"Heart rate","unit":"bpm","color":"hr","x":[0,15,...],"values":[...]}]}'>
//
// `color` names a CSS custom property (accent, hr, power, speed). For "line" with several series, the
// chart shows one at a time with buttons to switch. The element's text content is the accessible summary.

let uPlotModule;
function loadUPlot() {
  if (!uPlotModule) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/vendor/uplot.min.css";
    document.head.append(link);
    uPlotModule = import("/vendor/uplot.esm.js").then((m) => m.default);
  }
  return uPlotModule;
}

const HEIGHT = 220;

class TrainingChart extends HTMLElement {
  connectedCallback() {
    if (this.started) return;
    this.started = true;
    try {
      this.spec = JSON.parse(this.getAttribute("data") || "{}");
    } catch {
      return; // keep the text fallback
    }
    this.active = 0;
    this.fallback = this.querySelector(".chart-fallback");
    this.render();

    this.resizeObserver = new ResizeObserver(() => this.plot?.setSize({ width: this.plotWidth(), height: HEIGHT }));
    this.resizeObserver.observe(this);
    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.onTheme = () => this.render();
    this.themeQuery.addEventListener("change", this.onTheme);
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.themeQuery?.removeEventListener("change", this.onTheme);
    this.plot?.destroy();
  }

  plotWidth() {
    return Math.max(200, this.clientWidth);
  }

  token(name) {
    return getComputedStyle(this).getPropertyValue(`--${name}`).trim() || "#888";
  }

  async render() {
    const uPlot = await loadUPlot();
    const series = this.spec.series || [];
    if (series.length === 0) return;

    this.plot?.destroy();
    this.replaceChildren();
    if (this.fallback) {
      this.fallback.classList.add("visually-hidden"); // still read by screen readers
      this.append(this.fallback);
    }
    if (this.getAttribute("type") === "line" && series.length > 1) this.append(this.tabs(series));

    const target = document.createElement("div");
    this.append(target);
    const options = this.getAttribute("type") === "bars" ? this.barOptions(uPlot, series[0]) : this.lineOptions(series[this.active]);
    const data = this.getAttribute("type") === "bars" ? [series[0].values.map((_, i) => i), series[0].values] : [series[this.active].x, series[this.active].values];
    this.plot = new uPlot({ ...options, width: this.plotWidth(), height: HEIGHT }, data, target);
  }

  tabs(series) {
    const tabs = document.createElement("div");
    tabs.className = "chart-tabs";
    series.forEach((s, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = s.label;
      button.setAttribute("aria-pressed", String(i === this.active));
      button.addEventListener("click", () => {
        this.active = i;
        this.render();
      });
      tabs.append(button);
    });
    return tabs;
  }

  axes(xValues, unit) {
    const axis = {
      stroke: this.token("muted"),
      grid: { stroke: this.token("line"), width: 1 },
      ticks: { stroke: this.token("line"), width: 1 },
      font: `12px ${this.token("font-data")}`,
    };
    return [
      { ...axis, grid: { show: false }, values: xValues },
      { ...axis, size: 48, values: (_, ticks) => ticks.map((v) => `${v}${unit === "h" ? "h" : ""}`) },
    ];
  }

  barOptions(uPlot, s) {
    const color = this.token(s.color || "accent");
    const labels = this.spec.labels || [];
    return {
      legend: { show: false },
      cursor: { points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: (_, min, max) => [min - 0.6, max + 0.6] }, y: { range: (_, __, max) => [0, Math.max(1, max * 1.15)] } },
      axes: this.axes((_, ticks) => ticks.map((t) => (Number.isInteger(t) ? labels[t] ?? "" : "")), s.unit),
      series: [
        {},
        {
          label: s.label,
          fill: color,
          stroke: color,
          paths: uPlot.paths.bars({ size: [0.62, 48], radius: 0.15 }),
          points: { show: false },
          value: (_, v) => (v == null ? "–" : `${v} ${s.unit}`),
        },
      ],
    };
  }

  lineOptions(s) {
    const color = this.token(s.color || "accent");
    const clock = (t) => {
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      return h ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`;
    };
    return {
      legend: { show: true, live: true },
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: false } },
      axes: this.axes((_, ticks) => ticks.map(clock), s.unit),
      series: [
        { label: "Time", value: (_, v) => (v == null ? "–" : clock(v)) },
        {
          label: s.label,
          stroke: color,
          width: 2,
          fill: withAlpha(color, 0.12),
          points: { show: false },
          value: (_, v) => (v == null ? "–" : `${Math.round(v)} ${s.unit}`),
        },
      ],
    };
  }
}

/** A hex colour with transparency (canvas doesn't reliably understand color-mix()). */
function withAlpha(hex, alpha) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const full = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return `#${full}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

customElements.define("training-chart", TrainingChart);
