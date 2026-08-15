# dsh-hash-edit

Hash-anchored line-editing tools for **DeepSeek Harness (DSH)**, porting the behavior of the
Pi package [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro).

Every line of a text file carries a stable 3-character base-62 anchor. Tools address lines by
anchor instead of line number or raw text; edits never corrupt the file because **stale or
ambiguous anchors are rejected, never fuzzy-matched**. Undo persists across restarts.

## What you get

Two planes, per the agreed "host core + takeover preset" design:

- **Host core** (`require('dsh-hash-edit/core')`) — registers `hashline_read` /
  `hashline_replace` / `hashline_undo` on the shared host, so any agent/preset can call them
  without touching the built-ins.
- **Takeover** (package main `dsh-hash-edit`, actually mounted as an **agent preset**, pi-aligned):
  - shadows the built-in `read` with hash-anchored `read`
  - adds `replace` and `undo_last_replace`
  - **hides the built-in `edit`** (session-scoped)
  - **intercepts `write`** to append an auto-read anchor block, so anchors stay fresh
  - injects the usage-discipline prompt (one edit per file per message; copy bare hashes only).

> Why a preset? In DSH, hiding a built-in tool (`tools.restrict`) and intercepting tool results
> (`tools/result`) are **agent-scoped** operations, so the takeover lives in an agent preset;
> a host plugin can only register tools. Mount the preset (or set it as the deployment
> default) and every session under it gets the pi-style takeover — that is "usable from any
> preset" in the DSH model.

## Install (development)

```bash
npm install            # no runtime deps; node:test runner
npm test               # runs test/ under node --test (also run by CI)
```

To use the takeover, publish/link `dsh-hash-edit` and mount the preset in `preset/`
(`agent.cordis.yml` row `name: dsh-hash-edit`). CI validates the engine and package on every
push via `.github/workflows/ci.yml`.

## Repo layout

```
src/engine.js        # pure, dependency-free engine (xxHash32, anchoring, replace/undo)
src/plugin.js        # host-core cordis plugin (hashline_*)  -> export "./core"
src/takeover.js      # takeover cordis plugin (pi names + deny edit + write intercept) -> package main
preset/              # agent preset composition (agent.cordis.yml + preset.yml)
test/                # node:test unit + integration suite
.github/workflows/   # CI: npm test on node 20 & 22 for every push
docs/adr/            # architecture decision records
```

## Tools

### read (hashline)
`path`, optional `offset` (1-based), optional `limit` (default 200). Returns each line as
`HASH│content` and records the *served range* (lines actually shown).

### replace
`path`, `remove_from` (bare 3-char HASH), `remove_to` (defaults to `remove_from`),
`replacement_text` (`\n` separates lines; `""` deletes the range). One edit per call.

Rejections (never fuzzy-match):
- `[E_STALE_ANCHOR]` — anchor no longer exists.
- `[E_AMBIGUOUS_ANCHOR]` — anchor matches >1 line.
- `[E_RANGE_STALE]` — the file changed or the range lines were never shown.
- `[E_BAD_REF]`, `[E_FILE_TOO_LARGE]`.

### undo_last_replace
`path`. Reverts the most recent replace, restoring byte-exact content, BOM, line endings, and
previous anchors. `[E_UNDO_STALE]` if the file changed since.

## Anchoring

- `canon(line) = line.replace(/\r/g,"").trimEnd()`.
- `xxHash32(canon, seed 0) >>> 14 % 238328` → a 3-char base-62 (`A-Za-z0-9`) anchor
  (verified bit-exact against the `xxhashjs` reference).
- Collisions resolved via a bitset probing with stride `3907 = 62²+62+1` (coprime with the
  anchor space) — **unique anchors by construction**, never fuzzy.
- Stable mapping: survivors keep anchors by nearest-position content match; a removed line's
  anchor is reused when identical text is re-inserted; genuinely new lines get fresh anchors.
- File caps: ≤ 238,328 lines and ≤ 100 MB.

## Store

`.dsh-hash-edit/store.json` in the project workspace (gitignored):
- `snap[absPath]` — current line/hash snapshot + last-served range + checksum.
- `undo[absPath]` — single-level undo record per file.

## References

- [CONTEXT.md](CONTEXT.md) — glossary
- [docs/adr/0001-workspace-store.md](docs/adr/0001-workspace-store.md) — why the store lives
  in the project workspace (diverges from pi's user-level sqlite)
- Upstream: [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) (MIT) and
  the original [`pi-hashline-edit`](https://github.com/yugimob/pi-hashline-edit) by RimuruW.
