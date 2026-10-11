import { pathToFileURL } from 'node:url';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
const { LocalSourceSnapshotStore } = await import(pathToFileURL(process.argv[2]));
const command = JSON.parse(readFileSync(0, 'utf8'));
try {
  const result = await new LocalSourceSnapshotStore({ reposDir: command.reposDir }).materialize({
    sourceId: command.sourceId,
    ...command.snapshot,
    openFile: async (file) => {
      const path = join(command.inputDir, file.path);
      const contentLengthBytes = statSync(path).size;
      return { stream: createReadStream(path), contentLengthBytes };
    },
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({error: error.message}));
  process.exitCode = 1;
}
