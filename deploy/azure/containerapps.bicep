@description('Region where the api Container App is deployed.')
param location string = resourceGroup().location

@description('Existing managed environment that hosts the Container App.')
param envName string = 'asr-env'

@description('Container image for the api app (defaults to the asr-api tag pushed to the project ACR).')
param image string = '$ACR.azurecr.io/asr-api:latest'

@description('Entra ID tenant id used by API auth middleware.')
param tenantId string

@description('Entra ID client (application) id used by API auth middleware.')
param clientId string

@description('Internal URL of the Forgejo Container App (e.g. https://forgejo.internal.<fqdn>).')
param forgejoUrl string

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: envName
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'api'
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
      }
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
          ]
          volumeMounts: [
            {
              volumeName: 'api-data'
              mountPath: '/app/data'
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
