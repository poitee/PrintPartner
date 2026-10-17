let directory: string | null = null;

export function admitDesktopDataDirectory(dataDir: string | null): void {
  directory = dataDir;
}

export function desktopOwnsDataDirectory(dataDir: string): boolean {
  return directory === dataDir;
}
