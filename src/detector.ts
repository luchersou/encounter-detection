import { closeSync, openSync, readSync } from 'node:fs';
import { DELTA_LAT_MAXIMO_GRAUS, DISTANCIA_ENCONTRO_METROS, haversine } from './geo';
import type { Encontro, Faixa, TipoEncontro } from './types';

const LF = 10;
const ASPAS = 34;
const VIRGULA = 44;
const MENOS = 45;
const PONTO = 46;
const PONTO_VIRGULA = 59;
const ZERO = 48;
const NOVE = 57;

const SEM_FACCAO = -1;
const TAMANHO_LEITURA = 4 * 1024 * 1024;
const POTENCIAS_10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/**
 * Processa um arquivo (ou um trecho dele) e detecta os encontros.
 *
 * Os registros chegam agrupados por timestamp. O detector acumula as posições de um
 * timestamp (um "bloco") em arrays tipados e, quando o timestamp muda, compara os pares
 * do bloco e descarta tudo. A memória usada depende só do tamanho de um bloco, e não do
 * tamanho do arquivo.
 *
 * O parse é feito numa única passada sobre os bytes: não se cria uma string por linha
 * nem se usa split/parseFloat. Strings só são criadas para os encontros encontrados.
 */
export class DetectorEncontros {
  readonly encontros: Encontro[] = [];
  /** true se algum timestamp apareceu fora de ordem (os dados não estariam agrupados). */
  foraDeOrdem = false;
  linhasIgnoradas = 0;

  // Bloco atual (um timestamp). Cada índice é um registro ("slot").
  private n = 0;
  private cap = 256;
  private ids = new Int32Array(this.cap);
  private lats = new Float64Array(this.cap);
  private lons = new Float64Array(this.cap);
  private faccoes = new Int32Array(this.cap);
  private vitimas = new Uint8Array(this.cap);
  private restricaoInicio = new Int32Array(this.cap);
  private restricaoQtd = new Int32Array(this.cap);
  private restricoes = new Int32Array(1024);
  private qtdRestricoes = 0;

  // Ordem dos slots por latitude. É reaproveitada de um bloco para o outro: como as
  // pessoas se movem pouco em 5 s, ela já chega quase ordenada e a ordenação por
  // inserção custa praticamente O(n).
  private ordem = new Int32Array(this.cap);
  private nOrdem = -1;

  // Evita registro duplicado da mesma pessoa no mesmo timestamp.
  private blocoAtual = 0;
  private ultimoBlocoDoId = new Int32Array(1024);

  // Timestamp do bloco atual, com os bytes como estão no arquivo, sem as aspas.
  private timestamp = new Uint8Array(64);
  private timestampPalavras = new Int32Array(16);
  private tamTimestamp = 0;
  private timestampTexto: string | null = null;

  private faccoesTexto = new Map<string, number>();

  /** Lê o trecho [inicio, fim) do arquivo em pedaços e processa as linhas completas. */
  processarArquivo(caminho: string, faixa: Faixa): void {
    const fd = openSync(caminho, 'r');
    try {
      let buf = new Uint8Array(TAMANHO_LEITURA);
      let sobra = 0;
      let pos = faixa.inicio;

      while (pos < faixa.fim) {
        if (sobra >= buf.length - 1) {
          // Linha maior que o buffer: aumenta o buffer.
          const maior = new Uint8Array(buf.length * 2);
          maior.set(buf.subarray(0, sobra));
          buf = maior;
        }
        // Reserva 1 byte para poder terminar a última linha com '\n'.
        const lidos = readSync(fd, buf, sobra, Math.min(buf.length - 1 - sobra, faixa.fim - pos), pos);
        if (lidos === 0) break;
        pos += lidos;
        const total = sobra + lidos;

        if (pos >= faixa.fim) {
          sobra = total;
          break;
        }
        const ultimaQuebra = buf.lastIndexOf(LF, total - 1);
        if (ultimaQuebra < 0) {
          sobra = total;
          continue;
        }
        this.processarLinhas(buf, 0, ultimaQuebra + 1);
        sobra = total - ultimaQuebra - 1;
        buf.copyWithin(0, ultimaQuebra + 1, total);
      }
      if (sobra > 0) {
        // Garante que a última linha termina com '\n' (o arquivo pode não terminar assim).
        if (buf[sobra - 1] !== LF) buf[sobra++] = LF;
        this.processarLinhas(buf, 0, sobra);
      }
    } finally {
      closeSync(fd);
    }
    this.finalizar();
  }

  /**
   * Processa as linhas de buf[inicio, fim). Toda linha precisa terminar com '\n'
   * (buf[fim - 1] === LF), o que dispensa checar o fim do buffer a cada byte.
   */
  processarLinhas(buf: Uint8Array, inicio: number, fim: number): void {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = inicio;
    while (p < fim) {
      const inicioLinha = p;
      let c = buf[p];

      // 1. idMonitorado
      if (c === ASPAS) c = buf[++p];
      let id = 0;
      let digitos = 0;
      while (c >= ZERO && c <= NOVE) {
        id = id * 10 + (c - ZERO);
        digitos++;
        c = buf[++p];
      }
      if (c === ASPAS) c = buf[++p];
      if (digitos === 0 || c !== PONTO_VIRGULA) {
        p = this.ignorarLinha(buf, inicioLinha);
        continue;
      }
      c = buf[++p];

      // 2. faccaoMonitorado (vazio = sem facção)
      let faccao = SEM_FACCAO;
      if (c !== PONTO_VIRGULA) {
        const inicioFaccao = p;
        if (c === ASPAS) c = buf[++p];
        if (c >= ZERO && c <= NOVE) {
          faccao = 0;
          while (c >= ZERO && c <= NOVE) {
            faccao = faccao * 10 + (c - ZERO);
            c = buf[++p];
          }
          if (c === ASPAS) c = buf[++p];
        }
        if (c !== PONTO_VIRGULA) {
          // Facção não numérica (ou vazia entre aspas): caminho lento, raro.
          while (c !== PONTO_VIRGULA && c !== LF) c = buf[++p];
          if (c === LF) {
            p = this.ignorarLinha(buf, inicioLinha);
            continue;
          }
          faccao = this.faccaoTexto(buf, inicioFaccao, p);
        }
      }
      c = buf[++p];

      // 3. timestamp. Caminho rápido: quase toda linha repete o timestamp da anterior,
      // então basta comparar os bytes com o timestamp do bloco atual.
      // O timestamp é guardado sem aspas. A comparação lê 4 bytes por vez (DataView) e o
      // resto byte a byte.
      const tamAtual = this.tamTimestamp;
      const q = c === ASPAS ? p + 1 : p;
      let igual = tamAtual > 0 && q + tamAtual < fim;
      if (igual) {
        const palavras = this.timestampPalavras;
        const nPalavras = tamAtual >> 2;
        for (let w = 0; w < nPalavras; w++) {
          if (dv.getInt32(q + (w << 2), true) !== palavras[w]) {
            igual = false;
            break;
          }
        }
        if (igual) {
          const tsAtual = this.timestamp;
          for (let k = nPalavras << 2; k < tamAtual; k++) {
            if (buf[q + k] !== tsAtual[k]) {
              igual = false;
              break;
            }
          }
        }
      }
      let fimCampoTs = q + tamAtual;
      if (igual && buf[fimCampoTs] === ASPAS) fimCampoTs++;
      let novoTimestamp = false;
      let inicioTs = q;
      let fimTs = q + tamAtual;
      if (igual && buf[fimCampoTs] === PONTO_VIRGULA) {
        p = fimCampoTs;
      } else {
        const inicioCampoTs = p;
        while (c !== PONTO_VIRGULA && c !== LF) c = buf[++p];
        inicioTs = buf[inicioCampoTs] === ASPAS ? inicioCampoTs + 1 : inicioCampoTs;
        fimTs = p > inicioTs && buf[p - 1] === ASPAS ? p - 1 : p;
        if (c !== PONTO_VIRGULA || fimTs <= inicioTs) {
          p = this.ignorarLinha(buf, inicioLinha);
          continue;
        }
        novoTimestamp = !this.mesmoTimestamp(buf, inicioTs, fimTs);
      }
      c = buf[++p];

      // 4. latitude: inteiro / 10^casas (mesmo double que parseFloat produziria)
      let inicioCampo = p;
      if (c === ASPAS) c = buf[++p];
      let negativo = false;
      if (c === MENOS) {
        negativo = true;
        c = buf[++p];
      }
      let mantissa = 0;
      digitos = 0;
      let casas = 0;
      while (c >= ZERO && c <= NOVE) {
        mantissa = mantissa * 10 + (c - ZERO);
        digitos++;
        c = buf[++p];
      }
      if (c === PONTO) {
        c = buf[++p];
        while (c >= ZERO && c <= NOVE) {
          mantissa = mantissa * 10 + (c - ZERO);
          digitos++;
          casas++;
          c = buf[++p];
        }
      }
      if (c === ASPAS) c = buf[++p];
      let lat: number;
      if (c === PONTO_VIRGULA && digitos > 0 && digitos <= 15) {
        lat = mantissa / POTENCIAS_10[casas];
        if (negativo) lat = -lat;
      } else {
        while (c !== PONTO_VIRGULA && c !== LF) c = buf[++p];
        lat = c === PONTO_VIRGULA ? decimalLento(buf, inicioCampo, p) : NaN;
      }
      if (lat !== lat) {
        p = this.ignorarLinha(buf, inicioLinha);
        continue;
      }
      c = buf[++p];

      // 5. longitude (mesma lógica)
      inicioCampo = p;
      if (c === ASPAS) c = buf[++p];
      negativo = false;
      if (c === MENOS) {
        negativo = true;
        c = buf[++p];
      }
      mantissa = 0;
      digitos = 0;
      casas = 0;
      while (c >= ZERO && c <= NOVE) {
        mantissa = mantissa * 10 + (c - ZERO);
        digitos++;
        c = buf[++p];
      }
      if (c === PONTO) {
        c = buf[++p];
        while (c >= ZERO && c <= NOVE) {
          mantissa = mantissa * 10 + (c - ZERO);
          digitos++;
          casas++;
          c = buf[++p];
        }
      }
      if (c === ASPAS) c = buf[++p];
      let lon: number;
      if (c === PONTO_VIRGULA && digitos > 0 && digitos <= 15) {
        lon = mantissa / POTENCIAS_10[casas];
        if (negativo) lon = -lon;
      } else {
        while (c !== PONTO_VIRGULA && c !== LF) c = buf[++p];
        lon = c === PONTO_VIRGULA ? decimalLento(buf, inicioCampo, p) : NaN;
      }
      if (lon !== lon) {
        p = this.ignorarLinha(buf, inicioLinha);
        continue;
      }
      c = buf[++p];

      // 6. medidaProtetiva
      if (c === ASPAS) c = buf[++p];
      const vitima = c === 116 /* t */ || c === 84 /* T */ || c === 49; /* 1 */
      // Para no ';' antes de idsRestricaoMedida ou no fim da linha, se a coluna faltar.
      while (c !== PONTO_VIRGULA && c !== LF) c = buf[++p];

      // Linha válida. Se o timestamp mudou, fecha o bloco anterior.
      if (novoTimestamp) {
        this.fecharBloco();
        this.iniciarBloco(buf, inicioTs, fimTs - inicioTs);
      }

      // Registro repetido da mesma pessoa no mesmo timestamp: mantém o primeiro.
      if (id >= this.ultimoBlocoDoId.length) this.ultimoBlocoDoId = crescer(this.ultimoBlocoDoId, id + 1);
      if (this.ultimoBlocoDoId[id] === this.blocoAtual) {
        while (c !== LF) c = buf[++p];
        p++;
        continue;
      }
      this.ultimoBlocoDoId[id] = this.blocoAtual;

      if (this.n === this.cap) this.crescerBloco();
      const s = this.n++;
      this.ids[s] = id;
      this.lats[s] = lat;
      this.lons[s] = lon;
      this.faccoes[s] = faccao;
      this.vitimas[s] = vitima ? 1 : 0;
      this.restricaoInicio[s] = this.qtdRestricoes;

      // 7. idsRestricaoMedida: "1,2,3" (só interessa para vítimas)
      if (c === PONTO_VIRGULA) c = buf[++p];
      if (vitima) {
        let valor = 0;
        let temDigito = false;
        while (c !== LF) {
          if (c >= ZERO && c <= NOVE) {
            valor = valor * 10 + (c - ZERO);
            temDigito = true;
          } else if (c === VIRGULA || c === PONTO_VIRGULA) {
            if (temDigito) this.adicionarRestricao(valor);
            valor = 0;
            temDigito = false;
          }
          c = buf[++p];
        }
        if (temDigito) this.adicionarRestricao(valor);
      } else {
        while (c !== LF) c = buf[++p];
      }
      this.restricaoQtd[s] = this.qtdRestricoes - this.restricaoInicio[s];
      p++;
    }
  }

  /**
   * Fecha o último bloco. Deve ser chamado depois da última linha. O próximo trecho
   * processado (se houver) começa um bloco novo.
   */
  finalizar(): void {
    this.fecharBloco();
    this.tamTimestamp = 0;
  }

  /** Pula uma linha que não é um registro válido (cabeçalho, linha cortada etc.). */
  private ignorarLinha(buf: Uint8Array, inicio: number): number {
    const fim = buf.indexOf(LF, inicio);
    const texto = Buffer.from(buf.buffer, buf.byteOffset + inicio, fim - inicio).toString('latin1').trim();
    if (texto.length > 0 && !texto.startsWith('idMonitorado')) this.linhasIgnoradas++;
    return fim + 1;
  }

  private faccaoTexto(buf: Uint8Array, inicio: number, fim: number): number {
    const texto = Buffer.from(buf.buffer, buf.byteOffset + inicio, fim - inicio)
      .toString('latin1')
      .replace(/"/g, '')
      .trim();
    if (texto === '') return SEM_FACCAO;
    if (/^\d+$/.test(texto)) return Number(texto);
    let codigo = this.faccoesTexto.get(texto);
    if (codigo === undefined) {
      codigo = -2 - this.faccoesTexto.size;
      this.faccoesTexto.set(texto, codigo);
    }
    return codigo;
  }

  private mesmoTimestamp(buf: Uint8Array, inicio: number, fim: number): boolean {
    const tam = fim - inicio;
    if (tam !== this.tamTimestamp) return false;
    for (let i = 0; i < tam; i++) {
      if (buf[inicio + i] !== this.timestamp[i]) return false;
    }
    return true;
  }

  private iniciarBloco(buf: Uint8Array, inicio: number, tam: number): void {
    if (tam > this.timestamp.length) {
      this.timestamp = new Uint8Array(tam * 2);
      this.timestampPalavras = new Int32Array(tam >> 1);
    }
    if (this.tamTimestamp > 0 && !this.foraDeOrdem) {
      // Registra se os dados vierem fora de ordem (timestamp menor que o anterior).
      const anterior = this.timestamp.subarray(0, this.tamTimestamp);
      if (Buffer.compare(buf.subarray(inicio, inicio + tam), anterior) < 0) this.foraDeOrdem = true;
    }
    this.timestamp.set(buf.subarray(inicio, inicio + tam));
    const dv = new DataView(this.timestamp.buffer);
    for (let w = 0; w < tam >> 2; w++) this.timestampPalavras[w] = dv.getInt32(w << 2, true);
    this.tamTimestamp = tam;
    this.timestampTexto = null;
    this.blocoAtual++;
  }

  private adicionarRestricao(id: number): void {
    if (this.qtdRestricoes === this.restricoes.length) {
      this.restricoes = crescer(this.restricoes, this.restricoes.length * 2);
    }
    this.restricoes[this.qtdRestricoes++] = id;
  }

  private crescerBloco(): void {
    const cap = this.cap * 2;
    this.ids = crescer(this.ids, cap);
    this.lats = crescer(this.lats, cap);
    this.lons = crescer(this.lons, cap);
    this.faccoes = crescer(this.faccoes, cap);
    this.vitimas = crescer(this.vitimas, cap);
    this.restricaoInicio = crescer(this.restricaoInicio, cap);
    this.restricaoQtd = crescer(this.restricaoQtd, cap);
    this.ordem = crescer(this.ordem, cap);
    this.cap = cap;
  }

  /** Compara os pares do bloco atual e o esvazia. */
  private fecharBloco(): void {
    const n = this.n;
    if (n >= 2) this.detectarNoBloco(n);
    this.n = 0;
    this.qtdRestricoes = 0;
  }

  private detectarNoBloco(n: number): void {
    const lats = this.lats;
    const ordem = this.ordem;

    if (n !== this.nOrdem) {
      for (let i = 0; i < n; i++) ordem[i] = i;
      this.nOrdem = n;
    }

    // Ordenação por inserção por latitude. Como a ordem anterior é reaproveitada,
    // ela já chega quase ordenada.
    for (let i = 1; i < n; i++) {
      const s = ordem[i];
      const lat = lats[s];
      let j = i - 1;
      while (j >= 0 && lats[ordem[j]] > lat) {
        ordem[j + 1] = ordem[j];
        j--;
      }
      ordem[j + 1] = s;
    }

    // Varredura: para cada ponto, só olha os seguintes enquanto Δlat < limite.
    // Quase sempre o próximo já está longe e o laço interno para na primeira comparação.
    const lons = this.lons;
    const limite = DELTA_LAT_MAXIMO_GRAUS;
    for (let i = 0; i < n - 1; i++) {
      const a = ordem[i];
      const latA = lats[a];
      for (let j = i + 1; j < n; j++) {
        const b = ordem[j];
        const latB = lats[b];
        if (latB - latA >= limite) break;
        const d = haversine(latA, lons[a], latB, lons[b]);
        if (d < DISTANCIA_ENCONTRO_METROS) this.registrar(a, b, d);
      }
    }
  }

  private registrar(a: number, b: number, distancia: number): void {
    const idA = this.ids[a];
    const idB = this.ids[b];
    if (idA === idB) return;

    const tipo = this.classificar(a, b);
    if (tipo === null) return;

    const [s1, s2] = idA < idB ? [a, b] : [b, a];
    const id1 = this.ids[s1];
    const id2 = this.ids[s2];
    if (this.timestampTexto === null) {
      this.timestampTexto = Buffer.from(this.timestamp.buffer, 0, this.tamTimestamp).toString('latin1').trim();
    }
    this.encontros.push({
      tipo,
      monitoradosEncontro: [id1, id2],
      timestamp: this.timestampTexto,
      posicoes: {
        [id1]: { lat: this.lats[s1], lon: this.lons[s1] },
        [id2]: { lat: this.lats[s2], lon: this.lons[s2] },
      },
      distanciaMetros: distancia,
    });
  }

  /**
   * Regras de classificação, em ordem de prioridade:
   * 1. protetiva: um é vítima e o outro está na lista de agressores dela;
   * 2. vítima com qualquer outra pessoa: não é encontro (vítima não usa tornozeleira);
   * 3. faccao: dois monitorados da mesma facção;
   * 4. generico: quaisquer outros dois monitorados.
   */
  private classificar(a: number, b: number): TipoEncontro | null {
    if (this.restringe(a, b) || this.restringe(b, a)) return 'protetiva';
    if (this.vitimas[a] || this.vitimas[b]) return null;
    const fa = this.faccoes[a];
    if (fa !== SEM_FACCAO && fa === this.faccoes[b]) return 'faccao';
    return 'generico';
  }

  /** true se o slot `vitima` tem medida protetiva contra o id do slot `outro`. */
  private restringe(vitima: number, outro: number): boolean {
    if (!this.vitimas[vitima]) return false;
    const idOutro = this.ids[outro];
    const inicio = this.restricaoInicio[vitima];
    const fim = inicio + this.restricaoQtd[vitima];
    for (let i = inicio; i < fim; i++) {
      if (this.restricoes[i] === idOutro) return true;
    }
    return false;
  }
}

/** Caminho lento para números fora do padrão (mais de 15 dígitos, vírgula decimal etc.). */
function decimalLento(buf: Uint8Array, inicio: number, fim: number): number {
  const texto = Buffer.from(buf.buffer, buf.byteOffset + inicio, fim - inicio)
    .toString('latin1')
    .replace(/"/g, '')
    .replace(',', '.')
    .trim();
  return texto === '' ? NaN : Number(texto);
}

function crescer<T extends Int32Array | Float64Array | Uint8Array>(arr: T, tamanho: number): T {
  const novo = new (arr.constructor as new (n: number) => T)(Math.max(tamanho, arr.length * 2));
  novo.set(arr);
  return novo;
}
