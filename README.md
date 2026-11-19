# @aiuby-ia/flags — SDK JS/TS de flags e configuração

Cliente leve (sem dependência) para navegador e Node 18+.

```sh
npm install @aiuby-ia/flags
```

## Avaliação local = avaliação do servidor

O motor (`src/engine.ts`, também exportado como `@aiuby-ia/flags/engine`) é o **mesmo código** que o servidor da AIUBY usa. O bucketing é SHA-256 de `flagKey.salt.chave` (primeiros 32 bits, módulo 10.000), em JavaScript puro (`sha256.ts`), idêntico ao `createHash('sha256')` do Node. Os testes deste repositório conferem o hash contra o `crypto` do Node, e a plataforma confere que o SDK devolve o mesmo valor, variante e motivo que o servidor.

## Uso no servidor (Node)

```ts
import { createFlagsClient } from '@aiuby-ia/flags'

const flags = createFlagsClient({
  credential: process.env.AIUBY_FLAGS_TOKEN!, // escopo flags:evaluate
  sdkKey: process.env.AIUBY_FLAGS_SDK_KEY!,   // chave do ambiente
  pollIntervalMs: 30_000,
  onError: (e) => console.warn('[flags]', e.message),
})
await flags.ready()

const ctx = { key: 'cliente-42', plan: 'pro', app: { version: '2.3.0' } }
if (flags.getBoolean('checkout-novo', ctx, false)) { /* ... */ }
const ai = flags.getJson('assistente.config', ctx, { model: 'padrao', temperature: 0 })
```

## Navegador

Não coloque a credencial no navegador. Exponha o snapshot por uma rota do seu backend e aponte `snapshotUrl`:

```ts
const flags = createFlagsClient({
  snapshotUrl: '/api/minhas-flags/snapshot', // seu backend repassa /api/platform/flags/sdk/snapshot (com ETag)
  cache: {
    load: () => { try { return JSON.parse(localStorage.getItem('flags') ?? 'null') } catch { return null } },
    save: (s) => { try { localStorage.setItem('flags', JSON.stringify(s)) } catch {} },
  },
})
```

## Modos

- **online**: snapshot + polling com `If-None-Match` (304 quando nada mudou). Falha de rede mantém o último snapshot.
- **cache**: `cache.load()` no início (funciona antes da rede responder ou sem ela) e `cache.save()` a cada snapshot novo.
- **offline**: `mode: 'offline', bootstrap: snapshotSalvo`. Nenhuma chamada de rede.

Sem snapshot, toda avaliação devolve o padrão de quem chama com `reason: 'ERROR'` e `errorCode: 'PROVIDER_NOT_READY'`. Valor servido de tipo diferente do padrão: devolve o padrão (`TYPE_MISMATCH`).

## OpenFeature

```ts
import { OpenFeature } from '@openfeature/server-sdk'
import { AiubyFlagsServerProvider, createFlagsClient } from '@aiuby-ia/flags'

await OpenFeature.setProviderAndWait(new AiubyFlagsServerProvider(createFlagsClient({ credential, sdkKey })))
const value = await OpenFeature.getClient().getBooleanValue('checkout-novo', false, { targetingKey: 'cliente-42', plan: 'pro' })
```

No navegador, `AiubyFlagsWebProvider` (respostas síncronas, para `@openfeature/web-sdk`). Os pacotes `@openfeature/*` são peer dependencies opcionais: o SDK implementa a interface mínima do provedor sem importá-los.

## Limites

- A avaliação local não gera o token de exposição (assinado pelo servidor). Para experimento com exposição gravada, avalie pela rota remota `/sdk/evaluate`.
- Sem SSE: mudanças chegam pelo polling (mínimo 5 s, padrão 30 s).

## Licença

Apache 2.0. Veja [LICENSE](LICENSE).
