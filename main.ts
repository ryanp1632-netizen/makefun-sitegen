// The harness runs `node /bot/main.ts` (node22): read every case from /input/cases.json, build each site with
// solve.js, and write /output/answers.json (a JSON array of the answers, in the cases' order). Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--max-semi-space-size=32');

const { buildJson } = (await import(new URL('./solve.js', import.meta.url).href)) as { buildJson: (input: unknown) => string };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(INPUT_DIR + '/cases.json', 'utf8')) as { id: string; input: unknown }[];
let out = '[';
for (let i = 0; i < cases.length; i++) out += (i === 0 ? '' : ',') + buildJson(cases[i]!.input);
writeFileSync(OUTPUT_DIR + '/answers.json', out + ']');
