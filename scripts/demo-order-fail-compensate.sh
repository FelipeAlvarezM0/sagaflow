#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
INVENTORY_URL="${INVENTORY_URL:-http://localhost:3002}"

curl -sS -X POST "${INVENTORY_URL}/admin/failure" \
  -H "content-type: application/json" \
  -d '{"failRate":0,"failOnce":true,"failEndpoints":["reserve-inventory"]}' >/dev/null

payload='{
  "version": "1.0.0",
  "input": {
    "orderId": "o-fail-1",
    "amount": 220,
    "sku": "sku-fail",
    "email": "buyer@example.com"
  },
  "context": {
    "tenantId": "acme",
    "correlationId": "demo-fail-1"
  }
}'

run_resp=$(curl -sS -X POST "${API_URL}/v1/workflows/order-processing/start" \
  -H "content-type: application/json" \
  -H "x-correlation-id: demo-fail-1" \
  -d "${payload}")

run_id=$(echo "${run_resp}" | jq -r '.runId')
if [[ -z "${run_id}" || "${run_id}" == "null" ]]; then
  echo "No se pudo crear run: ${run_resp}"
  exit 1
fi

echo "Run creado: ${run_id}"

status=""
while true; do
  state=$(curl -sS "${API_URL}/v1/runs/${run_id}")
  status=$(echo "${state}" | jq -r '.run.status')
  echo "Estado run: ${status}"

  if [[ "${status}" == "COMPLETED" || "${status}" == "FAILED" || "${status}" == "COMPENSATED" || "${status}" == "CANCELLED" ]]; then
    echo ""
    echo "Timeline:"
    echo "${state}" | jq -r '.steps[] | "- \(.stepId): status=\(.status), attempts=\(.attempts), compensation=\(.compensationStatus), compAttempts=\(.compensationAttempts)"'
    break
  fi

  sleep 1
done

curl -sS -X POST "${INVENTORY_URL}/admin/failure" \
  -H "content-type: application/json" \
  -d '{"failRate":0,"failOnce":false,"failEndpoints":[]}' >/dev/null

if [[ "${status}" != "COMPENSATED" ]]; then
  echo "La demo de compensación no terminó en COMPENSATED"
  exit 1
fi

echo "Demo compensación OK"
