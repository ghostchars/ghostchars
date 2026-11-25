/**
 * One type, borrowed from the DOM library, so a Node profile can typecheck the
 * shared engine.
 *
 * `web/src/engine/zip.ts` calls `CompressionStream` and `DecompressionStream`
 * through `TransformStream<BufferSource, Uint8Array>`. `BufferSource` is
 * declared in TypeScript's `lib.dom.d.ts` and nowhere else, so a package built
 * with `"lib": ["ES2023"]` and `"types": ["node"]` cannot see it.
 *
 * WHY NOT JUST ADD "DOM" TO `lib`. That would work, and it would also make
 * `document`, `window`, `localStorage` and `fetch`'s DOM overloads typecheck
 * inside a command-line tool that has none of them at runtime. A typo that
 * should be a compile error would become a crash in a user's terminal. One
 * three-word declaration buys the same green typecheck without that.
 *
 * The definition is copied verbatim from `lib.dom.d.ts`. If TypeScript ever
 * widens it, this file is the single place to follow.
 */
declare type BufferSource = ArrayBufferView | ArrayBuffer
