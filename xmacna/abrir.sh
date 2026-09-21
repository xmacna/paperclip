#!/usr/bin/env bash
# Abre o Paperclip rodando a partir deste fork: sobe o servidor dev se a porta 3100
# estiver livre e abre o navegador quando ele responder.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL=http://localhost:3100
# O dev runner compila o paperclip-runnerd em Rust; ~/.cargo/bin não está no PATH do login.
export PATH="$HOME/.cargo/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if curl -fs -o /dev/null "$URL/api/health"; then exec xdg-open "$URL"; fi
( for _ in $(seq 1 600); do curl -fs -o /dev/null "$URL/api/health" && { xdg-open "$URL"; exit; }; sleep 1; done ) &
cd "$REPO"
exec corepack pnpm dev:once
