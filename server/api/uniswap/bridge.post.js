// server/api/bridge.post.js  (Nuxt 3 / Nitro, deployed on Vercel)
// All settings come from runtimeConfig (nuxt.config.js) - no process.env here.
//
// Actions (POST body { action, ... }):
//   deposit  { claimTx, recipient?, authSig? }                 Ethereum -> Unichain delivery
//   credit   { address }                                       what a wallet may still withdraw, per token
//   approve  { lockTx, token?, recipient?, authSig? }          Unichain -> Ethereum payout (paid by the relayer)
//   gas      { address }                                       Unichain gas top-up
//
// Security model (no approve, no permit anywhere):
//  - A deposit is a plain ERC-20 transfer to the vault. We read the Transfer event from the receipt.
//    The credit and the OUSD always go to the wallet that SENT the tokens, unless that wallet signs
//    (free, off-chain) a message naming another receiving address.
//  - A withdrawal is a plain OUSD transfer on Unichain. We verify it, spend credit in ONE token
//    (the one that was deposited), then sign an EIP-712 approval and submit vault.withdraw() ourselves.
//    The signature never leaves this server, and the vault only pays the recipient inside it.
//  - Credit is spent atomically in Redis, keyed by the lock tx, so a lock can be paid out once.
import { defineEventHandler, readBody, handleCors, setResponseStatus } from 'h3'
import { createClient } from 'redis'
import {
  JsonRpcProvider, Wallet, Contract, parseEther, parseUnits, isAddress, isHexString,
  getAddress, verifyMessage, id,
} from 'ethers'

// ---------------------------------------------------------------------------------------------
// Static config (keep TOKEN_DEFS in step with config/tokens.config.js)
// ---------------------------------------------------------------------------------------------
const PRESETS = {
  mainnet: { ethId: 1, ethRpc: 'https://ethereum-rpc.publicnode.com', uniId: 130, uniRpc: 'https://mainnet.unichain.org' },
  testnet: { ethId: 11155111, ethRpc: 'https://ethereum-sepolia-rpc.publicnode.com', uniId: 1301, uniRpc: 'https://sepolia.unichain.org' },
}

const TOKEN_DEFS = [
  { key: 'OUSD', cfgKey: 'ethOusd', decimals: 6, mainnet: '0x9f6F3991D525015a6F8CaF062C83b62fD3AC4436', testnet: '' },
  { key: 'USDC', cfgKey: 'ethUsdc', decimals: 6, mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', testnet: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  { key: 'USDT', cfgKey: 'ethUsdt', decimals: 6, mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7', testnet: '' },
  { key: 'DAI', cfgKey: 'ethDai', decimals: 18, mainnet: '0x6B175474E89094C44Da98b954EedeAC495271d0F', testnet: '' },
]

// The two free-signature messages. MUST match config/tokens.config.js word for word.
const deliveryMessage = (tx, recipient) =>
  `UNI Bridge: deliver the OUSD for my deposit ${String(tx).toLowerCase()} to ${recipient}`
const payoutMessage = (tx, recipient, tokenKey) =>
  `UNI Bridge: pay out my ${tokenKey} for lock ${String(tx).toLowerCase()} to ${recipient}`

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)')

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']
const UNI_TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function mintTokens(uint256 tokens)',
  'function transfer(address to, uint256 amount) returns (bool)',
]
const VAULT_ABI = [
  'function withdraw(address token, uint256 amount, bytes32 ref, uint256 deadline, address recipient, bytes signature)',
  'function tokens(address) view returns (bool listed, bool depositsOpen, uint8 decimals)',
  'function refUsed(bytes32) view returns (bool)',
  'function minAmount() view returns (uint256)',
  'function maxAmount() view returns (uint256)',
  'function paused() view returns (bool)',
]
const WITHDRAW_TYPES = {
  Withdraw: [
    { name: 'token', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'ref', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpError = (status, message) => Object.assign(new Error(message), { status })
const sameAddr = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()

// ---------------------------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------------------------
let redisPromise
let redisUrl
const redis = () => {
  if (!redisPromise) {
    const client = createClient({ url: redisUrl })
    client.on('error', (e) => console.error('redis error', e))
    redisPromise = client.connect().then(() => client).catch((e) => { redisPromise = null; throw e })
  }
  return redisPromise
}
const getJSON = async (key) => {
  const v = await (await redis()).get(key)
  return v ? JSON.parse(v) : null
}
const putJSON = async (key, value) => (await redis()).set(key, JSON.stringify(value))

async function acquire(key, leaseMs) {
  return (await (await redis()).set(key, '1', { NX: true, PX: leaseMs })) === 'OK'
}
const release = async (key) => { try { await (await redis()).del(key) } catch { } }

// Credit ledger: hash `credit/<address>` with one field per token key (values are 6-decimal dollar units).
// Both scripts run atomically inside Redis.
const CREDIT_ADD = `
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[2])
  return 1
end
return 0`

// Spend credit and create the payout record in one step. A lock tx can only ever be reserved once.
const CREDIT_RESERVE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'exists' end
local bal = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if bal < tonumber(ARGV[2]) then return 'insufficient' end
redis.call('HINCRBY', KEYS[2], ARGV[1], '-' .. ARGV[2])
redis.call('SET', KEYS[1], ARGV[3])
return 'ok'`

async function readCredits(address) {
  const h = await (await redis()).hGetAll(`credit/${address.toLowerCase()}`)
  const out = {}
  for (const [k, v] of Object.entries(h || {})) out[k] = BigInt(v)
  return out
}

// ---------------------------------------------------------------------------------------------
// Nonces: public RPCs sit behind load balancers, so 'pending' can come from a lagging node.
// We keep our own next-nonce per chain in Redis and use whichever is higher.
// ---------------------------------------------------------------------------------------------
const NONCE_TTL_S = 120
const isNonceError = (e) =>
  e && (e.code === 'NONCE_EXPIRED' || e.code === 'REPLACEMENT_UNDERPRICED' || /nonce too low/i.test(e.message || ''))

// chain: 'uni' (mint, transfer, gas drips) or 'eth' (vault payouts). `fn({ nonce })` must broadcast and return the tx.
async function withSendLock(c, chain, fn) {
  const provider = chain === 'eth' ? c.ethRead : c.uniRead
  const wallet = chain === 'eth' ? c.ethWallet : c.wallet
  const lockKey = `lock/send/${chain}`
  const nonceKey = `nonce/${chain}/${wallet.address.toLowerCase()}`
  for (let i = 0; i < 15; i++) {
    if (await acquire(lockKey, 20000)) {
      try {
        const r = await redis()
        for (let attempt = 0; attempt < 3; attempt++) {
          const chainNonce = await provider.getTransactionCount(wallet.address, 'pending')
          const stored = Number(await r.get(nonceKey)) || 0
          const nonce = Math.max(chainNonce, stored)
          try {
            const tx = await fn({ nonce })
            await r.set(nonceKey, String(nonce + 1), { EX: NONCE_TTL_S })
            return tx
          } catch (e) {
            if (!isNonceError(e)) throw e
            await r.set(nonceKey, String(nonce + 1), { EX: NONCE_TTL_S })
            await sleep(500)
          }
        }
        throw httpError(409, 'Nonce conflict, retrying')
      } finally { await release(lockKey) }
    }
    await sleep(400)
  }
  throw httpError(409, 'The relayer is busy, retrying')
}

// ---------------------------------------------------------------------------------------------
// Everything the handlers need, built from runtimeConfig
// ---------------------------------------------------------------------------------------------
function context(event) {
  const rc = useRuntimeConfig(event)
  const pub = rc.public
  const b = rc.bridge || {}

  const network = pub.bridgeNetwork === 'mainnet' ? 'mainnet' : 'testnet'
  const P = PRESETS[network]

  if (!isAddress(pub.vaultAddress || '') || !isAddress(pub.uniToken || '') || !rc.relayerPrivateKey) {
    throw httpError(500, 'Relayer is not configured')
  }
  if (!rc.redisUrl) throw httpError(500, 'Redis is not configured')
  redisUrl = rc.redisUrl

  // Supported tokens = those with a valid address (runtimeConfig override, else the built-in one)
  const tokens = {}
  for (const d of TOKEN_DEFS) {
    const addr = pub[d.cfgKey] || d[network]
    if (isAddress(addr || '')) tokens[d.key] = { key: d.key, decimals: d.decimals, address: getAddress(addr) }
  }
  if (!Object.keys(tokens).length) throw httpError(500, 'No tokens are configured')
  const byAddress = {}
  for (const t of Object.values(tokens)) byAddress[t.address.toLowerCase()] = t

  const ethRead = new JsonRpcProvider(b.ethRpc || P.ethRpc, P.ethId, { staticNetwork: true })
  const uniRead = new JsonRpcProvider(b.uniRpc || P.uniRpc, P.uniId, { staticNetwork: true })
  const wallet = new Wallet(rc.relayerPrivateKey, uniRead)
  const ethWallet = new Wallet(rc.relayerPrivateKey, ethRead) // needs ETH for payout gas; this address is the vault's `approver`
  const vault = getAddress(pub.vaultAddress)
  const uniTokenAddr = getAddress(pub.uniToken)

  return {
    network, ethId: P.ethId, vault, uniTokenAddr, tokens, byAddress,
    minConf: Number(b.minConfirmations || (network === 'mainnet' ? 2 : 1)),
    uniMinConf: Number(b.uniMinConfirmations || 1),
    budgetMs: Number(b.budgetMs || 8000),
    capAmount6: b.maxAmount ? parseUnits(String(b.maxAmount), 6) : null, // optional extra cap, 6-decimal units
    gasDrip: parseEther(String(b.gasDripEth || '0.00005')),
    gasMin: parseEther(String(b.gasMinEth || '0.00002')),
    gasCooldownMs: Number(b.gasCooldownMin || 60) * 60 * 1000,
    ethRead, uniRead, wallet, ethWallet,
    vaultRead: new Contract(vault, VAULT_ABI, ethRead),
    vaultSend: new Contract(vault, VAULT_ABI, ethWallet),
    token: new Contract(uniTokenAddr, UNI_TOKEN_ABI, wallet),
    allowedOrigins: String(rc.allowedOrigins || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------
function parseTransfer(log) {
  if (!log.topics || log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) return null // 4 topics = NFT transfer
  try {
    return {
      from: getAddress('0x' + log.topics[1].slice(26)),
      to: getAddress('0x' + log.topics[2].slice(26)),
      value: BigInt(log.data),
    }
  } catch { return null }
}

function recoverSigner(message, signature) {
  try { return verifyMessage(message, signature) } catch { throw httpError(400, 'Invalid signature') }
}

// Vault limits in 6-decimal units (plus the optional cap from runtimeConfig)
async function vaultLimits(c) {
  const [min, max] = await Promise.all([c.vaultRead.minAmount(), c.vaultRead.maxAmount()])
  return { min, max: c.capAmount6 && c.capAmount6 < max ? c.capAmount6 : max }
}

// The token must be listed on the vault and its decimals must match what this server assumes.
async function requireToken(c, key) {
  const t = c.tokens[key]
  if (!t) throw httpError(400, 'Unsupported token')
  const info = await c.vaultRead.tokens(t.address)
  if (!info.listed) throw httpError(400, `${key} is not enabled on the vault`)
  if (Number(info.decimals) !== t.decimals) throw httpError(500, `${key} decimals do not match the vault`)
  return t
}

const confirmOrTimeout = async (tx, remaining) => { await tx.wait(1, remaining()) }

// ---------------------------------------------------------------------------------------------
// ETHEREUM -> UNICHAIN
// ---------------------------------------------------------------------------------------------

// Reads the plain ERC-20 Transfer(sender -> vault) out of the deposit receipt.
async function verifyDeposit(c, hash) {
  if (!isHexString(hash, 32)) throw httpError(400, 'Invalid transaction hash')
  const receipt = await c.ethRead.getTransactionReceipt(hash)
  if (!receipt) throw httpError(409, 'Deposit transaction not visible yet')
  if (receipt.status !== 1) throw httpError(400, 'The deposit transaction failed on Ethereum')
  if ((await receipt.confirmations()) < c.minConf) throw httpError(409, 'Waiting for Ethereum confirmations')

  const hits = []
  for (const log of receipt.logs) {
    const t = c.byAddress[String(log.address).toLowerCase()]
    if (!t) continue
    const ev = parseTransfer(log)
    if (ev && sameAddr(ev.to, c.vault)) hits.push({ token: t, from: ev.from, value: ev.value })
  }
  if (!hits.length) throw httpError(400, 'No supported token transfer to the vault was found in this transaction')
  if (hits.length > 1) throw httpError(400, 'Send one token per transaction')

  const h = hits[0]
  // The tokens must come straight from the wallet that sent the transaction (no borrowed allowances).
  if (!sameAddr(h.from, receipt.from)) throw httpError(400, 'The deposit must be sent directly from the wallet that owns the tokens')

  const unit = 10n ** BigInt(h.token.decimals - 6)
  return { user: getAddress(h.from), token: h.token.key, amount6: h.value / unit }
}

// Mint / transfer on Unichain, once. Safe to call again after a timeout.
async function sendOnce(c, key, rec, field, deadline, send) {
  const remaining = () => Math.max(500, deadline - Date.now())
  const prior = rec[field]
  if (prior) {
    const r = await c.uniRead.getTransactionReceipt(prior)
    if (r && r.status === 1) return prior
    if (!r) {
      const pending = await c.uniRead.getTransaction(prior)
      if (pending) { await pending.wait(1, remaining()); return prior }
    }
  }
  const tx = await withSendLock(c, 'uni', send)
  rec[field] = tx.hash
  await putJSON(key, rec)
  await tx.wait(1, remaining())
  return tx.hash
}

async function deposit(c, body) {
  const { claimTx, recipient: recipientIn, authSig } = body
  if (typeof claimTx !== 'string') throw httpError(400, 'claimTx is required')
  const hash = claimTx.toLowerCase()
  const key = `deposit/${hash}`

  const existing = await getJSON(key)
  if (existing && existing.status === 'done') {
    return { status: 'done', mintTx: existing.mintTx, transferTx: existing.transferTx }
  }

  const dep = await verifyDeposit(c, hash)
  await requireToken(c, dep.token)
  const { max } = await vaultLimits(c)
  if (dep.amount6 <= 0n || dep.amount6 > max) throw httpError(400, 'Amount is outside the allowed range')

  const lockKey = `lock/${hash}`
  if (!(await acquire(lockKey, 25000))) throw httpError(409, 'This transfer is already being delivered')

  const deadline = Date.now() + c.budgetMs
  try {
    let rec = existing || (await getJSON(key))
    if (!rec) {
      // The first call fixes the receiving address for good. Default = the sender. Anyone else's
      // address needs the sender's own signature, so a bot that spots the tx cannot redirect it.
      let recipient = dep.user
      if (recipientIn) {
        if (!isAddress(recipientIn)) throw httpError(400, 'Invalid receiving address')
        if (!sameAddr(recipientIn, dep.user)) {
          if (!authSig) throw httpError(403, 'A signature from the sending wallet is required for a different receiving address')
          const to = getAddress(recipientIn)
          if (!sameAddr(recoverSigner(deliveryMessage(hash, to), authSig), dep.user)) {
            throw httpError(403, 'The signature does not match the sending wallet')
          }
          recipient = to
        }
      }
      rec = {
        user: dep.user, token: dep.token, amount: dep.amount6.toString(), recipient,
        mintTx: null, transferTx: null, status: 'processing', createdAt: Date.now(),
      }
    }

    // Credit the SENDER, in the token they sent. Exactly once per deposit tx.
    await (await redis()).eval(CREDIT_ADD, {
      keys: [`credited/${hash}`, `credit/${rec.user.toLowerCase()}`],
      arguments: [rec.token, rec.amount],
    })
    await putJSON(key, rec)

    const amount = BigInt(rec.amount)
    await sendOnce(c, key, rec, 'mintTx', deadline, (o) => c.token.mintTokens(amount, o))
    await sendOnce(c, key, rec, 'transferTx', deadline, (o) => c.token.transfer(rec.recipient, amount, o))
    rec.status = 'done'
    rec.doneAt = Date.now()
    await putJSON(key, rec)
    return { status: 'done', mintTx: rec.mintTx, transferTx: rec.transferTx }
  } catch (e) {
    if (e && e.code === 'TIMEOUT') return { status: 'pending' }
    throw e
  } finally {
    await release(lockKey)
  }
}

// ---------------------------------------------------------------------------------------------
// UNICHAIN -> ETHEREUM
// ---------------------------------------------------------------------------------------------

// The lock is a plain OUSD transfer from the user to the OUSD token contract itself.
async function verifyLock(c, hash) {
  const receipt = await c.uniRead.getTransactionReceipt(hash)
  if (!receipt) throw httpError(409, 'The Unichain transaction is not visible yet')
  if (receipt.status !== 1) throw httpError(400, 'The Unichain transaction failed')
  if ((await receipt.confirmations()) < c.uniMinConf) throw httpError(409, 'Waiting for Unichain confirmations')

  const hits = []
  for (const log of receipt.logs) {
    if (!sameAddr(log.address, c.uniTokenAddr)) continue
    const ev = parseTransfer(log)
    if (ev && sameAddr(ev.to, c.uniTokenAddr)) hits.push(ev)
  }
  if (hits.length !== 1) throw httpError(400, 'No single OUSD lock transfer was found in this transaction')
  if (!sameAddr(hits[0].from, receipt.from)) throw httpError(400, 'The lock must be sent directly from the wallet that owns the OUSD')
  if (hits[0].value <= 0n) throw httpError(400, 'Empty lock')
  return { locker: getAddress(hits[0].from), amount6: hits[0].value }
}

// Decides the token and the receiving address, then spends the credit. Returns the payout record,
// or { status: 'needs_auth' } when the wallet must sign first.
async function reserve(c, hash, key, { recipientIn, tokenIn, authSig }) {
  const lk = await verifyLock(c, hash)
  if (recipientIn && !isAddress(recipientIn)) throw httpError(400, 'Invalid receiving address')

  const credits = await readCredits(lk.locker)
  const eligible = Object.keys(c.tokens).filter((k) => (credits[k] || 0n) >= lk.amount6)
  if (!eligible.length) {
    throw httpError(400, 'This wallet has no deposit large enough to pay this out. You can only withdraw the token you deposited.')
  }

  const wanted = tokenIn ? String(tokenIn).toUpperCase() : null
  if (wanted && !c.tokens[wanted]) throw httpError(400, 'Unsupported token')

  let tokenKey
  let recipient
  if (authSig) {
    // The wallet's own signature fixes both the token and the receiving address.
    if (!wanted) throw httpError(400, 'token is required with a signature')
    recipient = recipientIn ? getAddress(recipientIn) : lk.locker
    if (!sameAddr(recoverSigner(payoutMessage(hash, recipient, wanted), authSig), lk.locker)) {
      throw httpError(403, 'The signature does not match the wallet that locked the OUSD')
    }
    tokenKey = wanted
  } else {
    const custom = recipientIn && !sameAddr(recipientIn, lk.locker)
    // No signature is needed only when nothing is ambiguous: paying the locker, in the only token it can use.
    if (custom || eligible.length > 1) return { status: 'needs_auth', eligible }
    tokenKey = eligible[0]
    if (wanted && wanted !== tokenKey) throw httpError(400, `This wallet can only withdraw ${tokenKey} for this amount`)
    recipient = lk.locker
  }

  const t = await requireToken(c, tokenKey)
  if (await c.vaultRead.paused()) throw httpError(409, 'The bridge is paused. Your OUSD stays locked and your credit is safe.')
  const { min, max } = await vaultLimits(c)
  if (lk.amount6 < min || lk.amount6 > max) throw httpError(400, 'Amount is outside the vault limits')

  const raw = lk.amount6 * 10n ** BigInt(t.decimals - 6)
  const liquidity = await new Contract(t.address, ERC20_ABI, c.ethRead).balanceOf(c.vault)
  if (liquidity < raw) {
    throw httpError(409, `Not enough ${tokenKey} liquidity on Ethereum right now. Your OUSD stays locked and your credit is safe, try Finish transfer later.`)
  }

  const rec = {
    locker: lk.locker, token: tokenKey, amount6: lk.amount6.toString(), raw: raw.toString(),
    recipient, payoutTx: null, status: 'reserved', createdAt: Date.now(),
  }
  const res = await (await redis()).eval(CREDIT_RESERVE, {
    keys: [key, `credit/${lk.locker.toLowerCase()}`],
    arguments: [tokenKey, lk.amount6.toString(), JSON.stringify(rec)],
  })
  if (res === 'insufficient') throw httpError(400, 'Not enough credit for this token')
  if (res === 'exists') return await getJSON(key)
  return rec
}

// Pays the recipient on Ethereum from the relayer. Safe to call again: the vault's refUsed
// flag means a lock can only ever be paid once, whatever happens here.
async function finishPayout(c, key, rec) {
  const deadlineMs = Date.now() + c.budgetMs
  const remaining = () => Math.max(500, deadlineMs - Date.now())
  const ref = key.slice('withdraw/'.length)

  const claimed = async () => {
    rec.status = 'claimed'
    rec.doneAt = Date.now()
    await putJSON(key, rec)
    return { status: 'claimed', payoutTx: rec.payoutTx }
  }

  try {
    if (rec.payoutTx) {
      const r = await c.ethRead.getTransactionReceipt(rec.payoutTx)
      if (r && r.status === 1) return await claimed()
      if (!r) {
        const pending = await c.ethRead.getTransaction(rec.payoutTx)
        if (pending) { await confirmOrTimeout(pending, remaining); return await claimed() }
      }
    }
    if (await c.vaultRead.refUsed(ref)) return await claimed()

    const t = c.tokens[rec.token]
    const deadline = Math.floor(Date.now() / 1000) + 3600
    const signature = await c.ethWallet.signTypedData(
      { name: 'UniBridgeVault', version: '1', chainId: c.ethId, verifyingContract: c.vault },
      WITHDRAW_TYPES,
      { token: t.address, recipient: rec.recipient, amount: BigInt(rec.raw), ref, deadline },
    )
    const tx = await withSendLock(c, 'eth', (o) =>
      c.vaultSend.withdraw(t.address, BigInt(rec.raw), ref, deadline, rec.recipient, signature, o))
    rec.payoutTx = tx.hash
    await putJSON(key, rec)
    await confirmOrTimeout(tx, remaining)
    return await claimed()
  } catch (e) {
    if (e && e.code === 'TIMEOUT') return { status: 'pending' }
    throw e
  }
}

async function approve(c, body) {
  const { lockTx, recipient: recipientIn, token: tokenIn, authSig } = body
  if (typeof lockTx !== 'string' || !isHexString(lockTx.toLowerCase(), 32)) throw httpError(400, 'Invalid transaction hash')
  const hash = lockTx.toLowerCase()
  const key = `withdraw/${hash}`

  let rec = await getJSON(key)
  if (rec && rec.status === 'claimed') return { status: 'claimed', payoutTx: rec.payoutTx }

  const lockKey = `lock/${hash}`
  if (!(await acquire(lockKey, 25000))) throw httpError(409, 'This payout is already being processed')
  try {
    rec = await getJSON(key)
    if (rec && rec.status === 'claimed') return { status: 'claimed', payoutTx: rec.payoutTx }
    if (!rec) {
      const out = await reserve(c, hash, key, { recipientIn, tokenIn, authSig })
      if (out.status === 'needs_auth') return out
      rec = out
    }
    return await finishPayout(c, key, rec)
  } finally {
    await release(lockKey)
  }
}

// ---------------------------------------------------------------------------------------------
// Credit + gas
// ---------------------------------------------------------------------------------------------
async function creditOf(c, address) {
  if (typeof address !== 'string' || !isAddress(address)) throw httpError(400, 'Invalid address')
  const credits = await readCredits(getAddress(address))
  const byToken = {}
  let total = 0n
  for (const k of Object.keys(c.tokens)) {
    const v = credits[k] || 0n
    byToken[k] = v.toString()
    total += v
  }
  return { byToken, available: total.toString() }
}

async function sponsorGas(c, address) {
  if (typeof address !== 'string' || !isAddress(address)) throw httpError(400, 'Invalid address')
  const addr = getAddress(address)
  const bal = await c.uniRead.getBalance(addr)
  if (bal >= c.gasMin) return { status: 'sufficient' }

  // Only wallets that can actually withdraw (they hold OUSD AND have credit) get gas.
  // This stops bots farming gas drips with dust.
  const [tokenBal, credits] = await Promise.all([c.token.balanceOf(addr), readCredits(addr)])
  const hasCredit = Object.values(credits).some((v) => v > 0n)
  if (tokenBal === 0n || !hasCredit) throw httpError(403, 'Gas is only sponsored for wallets that hold OUSD and have deposited')

  const gasKey = `gas/${addr.toLowerCase()}`
  if (!(await acquire(gasKey, c.gasCooldownMs))) throw httpError(429, 'Gas was already sent to this wallet recently.')
  try {
    const tx = await withSendLock(c, 'uni', (o) => c.wallet.sendTransaction({ to: addr, value: c.gasDrip, ...o }))
    await tx.wait(1, c.budgetMs)
    return { status: 'sent', hash: tx.hash }
  } catch (e) {
    await release(gasKey)
    throw e
  }
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------
export default defineEventHandler(async (event) => {
  let c
  try {
    c = context(event)
  } catch (e) {
    setResponseStatus(event, e.status || 500)
    return { error: e.message }
  }

  if (handleCors(event, {
    origin: c.allowedOrigins,
    methods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    preflight: { statusCode: 204 },
  })) return null

  if (event.method !== 'POST') {
    setResponseStatus(event, 405)
    return { error: 'POST only' }
  }

  try {
    const body = (await readBody(event)) || {}
    if (body.action === 'deposit') return await deposit(c, body)
    if (body.action === 'approve') return await approve(c, body)
    if (body.action === 'credit') return await creditOf(c, body.address)
    if (body.action === 'gas') return await sponsorGas(c, body.address)
    setResponseStatus(event, 400)
    return { error: 'Unknown action' }
  } catch (e) {
    const status = e.status || 500
    if (status === 500) console.error('bridge relay failed', e)
    setResponseStatus(event, status)
    return { error: status === 500 ? 'Delivery failed, please use "Finish transfer" to retry.' : e.message }
  }
})