import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { BUCKETS, bucketOf, compileFlag, evaluateFlag, pickByWeight } from '../src/engine'
import { sha256Uint32 } from '../src/sha256'

describe('motor de avaliação', () => {
  test('o SHA-256 em JS puro bate com o do Node', () => {
    for (const text of ['', 'a', 'checkout.salt.cliente-42', 'ç'.repeat(300)]) {
      expect(sha256Uint32(text)).toBe(createHash('sha256').update(text).digest().readUInt32BE(0))
    }
  })

  test('o balde fica no intervalo e é estável', () => {
    const b = bucketOf('checkout', 'salt', 'cliente-42')
    expect(b).toBeGreaterThanOrEqual(0)
    expect(b).toBeLessThan(BUCKETS)
    expect(bucketOf('checkout', 'salt', 'cliente-42')).toBe(b)
  })

  test('a escolha por peso respeita as faixas', () => {
    const items = [{ v: 'a', weight: 5000 }, { v: 'b', weight: 5000 }]
    expect(pickByWeight(items, 0).v).toBe('a')
    expect(pickByWeight(items, 9999).v).toBe('b')
  })

  test('flag desligada devolve o padrão com motivo DISABLED', () => {
    const flag = compileFlag({
      flagKey: 'novo', salt: 's', valueType: 'boolean', version: 1,
      config: {
        enabled: false, offVariant: 'off', rules: [], fallthrough: { variant: 'on' }, bucketBy: 'key', segments: {},
        variants: [{ key: 'on', value: true }, { key: 'off', value: false }],
      },
    })
    const r = evaluateFlag(flag, { key: 'u1' }, { killed: false, environment: 'prod', defaultValue: true })
    expect(r.value).toBe(false)
    expect(r.reason).toBe('DISABLED')
  })
})
