#!/bin/bash
# Sobe, dentro de um container só, as mesmas peças que o docker-compose sobe em
# cinco: Redis, as três réplicas do backend e o Nginx na frente.
#
# Não usa supervisord de propósito. O que se quer aqui é o oposto de "manter no
# ar a qualquer custo": se qualquer uma das peças morrer, o container inteiro
# deve morrer junto, para o Render reiniciar tudo num estado coerente. Um chat
# rodando com duas das três réplicas mortas, ou sem Redis, mentiria para quem
# está olhando o visualizador. O `wait -n` no final faz exatamente isso.
set -euo pipefail

# O nginx não expande variável de ambiente na própria configuração, e a porta
# de publicação quem escolhe é o Render.
export PORT="${PORT:-10000}"
envsubst '${PORT}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

echo "[start] subindo o Redis"
redis-server --port 6379 --save '' --appendonly no --maxmemory 64mb --maxmemory-policy noeviction &

# Espera o Redis aceitar conexão antes de subir os backends. Sem isso, os três
# sobem juntos, não encontram o backplane e caem no retry logo no arranque, o
# que numa instância gratuita (CPU fracionada) atrasa bastante o primeiro
# acesso.
for _ in $(seq 1 30); do
  if redis-cli -p 6379 ping > /dev/null 2>&1; then
    echo "[start] Redis respondendo"
    break
  fi
  sleep 0.5
done

cd /app/backend
porta=8081
for replica in "Servidor A" "Servidor B" "Servidor C"; do
  echo "[start] subindo ${replica} na porta ${porta}"
  REPLICA_NAME="${replica}" \
  REDIS_CONNECTION="127.0.0.1:6379" \
  ASPNETCORE_URLS="http://127.0.0.1:${porta}" \
    dotnet ChatServer.dll &
  porta=$((porta + 1))
done

echo "[start] subindo o Nginx na porta ${PORT}"
nginx -g 'daemon off;' &

# Encerra assim que o PRIMEIRO processo terminar, seja qual for. Ver o
# comentário do topo sobre por que morrer junto é o comportamento desejado.
wait -n
codigo=$?
echo "[start] uma das peças terminou (código ${codigo}); derrubando o container"
exit "${codigo}"
