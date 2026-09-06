#!/bin/bash
# Запускать НА СЕРВЕРЕ (159.194.227.150), из папки /opt/pmo (куда скопирован этот пакет).
set -e

DOMAIN="pmo.qslaide.beget.tech"

echo "=== 1. Установка Docker и Docker Compose ==="
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  echo "Docker уже установлен, пропускаю."
fi

echo "=== 2. Проверка .env ==="
if [ ! -f .env ]; then
  echo "Файл .env не найден. Скопируйте .env.example в .env и заполните значения:"
  echo "  cp .env.example .env && nano .env"
  exit 1
fi

echo "=== 3. Запуск с временным (bootstrap) конфигом — нужен для выпуска сертификата ==="
docker compose up -d --build postgres backend nginx

echo "=== 4. Проверка контейнеров (bootstrap-конфиг nginx ещё не проксирует /api, это нормально) ==="
sleep 3
docker compose exec -T backend wget -qO- http://localhost:3000/api/health && echo " -> backend отвечает напрямую" || echo "ВНИМАНИЕ: backend не отвечает, проверьте: docker compose logs backend"
curl -fsS -o /dev/null -w "HTTP статус http://localhost/ (bootstrap-страница): %{http_code}\n" "http://localhost/"

echo "=== 5. Проверка DNS домена ${DOMAIN} перед выпуском сертификата ==="
SERVER_IP=$(curl -fsS -4 ifconfig.me || curl -fsS -4 icanhazip.com)
DOMAIN_IP=$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -1)
echo "IP сервера:           ${SERVER_IP}"
echo "Куда сейчас смотрит ${DOMAIN}: ${DOMAIN_IP:-<нет записи>}"

if [ "${SERVER_IP}" != "${DOMAIN_IP}" ]; then
  echo ""
  echo "!!! DNS-запись ${DOMAIN} НЕ указывает на этот сервер (${SERVER_IP})."
  echo "!!! Сертификат Let's Encrypt выпустить нельзя, пока не поправите A-запись в панели Beget:"
  echo "!!!   ${DOMAIN}  A  ${SERVER_IP}"
  echo "!!! Сайт пока доступен только по HTTP напрямую: http://${SERVER_IP}/"
  echo "!!! После исправления DNS (обычно 5-30 минут на обновление) запустите этот скрипт ещё раз —"
  echo "!!! шаги 1-4 просто пропустятся, а сертификат будет выпущен автоматически."
  exit 0
fi

echo "=== 6. DNS в порядке. Выпуск сертификата Let's Encrypt ==="
CERT_EMAIL="${CERT_EMAIL:-admin@qslaide.beget.tech}"
# ВАЖНО: сервис certbot в docker-compose.yml имеет свой entrypoint (цикл автопродления),
# поэтому для разового выпуска сертификата entrypoint нужно явно переопределить обратно на certbot,
# иначе команда certonly будет проигнорирована и контейнер зависнет в цикле обновления.
docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d "${DOMAIN}" --email "${CERT_EMAIL}" --agree-tos --no-eff-email

echo "=== 7. Переключение на боевой конфиг с HTTPS ==="
cp nginx/pmo-full.conf nginx/pmo-bootstrap.conf
docker compose restart nginx

echo "=== 8. Запуск фонового обновления сертификата ==="
docker compose up -d certbot

echo ""
echo "=== 9. Финальная проверка ==="
sleep 2
curl -fsS "https://${DOMAIN}/api/health" && echo " -> https://${DOMAIN}/api/health отвечает OK" || echo "ВНИМАНИЕ: HTTPS ещё не отвечает, проверьте вручную через минуту"
curl -fsS -o /dev/null -w "HTTP статус https://${DOMAIN}/ : %{http_code}\n" "https://${DOMAIN}/"

echo ""
echo "Готово. Откройте: https://${DOMAIN}/"
