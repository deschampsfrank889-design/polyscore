// server/utils/relayer-config.ts
export function getRelayerConfig(event: any) {
  const c = useRuntimeConfig(event)
  if (!c.relayerPrivateKey || !c.approverPrivateKey || !c.bridge.ethRpc) {
    throw createError({ statusCode: 500, statusMessage: 'Server not configured' })
  }
  return c
}