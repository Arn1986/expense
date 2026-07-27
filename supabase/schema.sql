-- Ledgerly database schema for Supabase
-- Run the complete file in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  type text not null check (type in ('current', 'savings', 'credit', 'cash', 'investment', 'other')),
  opening_balance numeric(14,2) not null default 0,
  color text not null default '#2563eb' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  include_in_net_worth boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  kind text not null check (kind in ('expense', 'income')),
  color text not null default '#64748b' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index if not exists accounts_user_name_unique
  on public.accounts (user_id, lower(name));
create unique index if not exists categories_user_kind_name_unique
  on public.categories (user_id, kind, lower(name));

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('expense', 'income', 'transfer')),
  amount numeric(14,2) not null check (amount > 0),
  entry_date date not null default current_date,
  description text not null default '' check (char_length(description) <= 120),
  category_id uuid,
  account_id uuid,
  from_account_id uuid,
  to_account_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transactions_category_owner_fk foreign key (category_id, user_id) references public.categories(id, user_id) on delete restrict,
  constraint transactions_account_owner_fk foreign key (account_id, user_id) references public.accounts(id, user_id) on delete restrict,
  constraint transactions_from_account_owner_fk foreign key (from_account_id, user_id) references public.accounts(id, user_id) on delete restrict,
  constraint transactions_to_account_owner_fk foreign key (to_account_id, user_id) references public.accounts(id, user_id) on delete restrict,
  constraint transaction_shape_check check (
    (type in ('expense', 'income') and account_id is not null and category_id is not null and from_account_id is null and to_account_id is null)
    or
    (type = 'transfer' and account_id is null and category_id is null and from_account_id is not null and to_account_id is not null and from_account_id <> to_account_id)
  )
);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  period text not null check (period in ('monthly', 'yearly')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category_id, period),
  constraint budgets_category_owner_fk foreign key (category_id, user_id) references public.categories(id, user_id) on delete restrict
);

create index if not exists accounts_user_id_idx on public.accounts(user_id);
create index if not exists categories_user_id_idx on public.categories(user_id);
create index if not exists transactions_user_date_idx on public.transactions(user_id, entry_date desc);
create index if not exists transactions_account_id_idx on public.transactions(account_id);
create index if not exists transactions_from_account_id_idx on public.transactions(from_account_id);
create index if not exists transactions_to_account_id_idx on public.transactions(to_account_id);
create index if not exists budgets_user_id_idx on public.budgets(user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists accounts_set_updated_at on public.accounts;
create trigger accounts_set_updated_at before update on public.accounts for each row execute function public.set_updated_at();
drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at before update on public.categories for each row execute function public.set_updated_at();
drop trigger if exists transactions_set_updated_at on public.transactions;
create trigger transactions_set_updated_at before update on public.transactions for each row execute function public.set_updated_at();
drop trigger if exists budgets_set_updated_at on public.budgets;
create trigger budgets_set_updated_at before update on public.budgets for each row execute function public.set_updated_at();

alter table public.accounts enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets enable row level security;

drop policy if exists "Users manage their own accounts" on public.accounts;
create policy "Users manage their own accounts"
on public.accounts for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own categories" on public.categories;
create policy "Users manage their own categories"
on public.categories for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own transactions" on public.transactions;
create policy "Users manage their own transactions"
on public.transactions for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own budgets" on public.budgets;
create policy "Users manage their own budgets"
on public.budgets for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on public.accounts, public.categories, public.transactions, public.budgets from anon;
grant select, insert, update, delete on public.accounts, public.categories, public.transactions, public.budgets to authenticated;
