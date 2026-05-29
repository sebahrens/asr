# Deployment

## Overview

The system supports two deployment modes:
- **Dev**: docker-compose on local machine, mock auth, no cloud dependencies
- **Prod**: Azure Container Apps with Entra ID, managed TLS, persistent storage

## Development: docker-compose

```yaml
# docker-compose.yml (dev)
services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:15
    ports:
      - "3000:3000"
      - "2222:22"
    volumes:
      - ./data/forgejo:/data
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - FORGEJO__server__ROOT_URL=http://localhost:3000
      - FORGEJO__server__SSH_PORT=2222
    restart: unless-stopped

  api:
    build:
      context: .
      dockerfile: deploy/docker/Dockerfile.api
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=development
      - AUTH_MODE=mock
      - MOCK_USER_SUB=dev-user-0001
      - MOCK_USER_ROLES=Submitter,Compliance
      - FORGEJO_URL=http://forgejo:3000
      - FORGEJO_UPLOAD_TOKEN=${FORGEJO_ADMIN_TOKEN}
      - FORGEJO_MERGE_TOKEN=${FORGEJO_ADMIN_TOKEN}
      - DATABASE_PATH=/app/data/workflow.db
      - PORT=3001
    volumes:
      - ./data/api:/app/data
    depends_on:
      - forgejo
    restart: unless-stopped

  web:
    build:
      context: .
      dockerfile: deploy/docker/Dockerfile.web
      args:
        - VITE_API_URL=http://localhost:3001
        - VITE_AUTH_MODE=mock
        - VITE_ENABLE_MOCK_AUTH=true
    ports:
      - "5173:5173"
    depends_on:
      - api
    restart: unless-stopped

volumes:
  forgejo-data:
  api-data:
```

### First-time setup (dev)

```bash
# 1. Start services
docker compose up -d

# 2. Create Forgejo admin user
docker exec forgejo forgejo admin user create \
  --username asr-admin --password changeme --email admin@local.dev --admin

# 3. Generate admin token
# Visit http://localhost:3000/user/settings/applications → create token

# 4. Set token in .env
echo "FORGEJO_ADMIN_TOKEN=<token>" >> .env

# 5. Create skills-registry repo
curl -X POST http://localhost:3000/api/v1/user/repos \
  -H "Authorization: token <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"skills-registry","auto_init":true}'

# 6. Restart API to pick up token
docker compose restart api
```

## Production: Azure Container Apps

### Prerequisites

- Azure subscription with Contributor access
- Azure CLI (`az`) installed
- Entra ID app registrations created (see specs/api.md)
- Custom domain (optional, managed certs available)

### Infrastructure (Bicep)

```bicep
param location string = 'westeurope'
param envName string = 'asr-env'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${envName}-logs'
  location: location
  properties: { retentionInDays: 30, sku: { name: 'PerGB2018' } }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'asrstorage${uniqueString(resourceGroup().id)}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
}

resource forgejoShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  name: '${storageAccount.name}/default/forgejo-data'
  properties: { shareQuota: 50 }
}

resource apiShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  name: '${storageAccount.name}/default/api-data'
  properties: { shareQuota: 10 }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource forgejoStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'forgejo-storage'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'forgejo-data'
      accessMode: 'ReadWrite'
    }
  }
}

resource apiStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'api-storage'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'api-data'
      accessMode: 'ReadWrite'
    }
  }
}
```

### Container Apps

#### Forgejo (internal)

```bash
az containerapp create \
  --name forgejo \
  --resource-group $RG \
  --environment $ENV \
  --image $ACR.azurecr.io/forgejo:15 \
  --target-port 3000 \
  --ingress internal \
  --min-replicas 1 --max-replicas 1 \
  --cpu 1.0 --memory 2Gi \
  --registry-server $ACR.azurecr.io \
  --env-vars \
    "FORGEJO__server__ROOT_URL=https://forgejo.internal.$FQDN" \
    "FORGEJO__database__DB_TYPE=sqlite3"
```

#### API (external)

```bash
az containerapp create \
  --name api \
  --resource-group $RG \
  --environment $ENV \
  --image $ACR.azurecr.io/asr-api:latest \
  --target-port 3001 \
  --ingress external \
  --min-replicas 1 --max-replicas 3 \
  --cpu 0.5 --memory 1Gi \
  --registry-server $ACR.azurecr.io \
  --env-vars \
    "NODE_ENV=production" \
    "AUTH_MODE=entra" \
    "AZURE_TENANT_ID=$TENANT_ID" \
    "AZURE_CLIENT_ID=$CLIENT_ID" \
    "FORGEJO_URL=https://forgejo.internal.$FQDN" \
    "DATABASE_PATH=/app/data/workflow.db"
```

Volume mount for SQLite (must use `nobrl`):
```json
{
  "volumes": [{
    "name": "api-data",
    "storageName": "api-storage",
    "storageType": "AzureFile",
    "mountOptions": "nobrl"
  }]
}
```

#### Web (external)

```bash
az containerapp create \
  --name web \
  --resource-group $RG \
  --environment $ENV \
  --image $ACR.azurecr.io/asr-web:latest \
  --target-port 80 \
  --ingress external \
  --min-replicas 0 --max-replicas 3 \
  --cpu 0.25 --memory 0.5Gi \
  --registry-server $ACR.azurecr.io
```

### CORS

```bash
az containerapp ingress cors enable \
  --name api --resource-group $RG \
  --allowed-origins "https://web.$FQDN" "http://localhost:5173" \
  --allowed-methods "GET,POST,PUT,DELETE,OPTIONS" \
  --allowed-headers "Authorization,Content-Type"
```

### Secrets Management

Sensitive values stored in Azure Key Vault, referenced by Container Apps:

| Secret | Service |
|--------|---------|
| `forgejo-upload-token` | api |
| `forgejo-merge-token` | api |
| `audit-hmac-key` | api |
| `entra-client-secret` | forgejo (OIDC) |

### CI/CD (Forgejo Actions)

`azure/login@v2` is not natively available on Forgejo Actions runners. Use the `az` CLI directly with a service-principal JSON stored as the secret `AZURE_CREDENTIALS_JSON` (Forgejo disallows generic secret names like `GITHUB_TOKEN` or `AZURE_CREDENTIALS`).

```yaml
# .forgejo/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Azure login (CLI)
        env:
          AZURE_CREDENTIALS_JSON: ${{ secrets.AZURE_CREDENTIALS_JSON }}
        run: |
          echo "$AZURE_CREDENTIALS_JSON" > /tmp/sp.json
          az login --service-principal \
            --username "$(jq -r .clientId /tmp/sp.json)" \
            --password "$(jq -r .clientSecret /tmp/sp.json)" \
            --tenant "$(jq -r .tenantId /tmp/sp.json)"
          shred -u /tmp/sp.json
      - name: Build images in ACR
        env:
          GIT_SHA: ${{ env.GITHUB_SHA }}
        run: |
          az acr build --registry $ACR --image asr-api:$GIT_SHA ./deploy/docker/api
          az acr build --registry $ACR --image asr-web:$GIT_SHA ./packages/web
      - name: Roll Container Apps
        env:
          GIT_SHA: ${{ env.GITHUB_SHA }}
        run: |
          az containerapp update --name api --resource-group $RG --image $ACR.azurecr.io/asr-api:$GIT_SHA
          az containerapp update --name web --resource-group $RG --image $ACR.azurecr.io/asr-web:$GIT_SHA
```

### Forgejo Image Mirror

Pulling `codeberg.org/forgejo/forgejo:15` from inside Azure Container Apps is allowed but introduces an external dependency for cold starts. We mirror it into ACR on a daily cron via `az acr import`:

```bash
az acr import --name $ACR \
  --source codeberg.org/forgejo/forgejo:15 \
  --image forgejo:15 --force
```

The Forgejo Container App is then deployed from `$ACR.azurecr.io/forgejo:15`, removing the cross-internet pull on scale-out/restart.

## Monitoring

- **Logs**: Azure Log Analytics (all container stdout/stderr)
- **Metrics**: Container Apps built-in metrics (CPU, memory, requests, latency)
- **Alerts**: Configure on error rate > 1%, P95 latency > 2s, replica restart count
- **Health checks**: `/health` endpoint on API, Forgejo's `/api/v1/version`

## Scaling Constraints

| Service | Min | Max | Reason |
|---------|-----|-----|--------|
| Forgejo | 1 | 1 | Single-instance Git server |
| API | 1 | 3 | SQLite single-writer (reads can scale with read replicas later) |
| Web | 0 | 3 | Stateless static serving, scale to zero OK |
