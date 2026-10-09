// Adapted from hud (Apache-2.0), built on Token Weather Usage; see NOTICE and LICENSE-APACHE.
import {
  T, ctxBand, WEATHER_ICON_SIZE, weatherSvg, SPARK, SPARK_COLORS,
  SEP, TEXT_CELLS, BAR_CELLS, PACE_TICK, RAIL, TERM_TRACK, TERM_PACE, ink, TINTS,
  ICON_SIZE, SMALL_ICON, ICONS, ICON_COLORS, LIMIT_ICONS, RESERVED_COLUMNS, iconSvg,
} from "./constants";
import { short } from "./formatting";
import { contextData, turnDeltas, chartText, barsWidth, barsSvg, trendWord } from "./context";
import { limitData, gaugeOf, USED_ALERT } from "./limits";
import { cacheState, cacheText, cacheDetails } from "./cache";

// Hover cards: the app shows no SVG <title> tooltip, so each pill carries a card of its own,
// hidden until the pointer is over the pill, drawn above the band, in the app theme's own
// background and outline colors (tested in the app against a fixed dark card: this one reads better).
const CARD = { back: "background", line: "subtle" };
function hoverCard(Box, Text, tip) {
  const lines = String(tip).split("\n");
  // No key: a keyed Box would scope its own hover, and a hidden one is never hovered.
  return Box({
    position: "absolute",
    bottom: 1,
    left: 0,
    display: "none",
    hover: { display: "flex" },
    flexDirection: "column",
    paddingX: 1,
    paddingY: 0,
    borderStyle: "round",
    borderColor: CARD.line,
    backgroundColor: CARD.back,
    children: lines.map((line, i) => Text({ key: "t" + i, children: line })),
  });
}

// ---------- Blocks ----------

function icon(Svg, key, name, color, alt, size = ICON_SIZE) {
  const source = iconSvg(ICONS[name](color), size);
  return Svg({ key, source, alt, width: size, height: size });
}

function divider(Text, key) {
  return Text({ key, dimColor: true, children: SEP });
}

function gaugeBlock({ Box, Text, Svg }, mode, g) {
  // The bar carries the color; the text stays in the theme's color, readable everywhere.
  const color = ICON_COLORS[g.kind] ?? ICON_COLORS.spend_limit;
  const parts = [];
  if (mode === "svg") parts.push(icon(Svg, "k", LIMIT_ICONS[g.kind] ?? "coin", color, T.icons[g.kind] ?? g.label));
  parts.push(Text({ key: "l", children: g.label }));
  // A drawn rail in the app, a character bar in the terminal; only a terminal too narrow drops it.
  if (mode === "svg") parts.push(railGauge(Svg, g));
  else if (mode === "text") parts.push(textGauge(Box, Text, g));
  parts.push(Text(g.tone === "alert" ? { key: "v", bold: true, color: ink("alert", mode), children: g.value } : { key: "v", bold: true, children: g.value }));
  // Against the clock: ▲ points ahead in amber or red, ▼ points behind in green; on pace, no mark.
  if (g.mark) parts.push(Text({ key: "u", bold: true, color: ink(g.tone, mode), children: g.mark }));
  // Terminal too narrow: the time left goes last.
  if (g.when && mode === "svg") {
    parts.push(divider(Text, "s"), icon(Svg, "i", "clock", color, T.icons.reset, SMALL_ICON), Text({ key: "d", dimColor: true, children: g.when }));
  }
  else if (g.when && (mode === "text" || mode === "nobar")) parts.push(Text({ key: "d", dimColor: true, children: `· ${g.when}` }));
  // The reset time, and when the window would run out at this pace, go to the hover card.
  return { key: "gauge-" + g.label, tint: TINTS[g.kind] ?? TINTS.spend_limit, parts, tip: g.tip };
}

// The time left before the cache lapses: "cache 52m" in the terminal, a bolt and "52m" in the app.
function cacheTimeBlock({ Text, Svg }, mode, time, compact = false) {
  const parts = [];
  if (mode === "svg") parts.push(icon(Svg, "i", "bolt", ICON_COLORS[time.tone] ?? ICON_COLORS.calm, T.icons.cache));
  else parts.push(Text({ key: "l", children: T.cache }));
  // Short time left in yellow, an expired cache in red: the value is colored, bold.
  const valueColor = time.tone === "alert" || time.tone === "fast" ? ink(time.tone, mode) : undefined;
  parts.push(Text(time.tone === "none" ? { key: "v", dimColor: true, children: time.value } : { key: "v", bold: true, ...(valueColor ? { color: valueColor } : {}), children: time.value }));
  // After the value: the urgent detail in yellow, then the rest dim (the stake, and in the
  // terminal the advice the app keeps for the hover card).
  if (mode !== "none") {
    const lead = time.urgent ? time.detail : "";
    const rest = cacheDetails(time, compact, time.urgent ? "" : time.detail, mode !== "svg" ? time.advice : "");
    if (mode === "svg" && (lead || rest)) parts.push(divider(Text, "s"));
    if (lead) parts.push(Text({ key: "d", bold: true, color: ink("fast", mode), children: mode === "svg" ? lead : `· ${lead}` }));
    if (rest) parts.push(Text({ key: "e", dimColor: true, children: mode === "svg" && !lead ? rest : `· ${rest}` }));
  }
  // Hover the pill for the expiry time and the advice.
  return { key: "cache", tint: TINTS[time.tone] ?? TINTS.calm, parts, tip: time.tip ?? "" };
}

// The share of the last message read from the cache: "hit 97%", yellow with its cause on a miss.
function cacheHitBlock({ Text }, mode, hit) {
  const parts = [Text({ key: "l", children: T.hit })];
  parts.push(Text({ key: "v", bold: true, ...(hit.tone === "fast" ? { color: ink("fast", mode) } : {}), children: hit.value }));
  if (hit.detail && mode === "svg") parts.push(divider(Text, "s"), Text({ key: "d", dimColor: true, children: hit.detail }));
  else if (hit.detail && mode !== "none") parts.push(Text({ key: "d", dimColor: true, children: `· ${hit.detail}` }));
  return { key: "hit", tint: TINTS[hit.tone] ?? TINTS.calm, parts, tip: hit.tip ?? "" };
}

// ---------- Limits: gauges ----------

// The bar's segments in percent of the window: used within the pace, used ahead of the clock
// (colored by the tone), and the slack between the share used and the clock. Without a clock,
// all of the use counts as within. From USED_ALERT on, the use itself turns red.
function segments(g) {
  const used = Math.min(g.used, 100);
  const clock = g.elapsed ?? used;
  const base = g.used >= USED_ALERT ? ICON_COLORS.alert : ICON_COLORS[g.kind] ?? ICON_COLORS.spend_limit;
  // A lead inside the pace start is not flagged: it keeps the base color.
  const over = g.tone === "calm" ? base : ICON_COLORS[g.tone];
  return { within: Math.min(used, clock), over: Math.max(0, used - clock), slack: Math.max(0, clock - used), base, overColor: over };
}

// The app's rail: a rounded track, the use drawn over the slack, and the clock as a thin mark.
function railGauge(Svg, g) {
  const { width: w, height: h } = RAIL;
  const s = segments(g);
  const x = (pct) => ((pct / 100) * w).toFixed(1);
  const bar = (pct, fill, opacity = 1) => (pct > 0 ? `<rect x="0" y="3" width="${x(pct)}" height="6" rx="3" fill="${fill}" fill-opacity="${opacity}"/>` : "");
  // Drawn back to front: the slack up to the clock, the overshoot up to the use, then the use within.
  const body = [
    `<rect x="0" y="3" width="${w}" height="6" rx="3" fill="${RAIL.track}"/>`,
    bar(s.within + s.slack, s.base, RAIL.slack),
    bar(s.within + s.over, s.overColor),
    bar(s.within, s.base),
    g.elapsed === null ? "" : `<rect x="${Math.min(w - 2, Math.max(0, Number(x(g.elapsed)) - 1)).toFixed(1)}" y="0" width="2" height="${h}" rx="1" fill="${RAIL.pace}"/>`,
  ].join("");
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return Svg({ key: "bar", source, alt: T.railAlt(Math.round(g.used), g.elapsed === null ? null : Math.round(g.elapsed)), width: w, height: h });
}

// The terminal's bar: ten cells, each standing for a tenth of the window, and │ where the clock
// stands, between the cells. Any use at all fills at least one cell.
function textGauge(Box, Text, g) {
  const s = segments(g);
  const cells = (pct) => Math.round((pct / 100) * TEXT_CELLS);
  const used = g.used > 0 ? Math.max(1, cells(Math.min(g.used, 100))) : 0;
  const clock = g.elapsed === null ? used : cells(g.elapsed);
  const list = [];
  for (let i = 0; i < TEXT_CELLS; i++) {
    let cell;
    if (i < Math.min(used, clock)) cell = { color: s.base, children: BAR_CELLS.used };
    else if (i < used) cell = { color: s.overColor, children: BAR_CELLS.over };
    else if (i < clock) cell = { color: s.base, dimColor: true, children: BAR_CELLS.slack };
    else cell = { color: TERM_TRACK, children: BAR_CELLS.rest };
    list.push(Text({ key: "c" + i, ...cell }));
  }
  if (g.elapsed !== null) list.splice(clock, 0, Text({ key: "pace", color: TERM_PACE, children: PACE_TICK }));
  // Cells side by side, without the block's spacing between them.
  return Box({ key: "bar", flexDirection: "row", children: list });
}

// The boundary between cells where the clock stands, -1 without a clock.
function paceTick(g) {
  return g.elapsed === null ? -1 : Math.round((g.elapsed / 100) * TEXT_CELLS);
}

// A desktop pill: tinted, outlined, its parts side by side. The app rounds a Box only through its
// border, and a border brings a padding that made the band taller than the prompt box: paddingY,
// set after it, takes the vertical part back. A pill never shrinks: squeezed, the app broke "24 %"
// over two lines. A keyed pill is a hover scope: its card shows while the pointer is over it.
export function pill({ Box, Text }, b) {
  return Box({
    key: b.key,
    flexDirection: "row",
    columnGap: 1,
    alignItems: "center",
    children: b.tip ? [...b.parts, hoverCard(Box, Text, b.tip)] : b.parts,
    flexShrink: 0,
    paddingX: 1,
    paddingY: 0,
    borderStyle: "round",
    borderColor: b.tint[1],
    backgroundColor: b.tint[0],
  });
}

// A rule between terminal blocks; the info line uses the same spacing.
export function separator(Box, Text, key, glyph = SEP) {
  return Box({ key, paddingX: 1, children: [Text({ dimColor: true, children: glyph })] });
}

// ---------- Rows ----------

// The second and third rows of the band, in the same order on both surfaces:
//   context | cache time | cache hit
//   5h bar 22% ▼65 · 40m | 7d bar 29% ▲4 · 5d 6h
// In the terminal they are blocks split by a rule; in the app, pills.
export function drawLine(elements: any, surface: string, columns: number, now: number) {
  const { Box, Text, Svg } = elements;
  const desktop = surface === "desktop" && !!Svg;
  // A window that already reset has no valid reading: hidden until the next one.
  const gauges = limitData.reading.list.filter((limit) => !(Date.parse(limit.resetsAt ?? "") <= now)).map((limit) => gaugeOf(limit, now));
  const cacheNow = cacheState(now);
  // Icons and the full detail in the app. In the terminal each row gives up detail in steps until it
  // fits: the cache's lifetime (compact) on the status row; the bars, then the times left (none)
  // on the limits row.
  let mode = "svg";
  let limitsMode = "svg";
  let compact = false;
  if (!desktop) {
    const room = columns - RESERVED_COLUMNS;
    mode = "text";
    compact = statusWidth(cacheNow, false) > room;
    limitsMode = ["text", "nobar"].find((m) => limitsWidth(gauges, m) <= room) ?? "none";
  }

  const status = [];
  if (contextData.readings.length > 0) {
    const cur = contextData.readings[contextData.readings.length - 1];
    // The weather icon (glyph and color follow the share of the window), the tokens, and from the
    // second turn the bars of the recent prompts with the last one's change.
    const f = ctxBand(Math.round(cur.percent));
    const title = T.contextAlt(T.weather[f.id], T.percent(Math.round(cur.percent)), short(cur.window));
    const lead = desktop
      ? Svg({ key: "icon", source: weatherSvg(f), alt: title, width: WEATHER_ICON_SIZE, height: WEATHER_ICON_SIZE })
      : Text({ key: "icon", color: f.term, bold: true, children: f.icon });
    const parts = [lead, Text({ key: "tokens", bold: true, children: short(cur.tokens) })];
    // A single reading draws no trend: the bars wait for the second turn.
    if (contextData.readings.length >= 2) {
      if (desktop) {
        parts.push(divider(Text, "s"));
        parts.push(Svg({ key: "spark", source: barsSvg(SPARK_COLORS[f.term] ?? SPARK_COLORS.blue), alt: T.turnsAlt(turnDeltas().length), width: barsWidth(turnDeltas().length), height: SPARK.height }));
      } else {
        parts.push(Box({ key: "spark", flexDirection: "row", children: chartText(Text, f.term) }));
      }
      const trend = trendWord();
      if (trend) parts.push(Text({ key: "d", dimColor: true, children: trend }));
    }
    status.push({ key: "context", tint: TINTS.context, parts, tip: title });
  }
  if (cacheNow) {
    status.push(cacheTimeBlock(elements, mode, cacheNow.time, compact));
    if (cacheNow.hit) status.push(cacheHitBlock(elements, mode, cacheNow.hit));
  }
  const limits = gauges.map((g) => gaugeBlock(elements, desktop ? "svg" : limitsMode, g));

  const row = (b) => ({ key: b.key, flexDirection: "row", columnGap: 1, alignItems: "center", children: b.parts });
  let draw;
  if (desktop) {
    // Pills side by side.
    draw = (list) => list.map((b) => pill(elements, b));
  } else {
    draw = (list) => list.flatMap((b, i) => (i > 0 ? [separator(Box, Text, "sep-" + i), Box(row(b))] : [Box(row(b))]));
  }
  const rowOf = (key, list) => (list.length ? Box({ key, flexDirection: "row", alignItems: "center", ...(desktop ? { columnGap: 1 } : {}), children: draw(list) }) : null);
  const rows = [rowOf("row-status", status), rowOf("row-limits", limits)].filter(Boolean);
  if (rows.length === 1) return Box({ flexDirection: "row", paddingX: 1, children: rows });
  return Box({ flexDirection: "column", ...(desktop ? { rowGap: 1 } : {}), paddingX: 1, children: rows });
}

// Widths of the terminal rows in characters. A new field on a row has to be counted here.
function statusWidth(cacheNow, compact) {
  const blocks = [];
  if (contextData.readings.length > 0) {
    const cur = contextData.readings[contextData.readings.length - 1];
    blocks.push(2 + short(cur.tokens).length + (contextData.readings.length >= 2 ? 1 + turnDeltas().length + 1 + trendWord().length : 0));
  }
  // The cache text already holds its own rule between the time and the hit.
  if (cacheNow) blocks.push(cacheText(cacheNow, compact).length);
  return blocks.reduce((n, w) => n + w, 0) + 3 * Math.max(0, blocks.length - 1) + 2;
}

function limitsWidth(gauges, mode) {
  const blocks = gauges.map((g) =>
    g.label.length + (mode === "text" ? 1 + TEXT_CELLS + (paceTick(g) >= 0 ? 1 : 0) : 0) + 1 + g.value.length + (g.mark ? 1 + g.mark.length : 0) + (g.when && mode !== "none" ? 3 + g.when.length : 0),
  );
  return blocks.reduce((n, w) => n + w, 0) + 3 * Math.max(0, blocks.length - 1) + 2;
}

// True for a tree with nothing to show: nothing, empty text, or nested empty boxes and texts.
export function isBlank(node) {
  if (node == null || node === false || node === "") return true;
  if (Array.isArray(node)) return node.every(isBlank);
  if (typeof node === "string") return node.trim() === "";
  // An element carries its children beside its props, not inside them.
  if (typeof node === "object" && (node.type === "Box" || node.type === "Text")) return isBlank(node.children ?? node.props?.children);
  return false;
}
