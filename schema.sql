-- ====================================================================
-- 프라이빗 메신저 — Supabase 스키마 (다대다 1:1)
--
-- 기존 1:1 (관리자-클라이언트) 구조에서 다대다로 전환.
-- 각 사용자는 여러 개의 1:1 대화방을 가질 수 있고,
-- 누구나 초대 링크를 만들어 새 대화를 시작할 수 있다.
--
-- ⚠️ 이 파일을 통째로 SQL Editor에 붙여넣고 실행하면
--    기존 테이블/데이터/트리거가 모두 삭제됩니다.
--    테스트 데이터만 있다면 안전. 프로덕션 데이터가 있다면 백업 필수.
-- ====================================================================

-- ── 0. 기존 객체 정리 ─────────────────────────────────────────────────

drop trigger if exists on_auth_user_created on auth.users;
-- on_message_inserted 트리거는 messages 테이블이 cascade 로 drop 될 때 자동 제거됨
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.is_member(uuid) cascade;
drop function if exists public.shares_conversation(uuid) cascade;
drop function if exists public.redeem_invitation(text) cascade;
drop function if exists public.create_invitation() cascade;
drop function if exists public.update_conversation_last_message() cascade;
drop table if exists public.invitations cascade;
drop table if exists public.conversation_members cascade;
drop table if exists public.messages cascade;
drop table if exists public.conversations cascade;
drop table if exists public.profiles cascade;

-- ── 1. 테이블 ────────────────────────────────────────────────────────

create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  created_at timestamptz default now()
);

create table public.conversations (
  id uuid default gen_random_uuid() primary key,
  last_message_at timestamptz default now(),
  created_at timestamptz default now()
);

create table public.conversation_members (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx on public.conversation_members(user_id);

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

create table public.invitations (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  created_by uuid references public.profiles(id) on delete cascade not null,
  token text unique not null default encode(gen_random_bytes(16), 'hex'),
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz default now()
);

create index invitations_token_idx on public.invitations(token);
create index invitations_creator_idx on public.invitations(created_by);

-- ── 2. 헬퍼 함수 (RLS 안에서 안전하게 사용) ────────────────────────────

-- 현재 사용자가 특정 대화방의 멤버인지 확인
create or replace function public.is_member(conv_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.conversation_members
    where conversation_id = conv_id and user_id = auth.uid()
  );
$$;

-- 현재 사용자와 다른 사용자가 같은 대화방을 공유하는지
create or replace function public.shares_conversation(other_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.conversation_members cm1
    join public.conversation_members cm2 on cm1.conversation_id = cm2.conversation_id
    where cm1.user_id = auth.uid() and cm2.user_id = other_user_id
  );
$$;

-- ── 3. RLS (Row Level Security) ──────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.invitations enable row level security;

-- profiles: 본인 + 같은 대화방 참여자
create policy "profiles_self_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_partner_select" on public.profiles
  for select using (public.shares_conversation(id));
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

-- conversations: 멤버만 조회/수정, 인증된 사용자는 신규 생성 가능
create policy "conversations_member_select" on public.conversations
  for select using (public.is_member(id));
create policy "conversations_authenticated_insert" on public.conversations
  for insert with check (auth.uid() is not null);
create policy "conversations_member_update" on public.conversations
  for update using (public.is_member(id));

-- conversation_members: 본인 행 + 본인이 속한 대화방의 멤버 행 조회
-- 자기 자신을 멤버로 추가/제거 가능 (초대 수락이나 나가기)
create policy "members_select" on public.conversation_members
  for select using (
    user_id = auth.uid() or public.is_member(conversation_id)
  );
create policy "members_self_insert" on public.conversation_members
  for insert with check (user_id = auth.uid());
create policy "members_self_delete" on public.conversation_members
  for delete using (user_id = auth.uid());

-- messages: 본인이 멤버인 대화방의 메시지만
create policy "messages_member_select" on public.messages
  for select using (public.is_member(conversation_id));
create policy "messages_member_insert" on public.messages
  for insert with check (
    sender_id = auth.uid() and public.is_member(conversation_id)
  );

-- invitations: 본인이 만든 것만 조회. 생성도 본인이 멤버인 대화방에 한함.
-- (토큰 사용은 redeem_invitation 함수로 처리)
create policy "invitations_creator_select" on public.invitations
  for select using (created_by = auth.uid());
create policy "invitations_creator_insert" on public.invitations
  for insert with check (
    created_by = auth.uid() and public.is_member(conversation_id)
  );
create policy "invitations_creator_delete" on public.invitations
  for delete using (created_by = auth.uid());

-- ── 4. 회원가입 시 자동 프로필 생성 ───────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 5. 메시지 INSERT 시 last_message_at 자동 갱신 ───────────────────

create or replace function public.update_conversation_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
  set last_message_at = new.created_at
  where id = new.conversation_id;
  return new;
end;
$$;

create trigger on_message_inserted
  after insert on public.messages
  for each row execute function public.update_conversation_last_message();

-- ── 6. 초대 링크 생성 (대화방+멤버+토큰을 원자적으로 처리) ─────────────

create or replace function public.create_invitation()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  new_conv_id uuid;
  new_token text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다';
  end if;

  insert into public.conversations default values
  returning id into new_conv_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (new_conv_id, auth.uid());

  insert into public.invitations (conversation_id, created_by)
  values (new_conv_id, auth.uid())
  returning token into new_token;

  return new_token;
end;
$$;

-- ── 7. 초대 링크 사용 (서버 함수로 원자적 처리) ───────────────────────

-- 토큰으로 호출하면 호출자를 멤버로 추가하고 conversation_id 반환.
-- 만료/사용된 토큰이면 예외.
create or replace function public.redeem_invitation(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다';
  end if;

  select * into v_inv from public.invitations
  where token = invite_token
  for update;

  if v_inv is null then
    raise exception '유효하지 않은 초대 링크입니다';
  end if;

  if v_inv.expires_at < now() then
    raise exception '만료된 초대 링크입니다';
  end if;

  if v_inv.used_at is not null then
    -- 이미 사용된 경우, 그래도 호출자가 같은 대화방의 멤버이면 그냥 conversation_id 반환
    if exists (
      select 1 from public.conversation_members
      where conversation_id = v_inv.conversation_id and user_id = auth.uid()
    ) then
      return v_inv.conversation_id;
    end if;
    raise exception '이미 사용된 초대 링크입니다';
  end if;

  -- 본인이 만든 초대 링크는 본인이 사용 못 하게 (자기와의 대화 방지)
  if v_inv.created_by = auth.uid() then
    raise exception '본인이 만든 초대 링크는 사용할 수 없습니다';
  end if;

  -- 멤버로 이미 들어가 있으면 스킵
  if not exists (
    select 1 from public.conversation_members
    where conversation_id = v_inv.conversation_id and user_id = auth.uid()
  ) then
    insert into public.conversation_members (conversation_id, user_id)
    values (v_inv.conversation_id, auth.uid());
  end if;

  -- 초대 사용 처리
  update public.invitations
  set used_by = auth.uid(), used_at = now()
  where id = v_inv.id;

  return v_inv.conversation_id;
end;
$$;

-- ── 8. Realtime 활성화 (이미 등록되어 있으면 패스) ──────────────────

do $$
begin
  begin alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversations;
  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members;
  exception when duplicate_object then null; end;
end$$;

-- ── 9. Storage (사진 업로드용) ────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', true)
on conflict (id) do nothing;

-- storage 정책은 이미 있으면 패스 (별도 트랜잭션에서 처리되어 DROP+CREATE 패턴이 깨짐)
do $$
begin
  begin
    create policy "chat_images_upload" on storage.objects
      for insert with check (
        bucket_id = 'chat-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  exception when duplicate_object then null;
  end;
end$$;
