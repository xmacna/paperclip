# Paperclip — fork xmacna

Fork de `paperclipai/paperclip` usado para rodar o Paperclip local do Rafael e
desenvolver funcionalidades próprias. Guia do projeto (upstream): @AGENTS.md

## Remotes

- `origin` = `xmacna/paperclip` (fork **público**; forks de repo público não podem ser privados).
- `upstream` = `paperclipai/paperclip`, somente leitura (push desativado).

## Rodar

- `xmacna/abrir.sh` (é o que o atalho "Paperclip" da área de trabalho chama):
  `pnpm dev:once` na porta 3100 e abre o navegador.
- Estado em `~/.paperclip/instances/default` (postgres embutido na porta 54329),
  compartilhado com o CLI npm `paperclipai`; rode só um dos dois por vez.
- Requer Node >= 24.11, pnpm 9 via `corepack pnpm`, e Rust (`~/.cargo/bin`) para
  compilar o `paperclip-runnerd`.

## Sincronizar com o upstream

`xmacna/sync.sh`: faz fetch do upstream, merge em `master`, `pnpm install` e push para origin.
Merge, nunca rebase, porque o master do fork já foi publicado.

## Customizações próprias

- Manter o diff contra o upstream pequeno e localizado para os merges seguirem limpos;
  preferir plugins (`packages/plugins/`) e arquivos novos a editar arquivos centrais.
- Não commitar `pnpm-lock.yaml` alterado só por customização; no upstream, o CI é
  dono do lockfile.
- Mudança útil para todos pode virar PR no upstream, a partir de uma branch do fork.
