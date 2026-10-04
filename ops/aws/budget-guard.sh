#!/usr/bin/env bash
# Creates the "keel-monthly" AWS Budget with email alerts, if it doesn't exist yet.
# Standalone:  bash budget-guard.sh   (PROFILE=keel, BUDGET_USD=25 by default)
# Non-interactive: ALERT_EMAIL=you@example.com bash budget-guard.sh
# Also run by setup-agent-toolkit.sh right after sign-in.
set -euo pipefail
PROFILE="${PROFILE:-keel}"
export PATH="$HOME/.local/bin:$PATH"
step() { printf '\n==> %s\n' "$*"; }
step "Budget guard: monthly cost budget with email alerts (AWS Budgets: first 2 budgets are free)"
BUDGET_USD="${BUDGET_USD:-25}"
ACCOUNT_ID="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
if aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name keel-monthly \
     --profile "$PROFILE" --region us-east-1 >/dev/null 2>&1; then
  echo "Budget keel-monthly already exists, leaving it as is."
else
  if [ -z "${ALERT_EMAIL:-}" ]; then
    read -r -p "Email for budget alerts (blank to skip): " ALERT_EMAIL || ALERT_EMAIL=""
  fi
  if [ -n "$ALERT_EMAIL" ]; then
    NOTIFS=""
    for pct in 50 80 100; do
      NOTIFS+="{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":$pct,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]},"
    done
    NOTIFS+="{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]}"
    aws budgets create-budget --account-id "$ACCOUNT_ID" --profile "$PROFILE" --region us-east-1 \
      --budget "{\"BudgetName\":\"keel-monthly\",\"BudgetLimit\":{\"Amount\":\"$BUDGET_USD\",\"Unit\":\"USD\"},\"TimeUnit\":\"MONTHLY\",\"BudgetType\":\"COST\"}" \
      --notifications-with-subscribers "[$NOTIFS]" \
      && echo "Budget keel-monthly: \$$BUDGET_USD/month, alerts at 50/80/100% actual and 100% forecast." \
      || echo "Budget creation failed (your project may block Budgets); set a spend limit in AWS Settings instead."
  fi
fi

