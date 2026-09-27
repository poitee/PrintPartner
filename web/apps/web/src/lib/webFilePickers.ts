/** Browser file pickers and save dialogs. */

function pickFilesFromInput(input: HTMLInputElement): Promise<File[]> {
  return new Promise((resolve) => {
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(files);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

function pickFileObject(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Pick one or more STL files from the user's machine. */
export async function pickLocalFilesWeb(): Promise<File[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".stl,model/stl,application/sla";
  input.style.display = "none";
  return pickFilesFromInput(input);
}

/** Pick a folder tree via the browser directory picker (all files under the folder). */
export async function pickLocalDirectoryWeb(): Promise<File[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".stl,model/stl,application/sla";
  input.style.display = "none";
  (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
  return pickFilesFromInput(input);
}

export async function pickKitBundleFileWeb(): Promise<File | null> {
  return pickFileObject(".zip,.kit,.json,application/zip");
}

export async function pickZipArchiveFileWeb(): Promise<File | null> {
  return pickFileObject(".zip,application/zip");
}
