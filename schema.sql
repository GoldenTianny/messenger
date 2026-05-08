-- ====================================================================
-- 프라이빗 메신저 — Supabase 스키마
-- 새 Supabase 프로젝트의 SQL Editor에 그대로 붙여넣고 한 번 실행하세요.
-- ====================================================================

-- 재실행이 필요하면 아래 블록의 주석을 해제하고 먼저 실행하세요.
/*
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_admin() cascade;
drop table if exists public.messages cascade;
drop table if exists public.conversations cascade;
drop table if exists public.profiles cascade;
*/

-- ── 1. 테이블 ────────────────────────────────────────────────────────

create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  role text not null default 'client' check (role in ('admin', 'client')),
  created_at timestamptz default now()
);

create table public.conversations (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references public.profiles(id) on delete cascade unique not null,
  last_message_at timestamptz default now(),
  created_at timestamptz default now()
);

create table public.messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  sender_id uuid references public.profiles(id) on delete set null,
  body text,
  image_url text,
  created_at timestamptz default now(),
  check (body is not null or image_url is not null)
);

create index messages_conversation_idx on public.messages(conversation_id, created_at);

-- ── 2. 헬퍼 함수: 현재 사용자가 관리자인지 확인 ────────────────────────
-- security definer 로 RLS 무한재귀 방지

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- ── 3. RLS (Row Level Security) ──────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

-- profiles
create policy "profiles_self_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_admin_select" on public.profiles
  for select using (public.is_admin());
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

-- conversations
create policy "conversations_client_select" on public.conversations
  for select using (auth.uid() = client_id);
create policy "conversations_admin_select" on public.conversations
  for select using (public.is_admin());
create policy "conversations_client_insert" on public.conversations
  for insert with check (auth.uid() = client_id);
create policy "conversations_update" on public.conversations
  for update using (auth.uid() = client_id or public.is_admin());

-- messages
create policy "messages_client_select" on public.messages
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.client_id = auth.uid()
    )
  );
create policy "messages_admin_select" on public.messages
  for select using (public.is_admin());
create policy "messages_client_insert" on public.messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.client_id = auth.uid()
    )
  );
create policy "messages_admin_insert" on public.messages
  for insert with check (
    sender_id = auth.uid() and public.is_admin()
  );

-- ── 4. 회원가입 시 자동 프로필 생성 ───────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    'client'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 5. Realtime 활성화 ───────────────────────────────────────────────

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;

-- ── 6. Storage (사진 업로드용) ────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', true)
on conflict (id) do nothing;

create policy "chat_images_upload" on storage.objects
  for insert with check (
    bucket_id = 'chat-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- 공개 버킷이라 SELECT 정책 불필요
-- (URL을 알아야 접근 가능. 파일명에 랜덤 토큰 포함하여 추측 방지.)

-- ====================================================================
-- 회원가입 완료 후 본인을 관리자로 승격
-- (회원가입 → 이메일 인증 → SQL Editor에서 아래 한 줄 실행)
-- ====================================================================

-- update public.profiles
--   set role = 'admin'
--   where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
