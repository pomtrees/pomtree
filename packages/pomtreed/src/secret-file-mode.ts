// The platform decision for the `<ENV>_FILE` secret-file mode check. On POSIX the config loader refuses a secret file readable by
// group or other (core resolve.ts, tested in resolve.test.ts), fail closed. Windows reports a synthetic 0666 for every file, so the
// check cannot run there: it is skipped, and the daemon prints this warning at startup instead of refusing every secret.
//
// TODO(secret-file-acl-windows): a Windows secret file's ACL is not inspected; current behavior: the mode check is skipped and the
// startup warning below names the cause and the action. Read the file's DACL and refuse a grant to anyone beyond the owner.

export interface SecretFileModePolicy {
  fileMode?: (path: string) => number;
  warning?: string;
}

export function secretFileModePolicy(platform: NodeJS.Platform, readMode: (path: string) => number): SecretFileModePolicy {
  if (platform !== "win32") return { fileMode: readMode };
  return {
    warning:
      "pomtreed: warning: secret files (<ENV>_FILE) are not checked for access by other users: Windows has no POSIX file modes, so the permission check is skipped; restrict each secret file's ACL to the daemon's account yourself (for example `icacls <file> /inheritance:r /grant:r %USERNAME%:F`)",
  };
}
