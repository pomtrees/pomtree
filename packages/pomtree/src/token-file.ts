// Pure check on the operator token file's metadata; the caller supplies the stat and uid.
export function tokenFileProblem(st: { mode: number; uid: number }, uid: number | undefined, path: string): string | null {
  if (uid !== undefined && st.uid !== uid) {
    return `${path} is owned by uid ${st.uid}, not you (uid ${uid}); refusing to use it. Fix with: sudo chown "$(id -u)" ${path}`;
  }
  if (st.mode & 0o077) {
    return `${path} is accessible by group/others (mode ${(st.mode & 0o777).toString(8)}); anyone who can read it can control every agent. Fix with: chmod 600 ${path}`;
  }
  return null;
}
