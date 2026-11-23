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

    // ---- PUBLIC (sent to the browser: never put a secret here) ----
    public: {
      bridgeNetwork: 'testnet',  // switch to 'mainnet' only via env var, after testing
      vaultAddress: '',          // NUXT_PUBLIC_VAULT_ADDRESS
      uniToken: '',              // NUXT_PUBLIC_UNI_TOKEN
      ethUsdc: '',               // NUXT_PUBLIC_ETH_USDC (optional override)
      reownProjectId: '',        // NUXT_PUBLIC_REOWN_PROJECT_ID (public by design)
      relayerUrl: '/api/bridge',
    },
  },
});





// ,
//   runtimeConfig: {
//   // ---- private (server only) ----
//   relayerPrivateKey: '3eb9387730b821535d369caf0c17b6bdfd76a3dd3957286d29b4be048b75f355',
//   redisUrl: 'redis://default:bTBHK6UQGeRpavvm7LzSSZtkdrDeFoGa@priceless-hypercompact-gleeful-89274.db.redis.io:14490',
//   allowedOrigins: 'http://localhost:3000,https://ekiden.web.app', // comma-separated

//   bridge: {
//     ethRpc: 'https://eth-mainnet.g.alchemy.com/v2/Y8ew7o5gjdFDCO698pASWL1GgPGasOmj',          // empty = preset RPC
//     uniRpc: 'https://unichain-mainnet.g.alchemy.com/v2/Y8ew7o5gjdFDCO698pASWL1GgPGasOmj',          // empty = preset RPC
//     maxAmount: process.env.BRIDGE_MAX_AMOUNT || '10000',        // USDC, 6 decimals
//     gasDripEth: process.env.BRIDGE_GAS_DRIP_ETH || '0.00005',
//     gasMinEth: process.env.BRIDGE_GAS_MIN_ETH || '0.00002',
//     gasCooldownMin: process.env.BRIDGE_GAS_COOLDOWN_MIN || '60',
//     minConfirmations: process.env.BRIDGE_MIN_CONFIRMATIONS || '', // empty = 2 mainnet / 1 testnet
//     budgetMs: process.env.BRIDGE_BUDGET_MS || '8000',
//   },

//   // ---- public (also exposed to the client) ----
//   public: {
//     bridgeNetwork: 'mainnet', // 'mainnet' | 'testnet'
//     vaultAddress: '0x6922672247a0155b00D203cb1E345E996bD0Cb18',          // EkidenVault on Ethereum
//     uniToken: '0xa23352Ab0114A023C92a206FE786AC5472C7d08e',                  // USDC token on Unichain
//   },
// },