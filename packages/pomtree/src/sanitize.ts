// Neutralize terminal control sequences and control characters in agent-supplied
// text before it is printed to an operator terminal. `report show` dumps report
// content and `top` renders agent names and activity, and a malicious (or merely
// buggy) agent can embed ANSI CSI/OSC sequences there to move the cursor, rewrite
// the screen, or set the window title. Strip those sequences and the remaining
// C0/C1 controls (U+0000-U+001F and U+007F-U+009F), keeping LF (U+000A) and TAB
// (U+0009), which are structural whitespace rather than terminal commands.
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
