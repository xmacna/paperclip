#!/usr/bin/env bash
# Abre o Paperclip: liga o serviço systemd de usuário `paperclip` (se estiver parado)
# e abre o navegador quando o servidor responder. O servidor independe de terminal.
set -uo pipefail
URL=http://localhost:3100
healthy() { curl -fs -o /dev/null "$URL/api/health"; }
if ! healthy; then
  systemctl --user start paperclip.service
  notify-send -i applications-office Paperclip "Iniciando o servidor…" 2>/dev/null || true
  for _ in $(seq 1 600); do healthy && break; sleep 1; done
  healthy || { notify-send -u critical Paperclip "Servidor não subiu; veja: journalctl --user -u paperclip" 2>/dev/null; exit 1; }
fi
exec xdg-open "$URL"
