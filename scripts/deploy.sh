#!/usr/bin/env bash
# Deploys FairShift to Google Cloud Run with Firestore as the database.
#
#   ./scripts/deploy.sh <gcp-project-id> [region]
#
# Needs: gcloud signed in (`gcloud auth login`) as someone who can enable
# APIs, create a Firestore database and deploy to Cloud Run in the project.
# No keys or secrets are created: the service uses its own service account.
set -euo pipefail

PROJECT="${1:?Usage: scripts/deploy.sh <gcp-project-id> [region]}"
REGION="${2:-asia-south1}"
SERVICE="fairshift"
SA_NAME="fairshift-run"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT" >/dev/null

echo "Enabling APIs…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com

echo "Firestore database…"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native
fi

echo "Service account with Firestore access only…"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="FairShift on Cloud Run"
fi
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role="roles/datastore.user" --condition=None >/dev/null

echo "Building and deploying…"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,STORAGE=firestore,DEMO_MODE=true,DEMO_RESET_HOURS=24" \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 80 --timeout 60

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Deployed: ${URL}"
echo "Health:   $(curl -fsS "${URL}/healthz" || echo 'not answering yet')"
