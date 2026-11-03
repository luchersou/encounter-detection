import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processarFaixas } from './encontros';
import { haversine } from './geo';
import { particionar } from './particionar';
import type { Encontro } from './types';

/**
 * Testes de casos de borda que os datasets fornecidos não cobrem.
 * Uso: node dist/testes.js
 */
const pasta = mkdtempSync(join(tmpdir(), 'testes-encontros-'));
let n = 0;

function detectar(conteudo: string): Encontro[] {
  const arquivo = join(pasta, `caso${n++}.txt`);
  writeFileSync(arquivo, conteudo);
  return processarFaixas(arquivo, [{ inicio: 0, fim: statSync(arquivo).size }]).encontros;
}

const CABECALHO = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const linha = (id: number, faccao: string, ts: string, lat: string, lon: string, vitima = false, restricoes = '') =>
  `${id};${faccao};"${ts}";${lat};${lon};${vitima};${restricoes ? `"${restricoes}"` : ''}`;
const T0 = '2024-01-01 00:00:00';
const T1 = '2024-01-01 00:00:05';

const casos: [string, () => void][] = [
  ['detecta os três tipos de encontro', () => {
    const r = detectar([
      CABECALHO,
      linha(1, '', T0, '-10.00000', '-40.00000'),
      linha(2, '', T0, '-10.00005', '-40.00000'),
      linha(3, '7', T0, '-20.00000', '-40.00000'),
      linha(4, '7', T0, '-20.00005', '-40.00000'),
      linha(5, '', T0, '-30.00000', '-40.00000', true, '6'),
      linha(6, '', T0, '-30.00005', '-40.00000'),
    ].join('\n'));
    r.sort((a, b) => a.monitoradosEncontro[0] - b.monitoradosEncontro[0]);
    assert.deepEqual(r.map((e) => [e.tipo, ...e.monitoradosEncontro]), [
      ['generico', 1, 2],
      ['faccao', 3, 4],
      ['protetiva', 5, 6],
    ]);
  }],

  ['limite de 20 m é estrito (0,00017° ≈ 18,9 m entra; 0,00018° ≈ 20,02 m não)', () => {
    assert.ok(haversine(0, 0, 0.00017, 0) < 20);
    assert.ok(haversine(0, 0, 0.00018, 0) >= 20);
    const r = detectar([
      CABECALHO,
      linha(1, '', T0, '0.00000', '0.00000'),
      linha(2, '', T0, '0.00017', '0.00000'),
      linha(3, '', T0, '10.00000', '0.00000'),
      linha(4, '', T0, '10.00018', '0.00000'),
    ].join('\n'));
    assert.deepEqual(r.map((e) => e.monitoradosEncontro), [[1, 2]]);
  }],

  ['só compara posições com o mesmo timestamp', () => {
    const r = detectar([CABECALHO, linha(1, '', T0, '1.00000', '1.00000'), linha(2, '', T1, '1.00000', '1.00000')].join('\n'));
    assert.equal(r.length, 0);
  }],

  ['facções diferentes geram encontro genérico', () => {
    const r = detectar([CABECALHO, linha(1, '1', T0, '1.00000', '1.00000'), linha(2, '2', T0, '1.00001', '1.00000')].join('\n'));
    assert.equal(r[0].tipo, 'generico');
  }],

  ['vítima com quem não é seu agressor não é encontro', () => {
    const r = detectar([
      CABECALHO,
      linha(1, '', T0, '1.00000', '1.00000', true, '9'),
      linha(2, '', T0, '1.00001', '1.00000'),
    ].join('\n'));
    assert.equal(r.length, 0);
  }],

  ['vítima com vários agressores', () => {
    const r = detectar([
      CABECALHO,
      linha(1, '', T0, '1.00000', '1.00000', true, '3,7,12'),
      linha(7, '4', T0, '1.00001', '1.00000'),
    ].join('\n'));
    assert.deepEqual(r.map((e) => [e.tipo, ...e.monitoradosEncontro]), [['protetiva', 1, 7]]);
  }],

  ['protetiva tem prioridade sobre facção e ids saem em ordem crescente', () => {
    const r = detectar([
      CABECALHO,
      linha(9, '', T0, '1.00000', '1.00000', true, '2'),
      linha(2, '', T0, '1.00001', '1.00000'),
    ].join('\n'));
    assert.deepEqual(r[0].monitoradosEncontro, [2, 9]);
    assert.equal(r[0].tipo, 'protetiva');
  }],

  ['saída no formato exigido', () => {
    const [e] = detectar([CABECALHO, linha(40, '1', T0, '-10.07996', '-37.08384'), linha(44, '1', T0, '-10.07987', '-37.08389')].join('\n'));
    assert.deepEqual(e, {
      tipo: 'faccao',
      monitoradosEncontro: [40, 44],
      timestamp: T0,
      posicoes: { 40: { lat: -10.07996, lon: -37.08384 }, 44: { lat: -10.07987, lon: -37.08389 } },
      distanciaMetros: e.distanciaMetros,
    });
    assert.ok(Math.abs(e.distanciaMetros - 11.406788673336607) < 1e-9);
  }],

  ['aceita CRLF, timestamp sem aspas e arquivo sem "\\n" no final', () => {
    const r = detectar(
      [CABECALHO, linha(1, '', T0, '1.00000', '1.00000'), `2;;${T0};1.00001;1.00000;false;`].join('\r\n'),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].timestamp, T0);
  }],

  ['ignora linha cortada ou malformada sem quebrar', () => {
    const r = detectar([
      CABECALHO,
      linha(1, '', T0, '1.00000', '1.00000'),
      'lixo;;;',
      '',
      linha(2, '', T0, '1.00001', '1.00000'),
      `3;;"${T0}";1.0000`,
    ].join('\n'));
    assert.deepEqual(r.map((e) => e.monitoradosEncontro), [[1, 2]]);
  }],

  ['registro duplicado da mesma pessoa no mesmo timestamp não duplica o encontro', () => {
    const r = detectar([
      CABECALHO,
      linha(1, '', T0, '1.00000', '1.00000'),
      linha(1, '', T0, '1.00000', '1.00000'),
      linha(2, '', T0, '1.00001', '1.00000'),
    ].join('\n'));
    assert.equal(r.length, 1);
  }],

  ['facção não numérica', () => {
    const r = detectar([CABECALHO, linha(1, 'PCX', T0, '1.00000', '1.00000'), linha(2, 'PCX', T0, '1.00001', '1.00000')].join('\n'));
    assert.equal(r[0].tipo, 'faccao');
  }],

  ['avisa quando os timestamps estão fora de ordem', () => {
    const arquivo = join(pasta, 'desordem.txt');
    writeFileSync(arquivo, [CABECALHO, linha(1, '', T1, '1.00000', '1.00000'), linha(1, '', T0, '1.00000', '1.00000')].join('\n'));
    assert.equal(processarFaixas(arquivo, [{ inicio: 0, fim: statSync(arquivo).size }]).foraDeOrdem, true);
  }],

  ['divisão em faixas paralelas dá o mesmo resultado que uma faixa só', () => {
    const linhas = [CABECALHO];
    for (let t = 0; t < 2000; t++) {
      const ts = new Date(Date.UTC(2024, 0, 1) + t * 5000).toISOString().replace('T', ' ').slice(0, 19);
      for (let id = 1; id <= 30; id++) {
        // A cada 7 timestamps, os ids 1 e 2 se encontram.
        const lat = id === 2 && t % 7 === 0 ? 1 : id;
        linhas.push(linha(id, String(id % 3), ts, lat.toFixed(5), '1.00000'));
      }
    }
    const arquivo = join(pasta, 'grande.txt');
    writeFileSync(arquivo, linhas.join('\n'));
    const tamanho = statSync(arquivo).size;
    const unico = processarFaixas(arquivo, [{ inicio: 0, fim: tamanho }]).encontros;
    const faixas = particionar(arquivo, 13);
    assert.ok(faixas.length > 1);
    const paralelo = processarFaixas(arquivo, faixas, new Int32Array(new SharedArrayBuffer(4))).encontros;
    assert.equal(unico.length, Math.ceil(2000 / 7));
    assert.deepEqual(
      new Set(paralelo.map((e) => e.timestamp)),
      new Set(unico.map((e) => e.timestamp)),
    );
    assert.equal(paralelo.length, unico.length);
  }],
];

let falhas = 0;
for (const [nome, teste] of casos) {
  try {
    teste();
    console.log(`ok    ${nome}`);
  } catch (erro) {
    falhas++;
    console.log(`FALHA ${nome}\n      ${(erro as Error).message.split('\n').join('\n      ')}`);
  }
}
rmSync(pasta, { recursive: true, force: true });
console.log(`\n${casos.length - falhas}/${casos.length} testes passaram`);
process.exit(falhas ? 1 : 0);
