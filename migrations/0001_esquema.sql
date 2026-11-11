-- Esquema do D1, portado de SCHEMA em app.py (coluna lancamentos.provisao_id já incluída).
CREATE TABLE categorias (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE,
    ordem INTEGER NOT NULL DEFAULT 0
);
-- Contas que se repetem todo mês. Vigência por mês (AAAA-MM): 'inicio' e 'fim'
-- (fim NULL = sem data para acabar). Encerrar uma recorrência não apaga o histórico.
CREATE TABLE recorrencias (
    id INTEGER PRIMARY KEY,
    descricao TEXT NOT NULL,
    dia INTEGER NOT NULL CHECK (dia BETWEEN 1 AND 31),
    valor_centavos INTEGER NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    inicio TEXT NOT NULL,
    fim TEXT
);
CREATE TABLE parcelamentos (
    id INTEGER PRIMARY KEY,
    descricao TEXT NOT NULL,
    primeira_parcela TEXT NOT NULL,          -- AAAA-MM-DD
    valor_parcela_centavos INTEGER NOT NULL,
    n_parcelas INTEGER NOT NULL CHECK (n_parcelas >= 1),
    categoria_id INTEGER NOT NULL REFERENCES categorias(id)
);
-- Compras avulsas. 'mes' é o mês em que a despesa conta (ex.: mês da fatura).
CREATE TABLE lancamentos (
    id INTEGER PRIMARY KEY,
    mes TEXT NOT NULL,
    descricao TEXT NOT NULL,
    data TEXT,
    valor_centavos INTEGER NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    pago INTEGER NOT NULL DEFAULT 0,
    provisao_id INTEGER REFERENCES provisoes(id)
);
CREATE INDEX ix_lanc_mes ON lancamentos(mes);
-- Provisões: valor reservado por mês para despesas variáveis; compras com provisao_id consomem a reserva.
CREATE TABLE provisoes (
    id INTEGER PRIMARY KEY,
    descricao TEXT NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    inicio TEXT NOT NULL,
    fim TEXT
);
-- Valor provisionado de um mês específico (vence o valor padrão e a vigência).
CREATE TABLE provisao_meses (
    provisao_id INTEGER NOT NULL REFERENCES provisoes(id) ON DELETE CASCADE,
    mes TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    PRIMARY KEY (provisao_id, mes)
);
-- "Pago" de recorrências e parcelas fica preso ao item (tipo + id) e ao mês,
-- então cadastrar algo novo nunca desloca as marcações dos outros.
CREATE TABLE pagamentos (
    tipo TEXT NOT NULL CHECK (tipo IN ('rec', 'parc')),
    ref_id INTEGER NOT NULL,
    mes TEXT NOT NULL,
    PRIMARY KEY (tipo, ref_id, mes)
);
CREATE TABLE fontes_renda (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE,
    ordem INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE entradas (
    fonte_id INTEGER NOT NULL REFERENCES fontes_renda(id) ON DELETE CASCADE,
    mes TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL,
    PRIMARY KEY (fonte_id, mes)
);
-- Projeções: tudo aqui é hipotético e nunca entra nos totais reais.
CREATE TABLE projecao_entradas (
    mes TEXT PRIMARY KEY,
    valor_centavos INTEGER NOT NULL
);
CREATE TABLE cenarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
    ordem INTEGER NOT NULL DEFAULT 0
);
-- cenario_id NULL = conta prevista, vale para todos os cenários.
CREATE TABLE projecao_contas (
    id INTEGER PRIMARY KEY,
    cenario_id INTEGER REFERENCES cenarios(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL,
    total_centavos INTEGER NOT NULL CHECK (total_centavos > 0),
    n_parcelas INTEGER NOT NULL CHECK (n_parcelas >= 1),
    primeira_parcela TEXT NOT NULL           -- AAAA-MM
);
-- Projeções: ajuste de valor de recorrência/parcela só na projeção; cenario_id NULL = vale para todos.
CREATE TABLE projecao_ajustes (
    id INTEGER PRIMARY KEY,
    cenario_id INTEGER REFERENCES cenarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('rec', 'parc')),
    ref_id INTEGER NOT NULL,
    mes_inicio TEXT NOT NULL,                -- AAAA-MM
    mes_fim TEXT,                            -- AAAA-MM; NULL = sem fim
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    ordem INTEGER NOT NULL DEFAULT 0         -- precedência entre ajustes do mesmo nível: maior ordem vence
);
CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash TEXT NOT NULL
);
CREATE TABLE falhas_login (
    ip TEXT NOT NULL,
    quando REAL NOT NULL
);
CREATE TABLE sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira TEXT NOT NULL
);

INSERT INTO categorias (nome, ordem) VALUES
  ('Moradia', 0),
  ('Alimentação', 1),
  ('Transporte', 2),
  ('Saúde', 3),
  ('Educação', 4),
  ('Lazer', 5),
  ('Assinaturas', 6),
  ('Vestuário', 7),
  ('Outros', 8);
