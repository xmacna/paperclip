#!/usr/bin/env bash
# Traz as novidades do upstream (paperclipai/paperclip) para o master do fork xmacna.
# Usa merge (não rebase) para preservar o histórico já publicado em origin.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -z "$(git status --porcelain)" ] || { echo "Árvore suja; commite ou guarde as mudanças antes do sync." >&2; exit 1; }
git fetch upstream
git checkout master
git pull --ff-only origin master
read -r ahead behind < <(git rev-list --left-right --count master...upstream/master)
echo "fork à frente: $ahead | atrás do upstream: $behind"
[ "$behind" = 0 ] && { echo "Já sincronizado."; exit 0; }
git merge --no-edit upstream/master
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
git push origin master
echo "Sync concluído. Rode systemctl --user restart paperclip para aplicar (migrations rodam no próximo dev:once)."
