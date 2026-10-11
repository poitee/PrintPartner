import { pathToFileURL } from 'node:url';
import { readFileSync, createReadStream } from 'node:fs';
const { extractZipFile, streamSourceUpload } = await import(pathToFileURL(process.argv[2]));
const command = JSON.parse(readFileSync(0, 'utf8'));
try {
  const result = command.operation === 'upload'
    ? await streamSourceUpload(createReadStream(command.zip), command.destination, command.maxBytes)
    : extractZipFile(command.zip, command.destination, command.limits);
  console.log(JSON.stringify({result}));
} catch (error) {
  console.log(JSON.stringify({error: error.message, name: error.name}));
  process.exitCode = 1;
}
