# Context — dsh-hash-edit

A DSH (DeepSeek Harness) plugin that ports the behavior of the Pi package
[`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro): hash-anchored,
line-level read/replace/undo tools for the coding agent, where every line of a text file
carries a short stable hash that survives edits, and stale or ambiguous anchors are
rejected rather than fuzzy-matched.

## Glossary

- **hashline (哈希锚行)**: an individual line of a text file viewed together with the
  unique per-line **anchor** assigned to it. The model addresses lines by their anchor,
  never by line number or raw text.
- **anchor (锚点)**: a short string (3 characters, alphabet `A-Za-z0-9`) uniquely
  identifying one line of a file.
- **canon(ical) line**: the text a line is hashed on — line content stripped of `\r`
  then right-trimmed of trailing whitespace. Keeps anchors stable across editor save
  cycles that alter trailing whitespace.
- **unique-by-construction**: anchors never fuzzy-match — each line either owns a unique
  anchor or the operation is rejected. Collision-free by the allocator's design, never by
  guesswork.
- **stale anchor (过期锚点)**: an anchor that matches no line of the *current* file
  (the line changed or was removed after it was shown to the model). Rejected.
- **ambiguous anchor (歧义锚点)**: an anchor matching more than one current line. Rejected
  with candidates listed.
- **served range (已展示区间)**: the set of lines the model has actually been shown via a
  read or an auto-read block. A replace may only touch lines inside a served range; anything
  else is rejected as a stale range.
- **replace**: the single edit operation — removes one contiguous, anchor-bounded line range
  and substitutes replacement text. One edit per call.
- **undo entry (撤销记录)**: the persisted snapshot (prior full content, BOM, line ending,
  prior anchors, expected post-replace content) needed to revert one file's most recent
  replace. Saved *before* the edit is written.
- **single-level undo**: a file carries at most one undo entry; only the most recent replace
  can be reverted. A successful `write` clears it.
- **auto-read**: after a successful `write`, an annotated re-read block is appended to the
  result so anchors stay fresh for the next edit.
- **workspace store (工作区存储)**: the plugin's persistence rooted at a directory inside the
  target project (`.dsh-hash-edit/`), holding the anchor snapshots and undo entries. Follows
  the project; survives session restarts.
