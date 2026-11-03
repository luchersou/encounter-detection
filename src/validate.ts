import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Encontro } from './types';

/**
 * Compara um JSON gerado com o JSON de resposta esperado.
 * Uso: node dist/validate.js <gerado.json> <esperado.json> [<gerado.json> <esperado.json> ...]
 */
const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('Uso: node dist/validate.js <gerado.json> <esperado.json> [...]');
  process.exit(1);
}

const chave = (e: Encontro): string => {
  const [a, b] = [...e.monitoradosEncontro].sort((x, y) => x - y);
  return `${e.timestamp}|${a}|${b}`;
};

let tudoCerto = true;
for (let i = 0; i < args.length; i += 2) {
  const gerados: Encontro[] = JSON.parse(readFileSync(args[i], 'utf8'));
  const esperados: Encontro[] = JSON.parse(readFileSync(args[i + 1], 'utf8'));
  const mapaEsperado = new Map(esperados.map((e) => [chave(e), e]));

  let corretos = 0;
  let tipoErrado = 0;
  let extras = 0;
  let maiorDiferenca = 0;
  const vistos = new Set<string>();
  for (const g of gerados) {
    const k = chave(g);
    const e = mapaEsperado.get(k);
    if (!e || vistos.has(k)) {
      extras++;
      continue;
    }
    vistos.add(k);
    if (e.tipo !== g.tipo) {
      tipoErrado++;
      continue;
    }
    corretos++;
    maiorDiferenca = Math.max(maiorDiferenca, Math.abs(e.distanciaMetros - g.distanciaMetros));
    for (const id of e.monitoradosEncontro) {
      const pe = e.posicoes[id];
      const pg = g.posicoes[id];
      if (!pg || pe.lat !== pg.lat || pe.lon !== pg.lon) {
        console.log(`  posição divergente: ${k} id ${id}`);
        tudoCerto = false;
      }
    }
  }
  const faltando = esperados.length - vistos.size;
  const ok = corretos === esperados.length && extras === 0 && tipoErrado === 0;
  tudoCerto &&= ok;
  console.log(
    `${ok ? 'OK  ' : 'FALHA'} ${basename(args[i])}: ${corretos}/${esperados.length} corretos, ` +
      `${tipoErrado} tipo errado, ${extras} a mais, ${faltando} faltando, ` +
      `maior diferença de distância ${maiorDiferenca.toExponential(2)} m`,
  );
}
process.exit(tudoCerto ? 0 : 1);
