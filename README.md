# Detecção de Encontros: Desafio Trainee Tech Spacecom 2027

Solução em **TypeScript (Node.js)**, sem dependências de execução, que lê os datasets de
geolocalização e detecta encontros (distância **< 20 m** no **mesmo timestamp**) entre:

- **generico**: dois monitorados quaisquer;
- **faccao**: dois monitorados da mesma facção;
- **protetiva**: um agressor e a vítima que tem medida protetiva contra ele.

## Como executar

Requisitos: **Node.js 20 ou superior** (desenvolvido e testado no Node 24).

```bash
npm install          # instala só o compilador TypeScript (dependência de desenvolvimento)
npm run build        # compila src/ -> dist/

# processa todos os arquivos de uma pasta (ou arquivos avulsos) e grava os JSONs em output/
node dist/index.js datasets -o output
node dist/index.js datasets/dataset7.txt -o output
```

Os datasets não fazem parte do repositório. Coloque os `.txt` em `datasets/` (ou passe
qualquer outro caminho). Subpastas são ignoradas.

Cada `datasetN.txt` gera `output/respostasN.json`, no mesmo padrão de nome dos exemplos. Opções:

| Opção | Descrição |
|---|---|
| `-o, --saida <pasta>` | pasta de saída (padrão: `output`) |
| `-t, --threads <n>` | máximo de threads (padrão: núcleos lógicos da máquina) |

O tempo é medido sobre o JavaScript já compilado. O TypeScript é compilado antes e não
influencia a execução.

### Scripts auxiliares

```bash
npm test                                                   # testes de casos de borda
npm run validate -- output/respostas1.json datasets/respostas-oficiais/respostas1.json  # compara com uma resposta oficial
npm run bench -- datasets -n 5                             # mede o tempo (processo novo a cada execução)
```

## Resultados

| Dataset | Linhas | Pessoas | Encontros | generico | faccao | protetiva |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 5.000 | 10 | 4 | 2 | 1 | 1 |
| 2 | 25.000 | 20 | 6 | 3 | 2 | 1 |
| 3 | 100.000 | 40 | 10 | 5 | 3 | 2 |
| 4 | 400.020 | 60 | 15 | 7 | 5 | 3 |
| 5 | 1.000.000 | 80 | 21 | 10 | 7 | 4 |
| 6 | 8.000.000 | 100 | 27 | 12 | 9 | 6 |
| 7 | 12.000.000 | 120 | 35 | 15 | 12 | 8 |

Os JSONs estão em [output/](output/).

**Validação:**
- **Datasets 1 e 2:** 100% iguais às respostas oficiais (mesmos pares, timestamps, tipos e
  posições). As distâncias diferem só na 15ª casa significativa (até 4·10⁻¹⁴ m), porque os
  arquivos oficiais exibem a distância com 15 dígitos e o `double` tem 17.
- **Todos os 7 datasets:** conferidos contra uma segunda implementação, escrita à parte e
  propositalmente ingênua (leitura com `readline`, `split`, `parseFloat`, todos os pares
  comparados com todos, sem nenhum filtro). As duas encontram exatamente os mesmos 118
  encontros.
- **Uma thread ou várias:** a saída é idêntica byte a byte.

## Lógica

### 1. Leitura em fluxo, direto nos bytes

Os arquivos maiores têm 423 MB e 638 MB (8 e 12 milhões de linhas). Carregar tudo como texto,
quebrar em linhas e usar `split(';')`/`parseFloat` criaria dezenas de milhões de strings, e
o tempo iria quase todo para o coletor de lixo.

Por isso o arquivo é lido em pedaços de 4 MB, e um parser escrito à mão percorre os bytes
**uma única vez**:

- números (id, facção, ids de restrição) são montados dígito a dígito;
- latitude e longitude são lidas como inteiro e divididas por 10^casas
  (`-31.93195` → `-3193195 / 1e5`). Como os dois operandos são exatos em `double`, o
  resultado é **exatamente** o mesmo valor que `parseFloat` daria;
- o timestamp de cada linha é comparado, 4 bytes por vez, com o timestamp do bloco atual.
  Só quando ele muda é que o bloco anterior é fechado;
- nenhuma string é criada por linha. Strings só existem para os encontros encontrados.

### 2. Processamento por bloco de timestamp

Os registros vêm agrupados por timestamp (a cada 5 s, todas as pessoas). As posições de um
timestamp são guardadas em arrays tipados (`Float64Array`, `Int32Array`). Quando o
timestamp muda, os pares do bloco são comparados e o bloco é descartado. A memória usada
depende só do tamanho de um bloco (até 120 pessoas), e não do tamanho do arquivo.

### 3. Busca de pares: ordenação por latitude + varredura

Comparar todos os pares custaria n²/2 = 7.140 cálculos de Haversine por timestamp no
dataset 7 (714 milhões no total). Em vez disso:

1. **Pré-filtro exato.** A distância de Haversine nunca é menor que a distância ao longo do
   meridiano, `R·|Δφ|`. Logo, se `|Δlat| ≥ 20 m / R` (≈ 0,00018°), o par **não pode** ser
   um encontro. O filtro só descarta pares impossíveis, nunca um encontro verdadeiro.
2. **Ordenação por latitude** com *insertion sort*, **reaproveitando a ordem do timestamp
   anterior**. Em 5 s as pessoas se movem poucos metros, então a ordem quase não muda e a
   ordenação custa praticamente O(n).
3. **Varredura:** para cada pessoa, só olha as seguintes na ordem enquanto
   `Δlat < 0,00018°`. Na prática o laço interno para na primeira comparação, e o
   Haversine completo só é calculado para os poucos pares realmente próximos.

O custo por timestamp passa de O(n²) para praticamente O(n).

### 4. Paralelismo com divisão dinâmica de trabalho

Para arquivos acima de 32 MB:

- o arquivo é dividido em pedaços de ~16 MB, e **os cortes são feitos sempre no início de
  um novo timestamp**. Todas as posições de um instante ficam no mesmo pedaço, então nenhum
  par deixa de ser comparado;
- `worker_threads` e a thread principal pegam o próximo pedaço livre por meio de um
  **contador atômico compartilhado** (`SharedArrayBuffer` + `Atomics.add`). Quem termina
  antes pega mais trabalho, e o desbalanceamento é absorvido sem comunicação entre as
  threads;
- no fim, os resultados são unidos e ordenados por timestamp e ids, o que deixa a saída
  determinística.

Abaixo de 32 MB o processamento é feito numa thread só: subir um worker custa ~50 ms, mais
do que processar o arquivo inteiro.

## Regras de negócio e decisões de interpretação

| Regra | Implementação |
|---|---|
| Distância | Haversine com R = 6.371.000 m |
| Limite | `distancia < 20` (estrito) |
| Timestamps | só são comparadas posições com exatamente o mesmo timestamp |
| Unicidade | cada par aparece no máximo uma vez por timestamp, com os ids em ordem crescente |
| `protetiva` | um dos dois é vítima e o id do outro está no `idsRestricaoMedida` dela |
| `faccao` | nenhum dos dois é vítima e ambos têm a mesma facção (não vazia) |
| `generico` | nenhum dos dois é vítima e não são da mesma facção (inclui facções diferentes ou sem facção) |

O enunciado deixa alguns casos em aberto. As decisões abaixo priorizam **evitar falsos
positivos**, que descontam pontos:

- **Vítima perto de alguém que não é seu agressor:** não é registrado. A vítima não é um
  "monitorado" no sentido dos encontros genéricos (ela usa rastreador portátil, não
  tornozeleira), e a única relação dela que interessa é com o agressor.
- **Prioridade:** se um par é ao mesmo tempo agressor–vítima e da mesma facção, ele é
  `protetiva`. Cada par é registrado uma única vez por timestamp, com um único tipo.
- **Facções diferentes:** o par é `generico`.

Nos 7 datasets fornecidos não aparece nenhum desses casos ambíguos. Também não há pares a
menos de 0,1 m do limite de 20 m. Por isso, as decisões acima não alteram nenhum resultado
entregue.

### Robustez da leitura

O parser aceita quebras de linha `\n` ou `\r\n`, campos com ou sem aspas, arquivo sem `\n`
no final e facção não numérica. Linhas malformadas ou cortadas são ignoradas e contadas
num aviso. Registros repetidos da mesma pessoa no mesmo timestamp são considerados uma vez
só. Se o programa detectar timestamps fora de ordem, ele emite um aviso. Todos esses casos
estão cobertos em `npm test`.

## Desempenho

Máquina de teste: notebook Intel Core i5-1145G7 (4 núcleos, 8 threads), 16 GB de RAM,
Windows 11, Node 24. Mediana de 7 execuções, cada uma num processo novo (inclui a
inicialização do Node, de ~110 ms nesta máquina):

| Dataset | Tamanho | Tempo total do processo |
|---|---:|---:|
| 1 | 0,26 MB | ~110–195 ms |
| 2 | 1,3 MB | ~110 ms |
| 3 | 5,3 MB | ~150–190 ms |
| 4 | 21 MB | ~170 ms |
| 5 | 53 MB | ~340 ms |
| 6 | 423 MB | ~670 ms |
| 7 | 638 MB | ~870 ms |

Esses números são uma referência desta máquina e vão variar em outro hardware. Para
reproduzir a medição, rode `npm run bench -- datasets -n 7`. Cada execução do programa
também mostra o próprio tempo de processamento por dataset.

Nos datasets 1 a 4, o tempo é praticamente só a inicialização do Node. As variações vêm
da própria máquina (outros programas abertos, turbo da CPU).

Como referência, nesta máquina um laço em JavaScript que **apenas percorre os bytes** do
dataset 7, sem fazer nada com eles, leva ~0,9 s numa thread. O parser completo leva
~1,3 s numa thread e ~0,65 s em paralelo.

## Por que esta abordagem

- **Corretude primeiro:** o pré-filtro é matematicamente exato e a decisão final é sempre
  feita pelo Haversine, conforme o enunciado. O resultado foi conferido contra as
  respostas oficiais e contra uma implementação ingênua independente.
- **O gargalo é a leitura, não a geometria:** com até 120 pessoas por timestamp, a parte
  cara é ler 1,1 GB de texto. Por isso o maior investimento foi no parser (uma passada,
  sem criar strings) e no paralelismo da leitura.
- **Escala com os dados:** o tempo cresce de forma linear com o tamanho do arquivo, a
  memória é constante (um bloco + um buffer de 4 MB por thread) e o paralelismo se adapta
  ao número de núcleos da máquina.
- **Sem dependências:** só a biblioteca padrão do Node. O TypeScript é usado só em tempo
  de desenvolvimento.

## Estrutura

```
src/
  index.ts        CLI: lê argumentos, processa cada dataset e grava o JSON
  encontros.ts    orquestração: uma thread ou paralelo (workers + contador atômico)
  detector.ts     parser de bytes, blocos por timestamp, busca de pares e classificação
  particionar.ts  divide o arquivo em faixas alinhadas ao início de um timestamp
  worker.ts       ponto de entrada das worker threads
  geo.ts          Haversine e o limite do pré-filtro
  types.ts        tipos da saída
  validate.ts     compara uma saída com a resposta oficial
  testes.ts       testes de casos de borda
  bench.ts        medição de tempo
output/           JSONs gerados para os 7 datasets
```
