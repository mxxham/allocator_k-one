# Quickstart

## 1. Open it

Unzip, then drag the `fefo-allocator` folder onto VS Code (or `File → Open Folder`).
Open the folder itself, not the zip — the `.vscode` config only loads when the
folder is the workspace root.

You need **Node 20 or newer** (`node -v` to check). Nothing else.

## 2. Set up — once

In the VS Code terminal (`` Ctrl+` ``):

```bash
npm install
```

Pulls four packages: `exceljs`, `xlsx`, `tsx`, `typescript`, `esbuild`. About
20–30 seconds.

## 3a. Run the CLI

```bash
npm run allocate
```

Reads `data/Warehouse_Management_System_15_September_2026_.xlsx` and writes
two files into `out/`:

- `picklist_2026-09-15.xlsx` — **Picklist · Summary · Shortage · Exceptions ·
  Replenishment · Replenishment Shortage · Movement Report**
- `picklist_2026-09-15.html` — A4 print sheet, one page per outbound pick task

Expected output:

```
FEFO allocation — as of 2026-09-15
  cartons allocated     : 4730  (fill rate 98.54%)
  picklists             : 32
  shortages             : 4

Pickface replenishment
  pickfaces replenished : 35
  cartons moved         : 3564  (87 pallet, 40 case)
  replenishment tasks   : 127
  shortages             : 31
```

If you get different numbers, something in the input changed — check the
`Exceptions` sheet first.

## 3b. Run the web app

```bash
npm run web
```

This builds the browser bundle and starts a tiny local server, then prints a
link — open `http://localhost:5173` in your browser. Everything runs inside
that browser tab; the workbook you drop in is never uploaded anywhere.

1. Drag the daily workbook onto the drop zone (or click it to browse).
2. Set the as-of date, minimum shelf life, and pickface target if you want
   something other than the defaults.
3. Click **Run allocation**.
4. Browse the tabs: **Picklist**, **Replenishment**, **Movement report**,
   **Shortage**, **Exceptions**, **Pickfaces**.
5. Download the workbook, the print sheet, or the movement CSV from the
   buttons above the tabs.

Re-run any time by dropping a new file and clicking Run again — nothing needs
restarting. If you only change an option (not the file), Run again re-uses the
already-loaded workbook.

**No server needed to *view* it later** — after `npm run build:web` has run
once, `web/index.html` + `web/bundle.js` are a normal static pair of files.
Double-clicking `index.html` works directly in most browsers; use `npm run
web` if your browser blocks local file drag-and-drop (some do, for security).

## 4. Run it on tomorrow's workbook

**CLI:** drop the new file into `data/` and point the CLI at it:

```bash
npm start -- "data/Warehouse_Management_System_16_September_2026_.xlsx" --out out
```

Omit `--as-of` and it uses today's date. Other flags:

| Flag | Meaning |
|---|---|
| `--as-of YYYY-MM-DD` | date shelf life is measured from |
| `--min-shelf-life 180` | reject stock with fewer days left |
| `--no-split` | one combined picklist instead of forklift + handpick |
| `--no-replenish` | skip pickface replenishment entirely |
| `--out DIR` | output folder |

**Web app:** just drop the new file onto the page — no restart needed.

## Buttons instead of commands

`Ctrl+Shift+B` runs "Generate picklist" (the CLI). `Ctrl+Shift+P → Tasks: Run
Task` also has setup and typecheck. `F5` runs the CLI under the debugger, so
you can put a breakpoint in `src/allocator.ts` or `src/replenishment.ts` and
step through a single decision — the fastest way to see why a particular bin
was chosen.

## Where to change things

- **Business rules** (shelf-life floor, pallet-breaking policy, pickface
  target, aisle order): `src/config.ts` — every rule is a named field with a
  comment. The web app exposes the most-used ones (as-of date, shelf life,
  pickface target) as controls; everything else is a code change.
- **Column names**, if the spreadsheet headers ever change: both
  `src/adapters/excel-input.ts` (CLI) and `src/web/browser-input.ts` (web app)
  declare them near the top — keep the two in sync.
- **The FEFO bin-choice rule itself**: `src/binselect.ts` — shared by picking
  and replenishment, so a fix there fixes both.
- **The web page's look**: `web/index.html` (styles are inline at the top);
  the interactive behaviour is `src/web/main.ts`, rebuilt with `npm run
  build:web`.

`README.md` has the full rule order, the pickface/replenishment design, and
notes on moving this into k-one-v2.

## Troubleshooting

**`tsx: command not found`** or **web app is blank** — `npm install` didn't
finish, or `npm run build:web` hasn't been run yet. Run `npm install` again.

**`Sheet "WMS" not found`** — the new workbook renamed a sheet. Fix the names
in the `SHEETS` block at the top of `src/adapters/excel-input.ts` **and**
`src/web/browser-input.ts`.

**Everything shows as a shortage** — the stock sheet's header row moved.
`SHEETS.stockHeaderRow` is `4` for this file format (CLI adapter) /
`stockHeaderRow` in `browser-input.ts` (web adapter).

**`EPERM` / file locked on write (CLI)** — the output workbook is open in
Excel. Close it and re-run.

**Web app: "Run allocation" stays disabled** — no file has been loaded yet, or
the file isn't a `.xlsx`/`.xlsm`. Check the status line under the drop zone.

**Replenishment shortages look high** — that's often correct: a SKU whose
*only* stock is already in its pickface bin has nowhere to replenish from.
Check the **Replenishment Shortage** sheet/tab for which SKUs and why.
