# SafeSpace: design brief

The owner's words: "they all should feel like products, not some animated picture … PLEASE DON'T GIVE ME AI SLOP that just looks like any other site." For SafeSpace: "let users connect devices which can measure the data points … games or activities which use the keyboard or mouse tracking and give output accordingly."

## The feel

A quiet personal health instrument, phone first. It keeps the chart-recorder identity it already has (pale recorder green paper, one ink, blue = calm, red = stressed, DM Mono numerals, Instrument Sans), but now lives in a proper app shell. Reference points: the clarity of Apple Health's detail pages, the restraint of Oura's daily view, the honesty of a lab instrument. Not a spa (no pastel blobs, no "breathe ✨"), not a lab report (no AUCs on the first screen).

## Hard rules (a reviewer checks every one)

- No hero sections, feature-card grids, gradients, glows, blurred blobs, glassmorphism, emoji, stock illustrations, confetti, or "Welcome back 👋".
- Motion only when it carries information: the live pulse trace, the breathing guide, a score needle settling once. `prefers-reduced-motion` → static.
- Colour means something: calm blue and stress red only for scores; everything else is ink on paper. Signal pens keep their existing pen colours from `web/src/ui/pens.tsx`.
- Big mono numbers for readings (DM Mono, tabular). Touch targets ≥ 44 px. Bottom tab bar on phones (Today, History, Activities, Devices, Settings); a left rail at ≥ 900 px.
- Copy is plain and honest: "Your heart rate is 14 bpm above your resting 74." Always say which signals were measured and which were not. "Not a medical device" appears on first run, on results (small), and in settings, never as a scary banner.
- Every screen has designed first-run, empty, loading, offline ("Saved on this phone. It will sync when you're back online."), permission-denied (camera, Bluetooth) and error states with a way forward.
- Light and dark (the existing "night panel"). 0 axe violations. Works at 360 px.
- PWA installable; check-ins made offline are queued and synced.

## Tokens

Keep `web/src/styles/tokens.css` as the base (colours, fonts, spacing). Add:

```css
:root {
  --card: #f7faf7; --card-edge: #d4ded7; --radius-card: 14px; --radius-ctl: 10px;
  --tab-h: 64px; --rail-w: 232px;
  --good: #2d7a4b; --fair: #a15c00; --poor: #b42318;
}
[data-theme='dark'] { --card: #152019; --card-edge: #26342e; --good: #7cc79a; --fair: #e3a54f; --poor: #f97066; }
/* and the same dark values under prefers-color-scheme: dark for :root:not([data-theme='light']) */
```

## Screens

- **Signed out, `/`**: the product itself. Today's screen filled with a sample person's week (clearly labelled "Sample"), with **Try a check-in** (no account; nothing saved) and **Sign in**. Below the fold, real text for search engines: what it measures, the devices it works with, privacy in three sentences, a link to "How it works" and the case study.
- **First run** (after sign-up): three short screens (what it measures and cannot do; privacy and the recovery key, which the user must save, copy or download; connect a device or use the camera), then **Baseline 1 of 3**.
- **Today**: a large "Start a check-in" button, the latest result card, baseline progress, this week's strip of seven days coloured by score, a suggestion ("You haven't done a check-in since Monday").
- **Check-in**: choose the input (the connected device first; camera; or "just tell us how you feel"), a 60-second measurement with a live trace and a quality meter (good, fair, poor, with the reason), then feeling (five steps, words not faces) and tags, then the result.
- **Result**: score on the calm–stressed scale, each measured signal's contribution in words and a small bar, what was not measured, the feeling you reported, a note (template, or the LLM note if the user turned it on), and **Save**.
- **History**: a month calendar coloured by score, a list, filters by tag, trends by tag ("before exam" averages +0.38), weekly summary, export CSV and JSON, delete.
- **Activities**: the eight activities grouped by job (baseline, check-in, challenge, recovery) with length and device, and **Stress session** (10 minutes) at the top.
- **Devices**: connected devices with live bpm and battery if available, the add list (Bluetooth strap or watch, camera, import a file), each with what it gives and where it works; clear "not available on this browser" reasons.
- **Settings**: account, recovery key (regenerate), sessions, keep raw beats (off), AI-written notes (off), theme, export, delete account, "How it works" (the old four-pen simulator and model notes live here and at `/how-it-works`).
- `/embed` keeps working for the portfolio (the simulator).
