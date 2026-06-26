# CampCost 🏕️

> The only trip budget tracker that connects to your bank. Built for overlanders, van lifers, and road trippers.

**The problem:** Manual expense logging is too tedious on the road. You're not opening a spreadsheet after buying fuel, groceries, and propane at three different stops.

**The solution:** Connect your bank once. CampCost auto-imports every purchase. Each evening, spend 5 minutes reviewing — "trip expense or not?" — and your budget updates live.

---

## Features (v1)

- **Bank sync via Plaid** — transactions auto-import, no manual entry
- **Smart auto-categorization** — Shell/BP → Fuel, KOA/Hipcamp → Campground, Walmart → Groceries
- **Trip budget planning** — set budget by category before you leave
- **Transaction review queue** — swipe through each purchase, confirm or skip
- **Cash quick-add** — log a cash purchase in 5 seconds (amount + category)
- **Live stats** — cost per night, cost per mile, actuals vs budget by category
- **Charts** — daily spend bar chart, category donut

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, Vite, Recharts |
| Auth + DB | Supabase (Postgres + RLS) |
| Bank sync | Plaid Transactions API |
| Payments | Stripe (coming) |
| Deploy | Vercel (frontend) + Railway (backend) |

---

## Running Locally

### Prerequisites
- Node.js 18+
- Supabase project
- Plaid developer account (sandbox is free)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/masonscarby/campcost.git
cd campcost
npm install

# 2. Install backend deps
cd backend && npm install && cd ..

# 3. Copy env file and fill in your keys
cp .env.example .env
```

### Environment Variables

See `.env.example` for all required variables. You'll need:
- Supabase URL + anon key (from your Supabase project dashboard)
- Supabase service role key (backend only — never in frontend)
- Plaid client ID + secret (from Plaid dashboard, sandbox mode to start)

### Run the database migrations

In your Supabase SQL editor, run `supabase/migrations/001_init.sql`.

### Start dev servers

```bash
# Terminal 1 — frontend (runs on :5174)
npm run dev

# Terminal 2 — backend (runs on :3002)
cd backend && node server.js
```

---

## Branch Structure

| Branch | Purpose |
|--------|---------|
| `main` | Stable, always deployable, mirrors production |
| `mason-dev` | Active development, deploys to Vercel preview |
| `feature/*` | Individual features, PR into mason-dev |

---

## Project Structure

```
campcost/
├── src/
│   ├── pages/          # Route-level components
│   ├── components/     # Shared UI components
│   ├── context/        # Auth context
│   └── lib/            # Supabase client
├── backend/
│   └── server.js       # Express: Plaid token exchange + sync
├── supabase/
│   └── migrations/     # SQL migrations
└── .env.example        # Required environment variables (no real values)
```

---

## Security Notes

- `.env` is gitignored — real keys never touch this repo
- Plaid `access_token` is stored server-side only
- Supabase RLS enforces per-user data isolation
- Service role key is backend-only, never in frontend code

See the pre-production security checklist before deploying to production.

---

*Built by Mason Scarby — on a 2-year truck camper trip across the US.*
