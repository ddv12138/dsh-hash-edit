// dsh-hash-edit — main plugin (package entry).
// Mounting this bundle's patch row `name: dsh-hash-edit` registers the pi-aligned takeover
// (hash-anchored read / replace / undo_last_replace, hides built-in edit, intercepts write).
export { name, inject, apply } from './src/takeover.js'
