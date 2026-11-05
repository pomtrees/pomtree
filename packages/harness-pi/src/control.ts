// Strips terminal control sequences from text before it enters the journal. Pi runs as an interactive TUI and a
// model can echo tool output verbatim, so event text may carry ANSI CSI/OSC sequences, spinner redraws (CR, erase-line)
// or other C0/C1 controls; journaled, they rewrite the screen of whoever later prints the event (pomtree logs, trace, UI).
// Removes CSI, OSC, DCS/SOS/PM/APC strings, two/three-byte escapes and the remaining C0/C1 controls and DEL, keeping
// LF and TAB, which are structural whitespace rather than terminal commands. Printable text passes unchanged. A DCS/SOS/PM/APC
// string is removed only when it is terminated; an unterminated one loses just its introducer, so a page cannot hide the text
// (or a trailing "(cause=...)" suffix) after it.
// TODO(sanitize-core): the same function lives in packages/pomtree/src/sanitize.ts (stripControl); harness-pi cannot
// import pomtree, so both copies are pinned to one shared case list in their tests until it moves to @pomtree/core.
export function stripControl(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: ESC [ ... final byte 0x40-0x7E
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC: ESC ] ... BEL or ST
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      .replace(/\u001b[PX^_][^\u001b\u009c]*(?:\u001b\\|\u009c)/g, "") // DCS/SOS/PM/APC: only a terminated string is removed
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      .replace(/\u001b[\u0020-\u002f]*[\u0030-\u007e]/g, "") // two/three-byte Fe/Fs escapes
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "") // remaining C0/C1 + DEL, keep \t and \n
  );
}
