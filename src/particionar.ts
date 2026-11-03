import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Faixa } from './types';

const LF = 10;
const PONTO_VIRGULA = 59;
const JANELA_INICIAL = 256 * 1024;

/**
 * Divide o arquivo em até `partes` faixas de tamanho parecido para processar em paralelo.
 *
 * Os cortes nunca caem no meio de um bloco de timestamp: cada corte é levado até o
 * início do próximo timestamp. Assim, todas as posições de um mesmo instante ficam na
 * mesma faixa e nenhum par deixa de ser comparado.
 */
export function particionar(caminho: string, partes: number): Faixa[] {
  const fd = openSync(caminho, 'r');
  try {
    const tamanho = fstatSync(fd).size;
    const cortes = [0];
    for (let i = 1; i < partes; i++) {
      const aprox = Math.floor((tamanho * i) / partes);
      if (aprox <= cortes[cortes.length - 1]) continue;
      const corte = inicioDoProximoBloco(fd, aprox, tamanho);
      if (corte > cortes[cortes.length - 1] && corte < tamanho) cortes.push(corte);
    }
    cortes.push(tamanho);

    const faixas: Faixa[] = [];
    for (let i = 0; i < cortes.length - 1; i++) faixas.push({ inicio: cortes[i], fim: cortes[i + 1] });
    return faixas;
  } finally {
    closeSync(fd);
  }
}

/**
 * A partir de `pos`, encontra o offset da primeira linha cujo timestamp é diferente do
 * timestamp da primeira linha completa depois de `pos`.
 */
function inicioDoProximoBloco(fd: number, pos: number, tamanho: number): number {
  let janela = JANELA_INICIAL;
  for (;;) {
    const buf = Buffer.allocUnsafe(Math.min(janela, tamanho - pos));
    const lidos = readSync(fd, buf, 0, buf.length, pos);
    const fimLido = pos + lidos >= tamanho;

    let p = buf.indexOf(LF, 0);
    if (p < 0 || p + 1 >= lidos) {
      if (fimLido) return tamanho;
      janela *= 2;
      continue;
    }
    p++;

    let referencia: string | null = null;
    while (p < lidos) {
      const q = buf.indexOf(LF, p);
      if (q < 0 && !fimLido) break; // linha incompleta: precisa de janela maior
      const fimLinha = q < 0 ? lidos : q;
      const ts = timestampDaLinha(buf, p, fimLinha);
      if (ts !== null) {
        if (referencia === null) referencia = ts;
        else if (ts !== referencia) return pos + p;
      }
      if (q < 0) break;
      p = q + 1;
    }
    if (fimLido) return tamanho;
    janela *= 2;
  }
}

function timestampDaLinha(buf: Buffer, inicio: number, fim: number): string | null {
  const p1 = buf.indexOf(PONTO_VIRGULA, inicio);
  if (p1 < 0 || p1 >= fim) return null;
  const p2 = buf.indexOf(PONTO_VIRGULA, p1 + 1);
  if (p2 < 0 || p2 >= fim) return null;
  const p3 = buf.indexOf(PONTO_VIRGULA, p2 + 1);
  if (p3 < 0 || p3 >= fim) return null;
  return buf.toString('latin1', p2 + 1, p3).replace(/"/g, '');
}
