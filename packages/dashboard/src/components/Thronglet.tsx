// Legacy shim. The original hand-crafted vector Thronglet was replaced by
// the procedural pixel renderer (PixelThronglet). This file re-exports the new
// component under the old name and preserves the `statusToMood` helper so any
// stale import still compiles.
//
// Prefer importing directly from "./PixelThronglet" and "../lib/thronglet"
// in new code.

export { PixelThronglet as Thronglet } from "./PixelThronglet";
export { statusToMood } from "../lib/thronglet";
