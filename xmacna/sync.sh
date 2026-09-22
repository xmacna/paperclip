#!/usr/bin/env bash
# Sincroniza o fork xmacna com o upstream (paperclipai/paperclip).
# - master: espelho idêntico do upstream/master (só fast-forward, nunca recebe commit nosso).
# - xmacna: versão de produção do Rafael; recebe merge (não rebase) do master.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -z "$(git status --porcelain)" ] || { echo "Árvore suja; commite ou guarde as mudanças antes do sync." >&2; exit 1; }
git fetch upstream
git fetch origin
# master = upstream/master. Se o master local tiver commit próprio, o ff falha e paramos.
git branch -f master upstream/master 2>/dev/null || true
git push origin master:master
git checkout xmacna
git pull --ff-only origin xmacna
read -r ahead behind < <(git rev-list --left-right --count xmacna...master)
echo "xmacna à frente: $ahead | atrás do upstream: $behind"
[ "$behind" = 0 ] && { echo "Já sincronizado."; exit 0; }
git merge --no-edit master
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
git push origin xmacna
echo "Sync concluído. Reinicie o servidor para aplicar (migrations rodam no próximo dev:once)."
