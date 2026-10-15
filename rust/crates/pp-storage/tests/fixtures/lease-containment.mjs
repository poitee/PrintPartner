import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const { acquireStorageLease } = await import(pathToFileURL(process.argv[2]).href);
const lease = acquireStorageLease(process.argv[3]);
const deadline = setTimeout(() => { process.exitCode = 1; process.stdin.destroy(); }, 120_000);
console.log(`containment ready ${process.pid} ${lease.instance}`);
for await (const line of createInterface({ input: process.stdin })) {
  if (line !== 'ping') throw new Error(`Unexpected command ${line}`);
  console.log(`containment alive ${process.pid}`);
}
clearTimeout(deadline);
lease.release();
