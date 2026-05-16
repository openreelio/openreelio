import { cp, mkdir } from 'node:fs/promises';
import { URL } from 'node:url';

const source = new URL('../tests/e2e/fixtures/', import.meta.url);
const destination = new URL('../dist/tests/e2e/fixtures/', import.meta.url);

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
