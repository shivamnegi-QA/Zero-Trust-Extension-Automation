# ZT Browser Report — Design System Prompt

Use this prompt when creating any new report in the ZT Browser automation series to maintain visual consistency.

---

## How to Use

Paste the prompt block below at the start of any new report request. Adapt the content sections and data to the new topic, but keep all colors, typography, animation patterns, and component styles exactly as specified.

---

## Design System Prompt

```
Create a dark-themed, single-file HTML report using the following design system —
keep it visually consistent with the ZT Browser automation report series.

─────────────────────────────────────────────
## Color Palette (CSS variables)
─────────────────────────────────────────────
:root {
  --bg: #0A0E1A;          /* page background */
  --bg-2: #0F1524;        /* subtle alt background */
  --card: #111827;        /* card fill (use #1E2A45 for denser cards) */
  --card-2: #16213A;      /* gradient end for cards */
  --border: #1E2A45;      /* card/section borders (use #26355A for bolder) */
  --accent: #00D4FF;      /* primary cyan accent */
  --accent-2: #7C3AED;    /* purple secondary accent */
  --done: #22C55E;        /* green — completed/success */
  --wip: #F59E0B;         /* amber — in-progress/warning */
  --planned: #3B82F6;     /* blue — planned/informational */
  --danger: #EF4444;      /* red — problem/error */
  --text: #FFFFFF;        /* primary text */
  --muted: #94A3B8;       /* secondary/subdued text (use #8FA0BF as alt) */
}

─────────────────────────────────────────────
## Typography
─────────────────────────────────────────────
- Font: 'Inter' from Google Fonts (weights 300–900)
- Monospace: 'JetBrains Mono' (for code/KPIs if needed)

h1 (hero):
  font-size: clamp(36px, 6vw, 88px); font-weight: 900; letter-spacing: -1.5 to -2px
  gradient fill: linear-gradient(135deg, #FFFFFF 0%, var(--accent) 50%, var(--accent-2) 100%)
  applied via: -webkit-background-clip: text; color: transparent

h2 (section title):
  font-size: clamp(24px, 3.4–4vw, 46px); font-weight: 800; letter-spacing: -0.5 to -1px
  inline .accent spans → color: var(--accent)

.eyebrow (section label):
  font-size: 12px; font-weight: 700; letter-spacing: 3–4px; text-transform: UPPERCASE
  pill style: padding 6px 12px; background rgba(0,212,255,0.1);
              border: 1px solid rgba(0,212,255,0.3); border-radius: 20px

.subtitle (section intro):
  font-size: clamp(15px, 1.5–1.6vw, 19px); color: var(--muted); max-width: 780px

Body: font-size 14px; line-height 1.6

─────────────────────────────────────────────
## Navigation (sticky)
─────────────────────────────────────────────
- Position: fixed top bar
- Background: rgba(10,14,26,0.85) + backdrop-filter: blur(14px)
- Bottom border: 1px solid var(--border)
- Brand: logo image (22×22px, border-radius 6px, cyan glow box-shadow) + bold text
- Nav links: 12px, muted color
  hover → color var(--accent) + background rgba(0,212,255,0.08) + border-radius 8px
- Logo: CSS pulse animation — scale 1→1.25, opacity 1→0.55, 1.6–2s infinite

─────────────────────────────────────────────
## Section Layout
─────────────────────────────────────────────
- padding: 90px 6vw 40px
- Ambient radial gradients (position: absolute, pointer-events: none):
    radial-gradient(circle at 20% 30%, rgba(0,212,255,0.05–0.06) 0%, transparent 40%),
    radial-gradient(circle at 80% 70%, rgba(124,58,237,0.04–0.05) 0%, transparent 45%)
- .inner / .slide-inner: max-width 1200–1280px; margin: 0 auto; position: relative; z-index: 1

For presentation decks (full-page slides):
  min-height: 100vh; scroll-snap-align: start
  Slide number (e.g. "01 / 07"): position absolute, top-right, 12px, letter-spacing 3px

─────────────────────────────────────────────
## Cards
─────────────────────────────────────────────
Standard card:
  background: linear-gradient(160deg, var(--card) 0%, var(--card-2) 100%)
  border: 1px solid var(--border); border-radius: 16px; padding: 26px
  hover: translateY(-4px), border-color rgba(0,212,255,0.4),
         box-shadow: 0 20px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,212,255,0.1)

Top-accent card (KPI / coverage cards):
  ::before pseudo — height: 3px; top: 0; left: 0; right: 0
  background: linear-gradient(90deg, var(--accent), var(--accent-2))

Problem / danger card:
  border-left: 3px solid var(--danger)
  background: linear-gradient(90deg, rgba(239,68,68,0.08) 0%, transparent 100%)
  Icon background: rgba(239,68,68,0.15); icon border: rgba(239,68,68,0.3)

Info / highlight banner:
  background: linear-gradient(135deg, rgba(0,212,255,0.07–0.12), rgba(124,58,237,0.07–0.12))
  border: 1px solid rgba(0,212,255,0.2–0.3); border-radius: 18–20px

─────────────────────────────────────────────
## Status System (timelines / sprint zones)
─────────────────────────────────────────────
Done / Completed  → color #22C55E;  border rgba(34,197,94,0.25–0.4)
In Progress / WIP → color #F59E0B;  border var(--wip);
                    animated cardGlow box-shadow (0 0 20–40px rgba(245,158,11,0.1–0.28))
Planned / Pipeline→ color #3B82F6;  border rgba(59,130,246,0.4); opacity: 0.9

Status pills (hero stat row):
  display: inline-flex; gap: 10px; padding: 12px 20px; border-radius: 999px
  background: var(--card); border: 1px solid var(--border)
  Dot: 10px circle, matching status color + glow box-shadow
  WIP dot also pulses (same keyframe as logo)

Live badge:
  background: var(--wip); color: #0A0E1A; padding: 3px 10px; border-radius: 999px
  font-size: 11px; font-weight: 900; text-transform: UPPERCASE
  Inner dot: 6px circle, background #0A0E1A, animated pulse 1.2s infinite

─────────────────────────────────────────────
## KPI / Counter Cards
─────────────────────────────────────────────
Large number:
  font-size: clamp(38px, 5–6vw, 72px); font-weight: 900; letter-spacing: -1 to -2px
  gradient: linear-gradient(135deg, var(--accent), var(--accent-2))
  -webkit-background-clip: text; color: transparent
  font-variant-numeric: tabular-nums

Label: 12–13px; color: var(--muted); font-weight: 600; letter-spacing: 1.5–2px; UPPERCASE

ROI hero block:
  font-size: clamp(56px, 9vw, 108px); font-weight: 900; same gradient; letter-spacing: -3px
  Centered in a banner with gradient background + cyan border

─────────────────────────────────────────────
## Animated Counters (JavaScript)
─────────────────────────────────────────────
Markup:  <span data-count="N" data-suffix="+">0</span>

On IntersectionObserver (threshold: 0.4), animate 0 → N over 1400ms:
  const eased = 1 - Math.pow(1 - p, 3);   // ease-out cubic
  el.textContent = Math.round(target * eased).toLocaleString() + suffix;

Use countIO.unobserve(el) after trigger. Guard with el.dataset.counted = '1'.

─────────────────────────────────────────────
## Progress Bars
─────────────────────────────────────────────
Track:  height: 12–14px; background: rgba(255,255,255,0.05–0.06);
        border-radius: 999px; overflow: hidden

Fill:   height: 100%; border-radius: 999px
        background: linear-gradient(90deg, var(--done/accent), var(--accent/accent-2))
        width starts at 0; animates to data-target% via IntersectionObserver (threshold: 0.3)
        transition: width 1.4s cubic-bezier(0.2, 0.9, 0.3, 1)

Optional label bubble (fill::after):
  content: attr(data-label); position: absolute; right: 0; top: 50%; transform: translateY(-50%)
  background: var(--accent); color: #0A0E1A; font-size: 9px; font-weight: 800
  padding: 1px 5px; border-radius: 999px

─────────────────────────────────────────────
## Reveal Animations (scroll-driven)
─────────────────────────────────────────────
All content: class="reveal"
  Initial state: opacity: 0; transform: translateY(24–30px)
  Trigger (IntersectionObserver, threshold: 0.12–0.15): add class "visible"
  Visible state: opacity: 1; transform: translateY(0)
  Transition: 0.7–0.8s ease

Stagger delay classes:
  .d1 / .delay-1  → transition-delay: 0.08–0.1s
  .d2 / .delay-2  → transition-delay: 0.16–0.2s
  .d3 / .delay-3  → transition-delay: 0.24–0.3s
  .d4 / .delay-4  → transition-delay: 0.32–0.4s

─────────────────────────────────────────────
## Tech / Tool Badges
─────────────────────────────────────────────
Container:
  display: flex; align-items: center; gap: 14px
  background: var(--card); border: 1px solid var(--border)
  border-radius: 14px; padding: 16px
  hover: border-color var(--accent); translateY(-2px); transition: 0.3s

Logo icon:  44px × 44px; border-radius: 10px; flex-shrink: 0
            display: grid; place-items: center; brand color background
Name:       font-weight: 700; font-size: 14px
Desc:       color: var(--muted); font-size: 11.5px; margin-top: 2px

Grid layout: grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px

─────────────────────────────────────────────
## Timeline / Sprint Zone Layout
─────────────────────────────────────────────
Zone container:
  border-left: 2px solid (status color at 40–50% opacity); padding-left: 32px; margin-top: 30px

Zone header dot (::before):
  16px circle; position: absolute; left: -8px; top: 50%; transform: translateY(-50%)
  background: status color + matching glow box-shadow
  WIP dot also pulses

Sprint cards:
  Connector dot (::before): 12px circle; position: absolute; left: -37px; top: 22px
  Done: background status color + glow
  WIP:  background var(--wip) + glow + pulse animation
  Planned: background var(--planned) + glow

Sub-zone dividers (e.g. "ZT Browser Extension · S11–S18"):
  font-size: 12px; font-weight: 700; UPPERCASE; letter-spacing: 2px; color: var(--muted)
  Flanked by horizontal lines via ::before (width: 30px) and ::after (flex: 1)
  Both lines: height: 1px; background: var(--border)

─────────────────────────────────────────────
## Architecture / Pipeline Diagrams
─────────────────────────────────────────────
Grid layout: repeat(5, 1fr) with arch-arrow columns between content columns
  Center column: border-color var(--accent); box-shadow 0 0 20px rgba(0,212,255,0.15)

Block style:
  background: var(--card); border: 1px solid var(--border); border-radius: 12px
  padding: 14px 12px; text-align: center
  .title: font-weight 700; font-size 13px; color: var(--accent)
  .items: color: var(--muted); font-size: 11px; line-height: 1.5

Arrow columns: display: grid; place-items: center; color: var(--accent); font-size: 22px

Pipeline steps:
  Step number badge: position absolute; top: -10px; left: 50%; transform: translateX(-50%)
  22px circle; background: var(--accent); color: #000; font-size: 11px; font-weight: 800

─────────────────────────────────────────────
## Responsive Breakpoints
─────────────────────────────────────────────
≤900px:
  - All multi-column grids collapse to 1fr
  - Hide nav links (nav ul { display: none })
  - Remove scroll-snap (scroll-snap-type: none)
  - Adjust sprint card connector: left: -29px
  - Section padding: 80–90px 20px 40–50px
  - Hide slide numbers and arch arrows

≤560px:
  - Force single column for smaller card grids (next-grid, impact-cols)

─────────────────────────────────────────────
## Print Styles (@media print)
─────────────────────────────────────────────
- html, body: background #FFF; color #000
- nav: display none
- Cards: background #F6F7FB; border #DDD; box-shadow none
- Gradient text (h1, h2, .kpi, .count, .big):
    color: #0A0E1A; -webkit-text-fill-color: #0A0E1A  (overrides gradient clip)
- Accent/eyebrow text → color: #7C3AED
- Muted text → color: #333
- All .reveal: opacity 1; transform none (no animation)
- WIP cards: animation none
- Section padding: 30px; page-break-inside: avoid

─────────────────────────────────────────────
## CTA Buttons (optional)
─────────────────────────────────────────────
Primary .btn:
  background: linear-gradient(135deg, var(--accent), var(--accent-2))
  color: #0A0E1A; font-weight: 700; padding: 14px 28px; border-radius: 999px
  font-size: 14px; letter-spacing: 0.5px
  hover: translateY(-2px); box-shadow: 0 12px 28px rgba(0,212,255,0.35)

Ghost .btn.ghost:
  background: transparent; color: var(--text); border: 1px solid var(--border)

─────────────────────────────────────────────
## Grid Utility Classes
─────────────────────────────────────────────
.grid       → display: grid; gap: 20px
.grid-2     → grid-template-columns: repeat(2, 1fr)
.grid-3     → grid-template-columns: repeat(3, 1fr)
.grid-4     → grid-template-columns: repeat(4, 1fr)
.kpi-row    → grid-template-columns: repeat(4, 1fr); gap: 18px
```

---

## Quick Reference — Component Variants

| Component | Class / Pattern | Use Case |
|---|---|---|
| Eyebrow label | `.eyebrow` | Section identifier above h2 |
| Hero counter | `data-count="N"` | Animated stat numbers |
| Progress bar | `.track > .fill[data-target]` | Percentage meters |
| Status pill | `.pill.done / .wip / .planned` | Sprint/task status at a glance |
| Live badge | `.live-badge` | Currently active sprint |
| Danger card | `.card.pain-card` | Problem/blocker highlight |
| Top stripe card | `.kpi-card` (::before) | KPI metric blocks |
| Info banner | `.impact-card / .pipeline-banner` | Callout/summary boxes |
| Tech badge | `.badge` | Tool/tech stack items |
| Timeline zone | `.zone.done / .wip / .planned` | Sprint grouping |
| CTA button | `.btn` / `.btn.ghost` | Call-to-action links |

---

## JavaScript Boilerplate (copy into every report)

```js
// Reveal on scroll
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// Animated counters
const countIO = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const el = e.target;
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    const target = +el.dataset.count;
    const suffix = el.dataset.suffix || '';
    const duration = 1400;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    countIO.unobserve(el);
  });
}, { threshold: 0.4 });
document.querySelectorAll('[data-count]').forEach(el => countIO.observe(el));

// Progress bar fills
const progIO = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const el = e.target;
    const t = el.dataset.target;
    if (t) el.style.width = t + '%';
    progIO.unobserve(el);
  });
}, { threshold: 0.3 });
document.querySelectorAll('.track .fill, .progress .fill').forEach(el => progIO.observe(el));
```

---

## Google Fonts Link (include in every `<head>`)

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
```
