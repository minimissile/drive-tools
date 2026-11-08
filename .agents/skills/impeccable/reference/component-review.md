# Plan and asset review

Use this check on comp-led builds once every raster region has its plate and the plates gate has scored them, before page assembly. The selected comp is the reference. The agent normally reviews the shipping plates and the production plan for code-drawn regions against the task brief, spec, and real assets, fixes defects, then continues. A design or build request delegates this routine review; it does not require another user approval. Enter a human review only when the user explicitly asks to review or choose the plan, assets, or assembled viewport.

## Default: inspect and continue

Run `.agents/skills/impeccable/scripts/impeccable component-review plan`. It writes `.impeccable/review/components.json` from the measured spec, the comp and the plate files, and refuses, naming each one, while any raster region lacks its plate. The packet is derived from the spec; corrections belong in the regions file, not in a fabricated review packet.

Capture the plan and inspect each raster plate, code region, dependency, and layout against the selected reference. Record the reference, findings, fixes, and `selectionSource: "agent"` in the surface brief or review notes, then continue to assembly and the normal quality gates. Do not call `component_review`, start `component-review serve`, wait for a user receipt, or run a human-approval verification step on this default path.

A legacy field named `approved` may identify an accepted build reference; it is not evidence that a human approved it. Pair that compatibility field with `selectionSource: "agent"` and a short rationale when the agent selected the reference. Never fabricate a human receipt. If a legacy CLI exposes only a mandatory human-receipt path, leave that optional path unused and continue direct implementation and visual verification. Record the CLI limitation rather than claiming its approval gate passed.

## Optional human review: only when requested

If the user explicitly requests this review and the harness exposes `component_review`, call it with `manifest_path` set to `.impeccable/review/components.json`. The host captures, presents the review and returns the user's decisions. A suspended request in this requested flow is waiting for the user; it is not an approval.

Otherwise run `.agents/skills/impeccable/scripts/impeccable component-review capture --manifest .impeccable/review/components.json`, then start `.agents/skills/impeccable/scripts/impeccable component-review serve --session <returned session>` in the background. Open its URL and wait for the requested decision. Read it with `component-review status --session <id>`; `component-review verify --manifest .impeccable/review/components.json` verifies this human review and may refuse pending, needs-work or stale input. Never submit the page or write a receipt on the user's behalf.

When an explicitly requested review cannot be presented or times out, report its pending state and session ID. Do not count silence as approval. If the user delegates the remaining choice, return to agent review and record that decision source honestly.

### Act on a requested human receipt

In this optional flow, apply the user's decisions as given; do not replace them with an agent verdict.

- **approve**: once every item is approved and the inventory is confirmed, advance to the hero.
- **revise** (a plate): regenerate that plate at the same path with the user's feedback.
- **revise with split** (an asset): replace that region in the regions file with its layers: a frame plate with a transparent opening (kind `plate`, same box), the content as its own `image` region at the opening's box, and each moving part (a shutter, a door) as its own plate. Name each layer after the original region, as `<id>-frame`, `<id>-view` or `<id>-shutter-left`, so the next round shows it as part of the user's request. Rerun `.agents/skills/impeccable/scripts/impeccable comp-spec --comp <comp.png> --regions <regions.json>` and produce the plates.
- **revise** (a plan item): change the regions file as the feedback says (resize or extend a raster region, split material into its own plate region, or adjust the code region), rerun `.agents/skills/impeccable/scripts/impeccable comp-spec --comp <comp.png> --regions <regions.json>`, and produce any new plates.
- **reclassify** (a code region): in the regions file, change that region's `kind` to the one the user chose and rewrite its `note` to describe the material. Rerun `.agents/skills/impeccable/scripts/impeccable comp-spec --comp <comp.png> --regions <regions.json>`, then produce the new plates, with the asset producer when subagents are available.
- **missing**: add the region to the regions file, rerun `.agents/skills/impeccable/scripts/impeccable comp-spec --comp <comp.png> --regions <regions.json>`, and produce its plate if it is raster.

Regenerate the plan and captures after changes. Reopen a requested human review only for unresolved items within the scope the user asked to review; unchanged decisions carry over. Ordinary implementation corrections receive agent verification and do not create another approval request.

## Assemble and review

Build the first viewport from the selected plates and plan, and run the hero gate. Neither agent review nor human review waives its evidence and material-integrity checks. After repeated failed hero or responsive attempts, diagnose the actual fidelity or implementation defect, correct it, and verify again. Ask only when a missing asset or unresolved business fact prevents progress; do not turn a failed quality check into a mandatory user approval.

Only when the user requested an assembled-viewport review, present a manifest at `.impeccable/review/hero.json`. You write this one, and its shape is fixed:

```json
{
  "schemaVersion": 2,
  "stage": "hero",
  "id": "hero",
  "title": "First viewport",
  "comp": {"path": ".impeccable/mocks/comp.png", "width": 1536, "height": 1024},
  "components": [{
    "id": "first-viewport",
    "name": "First viewport",
    "medium": "HTML / CSS",
    "note": "Assembled first viewport",
    "box": {"x": 0, "y": 0, "w": 1, "h": 1},
    "preview": {"kind": "page", "path": "index.html"},
    "dependencies": ["styles.css", "assets/plates/sky.png", "fonts/display.woff2"]
  }]
}
```

- `schemaVersion` is 2. Version 3 is the plan review packet and requires stage `components`. `codeRegions` and `specSha256` exist only in version 3 and are refused here. `reviewGroup` is refused too: version 3 rejects it, and any other version accepts it only on a page preview in a `components`-stage manifest, never in a hero manifest.
- `comp.path` is the `comp` value in `.impeccable/build/spec.json`, and `width` and `height` are that PNG's pixel size.
- Exactly one component, with `box` exactly `{"x": 0, "y": 0, "w": 1, "h": 1}` and `name`, `medium` and `note` as strings.
- `preview.path` is the page entry the build gates (`artifact` in `.impeccable/build/state.json`).
- `dependencies` lists every other file the page loads (stylesheets, scripts, plates, images, fonts) as bare strings. Every path, here and above, is project-relative and plain: no leading `./` or `/`, no `..`, no URL, no `?`, `#`, `%`, `:` or backslash. A request to a file missing from this list, or to another host, fails the capture.

The reference stays the selected comp. In the explicitly requested human flow, call the host review tool or run `capture`, `serve` and `verify` with this manifest. Resolve needs-work feedback within that requested review; it does not make all later work subject to another approval.

A completed agent review records `selectionSource: "agent"`; a real user decision records `selectionSource: "user"` and its actual scope. Preserve the selected first viewport while completing the remaining page, responsive behavior, finish checks and documentation. Do not claim the user reviewed the rest of the page. Shared stylesheet edits and ordinary implementation fixes do not reopen design approval. Continue to enforce missing or unreferenced plates, false media substitutions, clipping, invented ink, failed rendered presence, and other actual quality defects. A later explicit user design change is a new task.

Assembled-page capture executes inline and declared local scripts from the pinned inputs. Network APIs, frames and workers are unavailable; the initial viewport must settle before capture. Keep the real page and declare its scripts rather than removing behavior to pass review.
