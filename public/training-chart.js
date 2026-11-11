// <training-chart>: the one chart component. The server renders it with its data in an attribute;
// this file draws it with uPlot (public/vendor). Colours come from the CSS tokens in app.css.
//
// type="bars": one bar per label.
//   data='{"labels":["Z1","Z2",...],"series":[{"label":"Time","unit":"h","color":"accent","values":[...]}]}'
//
// type="stack": one small chart per series, stacked, sharing the time axis and the cursor.
//   data='{"series":[{"label":"Power","unit":"W","color":"power","average":"212 W","x":[0,15,...],
//                     "values":[...],"stepped":true,"pace":false}]}'
//   `x` is seconds from the start. `stepped`: each value holds flat until the next x (AISC segments),
//   instead of a line between points. `null` values break the line (pauses). `pace`: values are seconds
//   per km, formatted as m:ss with faster at the top.
//
// `color` names a CSS custom property (accent, hr, power, speed). The element's text content is the
// accessible summary.

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

const BAR_HEIGHT = 220;
const ROW_HEIGHT = 110;
let instances = 0;

class TrainingChart extends HTMLElement {
  connectedCallback() {
    if (this.started) return;
    this.started = true;
    try {
      this.spec = JSON.parse(this.getAttribute("data") || "{}");
    } catch {
      return; // keep the text fallback
    }
    this.syncKey = `training-chart-${++instances}`;
    this.fallback = this.querySelector(".chart-fallback");
    this.render();

    this.resizeObserver = new ResizeObserver(() => {
      for (const plot of this.plots ?? []) plot.setSize({ width: this.plotWidth(), height: plot.height });
    });
    this.resizeObserver.observe(this);
    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.onTheme = () => this.render();
    this.themeQuery.addEventListener("change", this.onTheme);
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.themeQuery?.removeEventListener("change", this.onTheme);
    for (const plot of this.plots ?? []) plot.destroy();
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

    for (const plot of this.plots ?? []) plot.destroy();
    this.plots = [];
    this.replaceChildren();
    if (this.fallback) {
      this.fallback.classList.add("visually-hidden"); // still read by screen readers
      this.append(this.fallback);
    }

    if (this.getAttribute("type") === "bars") {
      const target = document.createElement("div");
      this.append(target);
      const s = series[0];
      const data = [s.values.map((_, i) => i), s.values];
      this.plots.push(new uPlot({ ...this.barOptions(uPlot, s), width: this.plotWidth(), height: BAR_HEIGHT }, data, target));
      return;
    }

    // Stacked charts share one time range, so their time axes line up.
    const xs = series.flatMap((s) => [s.x[0], s.x[s.x.length - 1]]);
    const range = [Math.min(...xs), Math.max(...xs)];
    series.forEach((s, i) => {
      const last = i === series.length - 1;
      const row = document.createElement("div");
      row.className = "chart-row";
      const head = document.createElement("div");
      head.className = "chart-row-head";
      const label = document.createElement("span");
      label.textContent = s.label;
      const value = document.createElement("span");
      value.className = "num";
      const idle = s.average ? `avg ${s.average}` : "";
      value.textContent = idle;
      head.append(label, value);
      const target = document.createElement("div");
      row.append(head, target);
      this.append(row);

      const options = this.rowOptions(uPlot, s, range, last, (v) => {
        value.textContent = v == null ? idle : this.format(v, s);
      });
      this.plots.push(new uPlot({ ...options, width: this.plotWidth(), height: ROW_HEIGHT + (last ? 28 : 0) }, [s.x, s.values], target));
    });
  }

  format(value, s) {
    if (s.pace) return `${clock(value)} /km`;
    return `${Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value)} ${s.unit}`;
  }

  axisStyle() {
    return {
      stroke: this.token("muted"),
      grid: { stroke: this.token("line"), width: 1 },
      ticks: { stroke: this.token("line"), width: 1 },
      font: `11px ${this.token("font-data")}`,
    };
  }

  rowOptions(uPlot, s, range, showTimeAxis, onValue) {
    const color = this.token(s.color || "accent");
    const axis = this.axisStyle();
    return {
      // Same right padding on every row, so the stacked plots line up (the time axis needs room for its last label).
      padding: [6, 14, showTimeAxis ? 0 : 4, 0],
      legend: { show: false },
      cursor: {
        sync: { key: this.syncKey },
        drag: { x: false, y: false },
        points: { size: 6, fill: color },
      },
      scales: {
        x: { time: false, range: () => range },
        // Pace: faster (fewer seconds per km) at the top.
        y: s.pace ? { dir: -1 } : {},
      },
      axes: [
        showTimeAxis ? { ...axis, grid: { show: false }, values: (_, ticks) => ticks.map(elapsedLabel) } : { show: false },
        { ...axis, size: 44, ticks: { show: false }, values: (_, ticks) => ticks.map((v) => (s.pace ? clock(v) : fmtTick(v))) },
      ],
      series: [
        {},
        {
          stroke: color,
          width: 1.5,
          fill: withAlpha(color, 0.1),
          spanGaps: false,
          points: { show: false },
          ...(s.stepped ? { paths: uPlot.paths.stepped({ align: 1 }) } : {}),
        },
      ],
      hooks: {
        setCursor: [(u) => onValue(u.cursor.idx == null ? null : u.data[1][u.cursor.idx])],
      },
    };
  }

  barOptions(uPlot, s) {
    const color = this.token(s.color || "accent");
    const labels = this.spec.labels || [];
    const axis = this.axisStyle();
    return {
      legend: { show: false },
      cursor: { points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: (_, min, max) => [min - 0.6, max + 0.6] }, y: { range: (_, __, max) => [0, Math.max(1, max * 1.15)] } },
      axes: [
        { ...axis, grid: { show: false }, values: (_, ticks) => ticks.map((t) => (Number.isInteger(t) ? labels[t] ?? "" : "")) },
        { ...axis, size: 48, values: (_, ticks) => ticks.map((v) => `${fmtTick(v)}${s.unit === "h" ? "h" : ""}`) },
      ],
      series: [
        {},
        {
          label: s.label,
          fill: color,
          stroke: color,
          paths: uPlot.paths.bars({ size: [0.62, 48], radius: 0.15 }),
          points: { show: false },
        },
      ],
    };
  }
}

/** Seconds as h:mm:ss or m:ss. */
function clock(seconds) {
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Elapsed time on the x axis: "45m", "1:30". */
function elapsedLabel(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`;
}

function fmtTick(v) {
  return Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(1) : String(Math.round(v));
}

/** A hex colour with transparency (canvas doesn't reliably understand color-mix()). */
function withAlpha(hex, alpha) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const full = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return `#${full}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

customElements.define("training-chart", TrainingChart);
