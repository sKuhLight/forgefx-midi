---
description: Plan a feature or change for forgefx-midi without editing code — scope, files, tests, and the mandatory Plane task-tracking step. Presents a plan and waits for approval.
---

Plan the following feature or change WITHOUT editing any code or files. Produce a
written plan only; make no edits until it is explicitly approved.

Feature request: $ARGUMENTS

Work through these steps and present the result:

1. **Goal & acceptance criteria.** Restate the goal in one or two sentences and
   list concrete, testable acceptance criteria.

2. **Layer & repo placement.** Identify which layers are affected — shared / core
   / device codecs / descriptors / catalog / tests. Then classify the change:
   - **protocol facts** (opcodes, enums, address models, block/param tables,
     encode/decode) → belongs HERE in forgefx-midi;
   - **device interaction** (talking to hardware, session/transport behavior) →
     belongs in ForgeFX;
   - **UI** → belongs in Axis.
   If it is not a protocol-facts change, say so and stop — it does not belong in
   this repo.

3. **Files to touch.** List the exact files. For any generated file
   (`src/**/*.generated.ts`, `src/am4/paramNamesGenerated.ts`, `src/version.ts`,
   `catalog/*.json`), note that the GENERATOR must be changed instead and the
   output regenerated via `npm run build` / `npm run catalog:export` — never edit
   the generated file directly.

4. **Test plan.** Name which suites cover the change, whether new suites are
   needed, and whether new golden fixtures must be captured or updated. Remember
   the runner requires `npm run build` before `npm test`.

5. **Task tracking (MANDATORY — see CLAUDE.md, "Task tracking" section).**
   Search this repo's Plane project for an existing work item covering this
   change (`search_work_items` / `list_work_items`). If none exists, create one
   with an imperative title and a description of goal + why + acceptance criteria.
   Move the item to **In Progress** when implementation begins. State in the plan
   which item this maps to (existing id or "to be created").

Finally: present the full plan, then WAIT for approval. Do not make any edits.
