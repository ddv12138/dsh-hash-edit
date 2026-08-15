# ADR-0001: Anchor and undo store lives in the project workspace

## Status
Accepted (2026)

## Context
`pi-hashline-edit-pro` persists its anchor snapshots and undo entries in a **user-level**
SQLite database (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`, honoring
`XDG_CONFIG_HOME`). For the DSH port we chose where to keep the equivalent store.

Three candidate homes:

1. **User-level directory (align with pi)** — one store for the whole user, following pi's
   exact model.
2. **Project workspace directory** — `.dsh-hash-edit/` inside the repo under version
   control (gitignored), so anchor/undo history travels with the project and any session
   working on that repo sees the same anchors.
3. **DSH `storageDomain`** — the harness's durable KV domain facility.

## Decision
Use a **project workspace store**: `.dsh-hash-edit/store.json`, a single JSON document
holding `{ snap, undo }`.

## Consequences
- The store follows the project: clone it, and anchor/undo history comes along; different
  repos never collide on one global store.
- The store is transparent and inspectable (plain JSON) and survives session restarts.
- Undo and anchor persistence are lost if the project is deleted or the `.dsh-hash-edit`
  directory is excluded from a copy — a deliberate, documented trade-off versus pi's
  user-level store.
- Because the DSH dynamic Host half exposes no `crypto`/`node:sqlite` builtins, we use a
  pure-JS xxHash32 and a JSON file instead of pi's sqlite/xxhash-wasm — functionally
  equivalent anchoring, different (self-contained) implementation.

## Nice-to-have later
If a durable, backend-managed store is ever preferred (multi-host, shared anchors), the
snap/undo shape is already a plain JSON document and can be migrated into a
`storageDomain` without changing the tool contract.
