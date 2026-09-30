# Agent Instructions

- `src/` is the shared `@todex/protocol` layer compiled directly by `TodeX_desktop` and `TodeX_web` through sibling-directory path aliases (`../TodeX_protocol/src`). There is no build artifact.
- Keep `src/` platform-agnostic: no `react-native`, `expo-*`, DOM, or Electron imports. `@react-native-community/netinfo` may only appear behind the guarded dynamic import in `v2.ts` (declared in `src/netinfo.d.ts`, stubbed by consumers).
- `@noble/*` imports must use the same subpath style (`@noble/curves/ed25519.js`, etc.) already used in the sources; versions are supplied by the consumers.

## Git delivery

- Do every complex task — anything beyond a parameter change or a few localized lines — in a dedicated Git worktree on its own branch, not in the main checkout, which may hold the user's uncommitted work. Install dependencies inside the worktree (`npm install`) before running checks.
- Hand the result back locally: bring the branch into the main checkout (fast-forward or cherry-pick) without modifying the user's uncommitted changes, rerun the relevant checks there, then remove the worktree and its branch.
- After completing each task, create one or more Git commits for the changes made in that task.
- Group commits by change category or repository responsibility when the task includes unrelated changes.
- Run the relevant validation commands before committing whenever practical, and mention any validation that could not be run. For this repo, that is `npm run test:unit`, `npm run check:protocol`, and `npm run typecheck`.
- Push the created commits to the current branch's upstream remote after committing.
- If committing or pushing is blocked, report the blocker explicitly and leave the working tree status clear in the final response.
- Do not include unrelated local changes in a task commit. Preserve user changes unless the user explicitly asks to modify or discard them.
