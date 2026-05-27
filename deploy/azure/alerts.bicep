@description('Resource id of the api Container App that the metric alerts are scoped to.')
param apiContainerAppId string

@description('Severity for the metric alerts emitted from this file (0=critical, 4=verbose).')
@minValue(0)
@maxValue(4)
param alertSeverity int = 2

@description('Email recipient for the shared action group used by every alert in this file.')
param notificationEmail string

@description('Name of the shared action group reused by latency, restart, and the asr-b4q.3 error-rate alert.')
param actionGroupName string = 'asr-alerts'

@description('Short name (max 12 chars) for the shared action group, surfaced in SMS/email subjects.')
param actionGroupShortName string = 'asrAlerts'

@description('Resource id of the Log Analytics workspace (asr-5v0.1) that the 5xx error-rate scheduled query runs against.')
param logAnalyticsWorkspaceId string

@description('Container App name of the api app whose console logs are filtered for the 5xx error-rate query. Matches the name set in containerapps.bicep.')
param apiAppName string = 'api'

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: [
      {
        name: 'ops'
        emailAddress: notificationEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource latencyAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'asr-api-latency-p95-2s'
  location: 'global'
  properties: {
    description: 'P95 response latency on the api Container App exceeds 2s over a 5-minute window.'
    severity: alertSeverity
    enabled: true
    scopes: [
      apiContainerAppId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.App/containerApps'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'p95RequestLatencyExceeded'
          metricName: 'RequestsLatencyMs'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 2000
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

resource restartAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'asr-api-restartcount-gt-0'
  location: 'global'
  properties: {
    description: 'api Container App replicas restarted at least once over a 5-minute window.'
    severity: alertSeverity
    enabled: true
    scopes: [
      apiContainerAppId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.App/containerApps'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'restartCountAboveZero'
          metricName: 'RestartCount'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

resource errorRateAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'asr-api-5xx-error-rate-gt-1pct'
  location: resourceGroup().location
  properties: {
    description: '5xx response ratio on the api Container App exceeds 1% of total requests over a 5-minute window.'
    severity: alertSeverity
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL\n| where TimeGenerated > ago(5m)\n| where ContainerAppName_s == \'${apiAppName}\'\n| extend status = toint(extract("\\"status\\"\\\\s*:\\\\s*(\\\\d+)", 1, Log_s))\n| where isnotnull(status)\n| summarize total = count(), errors = countif(status >= 500 and status < 600)\n| where total > 0\n| extend errorRate = todouble(errors) / todouble(total)\n| where errorRate > 0.01'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

@description('Resource id of the shared action group; consumed by the asr-b4q.3 5xx error-rate log-query alert.')
output actionGroupId string = actionGroup.id

@description('Resource id of the asr-b4q.3 5xx error-rate scheduled query alert, exported so operators can find it via az monitor scheduled-query list.')
output errorRateAlertId string = errorRateAlert.id
