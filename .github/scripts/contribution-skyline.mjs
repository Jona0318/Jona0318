#!/usr/bin/env node
/**
 * Contribution Skyline → animated SVG for the profile README.
 *
 * A README can't run React or canvas, so this renders the same scene the
 * <ContributionSkyline> component draws — a year of contributions as a heat
 * map that swings into an isometric skyline — as a self-contained SVG with CSS
 * animation. The flat map tilts into the iso floor along the real camera path,
 * then each week's bars rise in a wave from the oldest week to the newest and
 * the stats settle into the empty corners. It plays once and holds on the
 * skyline; with prefers-reduced-motion it shows the skyline straight away.
 *
 * Usage:
 *   node contribution-skyline.mjs --user <login> --out <dir>
 *   node contribution-skyline.mjs --user <login> --commits --out <dir>   (commits only; needs SKYLINE_TOKEN)
 *   node contribution-skyline.mjs --demo --out <dir>      (seeded sample year, no network)
 *
 * Writes contribution-skyline.svg and contribution-skyline-dark.svg. Any
 * failure to fetch real data exits non-zero, so the workflow never publishes
 * a fake or empty chart over the last good one.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// #region contributions — ported from components/ui/contribution-skyline.tsx

const DAY_MS = 86400000

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0)
const lerp = (a, b, t) => a + (b - a) * t
const easeInOutCubic = (x) => {
  const t = clamp01(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

const toKey = (ms) => new Date(ms).toISOString().slice(0, 10)

const dayMs = (v) => {
  if (typeof v === "number") return Math.floor(v / DAY_MS) * DAY_MS
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
    v = new Date(v)
  }
  return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())
}

const rng = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const generateContributions = (endMs, seed = 7, days = 371) => {
  const r = rng(seed)
  const bursts = Array.from({ length: 4 }, () => ({ at: r(), width: 0.035 + r() * 0.07, gain: 0.6 + r() * 1.1 }))
  const out = []
  let mood = 0.5
  for (let i = 0; i < days; i++) {
    const ms = endMs - (days - 1 - i) * DAY_MS
    const x = i / Math.max(1, days - 1)
    const dow = new Date(ms).getUTCDay()
    const weekend = dow === 0 || dow === 6
    let heat = 0.2
    for (const b of bursts) heat += b.gain * Math.exp(-((x - b.at) ** 2) / (2 * b.width ** 2))
    mood = mood * 0.85 + r() * 0.15
    heat *= 0.55 + mood * 0.9
    const pActive = Math.min(0.94, (weekend ? 0.22 : 0.5) + heat * 0.4)
    let count = 0
    if (r() < pActive) count = 1 + Math.floor(-Math.log(1 - r()) * (1.2 + heat * 7) * (weekend ? 0.5 : 1))
    if (r() < 0.01) count += 18 + Math.floor(r() * 24)
    out.push({ date: toKey(ms), count })
  }
  return out
}

const levelOf = (count, busy) => (count <= 0 ? 0 : busy <= 0 ? 4 : 1 + Math.min(3, Math.floor((count / busy) * 4)))

const buildGrid = (data, endMs, weekStart = 0) => {
  const counts = new Map()
  for (const d of data) {
    if (!d || typeof d.date !== "string") continue
    const ms = dayMs(d.date)
    const c = Number(d.count)
    if (!Number.isFinite(ms) || !(c > 0) || !Number.isFinite(c)) continue
    const k = toKey(ms)
    counts.set(k, (counts.get(k) ?? 0) + c)
  }
  let start = endMs - 364 * DAY_MS
  start -= ((new Date(start).getUTCDay() - weekStart + 7) % 7) * DAY_MS
  const cells = []
  for (let ms = start, i = 0; ms <= endMs; ms += DAY_MS, i++) {
    const date = toKey(ms)
    cells.push({ date, count: counts.get(date) ?? 0, level: 0, week: Math.floor(i / 7), day: i % 7 })
  }
  const nz = cells.map((c) => c.count).filter((c) => c > 0).sort((a, b) => a - b)
  const busy = nz.length ? nz[Math.floor(0.95 * (nz.length - 1))] : 0
  for (const c of cells) c.level = levelOf(c.count, busy)
  return { cells, weeks: cells.length ? cells[cells.length - 1].week + 1 : 0, max: nz.length ? nz[nz.length - 1] : 0 }
}

const computeStats = (cells) => {
  let total = 0
  let best = 0
  let bestDate = null
  let run = 0
  let runStart = null
  let longest = { days: 0, start: null, end: null }
  for (const c of cells) {
    total += c.count
    if (c.count > best) {
      best = c.count
      bestDate = c.date
    }
    if (c.count > 0) {
      if (run === 0) runStart = c.date
      run++
      if (run > longest.days) longest = { days: run, start: runStart, end: c.date }
    } else run = 0
  }
  let j = cells.length - 1
  if (j >= 0 && cells[j].count === 0) j--
  const endAt = j
  while (j >= 0 && cells[j].count > 0) j--
  const days = endAt - j
  const current = days > 0 ? { days, start: cells[j + 1].date, end: cells[endAt].date } : { days: 0, start: null, end: null }
  return {
    total,
    first: cells.length ? cells[0].date : null,
    last: cells.length ? cells[cells.length - 1].date : null,
    busiest: { count: best, date: bestDate },
    longest,
    current,
  }
}

const monthLabels = (cells, weeks, locale = "en-US") => {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" })
  const out = []
  let prev = -1
  for (let w = 0; w < weeks; w++) {
    const c = cells[w * 7]
    if (!c) break
    const m = +c.date.slice(5, 7)
    if (m !== prev) out.push({ week: w, label: fmt.format(dayMs(c.date)) })
    prev = m
  }
  if (out.length > 1 && out[1].week - out[0].week < 3) out.shift()
  return out
}

const barHeight = (count, max, scale = 1) => (count > 0 && max > 0 ? 0.4 + Math.pow(count / max, 0.85) * 7.2 * scale : 0.2)

const WAVE = 0.42
const YAW_3D = Math.PI / 4
const ELEV_3D = (34 * Math.PI) / 180

const camera = (e) => {
  const yaw = lerp(0, YAW_3D, e)
  const elev = lerp(Math.PI / 2, ELEV_3D, e)
  return { cs: Math.cos(yaw), sn: Math.sin(yaw), se: Math.sin(elev), ce: Math.cos(elev) }
}

const project = (c, x, y, z) => [x * c.cs - y * c.sn, (x * c.sn + y * c.cs) * c.se - z * c.ce]

const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

const PALETTES = {
  github: { light: ["#c6e48b", "#7bc96f", "#239a3b", "#196127"], dark: ["#0e4429", "#006d32", "#26a641", "#39d353"] },
  halloween: { light: ["#ffee4a", "#ffc501", "#fe9600", "#b33c00"], dark: ["#631c03", "#bd561d", "#fa7a18", "#fddf68"] },
  ocean: { light: ["#b8e3f5", "#6ec3eb", "#2a8fd1", "#0b4f8a"], dark: ["#0c2d4a", "#12508a", "#2a88d8", "#7cc7ff"] },
  ember: { light: ["#fde2c4", "#fbad6e", "#f06b3a", "#b3261e"], dark: ["#4a1a10", "#8f2f16", "#e0572a", "#ffa46b"] },
  grape: { light: ["#e4d4fb", "#b794f4", "#805ad5", "#44337a"], dark: ["#2d1f4f", "#553c9a", "#8b5cf6", "#c4b5fd"] },
  mono: { light: ["#d4d4d4", "#a3a3a3", "#525252", "#171717"], dark: ["#333333", "#5c5c5c", "#a3a3a3", "#fafafa"] },
}
// #endregion

// GitHub's own profile colours, so the card sits flush on the page in either theme.
const THEMES = {
  light: { dark: false, bg: [255, 255, 255], fg: [31, 35, 40], border: "#d0d7de" },
  dark: { dark: true, bg: [13, 17, 23], fg: [230, 237, 243], border: "#30363d" },
}

const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (c) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")
const n1 = (v) => (Math.round(v * 10) / 10).toString()
const n2 = (v) => (Math.round(v * 100) / 100).toString()
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif`

// Timeline, seconds.
const T_SWING = 0.8 // flat map holds, then the camera swings
const D_SWING = 1.2
const T_RISE = T_SWING + D_SWING // bars start rising as the camera lands
const D_RISE = 1.3 // morph length of the wave, as `duration` in the component

export function renderSkyline(model, { theme: themeName = "light", palette = "github", unit = "contribution", locale = "en-US", updated } = {}) {
  const theme = THEMES[themeName]
  const { cells, weeks, max, stats, months } = model
  const n = cells.length
  const plural = unit + "s"
  const noun = (k) => (k === 1 ? unit : plural)
  const nf = new Intl.NumberFormat(locale)
  const df = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" })
  const dfy = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  const range = (a, b, withYear = false) => (!a || !b ? "—" : (withYear ? dfy : df).format(dayMs(a)) + " — " + (withYear ? dfy : df).format(dayMs(b)))

  // Colours: [empty, l1..l4], with the two shaded side faces of each.
  const pal = (PALETTES[palette] ?? PALETTES.github)[theme.dark ? "dark" : "light"].map(hexRGB)
  const levels = [mixRGB(theme.bg, theme.fg, theme.dark ? 0.11 : 0.075), ...pal]
  const muted = hex(mixRGB(theme.bg, theme.fg, 0.55))
  const fg = hex(theme.fg)
  const bg = hex(theme.bg)
  const accent = hex(levels[4])

  // Card layout.
  const W = 900
  const box = { x: 20, y: 56, w: W - 40 }
  const stage = { x: box.x + 16, y: box.y + 16, w: box.w - 32 }

  // 3D fit: the full-height skyline plus room for month labels along the front edge, as `relayout` does.
  const cam3 = camera(1)
  const w3 = 0.9
  const off3 = (1 - w3) / 2
  const hgt = cells.map((c) => barHeight(c.count, max))
  let minx = Infinity
  let maxx = -Infinity
  let miny = Infinity
  let maxy = -Infinity
  const add = (x, y, z) => {
    const p = project(cam3, x, y, z)
    minx = Math.min(minx, p[0])
    maxx = Math.max(maxx, p[0])
    miny = Math.min(miny, p[1])
    maxy = Math.max(maxy, p[1])
  }
  cells.forEach((c, i) => {
    const x0 = c.week + off3
    const y0 = c.day + off3
    add(x0, y0, hgt[i])
    add(x0 + w3, y0, hgt[i])
    add(x0, y0 + w3, hgt[i])
    add(x0 + w3, y0 + w3, 0)
    add(x0, y0 + w3, 0)
    add(x0 + w3, y0, 0)
  })
  add(0, 8.5, 0)
  add(weeks, 8.5, 0)
  const pad3 = 20
  const natural = ((maxy - miny) / (maxx - minx)) * (stage.w - 2 * pad3) + 2 * pad3
  stage.h = Math.round(Math.max(Math.min(natural, stage.w * 0.72, 620), Math.min(natural, 240)))
  const aw = stage.w - 2 * pad3
  const ah = stage.h - 2 * pad3
  const s3 = Math.min(aw / (maxx - minx), ah / (maxy - miny))
  const ox3 = stage.x + pad3 + (aw - (maxx - minx) * s3) / 2 - minx * s3
  const oy3 = stage.y + pad3 + (ah - (maxy - miny) * s3) / 2 - miny * s3
  const p3 = (x, y, z) => {
    const p = project(cam3, x, y, z)
    return [ox3 + p[0] * s3, oy3 + p[1] * s3]
  }

  // 2D fit: the flat heat map across the stage, weekday names in the gutter, centred vertically.
  const gutter = 30
  const s2 = (stage.w - gutter - 4) / weeks
  const ox2 = stage.x + gutter + 2
  const oy2 = stage.y + (stage.h - 7 * s2 + 20) / 2

  // The camera swing, sampled along the component's eased path. Height is invisible until the bars
  // rise, so the scene is just the ground plane and every frame is one affine matrix.
  const gx = weeks / 2
  const gy = 3.5
  const c2 = [ox2 + gx * s2, oy2 + gy * s2]
  const c3 = p3(gx, gy, 0)
  const STEPS = 16
  const frames = []
  for (let k = 0; k <= STEPS; k++) {
    const e = easeInOutCubic(k / STEPS)
    const { cs, sn, se } = camera(e)
    const s = lerp(s2, s3, e)
    const a = s * cs
    const b = s * sn * se
    const c = -s * sn
    const d = s * cs * se
    const cx = lerp(c2[0], c3[0], e)
    const cy = lerp(c2[1], c3[1], e)
    const m = [a, b, c, d, cx - (a * gx + c * gy), cy - (b * gx + d * gy)].map((v) => +v.toFixed(4))
    frames.push(`${n2((k / STEPS) * 100)}%{transform:matrix(${m.join(",")})}`)
  }
  const finalMatrix = frames[STEPS].replace(/^[^{]+\{transform:|\}$/g, "")

  // 2D layer: cells in grid units inside the swinging group.
  const w2 = 0.78
  const off2 = (1 - w2) / 2
  const flat = cells
    .map((c) => `<rect class="q${c.level}" x="${n2(c.week + off2)}" y="${n2(c.day + off2)}" width="${w2}" height="${w2}" rx="0.16"/>`)
    .join("")

  const wf = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
  const flatLabels = []
  let edge = -Infinity
  for (const m of months) {
    const x = ox2 + (m.week + off2) * s2
    if (x < edge || x + m.label.length * 6.5 > stage.x + stage.w) continue
    flatLabels.push(`<text x="${n1(x)}" y="${n1(oy2 - 6)}">${esc(m.label)}</text>`)
    edge = x + m.label.length * 6.5 + 6
  }
  for (let d = 0; d < 7 && d < n; d++) {
    const dow = new Date(dayMs(cells[d].date)).getUTCDay()
    if (dow === 1 || dow === 3 || dow === 5)
      flatLabels.push(`<text x="${n1(ox2 - 6)}" y="${n1(oy2 + (d + 0.5) * s2 + 4)}" text-anchor="end">${esc(wf.format(dayMs(cells[d].date)))}</text>`)
  }

  // 3D layer: painter's order, nearest last. Each bar is drawn at full height; its top face slides up
  // from the floor and its two side faces grow out of their (slanted) bottom edges.
  const order = cells.map((_, i) => i).sort((i, j) => cells[i].week + cells[i].day - (cells[j].week + cells[j].day) || i - j)
  const side = (a, b, hpx, cls) => {
    if (b[0] < a[0]) [a, b] = [b, a] // a rect can't have negative width; walk the edge left to right
    const dx = b[0] - a[0]
    const ang = (Math.atan2(b[1] - a[1], dx) * 180) / Math.PI
    return `<g transform="translate(${n1(a[0])} ${n1(a[1])}) skewY(${n2(ang)})"><rect class="s ${cls}" y="${n1(-hpx)}" width="${n1(dx)}" height="${n1(hpx)}"/></g>`
  }
  const rise = (1 - WAVE) * D_RISE
  const bars = order
    .map((i) => {
      const c = cells[i]
      const x0 = c.week + off3
      const y0 = c.day + off3
      const x1 = x0 + w3
      const y1 = y0 + w3
      const hpx = hgt[i] * cam3.ce * s3
      const top = [p3(x0, y0, hgt[i]), p3(x1, y0, hgt[i]), p3(x1, y1, hgt[i]), p3(x0, y1, hgt[i])]
      const delay = T_RISE + ((weeks > 1 ? c.week / (weeks - 1) : 0) * 0.36 + (c.day / 6) * 0.06) * D_RISE
      return (
        `<g class="l${c.level}" style="--d:${n2(delay)}s;--h:${n1(hpx)}px">` +
        side(p3(x0, y1, 0), p3(x1, y1, 0), hpx, "y") +
        side(p3(x1, y0, 0), p3(x1, y1, 0), hpx, "x") +
        `<polygon class="t" points="${top.map((p) => n1(p[0]) + "," + n1(p[1])).join(" ")}"/>` +
        `</g>`
      )
    })
    .join("")

  const skyLabels = []
  edge = -Infinity
  for (const m of months) {
    const [x, y] = p3(m.week + 0.5, 7.3, 0)
    if (x < edge || x + m.label.length * 6.5 > stage.x + stage.w) continue
    skyLabels.push(`<text x="${n1(x)}" y="${n1(y + 12)}">${esc(m.label)}</text>`)
    edge = x + m.label.length * 6.5 + 10
  }

  // Stats in the two corners the iso diamond leaves empty.
  const big = Math.round(Math.max(30, Math.min(56, stage.w * 0.058)))
  const blocks = [
    { label: "1 year total", value: nf.format(stats.total), unit: noun(stats.total), sub: range(stats.first, stats.last, true) },
    { label: "Busiest day", value: nf.format(stats.busiest.count), unit: noun(stats.busiest.count), sub: stats.busiest.date ? df.format(dayMs(stats.busiest.date)) : "—" },
    { label: "Longest streak", value: nf.format(stats.longest.days), unit: stats.longest.days === 1 ? "day" : "days", sub: range(stats.longest.start, stats.longest.end) },
    { label: "Current streak", value: nf.format(stats.current.days), unit: stats.current.days === 1 ? "day" : "days", sub: range(stats.current.start, stats.current.end) },
  ]
  const blockH = 16 + big + 20
  const stat = (b, x, y, anchor) =>
    `<g text-anchor="${anchor}">` +
    `<text x="${x}" y="${y + 13}" class="m" font-size="13">${esc(b.label)}</text>` +
    `<text x="${x}" y="${y + 14 + big * 0.86}" class="v" font-size="${big}">${esc(b.value)}</text>` +
    `<text x="${x}" y="${y + 16 + big + 14}" font-size="13"><tspan>${esc(b.unit)}</tspan><tspan class="m"> · ${esc(b.sub)}</tspan></text>` +
    `</g>`
  const right = stage.x + stage.w - 4
  const statsTR = stat(blocks[0], right, stage.y + 4, "end") + stat(blocks[1], right, stage.y + 4 + blockH + 16, "end")
  const bottom = stage.y + stage.h - 4
  const statsBL = stat(blocks[2], stage.x + 4, bottom - 2 * blockH - 16, "start") + stat(blocks[3], stage.x + 4, bottom - blockH, "start")

  // Footer: when it was drawn, and the legend.
  const fy = stage.y + stage.h + 30
  const boxH = fy + 14 - box.y
  const H = box.y + boxH + 20
  const legendRight = box.x + box.w - 16
  const swatchX0 = legendRight - 30 - 5 * 15
  const legend =
    `<text x="${swatchX0 - 6}" y="${fy}" text-anchor="end">Less</text>` +
    levels.map((c, i) => `<rect x="${swatchX0 + i * 15}" y="${fy - 10}" width="11" height="11" rx="2" fill="${hex(c)}"/>`).join("") +
    `<text x="${legendRight}" y="${fy}" text-anchor="end">More</text>`

  const css = [
    `text{font-family:${FONT};fill:${fg}}`,
    `.m,.lab text,.foot text{fill:${muted}}`,
    `.lab text,.foot text{font-size:11px}`,
    `.v{fill:${accent};font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}`,
    ...levels.map((c, i) => `.q${i}{fill:${hex(c)}}.l${i} .t{fill:${hex(c)}}.l${i} .y{fill:${hex(c.map((v) => v * 0.84))}}.l${i} .x{fill:${hex(c.map((v) => v * 0.68))}}`),
    `.flat rect{stroke:${fg};stroke-opacity:.07;stroke-width:1px;vector-effect:non-scaling-stroke}`,
    // Static styles are the final frame; every animation runs from its keyframe into them.
    `.g2{transform:${finalMatrix};animation:swing ${D_SWING}s linear ${T_SWING}s both}`,
    `@keyframes swing{${frames.join("")}}`,
    `.flat{opacity:0;animation:out .35s ease ${n2(T_RISE - 0.15)}s both}`,
    `.lab2{opacity:0;animation:out .45s ease ${T_SWING}s both}`,
    `.sky{animation:in .2s ease ${n2(T_RISE - 0.1)}s both}`,
    `.sky .t{animation:up ${n2(rise)}s cubic-bezier(.33,1,.68,1) var(--d) both}`,
    `.sky .s{transform-box:fill-box;transform-origin:50% 100%;animation:grow ${n2(rise)}s cubic-bezier(.33,1,.68,1) var(--d) both}`,
    `.lab3{animation:in .6s ease ${n2(T_RISE + D_RISE * 0.7)}s both}`,
    `.tr{animation:drop .6s cubic-bezier(.65,0,.35,1) ${n2(T_RISE + D_RISE * 0.55)}s both}`,
    `.bl{animation:lift .6s cubic-bezier(.65,0,.35,1) ${n2(T_RISE + D_RISE * 0.65)}s both}`,
    `@keyframes out{from{opacity:1}}`,
    `@keyframes in{from{opacity:0}}`,
    `@keyframes up{from{transform:translateY(var(--h))}}`,
    `@keyframes grow{from{transform:scaleY(0)}}`,
    `@keyframes drop{from{opacity:0;transform:translateY(-10px)}}`,
    `@keyframes lift{from{opacity:0;transform:translateY(10px)}}`,
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`,
  ].join("")

  const summary = `${nf.format(stats.total)} ${noun(stats.total)} between ${range(stats.first, stats.last, true)}, shown as a 3D skyline.`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t">` +
    `<title id="t">${esc(summary)}</title>` +
    `<style>${css}</style>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${bg}" stroke="${theme.border}"/>` +
    `<text x="24" y="36" font-size="15"><tspan font-weight="600">${nf.format(stats.total)}</tspan> ${noun(stats.total)} in the last year</text>` +
    `<rect x="${box.x + 0.5}" y="${box.y + 0.5}" width="${box.w - 1}" height="${boxH - 1}" rx="8" fill="none" stroke="${theme.border}"/>` +
    `<g class="flat"><g class="g2">${flat}</g></g>` +
    `<g class="lab lab2">${flatLabels.join("")}</g>` +
    `<g class="sky">${bars}</g>` +
    `<g class="lab lab3">${skyLabels.join("")}</g>` +
    `<g class="tr">${statsTR}</g>` +
    `<g class="bl">${statsBL}</g>` +
    `<g class="foot"><text x="${box.x + 16}" y="${fy}">${updated ? "Updated " + esc(dfy.format(dayMs(updated))) : ""}</text>${legend}</g>` +
    `</svg>`
  )
}

export function buildModel(data, locale = "en-US") {
  const dates = data.map((d) => dayMs(d.date)).filter(Number.isFinite)
  if (!dates.length) throw new Error("No contribution days to draw")
  const grid = buildGrid(data, Math.max(...dates))
  return { ...grid, stats: computeStats(grid.cells), months: monthLabels(grid.cells, grid.weeks, locale) }
}

/**
 * Reads the public contribution calendar — the exact graph the profile shows, private contributions
 * included when the profile opts in to showing them. The API only offers that to a token with access
 * to those private repos; this needs no token at all.
 *
 * It's HTML, not an API, so it is parsed strictly: every day cell must have a tooltip with a count that
 * agrees with the cell's level, and the days must form an unbroken run of about a year. Anything else
 * throws, so a markup change fails the job instead of publishing an empty or partial chart.
 */
export const parseCalendar = (html) => {
  const tips = new Map()
  for (const m of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) tips.set(m[1], m[2].trim())
  const days = []
  for (const m of html.matchAll(/<td\b[^>]*>/g)) {
    const td = m[0]
    const date = /\bdata-date="(\d{4}-\d{2}-\d{2})"/.exec(td)?.[1]
    if (!date) continue
    const id = /\bid="([^"]+)"/.exec(td)?.[1]
    const level = /\bdata-level="(\d)"/.exec(td)?.[1]
    const tip = id ? tips.get(id) : undefined
    if (level == null || tip == null) throw new Error(`Calendar cell ${date} has no level or tooltip; the markup has changed`)
    const n = /^No contributions\b/.test(tip) ? 0 : /^([\d,]+) contributions?\b/.exec(tip)?.[1]?.replace(/,/g, "")
    if (n == null) throw new Error(`Can't read a count from "${tip}" (${date}); the markup has changed`)
    const count = Number(n)
    if ((count > 0) !== (+level > 0)) throw new Error(`Cell ${date}: count ${count} disagrees with level ${level}`)
    days.push({ date, count })
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1))
  if (days.length < 360) throw new Error(`Only ${days.length} days in the calendar; expected about a year`)
  for (let i = 1; i < days.length; i++)
    if (dayMs(days[i].date) - dayMs(days[i - 1].date) !== DAY_MS) throw new Error(`Calendar skips from ${days[i - 1].date} to ${days[i].date}`)
  return days
}

async function fetchContributions(login) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(login)}/contributions`, {
    headers: { "User-Agent": "contribution-skyline", Accept: "text/html" },
  })
  if (!res.ok) throw new Error(`Contribution calendar for "${login}" responded ${res.status}`)
  return parseCalendar(await res.text())
}

const COMMITS_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner }
        contributions(first: 100) { totalCount nodes { occurredAt commitCount } }
      }
    }
  }
}`

// A window of at most 31 days keeps every repo under the 100-day page, so nothing needs paging.
const WINDOW_DAYS = 30

// A commit contribution's occurredAt is the start of its day in the author's time zone (22:00Z for
// midnight CEST), so its calendar day is the UTC date half a day later.
const commitDate = (iso) => {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new Error(`Commit contribution has no usable date: "${iso}"`)
  return toKey(ms + DAY_MS / 2)
}

/**
 * Reads one window of the GraphQL answer into [{ repo, date, count }]. Strict like parseCalendar: errors,
 * a missing user, a full page of repos or a repo with more days than were returned all mean the answer
 * may be partial, so it throws instead of drawing too few commits.
 */
export const parseCommitWindow = (body) => {
  if (body?.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`)
  const repos = body?.data?.user?.contributionsCollection?.commitContributionsByRepository
  if (!Array.isArray(repos)) throw new Error("GraphQL answer has no commit contributions; is the login right?")
  if (repos.length >= 100) throw new Error("100 repos in one window; the list may be cut off")
  const out = []
  repos.forEach((r, i) => {
    const repo = r?.repository?.nameWithOwner
    const { totalCount, nodes } = r?.contributions ?? {}
    if (!repo || !Array.isArray(nodes)) throw new Error(`Repo #${i} in the answer is malformed`)
    if (nodes.length < totalCount) throw new Error(`Repo #${i}: ${totalCount} days but only ${nodes.length} returned`)
    for (const n of nodes) {
      if (!Number.isInteger(n?.commitCount) || n.commitCount < 1) throw new Error(`Repo #${i}: bad commit count ${n?.commitCount}`)
      out.push({ repo, date: commitDate(n.occurredAt), count: n.commitCount })
    }
  })
  return out
}

/**
 * Commits only, per day, for about the year the skyline shows. Needs a token: with one that can read the
 * user's private repos (a PAT in SKYLINE_TOKEN) their commits count too, but only the daily totals leave
 * this function, never repo names, since Action logs on a public repo are public.
 */
export async function fetchCommits(login, token, now = Date.now(), request = fetch) {
  if (!token) throw new Error("--commits needs a token in SKYLINE_TOKEN; refusing to fall back to all contributions")
  const start = now - 371 * DAY_MS
  const seen = new Map() // "repo|date" → count; a day on a window edge must not count twice
  for (let from = start; from < now; from += WINDOW_DAYS * DAY_MS) {
    const to = Math.min(from + WINDOW_DAYS * DAY_MS, now)
    const res = await request("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "User-Agent": "contribution-skyline", "Content-Type": "application/json" },
      body: JSON.stringify({ query: COMMITS_QUERY, variables: { login, from: new Date(from).toISOString(), to: new Date(to).toISOString() } }),
    })
    if (!res.ok) throw new Error(`GitHub GraphQL responded ${res.status} for ${toKey(from)} — ${toKey(to)}`)
    for (const c of parseCommitWindow(await res.json())) {
      const k = c.repo + "|" + c.date
      const prev = seen.get(k)
      if (prev != null && prev !== c.count) throw new Error(`${c.date}: two windows disagree on one repo's commits (${prev} vs ${c.count})`)
      seen.set(k, c.count)
    }
  }
  const perDay = new Map()
  for (const [k, count] of seen) {
    const date = k.slice(k.lastIndexOf("|") + 1)
    perDay.set(date, (perDay.get(date) ?? 0) + count)
  }
  // A zero for today pins the chart's last day to now, even after a quiet day.
  return [...[...perDay].map(([date, count]) => ({ date, count })), { date: toKey(now), count: 0 }]
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf("--" + name)
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback
  }
  const out = opt("out", "dist")
  const palette = opt("palette", "github")
  const commits = args.includes("--commits")
  const unit = commits ? "commit" : "contribution"
  let data
  if (args.includes("--demo")) {
    data = generateContributions(dayMs(opt("end", toKey(Date.now()))), Number(opt("seed", 7)))
  } else {
    const user = opt("user", process.env.GITHUB_REPOSITORY_OWNER)
    if (!user) throw new Error("Pass --user <login> (or set GITHUB_REPOSITORY_OWNER)")
    data = commits ? await fetchCommits(user, process.env.SKYLINE_TOKEN) : await fetchContributions(user)
  }
  const model = buildModel(data)
  const updated = toKey(Date.now())
  await mkdir(out, { recursive: true })
  for (const [theme, file] of [["light", "contribution-skyline.svg"], ["dark", "contribution-skyline-dark.svg"]]) {
    const svg = renderSkyline(model, { theme, palette, unit, updated })
    await writeFile(join(out, file), svg)
    console.log(`${join(out, file)}  ${(svg.length / 1024).toFixed(0)} KB  ${model.stats.total} ${unit}s, ${model.cells.length} days`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err)
    process.exitCode = 1 // not process.exit(): let open fetch sockets close first
  })
}
