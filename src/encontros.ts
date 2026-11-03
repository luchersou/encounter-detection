import { statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DetectorEncontros } from './detector';
import { particionar } from './particionar';
import type { Encontro, Faixa } from './types';

/**
 * Abaixo deste tamanho o processamento é feito numa thread só: subir um worker custa
 * ~50 ms, mais do que processar o arquivo inteiro.
 */
const TAMANHO_MINIMO_PARALELO = 32 * 1024 * 1024;
/** Tamanho aproximado de cada pedaço distribuído entre as threads. */
const TAMANHO_PEDACO = 16 * 1024 * 1024;

export interface ResultadoParcial {
  encontros: Encontro[];
  foraDeOrdem: boolean;
  linhasIgnoradas: number;
}

export interface ResultadoDeteccao extends ResultadoParcial {
  threads: number;
}

export async function detectarEncontros(caminho: string, maxThreads = availableParallelism()): Promise<ResultadoDeteccao> {
  const tamanho = statSync(caminho).size;
  const threads = tamanho < TAMANHO_MINIMO_PARALELO ? 1 : Math.max(1, maxThreads);

  let resultado: ResultadoDeteccao;
  if (threads === 1) {
    const unico = processarFaixas(caminho, [{ inicio: 0, fim: tamanho }]);
    resultado = { ...unico, threads: 1 };
  } else {
    // O arquivo é dividido em mais pedaços do que threads. Cada thread (inclusive a
    // principal) pega o próximo pedaço livre por um contador atômico compartilhado, então
    // quem termina antes pega mais trabalho e nenhuma thread fica esperando as outras.
    const faixas = particionar(caminho, Math.max(threads, Math.ceil(tamanho / TAMANHO_PEDACO)));
    const contador = new Int32Array(new SharedArrayBuffer(4));
    const workers = Array.from({ length: Math.min(threads, faixas.length) - 1 }, () =>
      executarWorker(caminho, faixas, contador),
    );
    const principal = processarFaixas(caminho, faixas, contador);
    const parciais = [principal, ...(await Promise.all(workers))];
    resultado = {
      encontros: parciais.flatMap((r) => r.encontros),
      foraDeOrdem: parciais.some((r) => r.foraDeOrdem),
      linhasIgnoradas: parciais.reduce((soma, r) => soma + r.linhasIgnoradas, 0),
      threads: parciais.length,
    };
  }

  resultado.encontros.sort(compararEncontros);
  return resultado;
}

/**
 * Processa faixas do arquivo. Sem contador, processa todas; com contador, vai pegando
 * a próxima faixa livre até acabarem (usado em paralelo por várias threads).
 */
export function processarFaixas(caminho: string, faixas: Faixa[], contador?: Int32Array): ResultadoParcial {
  const detector = new DetectorEncontros();
  if (contador) {
    for (let i = Atomics.add(contador, 0, 1); i < faixas.length; i = Atomics.add(contador, 0, 1)) {
      detector.processarArquivo(caminho, faixas[i]);
    }
  } else {
    for (const faixa of faixas) detector.processarArquivo(caminho, faixa);
  }
  return {
    encontros: detector.encontros,
    foraDeOrdem: detector.foraDeOrdem,
    linhasIgnoradas: detector.linhasIgnoradas,
  };
}

function executarWorker(caminho: string, faixas: Faixa[], contador: Int32Array): Promise<ResultadoParcial> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'worker.js'), { workerData: { caminho, faixas, contador } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (codigo) => {
      if (codigo !== 0) reject(new Error(`Worker terminou com código ${codigo}`));
    });
  });
}

/** Ordem determinística da saída: timestamp e depois os ids do par. */
function compararEncontros(a: Encontro, b: Encontro): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return (
    a.monitoradosEncontro[0] - b.monitoradosEncontro[0] || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]
  );
}
