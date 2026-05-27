@description('Region where the api Container App is deployed.')
param location string = resourceGroup().location

@description('Existing managed environment that hosts the Container App.')
param envName string = 'asr-env'

@description('Login server of the Azure Container Registry that hosts mirrored and built images (e.g. asracr.azurecr.io).')
param acrLoginServer string

@description('Container image for the api app (defaults to the asr-api tag pushed to the project ACR).')
param image string = '${acrLoginServer}/asr-api:latest'

@description('Container image for the forgejo app (defaults to the mirrored forgejo:15 tag in the project ACR).')
param forgejoImage string = '${acrLoginServer}/forgejo:15'

@description('Container image for the web app (defaults to the asr-web tag pushed to the project ACR).')
param webImage string = '${acrLoginServer}/asr-web:latest'

@description('Entra ID tenant id used by API auth middleware.')
param tenantId string

@description('Entra ID client (application) id used by API auth middleware.')
param clientId string

@description('Internal URL of the Forgejo Container App (e.g. https://forgejo.internal.<fqdn>).')
param forgejoUrl string

@description('Public origin of the web Container App used in CORS allowedOrigins (e.g. https://web.<fqdn>).')
param webOrigin string

@description('Base URI of the Key Vault that holds api runtime secrets (e.g. https://asr-kv.vault.azure.net/).')
param keyVaultUri string

@description('Resource id of the user-assigned managed identity used to read Key Vault secrets.')
param managedIdentityId string

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: envName
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
        corsPolicy: {
          allowedOrigins: [
            webOrigin
            'http://localhost:5173'
          ]
          allowedMethods: [
            'GET'
            'POST'
            'PUT'
            'DELETE'
            'OPTIONS'
          ]
          allowedHeaders: [
            'Authorization'
            'Content-Type'
          ]
        }
      }
      secrets: [
        {
          name: 'forgejo-upload-token'
          keyVaultUrl: '${keyVaultUri}secrets/forgejo-upload-token'
          identity: managedIdentityId
        }
        {
          name: 'forgejo-merge-token'
          keyVaultUrl: '${keyVaultUri}secrets/forgejo-merge-token'
          identity: managedIdentityId
        }
        {
          name: 'audit-hmac-key'
          keyVaultUrl: '${keyVaultUri}secrets/audit-hmac-key'
          identity: managedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'AUTH_MODE'
              value: 'entra'
            }
            {
              name: 'AZURE_TENANT_ID'
              value: tenantId
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: clientId
            }
            {
              name: 'FORGEJO_URL'
              value: forgejoUrl
            }
            {
              name: 'DATABASE_PATH'
              value: '/app/data/workflow.db'
            }
            {
              name: 'FORGEJO_UPLOAD_TOKEN'
              secretRef: 'forgejo-upload-token'
            }
            {
              name: 'FORGEJO_MERGE_TOKEN'
              secretRef: 'forgejo-merge-token'
            }
            {
              name: 'AUDIT_HMAC_KEY_BYTES'
              secretRef: 'audit-hmac-key'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'api-data'
              mountPath: '/app/data'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3001
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3001
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
      volumes: [
        {
          name: 'api-data'
          storageName: 'api-storage'
          storageType: 'AzureFile'
          mountOptions: 'nobrl'
        }
      ]
    }
  }
}

resource forgejo 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'forgejo'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: false
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: managedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'forgejo'
          image: forgejoImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            {
              name: 'FORGEJO__server__ROOT_URL'
              value: forgejoUrl
            }
            {
              name: 'FORGEJO__database__DB_TYPE'
              value: 'sqlite3'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'forgejo-data'
              mountPath: '/data'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/v1/version'
                port: 3000
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'forgejo-data'
          storageName: 'forgejo-storage'
          storageType: 'AzureFile'
        }
      ]
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'web'
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 80
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}
