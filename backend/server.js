import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } from 'plaid'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '../.env' })

const app = express()
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174'] }))
app.use(express.json())

// Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
})
const plaid = new PlaidApi(plaidConfig)

// Supabase service role client (bypasses RLS for backend operations)
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// ─────────────────────────────────────────────
// POST /api/plaid/link-token
// Creates a Plaid Link token for the frontend
// ─────────────────────────────────────────────
app.post('/api/plaid/link-token', async (req, res) => {
  const { user_id } = req.body
  if (!user_id) return res.status(400).json({ error: 'user_id required' })

  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: 'CampCost',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: process.env.PLAID_WEBHOOK_URL || '',
    })
    res.json({ link_token: response.data.link_token })
  } catch (err) {
    console.error('link-token error:', err.response?.data || err.message)
    res.status(500).json({ error: err.response?.data?.error_message || err.message })
  }
})

// ─────────────────────────────────────────────
// POST /api/plaid/exchange-token
// Exchanges public_token → access_token, saves to Supabase
// ─────────────────────────────────────────────
app.post('/api/plaid/exchange-token', async (req, res) => {
  const { public_token, user_id, institution_name } = req.body
  if (!public_token || !user_id) return res.status(400).json({ error: 'public_token and user_id required' })

  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token })
    const { access_token, item_id } = exchange.data

    // Store in Supabase (upsert in case user reconnects)
    const { error } = await supabase
      .from('plaid_connections')
      .upsert({
        user_id,
        access_token,
        item_id,
        institution_name: institution_name || 'Bank',
        last_sync_at: new Date().toISOString(),
      }, { onConflict: 'item_id' })

    if (error) throw error

    // Kick off sync in background — don't block the response if transactions aren't ready yet
    syncTransactions(user_id, access_token).catch(err =>
      console.log('Initial sync skipped (transactions not ready yet):', err.message)
    )

    res.json({ success: true })
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message)
    res.status(500).json({ error: err.response?.data?.error_message || err.message })
  }
})

// ─────────────────────────────────────────────
// POST /api/plaid/sync
// Manually trigger a transaction sync for a user
// ─────────────────────────────────────────────
app.post('/api/plaid/sync', async (req, res) => {
  const { user_id } = req.body
  if (!user_id) return res.status(400).json({ error: 'user_id required' })

  try {
    const { data: connections } = await supabase
      .from('plaid_connections')
      .select('access_token, last_sync_at')
      .eq('user_id', user_id)

    if (!connections?.length) return res.status(404).json({ error: 'No bank connected' })

    let total = 0
    for (const conn of connections) {
      total += await syncTransactions(user_id, conn.access_token, conn.last_sync_at)
    }

    res.json({ synced: total })
  } catch (err) {
    const plaidMsg = err.response?.data?.error_message || err.response?.data?.error_code
    console.error('sync error:', plaidMsg || err.message, err.response?.data || '')
    res.status(500).json({ error: plaidMsg || err.message })
  }
})

// ─────────────────────────────────────────────
// POST /api/plaid/webhook
// Plaid fires this when new transactions are available
// ─────────────────────────────────────────────
app.post('/api/plaid/webhook', async (req, res) => {
  const { webhook_type, webhook_code, item_id } = req.body
  console.log('Plaid webhook:', webhook_type, webhook_code)

  if (webhook_type === 'TRANSACTIONS' &&
     (webhook_code === 'SYNC_UPDATES_AVAILABLE' || webhook_code === 'DEFAULT_UPDATE')) {
    // Find user for this item
    const { data: conn } = await supabase
      .from('plaid_connections')
      .select('user_id, access_token, last_sync_at')
      .eq('item_id', item_id)
      .single()

    if (conn) {
      await syncTransactions(conn.user_id, conn.access_token, conn.last_sync_at)
    }
  }

  res.json({ received: true })
})

// ─────────────────────────────────────────────
// syncTransactions — core sync logic
// Pulls transactions from last_sync_at (or 90 days on first sync)
// ─────────────────────────────────────────────
const BUFFER_DAYS = 2 // Match transactions this many days before/after trip dates

async function syncTransactions(user_id, access_token, lastSyncAt = null) {
  const startDate = lastSyncAt ? new Date(lastSyncAt) : (() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return d
  })()
  const start = startDate.toISOString().split('T')[0]
  const end = new Date().toISOString().split('T')[0]

  const response = await plaid.transactionsGet({
    access_token,
    start_date: start,
    end_date: end,
  })

  const txs = response.data.transactions
  if (!txs.length) return 0

  // Find user's active trips to match transactions to
  const { data: trips } = await supabase
    .from('trips')
    .select('id, start_date, end_date')
    .eq('user_id', user_id)
    .in('status', ['planning', 'active'])

  let inserted = 0

  for (const tx of txs) {
    // Skip credits (refunds/deposits)
    if (tx.amount < 0) continue

    // Find matching trip by date, fall back to first active trip if no dates set
    const today = new Date()
    today.setHours(23, 59, 59, 999)

    const tripMatch = trips?.find(t => {
      if (!t.start_date) return false
      const txDate = new Date(tx.date)
      // Add buffer days before trip start (gas/supplies before leaving)
      const start = new Date(t.start_date)
      start.setDate(start.getDate() - BUFFER_DAYS)
      // Add buffer days after trip end (capped at today) for post-trip purchases
      const rawEnd = t.end_date ? new Date(t.end_date) : null
      const bufferedEnd = rawEnd
        ? new Date(rawEnd.getTime() + BUFFER_DAYS * 86400000)
        : null
      const end = bufferedEnd
        ? new Date(Math.min(bufferedEnd.getTime(), today.getTime()))
        : today
      return txDate >= start && txDate <= end
    }) || trips?.find(t => !t.start_date) || trips?.[0]

    if (!tripMatch) continue

    const category = categorize(tx.name, tx.merchant_name)

    // Insert, skip duplicates via plaid_transaction_id unique constraint
    const { error } = await supabase.from('expenses').insert({
      trip_id: tripMatch.id,
      user_id,
      category,
      amount: tx.amount,
      merchant_name: tx.merchant_name || tx.name,
      expense_date: tx.date,
      source: 'plaid',
      plaid_transaction_id: tx.transaction_id,
      reviewed: false,
    })

    if (!error) inserted++
  }

  // Update last sync time
  await supabase
    .from('plaid_connections')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('user_id', user_id)

  console.log(`Synced ${inserted} new transactions for user ${user_id}`)
  return inserted
}

// ─────────────────────────────────────────────
// categorize — merchant name → expense_category
// ─────────────────────────────────────────────
function categorize(name = '', merchant = '') {
  const text = `${name} ${merchant}`.toLowerCase()

  if (/shell|bp |chevron|exxon|mobil|pilot|love's|loves|flying j|speedway|sunoco|circle k|casey|kwik trip|fuel|gasoline|gas station/.test(text)) return 'fuel'
  if (/koa|hipcamp|reserveamerica|campground|rv park|rv resort|state park|campsite|boondock|harvest host/.test(text)) return 'campground'
  if (/walmart|kroger|safeway|aldi|publix|heb|meijer|whole foods|trader joe|grocery|supermarket|food lion|sprouts/.test(text)) return 'food_groceries'
  if (/rei|cabela|bass pro|academy sports|backcountry|moosejaw|gear/.test(text)) return 'gear'
  if (/autozone|o'reilly|napa auto|advance auto|mechanic|muffler|tire|jiffy lube|repair|firestone|pep boys/.test(text)) return 'repairs'
  if (/propane|amerigas|ferrellgas|blue rhino|utilities|dump station/.test(text)) return 'propane_utilities'
  if (/national park|state park|entrance fee|permit|recreation/.test(text)) return 'activities'

  return 'misc'
}

// Debug endpoint — remove before production
app.post('/api/debug/sync', async (req, res) => {
  const { user_id } = req.body
  const { data: connections } = await supabase.from('plaid_connections').select('*').eq('user_id', user_id)
  const { data: trips, error: tripsError } = await supabase.from('trips').select('*').eq('user_id', user_id)

  let plaidTxs = []
  if (connections?.length) {
    try {
      const end = new Date().toISOString().split('T')[0]
      const start = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
      const r = await plaid.transactionsGet({ access_token: connections[0].access_token, start_date: start, end_date: end })
      plaidTxs = r.data.transactions.slice(0, 5)
    } catch (e) { plaidTxs = [{ error: e.message }] }
  }

  res.json({ connections, trips, trips_error: tripsError, sample_transactions: plaidTxs })
})

const PORT = process.env.BACKEND_PORT || 3002
app.listen(PORT, () => console.log(`CampCost backend running on port ${PORT}`))
