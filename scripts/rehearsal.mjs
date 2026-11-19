// 文本演练台 CLI：本地读取合成资料，按发话时间回放全部通知，
// 输出人工可读的响应草稿报告、可核查 JSON，以及可选的交接回查。
// 不连接、不控制任何设备。

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInputs } from './inspect.mjs';
import { RehearsalEngine } from './lib/engine.mjs';
import { renderHandover, renderRunReport } from './lib/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultData = new URL('../data/inputs.json', import.meta.url);
const defaultOutDir = resolve(here, '../output');

function parseArgs(argv) {
  const args = { data: defaultData, outDir: defaultOutDir, cutoff: null, jsonOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data') args.data = pathToFileURL(resolve(argv[++i]));
    else if (arg === '--out-dir') args.outDir = resolve(argv[++i]);
    else if (arg === '--at') args.cutoff = argv[++i];
    else if (arg === '--json-only') args.jsonOnly = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：node scripts/rehearsal.mjs [--data 路径] [--out-dir 目录] [--at "2026-08-02T00:20:00+08:00"] [--json-only]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const data = await readInputs(args.data);
  const engine = new RehearsalEngine(data);
  const report = engine.run();

  await mkdir(args.outDir, { recursive: true });
  const jsonPath = resolve(args.outDir, 'rehearsal-report.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const outputs = [jsonPath];
  if (!args.jsonOnly) {
    const textPath = resolve(args.outDir, 'rehearsal-report.txt');
    await writeFile(textPath, renderRunReport(report) + '\n', 'utf8');
    outputs.push(textPath);
  }

  if (args.cutoff) {
    const handover = engine.handover(args.cutoff);
    const hJson = resolve(args.outDir, 'handover.json');
    const hTxt = resolve(args.outDir, 'handover.txt');
    await writeFile(hJson, JSON.stringify(handover, null, 2) + '\n', 'utf8');
    if (!args.jsonOnly) await writeFile(hTxt, renderHandover(handover) + '\n', 'utf8');
    outputs.push(hJson, hTxt);
  }

  process.stdout.write(renderRunReport(report) + '\n');
  process.stdout.write(`\n已写出：\n${outputs.map((p) => `- ${p}`).join('\n')}\n`);
  if (args.cutoff) process.stdout.write(`交接回查时点：${args.cutoff}\n`);
}

main().catch((err) => {
  process.stderr.write(`演练台运行失败：${err.stack}\n`);
  process.exit(1);
});
