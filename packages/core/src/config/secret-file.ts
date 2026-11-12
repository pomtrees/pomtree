// The one mode rule for a file that holds a secret: no group or other permission bit. resolveConfig applies it to `<ENV>_FILE`
// secrets and the sandbox credential reader (pomtreed) imports it for backend credentials, so there is no second copy. Pure: the
// caller injects the stat result, so core touches no fs.

// The part of fs.Stats this rule reads; `statSync(path)` satisfies it.
export interface SecretFileStat {
  readonly mode: number;
}

// Callers must `fstat` the descriptor they opened and read from that same descriptor, never stat the path and then read the path
// (the file could be swapped between the two). Where the platform has no POSIX modes (Windows) a caller has no mode to inject and
// the check is skipped; that is accepted there (see fileMode in resolve.ts and docs/configuration.md), not silently assumed safe.
//
// The reason a secret file is refused, or null when only its owner can access it. The reason names the file and the action.
export function secretFileModeReason(path: string, stat: SecretFileStat): string | null {
  if (!Number.isInteger(stat.mode) || stat.mode < 0) return `${path} has an unreadable mode (${String(stat.mode)}); stat it again and run chmod 600 ${path}`;
  return (stat.mode & 0o077) === 0 ? null : `${path} is readable by group/other; run chmod 600 ${path}`;
}
