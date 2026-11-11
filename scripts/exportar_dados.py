#!/usr/bin/env python3
"""Exporta os dados do dados.db (SQLite) como um arquivo SQL para carregar no D1 da Cloudflare.

    python3 scripts/exportar_dados.py [--db dados.db] [--saida dados-export.sql]
    npx wrangler d1 execute controle-financeiro --local  --file dados-export.sql     # ensaio local
    npx wrangler d1 execute controle-financeiro --remote --file dados-export.sql     # banco de verdade

- Só INSERTs (um por linha), na ordem das chaves estrangeiras, com os ids preservados.
- Não exporta usuários, sessões nem falhas de login: as senhas são recadastradas no Worker
  (scripts/criar-usuario.mjs), porque o hash antigo usa mais iterações do que a Cloudflare aceita.
- O arquivo começa com `DELETE FROM categorias;` para trocar as 9 categorias padrão da migração pelas suas
  (com os mesmos ids). Por isso só serve num D1 recém-criado: se já houver dados ligados às categorias, o
  DELETE falha pela chave estrangeira e nada é alterado, em vez de apagar o que existe.
- O banco de origem é aberto só para leitura.
"""
import argparse
import sqlite3
import sys
from pathlib import Path

# Pais antes dos filhos (mesma ordem de scripts/gerar_golden.py).
ORDEM_TABELAS = ["categorias", "fontes_renda", "provisoes", "provisao_meses", "recorrencias", "parcelamentos",
                 "lancamentos", "pagamentos", "entradas", "projecao_entradas", "cenarios", "projecao_contas",
                 "projecao_ajustes"]


def literal(v):
    """Valor como literal SQL. Quebras de linha viram char(10)/char(13) para a instrução caber numa linha."""
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, str):
        return "'" + v.replace("'", "''").replace("\r", "'||char(13)||'").replace("\n", "'||char(10)||'") + "'"
    raise TypeError(f"Tipo de valor sem suporte na exportação: {type(v).__name__}")


def exportar(db_path, saida_path):
    """Grava o SQL em `saida_path` e devolve {tabela: número de linhas} das tabelas que existem na origem."""
    db_path = Path(db_path)
    if not db_path.is_file():
        raise FileNotFoundError(f"Banco não encontrado: {db_path}")
    origem = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        existentes = {r[0] for r in origem.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        linhas_sql, contagens = ["DELETE FROM categorias;"], {}
        for tabela in ORDEM_TABELAS:
            if tabela not in existentes:
                continue
            colunas = [r[1] for r in origem.execute(f"PRAGMA table_info({tabela})")]
            lista = ", ".join(colunas)
            n = 0
            for linha in origem.execute(f"SELECT {lista} FROM {tabela} ORDER BY rowid"):
                linhas_sql.append(f"INSERT INTO {tabela} ({lista}) VALUES ({', '.join(literal(v) for v in linha)});")
                n += 1
            contagens[tabela] = n
    finally:
        origem.close()
    cabecalho = [f"-- Exportado de {db_path.name} por scripts/exportar_dados.py. Só para um D1 recém-criado (veja o script)."]
    Path(saida_path).write_text("\n".join(cabecalho + linhas_sql) + "\n", encoding="utf-8")
    return contagens


def main():
    ap = argparse.ArgumentParser(description="Exporta o dados.db como SQL para o D1.")
    ap.add_argument("--db", default=str(Path(__file__).resolve().parent.parent / "dados.db"))
    ap.add_argument("--saida", default="dados-export.sql")
    args = ap.parse_args()
    try:
        contagens = exportar(args.db, args.saida)
    except FileNotFoundError as e:
        sys.exit(str(e))
    print(f"Gravado em {args.saida}:")
    for tabela, n in contagens.items():
        print(f"  {tabela}: {n} linhas")


if __name__ == "__main__":
    main()
