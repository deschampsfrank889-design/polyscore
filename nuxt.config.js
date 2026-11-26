// https://v3.nuxtjs.org/api/configuration/nuxt.config


export default defineNuxtConfig({
  css: [
    "~/assets/css/tailwind.css",
    "~/layouts/global.css"
  ],
  modules: ["@nuxtjs/tailwindcss", "nuxt-icon"],
  plugins: [{ src: "@/plugins/aos", ssr: false, mode: "client" }],
  nitro: {
    preset: 'vercel'
  },
  routeRules: {
    '/api/**': { cache: false } 
  },
  runtimeConfig: {
    // ---- SERVER ONLY (never sent to the browser) ----
    // Declare the names here and leave them empty. Real values come from
    // environment variables (NUXT_ prefix): a gitignored .env locally,
    // Vercel "Sensitive" env vars in production.
    relayerPrivateKey: '',   // NUXT_RELAYER_PRIVATE_KEY
    approverPrivateKey: '',  // NUXT_APPROVER_PRIVATE_KEY
    redisUrl: '',            // NUXT_REDIS_URL
    allowedOrigins: '',      // NUXT_ALLOWED_ORIGINS (comma separated)

    bridge: {
      ethRpc: '',            // NUXT_BRIDGE_ETH_RPC (contains your Alchemy key)
      uniRpc: '',            // NUXT_BRIDGE_UNI_RPC (contains your Alchemy key)
      minConfirmations: '',  // NUXT_BRIDGE_MIN_CONFIRMATIONS
      budgetMs: '',          // NUXT_BRIDGE_BUDGET_MS
      maxAmount: '80000',    // not a secret; keep equal to the vault's maxAmount
      gasDripEth: '',
      gasMinEth: '',
      gasCooldownMin: '',
    },

    // ---- PUBLIC (exposed to the browser) ----
    public: {
      bridgeNetwork: 'mainnet',
      vaultAddress: '', 
      uniToken: '', 
      relayerUrl: '/api/bridge',
      ethOusd: '', 
      ethUsdc: '', 
      ethUsdt: '', 
      ethDai: '',
    }
  },
});