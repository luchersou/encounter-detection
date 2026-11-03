export const RAIO_TERRA_METROS = 6_371_000;
export const DISTANCIA_ENCONTRO_METROS = 20;

const GRAUS_PARA_RAD = Math.PI / 180;

/**
 * Distância em metros entre dois pontos pela fórmula de Haversine (R = 6.371.000 m).
 */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * GRAUS_PARA_RAD;
  const phi2 = lat2 * GRAUS_PARA_RAD;
  const dPhi = (lat2 - lat1) * GRAUS_PARA_RAD;
  const dLambda = (lon2 - lon1) * GRAUS_PARA_RAD;

  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);
  const a = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RAIO_TERRA_METROS * c;
}

/**
 * Pré-filtro exato: a distância de Haversine nunca é menor que a distância medida só
 * ao longo do meridiano, R·|Δφ|. Logo, se |Δlat| ≥ 20 m / R (em graus), o par não pode
 * ser um encontro e o Haversine nem precisa ser calculado.
 * A pequena folga absorve erro de arredondamento e não gera falso positivo,
 * porque a decisão final é sempre feita pelo Haversine.
 */
export const DELTA_LAT_MAXIMO_GRAUS =
  (DISTANCIA_ENCONTRO_METROS / RAIO_TERRA_METROS) / GRAUS_PARA_RAD + 1e-9;
