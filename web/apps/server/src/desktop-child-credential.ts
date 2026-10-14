// The parent records a child token Node cannot recompute off Linux, then
// passes that exact token through desktop setup. A recycled PID does not have it.
let credential: string | null = null;

export function presentDesktopChildCredential(identity: string | null): void {
  if (identity !== null && identity.length === 0) throw new Error("Desktop child credential rejected");
  credential = identity;
}

export function desktopChildCredential(): string | null {
  return credential;
}
