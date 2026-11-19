import type { FlagsClient } from './client'
import type { EvaluationResult } from './engine'

/**
 * Provedor OpenFeature. Interface mínima escrita aqui (sem importar @openfeature/*, que fica só como
 * peer dependency opcional): `metadata`, `initialize`, `onClose` e os quatro `resolve*Evaluation`.
 * `AiubyFlagsWebProvider` responde síncrono (@openfeature/web-sdk); `AiubyFlagsServerProvider`
 * devolve Promise (@openfeature/server-sdk). O `targetingKey` do OpenFeature vira a `key` do contexto.
 */

export type OpenFeatureContext = { targetingKey?: string; [attribute: string]: unknown }
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type ResolutionDetails<T> = {
  value: T
  variant?: string
  reason?: string
  errorCode?: string
  errorMessage?: string
  flagMetadata?: Record<string, string | number | boolean>
}

function toContext(context: OpenFeatureContext | undefined): { key: string; [attribute: string]: unknown } {
  const { targetingKey, ...rest } = context ?? {}
  return { ...rest, key: typeof targetingKey === 'string' ? targetingKey : typeof rest.key === 'string' ? rest.key : '' }
}

function toDetails<T>(r: EvaluationResult & { value: T }): ResolutionDetails<T> {
  return {
    value: r.value,
    ...(r.variant !== null ? { variant: r.variant } : {}),
    reason: r.reason,
    ...(r.errorCode ? { errorCode: r.errorCode, errorMessage: r.errorMessage } : {}),
    flagMetadata: r.flagMetadata,
  }
}

export class AiubyFlagsWebProvider {
  readonly metadata = { name: 'aiuby-flags' } as const
  readonly runsOn = 'client' as const
  readonly hooks = []

  constructor(protected readonly client: FlagsClient) {}

  initialize(): Promise<void> {
    return this.client.ready()
  }

  onClose(): Promise<void> {
    this.client.close()
    return Promise.resolve()
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context?: OpenFeatureContext): ResolutionDetails<boolean> {
    return toDetails(this.client.details(flagKey, toContext(context), defaultValue))
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string, context?: OpenFeatureContext): ResolutionDetails<string> {
    return toDetails(this.client.details(flagKey, toContext(context), defaultValue))
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number, context?: OpenFeatureContext): ResolutionDetails<number> {
    return toDetails(this.client.details(flagKey, toContext(context), defaultValue))
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context?: OpenFeatureContext): ResolutionDetails<T> {
    return toDetails(this.client.details(flagKey, toContext(context), defaultValue))
  }
}

export class AiubyFlagsServerProvider {
  readonly metadata = { name: 'aiuby-flags' } as const
  readonly runsOn = 'server' as const
  readonly hooks = []
  private readonly sync: AiubyFlagsWebProvider

  constructor(client: FlagsClient) {
    this.sync = new AiubyFlagsWebProvider(client)
  }

  initialize(): Promise<void> {
    return this.sync.initialize()
  }

  onClose(): Promise<void> {
    return this.sync.onClose()
  }

  async resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context?: OpenFeatureContext): Promise<ResolutionDetails<boolean>> {
    return this.sync.resolveBooleanEvaluation(flagKey, defaultValue, context)
  }

  async resolveStringEvaluation(flagKey: string, defaultValue: string, context?: OpenFeatureContext): Promise<ResolutionDetails<string>> {
    return this.sync.resolveStringEvaluation(flagKey, defaultValue, context)
  }

  async resolveNumberEvaluation(flagKey: string, defaultValue: number, context?: OpenFeatureContext): Promise<ResolutionDetails<number>> {
    return this.sync.resolveNumberEvaluation(flagKey, defaultValue, context)
  }

  async resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context?: OpenFeatureContext): Promise<ResolutionDetails<T>> {
    return this.sync.resolveObjectEvaluation(flagKey, defaultValue, context)
  }
}
