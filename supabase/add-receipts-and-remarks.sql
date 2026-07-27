-- Ledgerly migration: transaction remarks and private receipt images
-- Run this entire file once in Supabase Dashboard > SQL Editor.

alter table public.transactions
  add column if not exists remarks text not null default '',
  add column if not exists receipt_path text,
  add column if not exists receipt_name text,
  add column if not exists receipt_mime_type text,
  add column if not exists receipt_size bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'transactions_remarks_length_check'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_remarks_length_check
      check (char_length(remarks) <= 2000);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'transactions_receipt_name_length_check'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_receipt_name_length_check
      check (receipt_name is null or char_length(receipt_name) <= 255);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'transactions_receipt_mime_length_check'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_receipt_mime_length_check
      check (receipt_mime_type is null or char_length(receipt_mime_type) <= 100);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'transactions_receipt_size_check'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_receipt_size_check
      check (receipt_size is null or receipt_size between 0 and 8388608);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'transactions_receipt_path_owner_check'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_receipt_path_owner_check
      check (receipt_path is null or receipt_path like user_id::text || '/%');
  end if;
end
$$;

-- Create or update a private receipt bucket. Images are limited to 8 MB.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'receipts',
  'receipts',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Every receipt path starts with the authenticated user's UUID.
drop policy if exists "Users upload their own receipts" on storage.objects;
create policy "Users upload their own receipts"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users read their own receipts" on storage.objects;
create policy "Users read their own receipts"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users update their own receipts" on storage.objects;
create policy "Users update their own receipts"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users delete their own receipts" on storage.objects;
create policy "Users delete their own receipts"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
