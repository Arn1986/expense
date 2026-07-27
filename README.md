# Ledgerly Personal Finance

Ledgerly is a responsive, GitHub Pages-ready personal finance application with optional Supabase authentication and cloud synchronization.

## Included features

- Multiple accounts: current, savings, multiple credit cards, cash, investment, and custom accounts
- Custom account name, starting balance, color, and net-worth inclusion
- Expenses, income, and transfers on today or any selected date
- Separate expense and income categories, with category creation and editing in the UI
- Monthly and yearly category budgets
- Dashboard account balances, current net worth, monthly income, expenses, cash flow, budget progress, and category spending
- Reports for net worth, expenses, cash flow, savings rate, budget use, income sources, and monthly trends
- Transaction search and filters
- JSON backup and restore
- CSV transaction export
- Supabase email/password authentication and Row Level Security
- Local preview mode before Supabase is configured
- Responsive phone, tablet, and desktop layouts

## Important balance convention

Balances are signed:

- Asset accounts normally have positive balances.
- Credit-card debt should be entered as a negative starting balance, for example `-500`.
- A credit-card purchase lowers the balance further.
- A transfer from a current account to the credit card raises the card balance toward zero.

## Configure Supabase

### 1. Create a project

Create a Supabase project and enable email/password authentication. Email confirmation can remain enabled; new users will be asked to confirm their email before signing in.

### 2. Create the database

Open **SQL Editor** in Supabase and run:

```text
supabase/schema.sql
```

The schema creates accounts, categories, transactions, and budgets. It also enables Row Level Security so authenticated users can only manage rows matching their own user ID.

### 3. Add browser credentials

Open `config.js` and add your project values:

```js
export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "YOUR_PUBLISHABLE_KEY";
```

Use the **publishable** key (or legacy `anon` key). Never use a secret key or `service_role` key in browser code. Browser credentials are visible to visitors; data protection comes from authentication and the included RLS policies.

### 4. Set allowed URLs

In Supabase, open **Authentication → URL Configuration** and add:

- Your local URL, such as `http://localhost:8000`
- Your GitHub Pages URL, such as `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`

## Run locally

ES modules require an HTTP server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Without Supabase values, the app offers a local preview that stores data in `localStorage` under `ledgerly-data-v2-local`.

## Publish with GitHub Pages

1. Create a GitHub repository.
2. Add all project files, including `.github/workflows/pages.yml`.
3. Commit your configured `config.js`.
4. In GitHub, open **Settings → Pages**.
5. Select **GitHub Actions** as the source.
6. Push to `main`.

The included workflow publishes the static site automatically.

## CSV and backups

- **Export JSON backup** preserves all Ledgerly records and IDs.
- **Import JSON backup** replaces the current user's data, including cloud data when signed in with Supabase.
- **Export transactions CSV** creates a spreadsheet-compatible file with account, category, date, type, and amount fields.

## Project structure

```text
index.html                  Application markup
styles.css                  Responsive design
app.js                      UI, calculations, Supabase integration
config.js                   Supabase project URL and publishable key
config.example.js           Blank configuration example
supabase/schema.sql         Database tables, constraints, indexes, and RLS
.github/workflows/pages.yml GitHub Pages deployment
```

## Security notes

- Keep Row Level Security enabled on all four tables.
- Do not place Supabase secret or service-role keys in the repository.
- Export periodic JSON backups even when cloud sync is active.
- Financial applications should be reviewed and tested before storing sensitive production data.
