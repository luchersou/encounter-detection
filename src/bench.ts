import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Mede o tempo de execução de cada dataset, cada um em um processo novo (como numa
 * execução real), repetindo várias vezes.
 * Uso: node dist/bench.js <arquivo|pasta>... [--vezes N] [--threads N]
 */
const args = process.argv.slice(2);
let vezes = 5;
const extras: string[] = [];
const entradas: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--vezes' || args[i] === '-n') vezes = Number(args[++i]);
  else if (args[i] === '--threads' || args[i] === '-t') extras.push('-t', args[++i]);
  else entradas.push(args[i]);
}

const arquivos = entradas.flatMap((e) =>
  statSync(e).isDirectory()
    ? readdirSync(e)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((n) => join(e, n))
    : [e],
);

const saida = mkdtempSync(join(tmpdir(), 'bench-'));
const programa = join(__dirname, 'index.js');
let somaMedias = 0;

console.log(`${vezes} execuções por dataset (processo novo a cada vez)\n`);
for (const arquivo of arquivos) {
  spawnSync(process.execPath, [programa, arquivo, '-o', saida, ...extras]); // aquece o cache de disco
  const tempos: number[] = [];
  for (let i = 0; i < vezes; i++) {
    const inicio = performance.now();
    const r = spawnSync(process.execPath, [programa, arquivo, '-o', saida, ...extras]);
    tempos.push(performance.now() - inicio);
    if (r.status !== 0) throw new Error(r.stderr.toString());
  }
  tempos.sort((a, b) => a - b);
  const media = tempos.reduce((s, t) => s + t, 0) / tempos.length;
  somaMedias += media;
  console.log(
    `${basename(arquivo).padEnd(14)} média ${media.toFixed(0).padStart(5)} ms   ` +
      `mediana ${tempos[tempos.length >> 1].toFixed(0).padStart(5)} ms   mínimo ${tempos[0].toFixed(0).padStart(5)} ms`,
  );
}
console.log(`\nSoma das médias: ${somaMedias.toFixed(0)} ms`);
rmSync(saida, { recursive: true, force: true });
