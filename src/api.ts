import type { HarnessEvent } from './harnessTypes'
import type { ValleyPluginApi as HostApi } from '@valley/plugin-sdk'
import type { DriverResult } from '@valley/plugin-sdk/types'
import type { ChannelsInfo, AiStreamEvent, ChannelMessage } from './types'
import type { AiDriver, ChannelDriver, AiBalanceResult, AiCacheStatsResult, AiChatListResult, AiChatStartResult, AiChatThreadResult, AiCommandsResult, AiConfigResult, AiConnectionsResult, AiGuardOverridesResult, AiGuardResult, AiHarnessPackageResult, AiHarnessRunResult, AiHarnessRunsResult, AiHarnessesResult, AiMemoryResult, AiModelsResult, AiOllamaStatusResult, AiPendingResult, AiPersonalitiesResult, AiPersonalityResult, AiProvidersResult, AiUsageResult, ChannelsResult } from './apiTypes'
export type ValleyPluginApi = HostApi & { assistant: AiDriver; channels: ChannelDriver }
export function createAssistantApi(api: HostApi): ValleyPluginApi {
  if ('assistant' in api && 'channels' in api) return api as ValleyPluginApi
  const driverCall = async (namespace: string, method: string, payload: unknown): Promise<DriverResult> => {
    try { return { ok: true, data: await api.backend.call(`${namespace}.${method}`, payload) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  return { ...api,
      assistant: {
        chat: (request) => driverCall('ai', 'chat', request) as Promise<AiChatStartResult>,
        cancel: (requestId) => driverCall('ai', 'cancel', { requestId }),
        listModels: (aiProvider) => driverCall('ai', 'listModels', { provider: aiProvider }) as Promise<AiModelsResult>,
        providerStatus: () => driverCall('ai', 'providerStatus', {}) as Promise<AiProvidersResult>,
        listConnections: () => driverCall('ai', 'listConnections', {}) as Promise<AiConnectionsResult>,
        setConnectionKey: (connectionId, key) => driverCall('ai', 'setConnectionKey', { connectionId, key }),
        setKey: (aiProvider, key) => driverCall('ai', 'setKey', { provider: aiProvider, key }),
        setBaseUrl: (aiProvider, baseUrl) => driverCall('ai', 'setBaseUrl', { provider: aiProvider, baseUrl }),
        getConfig: () => driverCall('ai', 'getConfig', {}) as Promise<AiConfigResult>,
        writeRule: (name, content) => driverCall('ai', 'writeRule', { name, content }),
        getGuard: () => driverCall('ai', 'getGuard', {}) as Promise<AiGuardResult>,
        saveGuard: (policy) => driverCall('ai', 'saveGuard', { policy }) as Promise<AiGuardResult>,
        appendGuardAudit: (entry) => driverCall('ai', 'appendGuardAudit', { entry }),
        addPending: (record) => driverCall('ai', 'addPending', { record }),
        removePending: (requestId) => driverCall('ai', 'removePending', { requestId }),
        listPending: () => driverCall('ai', 'listPending', {}) as Promise<AiPendingResult>,
        listChats: () => driverCall('ai', 'listChats', {}) as Promise<AiChatListResult>,
        readChat: (id) => driverCall('ai', 'readChat', { id }) as Promise<AiChatThreadResult>,
        saveChat: (thread) => driverCall('ai', 'saveChat', { thread }),
        renameChat: (id, title) => driverCall('ai', 'renameChat', { id, title }),
        deleteChat: (id) => driverCall('ai', 'deleteChat', { id }),
        clearChat: (id) => driverCall('ai', 'clearChat', { id }),
        setChatPinned: (id, pinned) => driverCall('ai', 'setChatPinned', { id, pinned }),
        readGuardOverrides: (chatId) => driverCall('ai', 'readGuardOverrides', { chatId }) as Promise<AiGuardOverridesResult>,
        saveGuardOverrides: (chatId, overrides) => driverCall('ai', 'saveGuardOverrides', { chatId, overrides }),
        listPersonalities: () => driverCall('ai', 'listPersonalities', {}) as Promise<AiPersonalitiesResult>,
        readPersonality: (id) => driverCall('ai', 'readPersonality', { id }) as Promise<AiPersonalityResult>,
        savePersonality: (personality) => driverCall('ai', 'savePersonality', { personality }),
        deletePersonality: (id) => driverCall('ai', 'deletePersonality', { id }),
        listCommands: () => driverCall('ai', 'listCommands', {}) as Promise<AiCommandsResult>,
        saveCommands: (commands) => driverCall('ai', 'saveCommands', { commands }),
        appendMemory: (chatId, entry) => driverCall('ai', 'appendMemory', { chatId, entry }),
        readMemory: (chatId) => driverCall('ai', 'readMemory', { chatId }) as Promise<AiMemoryResult>,
        onStream: (cb) => api.backend.on('stream', (payload) => cb(payload as AiStreamEvent)),
        getUsage: () => driverCall('ai', 'getUsage', {}) as Promise<AiUsageResult>,
        ingestAttachment: (request) =>
          driverCall('ai', 'ingestAttachment', request) as Promise<DriverResult & { data?: { text: string } }>,
        getBalance: (aiProvider) => driverCall('ai', 'getBalance', { provider: aiProvider }) as Promise<AiBalanceResult>,
        ollamaStatus: () => driverCall('ai', 'ollamaStatus', {}) as Promise<AiOllamaStatusResult>,
        getCacheStats: () => driverCall('ai', 'getCacheStats', {}) as Promise<AiCacheStatsResult>,
        listHarnesses: () => driverCall('ai', 'listHarnesses', {}) as Promise<AiHarnessesResult>,
        readHarnessPackage: (id) => driverCall('ai', 'readHarnessPackage', { id }) as Promise<AiHarnessPackageResult>,
        createHarness: (input) => driverCall('ai', 'createHarness', { package: input }) as Promise<AiHarnessesResult>,
        writeHarnessFile: (id, path, content, baseline) => driverCall('ai', 'writeHarnessFile', { id, path, content, baseline }) as Promise<import('@valley/plugin-sdk/types').GuardedWriteResult>,
        updateHarnessManifest: (id, manifest, baseline) => driverCall('ai', 'updateHarnessManifest', { id, manifest, baseline }) as Promise<import('@valley/plugin-sdk/types').GuardedWriteResult>,
        updateHarnessConfig: (id, config, baseline) => driverCall('ai', 'updateHarnessConfig', { id, config, baseline }) as Promise<import('@valley/plugin-sdk/types').GuardedWriteResult>,
        saveHarnessSettings: (id, values) => driverCall('ai', 'saveHarnessSettings', { id, values }) as Promise<AiHarnessesResult>,
        reloadHarnesses: () => driverCall('ai', 'reloadHarnesses', {}) as Promise<AiHarnessesResult>,
        runHarness: (id, targets, options) => driverCall('ai', 'runHarness', { id, targets, options }) as Promise<AiHarnessRunResult>,
        cancelHarnessRun: (runId) => driverCall('ai', 'cancelHarnessRun', { runId }),
        listHarnessRuns: (id, limit) => driverCall('ai', 'listHarnessRuns', { id, limit }) as Promise<AiHarnessRunsResult>,
        readHarnessRun: (runId) => driverCall('ai', 'readHarnessRun', { runId }) as Promise<AiHarnessRunResult>,
        clearHarnessCache: (id) => driverCall('ai', 'clearHarnessCache', { id }),
        onHarnessEvent: (cb) => api.backend.on('harness', (payload) => cb(payload as HarnessEvent))
      },
      channels: {
        list: () => driverCall('channels', 'list', {}) as Promise<ChannelsResult>,
        add: (type, name) =>
          driverCall('channels', 'add', { type, name }) as Promise<
            DriverResult & { data?: { id: string } & ChannelsInfo }
          >,
        remove: (channelId) => driverCall('channels', 'remove', { channelId }) as Promise<ChannelsResult>,
        rename: (channelId, name) => driverCall('channels', 'rename', { channelId, name }) as Promise<ChannelsResult>,
        setSecret: (channelId, secret) => driverCall('channels', 'setSecret', { channelId, secret }),
        setSecretField: (channelId, key, secret) => driverCall('channels', 'setSecretField', { channelId, key, secret }) as Promise<ChannelsResult>,
        setConfig: (channelId, config) => driverCall('channels', 'setConfig', { channelId, config }) as Promise<ChannelsResult>,
        start: (channelId) => driverCall('channels', 'start', { channelId }) as Promise<ChannelsResult>,
        stop: (channelId) => driverCall('channels', 'stop', { channelId }) as Promise<ChannelsResult>,
        send: (channelId, chatRef, text) => driverCall('channels', 'send', { channelId, chatRef, text }),
        sendButtons: (channelId, chatRef, text, buttons) =>
          driverCall('channels', 'sendButtons', { channelId, chatRef, text, buttons }),
        sendAttachment: (channelId, chatRef, path, caption) =>
          driverCall('channels', 'sendAttachment', { channelId, chatRef, path, caption }),
        onMessage: (cb) => api.backend.on('message', (payload) => cb(payload as ChannelMessage))
      }
  }
}
