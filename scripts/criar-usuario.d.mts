export function gerarHash(senha: string, sal?: Uint8Array): Promise<string>;
export function sqlUsuario(nome: string, hash: string): string;
