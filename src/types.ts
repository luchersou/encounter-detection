export type TipoEncontro = 'generico' | 'faccao' | 'protetiva';

export interface Posicao {
  lat: number;
  lon: number;
}

export interface Encontro {
  tipo: TipoEncontro;
  monitoradosEncontro: [number, number];
  timestamp: string;
  posicoes: Record<string, Posicao>;
  distanciaMetros: number;
}

/** Intervalo de bytes [inicio, fim) de um arquivo, alinhado ao início de um bloco de timestamp. */
export interface Faixa {
  inicio: number;
  fim: number;
}
