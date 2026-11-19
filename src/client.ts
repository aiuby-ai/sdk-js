import { compileFlag, errorResult, evaluateFlag, type CompiledFlag, type EngineConfig, type EvaluationResult, type ValueType } from './engine'

/**
 * Cliente leve de Feature Management / Runtime Configuration da AIUBY, para navegador e Node.
 * Baixa o snapshot do ambiente e avalia localmente com o mesmo motor do servidor (engine.ts):
 * o mesmo contexto cai na mesma variante aqui e na avaliação remota.
 *
 * Modos:
 *  - online (padrão): baixa o snapshot e faz polling com ETag (304 quando nada mudou);
 *  - cache: online + `cache` (ex.: localStorage, arquivo) para começar do último snapshot salvo
 *    e continuar funcionando se a rede cair;
 *  - offline: só `bootstrap`, sem rede (testes, ambientes isolados, build estático).
 * Sem snapshot, toda avaliação devolve o padrão de quem chama (motivo ERROR, PROVIDER_NOT_READY).
 */

export const SNAPSHOT_SCHEMA_VERSION = 1
export const DEFAULT_BASE_URL = 'https://aiuby.com'
export const SNAPSHOT_PATH = '/api/platform/flags/sdk/snapshot'
export const DEFAULT_POLL_MS = 30_000
export const MIN_POLL_MS = 5_000

export type SnapshotFlag =
  | { key: string; valueType: ValueType; published: true; version: number; killed: boolean; salt: string; config: EngineConfig }
  | { key: string; valueType: ValueType; published: false }
export type Snapshot = { schemaVersion: number; environment: string; etag: string; generatedAt: string; flags: SnapshotFlag[] }

/** Onde guardar o último snapshot (modo cache). Pode ser síncrono ou assíncrono. */
export type SnapshotCache = { load(): Snapshot | null | Promise<Snapshot | null>; save(snapshot: Snapshot): void | Promise<void> }

export type EvaluationContext = { key: string; [attribute: string]: unknown }

export type FlagsClientOptions = {
  /** Chave do SDK do ambiente (X-AIUBY-Flags-Key). Obrigatória no modo online, salvo com `snapshotUrl` de um proxy seu. */
  sdkKey?: string
  /** Credencial de API com o escopo flags:evaluate. Só no servidor: no navegador, use um proxy (`snapshotUrl`). */
  credential?: string
  baseUrl?: string
  /** URL completa do snapshot (ex.: rota do seu backend que repassa o snapshot ao navegador). */
  snapshotUrl?: string
  mode?: 'online' | 'offline'
  bootstrap?: Snapshot
  cache?: SnapshotCache
  /** Intervalo do polling. 0 desliga. Mínimo 5 s. */
  pollIntervalMs?: number
  fetch?: typeof fetch
  headers?: Record<string, string>
  onError?: (error: Error) => void
}

type Compiled = { flag: SnapshotFlag; compiled: CompiledFlag | null }

function isSnapshot(value: unknown): value is Snapshot {
  if (value === null || typeof value !== 'object') return false
  const s = value as Partial<Snapshot>
  return s.schemaVersion === SNAPSHOT_SCHEMA_VERSION && typeof s.environment === 'string' && typeof s.etag === 'string' && Array.isArray(s.flags)
}

const typeOfValue = (v: unknown): ValueType | 'null' =>
  v === null || v === undefined ? 'null' : typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : 'json'

export class FlagsClient {
  private snapshot: Snapshot | null = null
  private flags = new Map<string, Compiled>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly listeners = new Set<(snapshot: Snapshot) => void>()
  private readonly readyPromise: Promise<void>

  constructor(private readonly options: FlagsClientOptions) {
    if (options.bootstrap) this.apply(options.bootstrap)
    this.readyPromise = this.start()
  }

  /** Resolve depois da primeira tentativa (cache e rede). Nunca rejeita: sem snapshot, valem os padrões. */
  ready(): Promise<void> {
    return this.readyPromise
  }

  get isReady(): boolean {
    return this.snapshot !== null
  }

  get environment(): string | null {
    return this.snapshot?.environment ?? null
  }

  get etag(): string | null {
    return this.snapshot?.etag ?? null
  }

  /** Avisa quando o snapshot muda. Devolve a função que cancela. */
  onChange(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async start(): Promise<void> {
    if (this.options.mode === 'offline') return
    if (this.options.cache && !this.snapshot) {
      try {
        const cached = await this.options.cache.load()
        if (isSnapshot(cached)) this.apply(cached)
      } catch (error) {
        this.report(error)
      }
    }
    await this.refresh()
    this.schedule()
  }

  private schedule(): void {
    const every = this.options.pollIntervalMs ?? DEFAULT_POLL_MS
    if (this.closed || every === 0) return
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule())
    }, Math.max(every, MIN_POLL_MS))
    // Node: o polling não segura o processo aberto.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  private url(): string {
    if (this.options.snapshotUrl) return this.options.snapshotUrl
    return `${(this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${SNAPSHOT_PATH}`
  }

  /** Busca o snapshot (com If-None-Match). Devolve true se mudou. Falha de rede mantém o último. */
  async refresh(): Promise<boolean> {
    if (this.options.mode === 'offline' || this.closed) return false
    const headers: Record<string, string> = { Accept: 'application/json', ...this.options.headers }
    if (this.options.credential) headers.Authorization = `Bearer ${this.options.credential}`
    if (this.options.sdkKey) headers['X-AIUBY-Flags-Key'] = this.options.sdkKey
    if (this.snapshot) headers['If-None-Match'] = this.snapshot.etag
    try {
      const response = await (this.options.fetch ?? fetch)(this.url(), { method: 'GET', headers })
      if (response.status === 304) return false
      if (!response.ok) throw new Error(`Snapshot de flags respondeu ${response.status}.`)
      const body: unknown = await response.json()
      if (!isSnapshot(body)) throw new Error('Snapshot de flags em formato desconhecido.')
      const changed = body.etag !== this.snapshot?.etag
      this.apply(body)
      if (this.options.cache) await this.options.cache.save(body)
      return changed
    } catch (error) {
      this.report(error)
      return false
    }
  }

  private apply(snapshot: Snapshot): void {
    const flags = new Map<string, Compiled>()
    for (const flag of snapshot.flags) {
      const compiled = flag.published ? compileFlag({ flagKey: flag.key, salt: flag.salt, valueType: flag.valueType, version: flag.version, config: flag.config }) : null
      flags.set(flag.key, { flag, compiled })
    }
    this.snapshot = snapshot
    this.flags = flags
    for (const listener of this.listeners) listener(snapshot)
  }

  /** Avaliação completa (valor, variante, motivo, metadados), igual à resposta de /sdk/evaluate sem o token de exposição. */
  evaluate(flagKey: string, context: EvaluationContext, defaultValue?: unknown): EvaluationResult {
    if (!this.snapshot) return errorResult(flagKey, 'PROVIDER_NOT_READY', 'Snapshot de flags ainda não carregado.', defaultValue)
    if (!context || typeof context.key !== 'string' || context.key.length === 0) {
      return errorResult(flagKey, 'TARGETING_KEY_MISSING', 'O contexto precisa de key (texto).', defaultValue)
    }
    const entry = this.flags.get(flagKey)
    if (!entry) return errorResult(flagKey, 'FLAG_NOT_FOUND', 'Flag não encontrada neste workspace.', defaultValue)
    const { flag, compiled } = entry
    if (!compiled || !flag.published) {
      return { flagKey, value: defaultValue ?? null, variant: null, reason: 'DEFAULT', flagMetadata: { environment: this.snapshot.environment, published: false, valueType: flag.valueType } }
    }
    try {
      return evaluateFlag(compiled, context, { killed: flag.killed, environment: this.snapshot.environment, defaultValue })
    } catch (error) {
      return errorResult(flagKey, 'GENERAL', error instanceof Error ? error.message : 'Falha ao avaliar.', defaultValue)
    }
  }

  /** Valor tipado: se o valor servido não for do tipo do padrão, devolve o padrão (TYPE_MISMATCH). */
  details<T>(flagKey: string, context: EvaluationContext, defaultValue: T): EvaluationResult & { value: T } {
    const result = this.evaluate(flagKey, context, defaultValue)
    if (result.reason === 'ERROR' || typeOfValue(result.value) === typeOfValue(defaultValue) || (result.value === null && result.variant === null)) {
      return { ...result, value: (result.value ?? defaultValue) as T }
    }
    return { ...errorResult(flagKey, 'TYPE_MISMATCH', `A flag serve ${typeOfValue(result.value)}, e o padrão é ${typeOfValue(defaultValue)}.`, defaultValue, result.flagMetadata), value: defaultValue }
  }

  getBoolean(flagKey: string, context: EvaluationContext, defaultValue: boolean): boolean {
    return this.details(flagKey, context, defaultValue).value
  }

  getString(flagKey: string, context: EvaluationContext, defaultValue: string): string {
    return this.details(flagKey, context, defaultValue).value
  }

  getNumber(flagKey: string, context: EvaluationContext, defaultValue: number): number {
    return this.details(flagKey, context, defaultValue).value
  }

  /** Configuração estruturada (flag `json`, inclusive AI Configs). */
  getJson<T extends object>(flagKey: string, context: EvaluationContext, defaultValue: T): T {
    return this.details(flagKey, context, defaultValue).value
  }
}

export function createFlagsClient(options: FlagsClientOptions): FlagsClient {
  if (options.mode !== 'offline' && !options.snapshotUrl && (!options.sdkKey || !options.credential)) {
    throw new Error('Modo online precisa de sdkKey e credential (ou snapshotUrl de um proxy seu).')
  }
  if (options.mode === 'offline' && !options.bootstrap) throw new Error('Modo offline precisa de bootstrap (um snapshot salvo).')
  return new FlagsClient(options)
}
