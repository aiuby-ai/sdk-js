import { sha256Uint32 } from './sha256'

/**
 * Motor de avaliação das flags, puro e sem dependência: o MESMO código roda no servidor da AIUBY
 * (lib/flags reexporta daqui) e no SDK (avaliação local a partir do snapshot). Por isso não há
 * duas implementações do bucketing nem das regras. Modelo do OpenFeature: valor, variante, motivo
 * e metadados. Ordem: kill switch → desligada → regras na ordem escrita → fallthrough.
 */

/** Baldes de 0 a 9.999: 1 balde = 0,01% do tráfego. */
export const BUCKETS = 10_000
/** Texto comparado por starts_with/ends_with/contains: o atributo é cortado em 1.000 caracteres. */
export const MAX_TEXT_INPUT = 1000

export const SEMVER = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

export const REASONS = ['STATIC', 'TARGETING_MATCH', 'SPLIT', 'DEFAULT', 'DISABLED', 'ERROR'] as const
export type Reason = (typeof REASONS)[number]
export type ErrorCode = 'FLAG_NOT_FOUND' | 'TARGETING_KEY_MISSING' | 'TYPE_MISMATCH' | 'PARSE_ERROR' | 'PROVIDER_NOT_READY' | 'GENERAL'
export type ValueType = 'boolean' | 'string' | 'number' | 'json'

export type FlagMetadata = Record<string, string | number | boolean>
export type EvaluationResult = {
  flagKey: string
  value: unknown
  variant: string | null
  reason: Reason
  errorCode?: ErrorCode
  errorMessage?: string
  flagMetadata: FlagMetadata
}

/** Formas estruturais da configuração (o servidor valida com zod antes de gravar; aqui só se lê). */
export type EngineCondition = { op: string; attribute?: string; value?: unknown }
export type EngineSegment = { conditions: readonly EngineCondition[]; included: readonly string[]; excluded: readonly string[] }
export type EngineServe = { variant: string } | { rollout: readonly { variant: string; weight: number }[] }
export type EngineRule = { id: string; conditions: readonly EngineCondition[]; segments: readonly string[]; serve: EngineServe }
export type EngineConfig = {
  enabled: boolean
  variants: readonly { key: string; value?: unknown }[]
  offVariant: string
  rules: readonly EngineRule[]
  fallthrough: EngineServe
  bucketBy: string
  segments: Record<string, { revision: number; definition: EngineSegment }>
}

/**
 * Balde do contexto na flag: os primeiros 32 bits do SHA-256 de `flagKey.salt.chave`, módulo 10.000.
 * O viés do módulo é de no máximo 2^32 mod 10.000 / 2^32 ≈ 1,6·10⁻⁶ por balde, desprezível.
 */
export function bucketOf(flagKey: string, salt: string, contextKey: string): number {
  return sha256Uint32(`${flagKey}.${salt}.${contextKey}`) % BUCKETS
}

/** Escolhe a variante pelo balde: pesos em baldes (somam 10.000), na ordem em que foram escritos. */
export function pickByWeight<T extends { weight: number }>(items: readonly T[], bucket: number): T {
  let cumulative = 0
  for (const item of items) {
    cumulative += item.weight
    if (bucket < cumulative) return item
  }
  return items[items.length - 1]
}

/** Compara duas versões semver. Pré-lançamento vem antes do lançamento (1.0.0-rc.1 < 1.0.0). */
export function compareSemver(a: string, b: string): number | undefined {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return undefined
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return Math.sign(d)
  }
  const ra = pa[4]
  const rb = pb[4]
  if (!ra && !rb) return 0
  if (!ra) return 1
  if (!rb) return -1
  const xa = ra.split('.')
  const xb = rb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1
    if (xb[i] === undefined) return 1
    const na = /^\d+$/.test(xa[i])
    const nb = /^\d+$/.test(xb[i])
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i])
      if (d !== 0) return Math.sign(d)
    } else if (na !== nb) return na ? -1 : 1
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1
  }
  return 0
}

type CompiledSegment = { conditions: readonly EngineCondition[]; included: Set<string>; excluded: Set<string> }

/** Versão publicada pronta para avaliar (listas de chaves viram conjuntos). */
export type CompiledFlag<C extends EngineConfig = EngineConfig> = {
  flagKey: string
  salt: string
  valueType: ValueType
  version: number
  config: C
  values: Map<string, unknown>
  segments: Map<string, CompiledSegment>
}

export function compileSegment(s: EngineSegment): CompiledSegment {
  return { conditions: s.conditions, included: new Set(s.included), excluded: new Set(s.excluded) }
}

export function compileFlag<C extends EngineConfig>(input: { flagKey: string; salt: string; valueType: ValueType; version: number; config: C }): CompiledFlag<C> {
  const segments = new Map(Object.entries(input.config.segments ?? {}).map(([k, s]) => [k, compileSegment(s.definition)]))
  return { ...input, values: new Map(input.config.variants.map((v) => [v.key, v.value])), segments }
}

export function readAttribute(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * Condição que não dá para avaliar (atributo ausente ou de outro tipo) conta como não casada.
 * Todo operador roda em tempo linear no tamanho do atributo (texto cortado em 1.000 caracteres).
 */
export function conditionHolds(c: EngineCondition, context: Record<string, unknown>): boolean {
  const v = readAttribute(context, typeof c.attribute === 'string' ? c.attribute : '')
  const x = c.value
  switch (c.op) {
    case 'eq': return isScalar(v) && v === x
    case 'neq': return isScalar(v) && typeof v === typeof x && v !== x
    case 'in': return isScalar(v) && Array.isArray(x) && x.some((y) => y === v)
    case 'not_in': return isScalar(v) && Array.isArray(x) && !x.some((y) => y === v)
    case 'gt': return typeof v === 'number' && typeof x === 'number' && v > x
    case 'gte': return typeof v === 'number' && typeof x === 'number' && v >= x
    case 'lt': return typeof v === 'number' && typeof x === 'number' && v < x
    case 'lte': return typeof v === 'number' && typeof x === 'number' && v <= x
    case 'starts_with': return typeof v === 'string' && typeof x === 'string' && v.slice(0, MAX_TEXT_INPUT).startsWith(x)
    case 'ends_with': return typeof v === 'string' && typeof x === 'string' && v.slice(0, MAX_TEXT_INPUT).endsWith(x)
    case 'contains': return typeof v === 'string' && typeof x === 'string' && v.slice(0, MAX_TEXT_INPUT).includes(x)
    case 'semver_eq':
    case 'semver_gt':
    case 'semver_gte':
    case 'semver_lt':
    case 'semver_lte': {
      if (typeof v !== 'string' || typeof x !== 'string') return false
      const cmp = compareSemver(v, x)
      if (cmp === undefined) return false
      return c.op === 'semver_eq' ? cmp === 0 : c.op === 'semver_gt' ? cmp > 0 : c.op === 'semver_gte' ? cmp >= 0 : c.op === 'semver_lt' ? cmp < 0 : cmp <= 0
    }
    // Regex não passa da validação do servidor; operador desconhecido (dado antigo ou futuro) não casa.
    default: return false
  }
}

export function inSegment(s: CompiledSegment, context: Record<string, unknown> & { key: string }): boolean {
  if (s.excluded.has(context.key)) return false
  if (s.included.has(context.key)) return true
  return s.conditions.length > 0 && s.conditions.every((c) => conditionHolds(c, context))
}

type Served = { variant: string; split: boolean } | { error: ErrorCode; message: string }

function serve(flag: CompiledFlag, s: EngineServe, context: Record<string, unknown>): Served {
  if ('variant' in s) return { variant: s.variant, split: false }
  const raw = readAttribute(context, flag.config.bucketBy)
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: 'TARGETING_KEY_MISSING', message: `O contexto não tem o atributo ${flag.config.bucketBy} para o rollout.` }
  }
  return { variant: pickByWeight(s.rollout, bucketOf(flag.flagKey, flag.salt, String(raw))).variant, split: true }
}

export function errorResult(flagKey: string, errorCode: ErrorCode, errorMessage: string, defaultValue: unknown, flagMetadata: FlagMetadata = {}): EvaluationResult {
  return { flagKey, value: defaultValue ?? null, variant: null, reason: 'ERROR', errorCode, errorMessage, flagMetadata }
}

/**
 * Avalia uma versão publicada. `killed` vem do estado do ambiente (não da versão): o kill switch
 * vale na hora, sem nova versão. `defaultValue` é o padrão de quem chama, usado só em erro.
 */
export function evaluateFlag(flag: CompiledFlag, context: Record<string, unknown> & { key: string }, options: { killed: boolean; environment: string; defaultValue?: unknown }): EvaluationResult {
  const meta: FlagMetadata = { version: flag.version, environment: options.environment, valueType: flag.valueType }
  const result = (variant: string, reason: Reason, extra: FlagMetadata = {}): EvaluationResult =>
    ({ flagKey: flag.flagKey, value: flag.values.get(variant), variant, reason, flagMetadata: { ...meta, ...extra } })
  const c = flag.config
  if (options.killed) return result(c.offVariant, 'DISABLED', { killed: true })
  if (!c.enabled) return result(c.offVariant, 'DISABLED')
  for (const rule of c.rules) {
    if (!rule.conditions.every((x) => conditionHolds(x, context))) continue
    if (!rule.segments.every((k) => { const seg = flag.segments.get(k); return seg !== undefined && inSegment(seg, context) })) continue
    const s = serve(flag, rule.serve, context)
    if ('error' in s) return errorResult(flag.flagKey, s.error, s.message, options.defaultValue, { ...meta, ruleId: rule.id })
    return result(s.variant, s.split ? 'SPLIT' : 'TARGETING_MATCH', { ruleId: rule.id })
  }
  const s = serve(flag, c.fallthrough, context)
  if ('error' in s) return errorResult(flag.flagKey, s.error, s.message, options.defaultValue, meta)
  return result(s.variant, s.split ? 'SPLIT' : c.rules.length === 0 ? 'STATIC' : 'DEFAULT')
}
