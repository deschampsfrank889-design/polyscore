// config/tokens.config.js
// Single place that defines the Ethereum tokens the bridge accepts, plus the two free-signature
// messages. The server (server/api/bridge.post.js) has its own copy of the two message functions:
// keep the wording identical or signatures will not verify.

// OUSD on Unichain (your custom token) always uses 6 decimals.
export const UNI_DECIMALS = 6

// `cfgKey` is the runtimeConfig.public key that can override the address.
// Mainnet addresses are built in. On Sepolia set your own test tokens in runtimeConfig
// (a token with no address is hidden on the site).
export const TOKENS = [
  {
    key: 'OUSD', symbol: 'Open USD', short: 'OUSD', decimals: 6, icon: '/images/ousd.png', cfgKey: 'ethOusd',
    addresses: { mainnet: '0x9f6F3991D525015a6F8CaF062C83b62fD3AC4436', testnet: '' },
  },
  {
    key: 'USDC', symbol: 'USDC', short: 'USDC', decimals: 6, icon: '/images/usdc.png', cfgKey: 'ethUsdc',
    // Circle's Sepolia USDC. Check it at developers.circle.com before relying on it.
    addresses: { mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', testnet: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  },
  {
    key: 'USDT', symbol: 'USDT', short: 'USDT', decimals: 6, icon: '/images/usdt.png', cfgKey: 'ethUsdt',
    addresses: { mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7', testnet: '' },
  },
  {
    key: 'DAI', symbol: 'DAI', short: 'DAI', decimals: 18, icon: '/images/dai.png', cfgKey: 'ethDai',
    addresses: { mainnet: '0x6B175474E89094C44Da98b954EedeAC495271d0F', testnet: '' },
  },
]

export const tokenByKey = (key) => TOKENS.find((t) => t.key === key) || null

// Free off-chain signatures (they cost no gas and are NOT permits or approvals: they cannot move funds).
// deposit: the sender confirms where the OUSD should be delivered on Unichain.
export const deliveryMessage = (tx, recipient) =>
  `UNI Bridge: deliver the OUSD for my deposit ${String(tx).toLowerCase()} to ${recipient}`

// withdraw: the sender confirms which token to pay out and where.
export const payoutMessage = (tx, recipient, tokenKey) =>
  `UNI Bridge: pay out my ${tokenKey} for lock ${String(tx).toLowerCase()} to ${recipient}`