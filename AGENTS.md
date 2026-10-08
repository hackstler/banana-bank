<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Scope and approval rules

- Follow the user's explicit request as the authoritative scope of work.
- Implement only what the user has requested and the changes clearly required to complete and verify that request.
- Do not implement additional features, refactors, persistence changes, schema changes, dependencies, documentation, or behavioral changes merely because they may be useful.
- Treat any change that is not clearly required by the request as an additional proposal.
- Before implementing an additional proposal:
  1. Stop and ask the user for explicit approval.
  2. Explain why the proposal is being considered.
  3. Describe its expected benefit.
  4. Identify the affected behavior, files, data, contracts, or dependencies.
  5. Explain relevant risks, side effects, and impact on the current task.
- Do not implement the proposal until the user has explicitly approved it.
- If it is unclear whether a change is required or additional, treat it as additional and ask first.

## Work cycle

Follow this cycle: rule → reproduction → evidence → alternatives → decision → implementation → repeat the same scenario → checks → update HowToDemo → review with the user → commit. The commit is the final step; do not add extra functionality without approval.
