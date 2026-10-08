import {
  T, ctxBand, WEATHER_ICON_SIZE, weatherSvg, SPARK, SPARK_COLORS,
  SEP, TEXT_CELLS, TERM_TONES, TERM_TRACK, TERM_MARGIN, ink, TINTS,
  ICON_SIZE, SMALL_ICON, ICONS, ICON_COLORS, LIMIT_ICONS, RESERVED_COLUMNS, iconSvg,
} from "./constants.mjs";
import { short } from "./formatting.mjs";
import { contextData, turnDeltas, chartText, barsWidth, barsSvg, trendWord } from "./context.mjs";
import { limitData, gaugeOf } from "./limits.mjs";
import { cacheState, cacheText, cacheDetails } from "./cache.mjs";

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
  // The same character bar in the terminal and the app; only a terminal too narrow drops it.
  if (mode === "text" || mode === "svg") parts.push(textGauge(Box, Text, g));
  // The bar says how much is used, so the percentage is only drawn where there is no bar.
  if (mode === "nobar" || mode === "none") {
    parts.push(Text(g.tone === "alert" ? { key: "v", bold: true, color: ink("alert", mode), children: g.value } : { key: "v", bold: true, children: g.value }));
  }
  // Against the clock: ▲ points ahead in amber or red, ▼ points behind in green; on pace, no mark.
  if (g.mark) parts.push(Text({ key: "u", bold: true, color: ink(g.tone, mode), children: g.mark }));
  // Terminal too narrow: the detail goes with the bar, leaving the label and the percentage.
  if (g.when && mode === "svg") {
    parts.push(divider(Text, "s"), icon(Svg, "i", "clock", color, T.icons.reset, SMALL_ICON), Text({ key: "d", dimColor: true, children: g.when }));
  }
  else if (g.when && (mode === "text" || mode === "nobar")) parts.push(Text({ key: "d", dimColor: true, children: `· ${g.when}` }));
  // The 5-hour reset time goes to the hover card.
  return { key: "gauge-" + g.label, tint: TINTS[g.kind] ?? TINTS.spend_limit, parts, tip: g.resetAt ? T.resetsAt(g.resetAt) : "" };
}

function cacheBlock({ Text, Svg }, mode, state, compact = false) {
  const parts = [];
  if (mode === "svg") {
    const color = ICON_COLORS[state.tone] ?? ICON_COLORS.calm;
    parts.push(icon(Svg, "i", "bolt", color, T.icons.cache));
  }
  // In the app the bolt says "cache"; the terminal keeps the word.
  if (mode !== "svg") parts.push(Text({ key: "l", children: T.cache }));
  // A miss or a short time left in yellow, an expired cache in red: the value is colored, bold.
  const valueColor = state.tone === "alert" || state.tone === "fast" ? ink(state.tone, mode) : undefined;
  parts.push(Text(state.tone === "none" ? { key: "v", dimColor: true, children: state.value } : { key: "v", bold: true, ...(valueColor ? { color: valueColor } : {}), children: state.value }));
  // After the value: the urgent detail in yellow, then the rest dim (the stake, and in the
  // terminal the advice the app keeps for the tooltip).
  if (mode !== "none") {
    const lead = state.urgent ? state.detail : "";
    const rest = cacheDetails(state, compact, state.urgent ? "" : state.detail, mode !== "svg" ? state.advice : "");
    if (mode === "svg" && (lead || rest)) parts.push(divider(Text, "s"));
    if (lead) parts.push(Text({ key: "d", bold: true, color: ink("fast", mode), children: mode === "svg" ? lead : `· ${lead}` }));
    if (rest) parts.push(Text({ key: "e", dimColor: true, children: mode === "svg" && !lead ? rest : `· ${rest}` }));
  }
  const tint = TINTS[state.tone] ?? TINTS.calm;
  // Hover the pill for the expiry time, the share read and the advice.
  return { key: "cache", tint, parts, tip: state.tip ?? "" };
}

// ---------- Limits: gauges ----------

// Character bar of full blocks, the same in the terminal and the app: solid █ up to the share used; the gap with elapsed time shaded (▓ in the bar's color when ahead of time, ▒ grey as margin), ░ for the empty track. The pace cell, the last one the clock reaches, is underlined: it marks where the clock says you should be.
function textGauge(Box, Text, g) {
  const used = Math.round((g.used / 100) * TEXT_CELLS);
  const time = g.elapsed === null ? used : Math.round((g.elapsed / 100) * TEXT_CELLS);
  const pace = g.elapsed === null || time <= 0 ? -1 : Math.min(time, TEXT_CELLS) - 1;
  const color = TERM_TONES[g.tone];
  const cell = (i) => {
    const key = "c" + i;
    const mark = i === pace ? { underline: true } : {};
    if (i < Math.min(used, time)) return Text({ key, color, children: "█", ...mark });
    if (i < used) return Text({ key, color, children: "▓", ...mark });
    if (i < time) return Text({ key, color: TERM_MARGIN, children: "▒", ...mark });
    return Text({ key, color: TERM_TRACK, children: "░", ...mark });
  };
  // Cells side by side, without the block's spacing between them.
  return Box({ key: "bar", flexDirection: "row", children: Array.from({ length: TEXT_CELLS }, (_, i) => cell(i)) });
}

// A rule between terminal blocks; the info line uses the same spacing with its own glyph.
export function separator(Box, Text, key, glyph = SEP) {
  return Box({ key, paddingX: 1, children: [Text({ dimColor: true, children: glyph })] });
}

// ---------- Line ----------

export function drawLine(elements, surface, columns, now, agents) {
  const { Box, Text, Svg } = elements;
  const desktop = surface === "desktop" && !!Svg;
  // A window that already reset has no valid reading: hidden until the next one.
  const gauges = limitData.reading.list.filter((limit) => !(Date.parse(limit.resetsAt ?? "") <= now)).map((limit) => gaugeOf(limit, now));
  const cacheNow = cacheState(now);
  // Block-character bars in the app. In the terminal the line gives up detail in steps until it fits:
  // the cache's lifetime (compact), then the bars (nobar: the reset times stay),
  // then the reset times too (none).
  let mode = "svg";
  let compact = false;
  if (!desktop) {
    const step = [0, 1, 2].find((level) => textWidth(gauges, cacheNow, level) <= columns - RESERVED_COLUMNS) ?? 3;
    mode = ["text", "text", "nobar", "none"][step];
    compact = step >= 1;
  }

  const blocks = [];
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
    blocks.push({ key: "context", tint: TINTS.context, parts, tip: title });
  }
  for (const g of gauges) blocks.push(gaugeBlock(elements, mode, g));
  if (cacheNow) blocks.push(cacheBlock(elements, mode, cacheNow, compact));
  // Agents last, shown only while some run: the blocks before them stay in place. The terminal's
  // info line already lists them by model, so the pill is the desktop's alone.
  if (desktop && agents.length > 0) {
    const parts = [];
    parts.push(icon(Svg, "i", "agents", ICON_COLORS.agents, T.icons.agents));
    parts.push(Text({ key: "v", bold: true, children: T.agents(agents.length) }));
    // The hover card lists what each one is doing.
    blocks.push({ key: "agents", tint: TINTS.agents, parts, tip: agents.map((a) => `${a.type} · ${a.description}`).join("\n") });
  }

  const row = (b) => ({ key: b.key, flexDirection: "row", columnGap: 1, alignItems: "center", children: b.parts });
  if (desktop) {
    // Pills: tinted, outlined, side by side. The app rounds a Box only through its border, and
    // a border brings a padding that made the band taller than the prompt box: paddingY, set
    // after it, takes the vertical part back.
    // A pill never shrinks: squeezed, the app broke "24 %" over two lines.
    // A keyed pill is a hover scope: its card shows while the pointer is over it.
    const pills = blocks.map((b) =>
      Box({
        ...row(b),
        children: b.tip ? [...b.parts, hoverCard(Box, Text, b.tip)] : b.parts,
        flexShrink: 0,
        paddingX: 1,
        paddingY: 0,
        borderStyle: "round",
        borderColor: b.tint[1],
        backgroundColor: b.tint[0],
      }),
    );
    // Two rows: what the session is doing (context, cache, agents) above the limits.
    const rowOf = (key, list) => (list.length ? Box({ key, flexDirection: "row", alignItems: "center", columnGap: 1, children: list }) : null);
    const status = rowOf("row-status", pills.filter((_, i) => !blocks[i].key.startsWith("gauge-")));
    const limits = rowOf("row-limits", pills.filter((_, i) => blocks[i].key.startsWith("gauge-")));
    const rows = [status, limits].filter(Boolean);
    return rows.length === 1 ? Box({ flexDirection: "row", paddingX: 1, children: rows }) : Box({ flexDirection: "column", rowGap: 1, paddingX: 1, children: rows });
  }
  const children = [];
  blocks.forEach((b, i) => {
    if (i > 0) children.push(separator(Box, Text, "sep-" + i));
    children.push(Box(row(b)));
  });
  return Box({ flexDirection: "row", alignItems: "center", paddingX: 1, children });
}

// Width of the terminal line in characters, with the bars and details. A new field on the line has to be counted here.
// `level`: 0 everything, 1 a compact cache, 2 also no bars, (3: no reset times either, never measured).
function textWidth(gauges, cacheNow, level = 0) {
  let width = 0;
  let blocks = 0;
  if (contextData.readings.length > 0) {
    const cur = contextData.readings[contextData.readings.length - 1];
    width += 2 + short(cur.tokens).length;
    if (contextData.readings.length >= 2) width += 1 + turnDeltas().length + 1 + trendWord().length;
    blocks++;
  }
  for (const g of gauges) width += g.label.length + 1 + (level < 2 ? TEXT_CELLS + 1 : g.value.length + 1) + (g.mark ? 1 + g.mark.length : 0) + (g.when ? 3 + g.when.length : 0);
  blocks += gauges.length;
  if (cacheNow) {
    width += cacheText(cacheNow, level >= 1).length;
    blocks++;
  }
  return width + 3 * Math.max(0, blocks - 1) + 2;
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
