export function matchesPlanningPathScope(path: string, scopes: ReadonlySet<string>): boolean {
  for (const scope of scopes) {
    if (scope.endsWith("/**") && path.startsWith(scope.slice(0, -2))) return true;
    if (path === scope) return true;
  }
  return false;
}
