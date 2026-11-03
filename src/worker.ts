import { parentPort, workerData } from 'node:worker_threads';
import { processarFaixas } from './encontros';
import type { Faixa } from './types';

const { caminho, faixas, contador } = workerData as { caminho: string; faixas: Faixa[]; contador: Int32Array };

parentPort!.postMessage(processarFaixas(caminho, faixas, contador));
