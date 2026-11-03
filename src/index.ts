import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { detectarEncontros } from './encontros';

const USO = `Uso: node dist/index.js <arquivo|pasta>... [--saida <pasta>] [--threads <n>]

  <arquivo|pasta>   datasets a processar (uma pasta processa todos os arquivos dela)
  --saida, -o       pasta onde os JSONs serão gravados (padrão: output)
  --threads, -t     máximo de threads (padrão: núcleos da máquina)

Exemplo: node dist/index.js datasets -o output`;

interface Opcoes {
  entradas: string[];
  saida: string;
  threads: number;
}

function lerArgumentos(args: string[]): Opcoes {
  const opcoes: Opcoes = { entradas: [], saida: 'output', threads: availableParallelism() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--saida' || arg === '-o') opcoes.saida = args[++i];
    else if (arg === '--threads' || arg === '-t') opcoes.threads = Math.max(1, Number(args[++i]) || 1);
    else if (arg === '--help' || arg === '-h') {
      console.log(USO);
      process.exit(0);
    } else opcoes.entradas.push(arg);
  }
  return opcoes;
}

function listarArquivos(entradas: string[]): string[] {
  const arquivos: string[] = [];
  for (const entrada of entradas) {
    if (statSync(entrada).isDirectory()) {
      const nomes = readdirSync(entrada)
        .filter((nome) => statSync(join(entrada, nome)).isFile())
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      arquivos.push(...nomes.map((nome) => join(entrada, nome)));
    } else {
      arquivos.push(entrada);
    }
  }
  return arquivos;
}

/** dataset3.txt -> respostas3.json (mesmo padrão dos arquivos de exemplo). */
function nomeSaida(arquivo: string): string {
  const nome = basename(arquivo, extname(arquivo));
  const numero = /^dataset(\d+)$/i.exec(nome);
  return numero ? `respostas${numero[1]}.json` : `${nome}.json`;
}

async function main(): Promise<void> {
  const opcoes = lerArgumentos(process.argv.slice(2));
  if (opcoes.entradas.length === 0) {
    console.error(USO);
    process.exit(1);
  }

  mkdirSync(opcoes.saida, { recursive: true });

  for (const arquivo of listarArquivos(opcoes.entradas)) {
    const inicio = performance.now();
    const resultado = await detectarEncontros(arquivo, opcoes.threads);
    const destino = join(opcoes.saida, nomeSaida(arquivo));
    writeFileSync(destino, JSON.stringify(resultado.encontros, null, 2));
    const ms = performance.now() - inicio;

    const porTipo = { generico: 0, faccao: 0, protetiva: 0 };
    for (const e of resultado.encontros) porTipo[e.tipo]++;
    console.log(
      `${basename(arquivo)}: ${resultado.encontros.length} encontros ` +
        `(generico ${porTipo.generico}, faccao ${porTipo.faccao}, protetiva ${porTipo.protetiva}) ` +
        `em ${ms.toFixed(1)} ms [${resultado.threads} thread(s)] -> ${destino}`,
    );
    if (resultado.linhasIgnoradas > 0) {
      console.warn(`  aviso: ${resultado.linhasIgnoradas} linha(s) malformada(s) ignorada(s)`);
    }
    if (resultado.foraDeOrdem) {
      console.warn('  aviso: timestamps fora de ordem; o algoritmo assume registros agrupados por timestamp');
    }
  }
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
