-- RVFixWise application policies and publishing functions

-- Public content is read-only and limited to published records.
grant select on public.sites, public.categories, public.people, public.articles,
  public.article_sources, public.internal_links to anon;

create policy sites_public_select on public.sites for select to anon using (is_active);
create policy categories_public_select on public.categories for select to anon using (is_active);
create policy people_public_select on public.people for select to anon using (is_active);
create policy articles_public_select on public.articles for select to anon
using (status = 'published' and published_at is not null);
create policy article_sources_public_select on public.article_sources for select to anon
using (exists (select 1 from public.articles a where a.id=article_id and a.status='published'));
create policy internal_links_public_select on public.internal_links for select to anon
using (is_live and exists (select 1 from public.articles a where a.id=source_article_id and a.status='published'));

-- Member reads and editor writes for Quick Entry dependencies.
create policy categories_member_select on public.categories for select to authenticated
using (public.user_has_site_role(site_id, array['owner','admin','editor','reviewer','viewer']::public.app_role[]));
create policy categories_admin_write on public.categories for all to authenticated
using (public.user_has_site_role(site_id, array['owner','admin']::public.app_role[]))
with check (public.user_has_site_role(site_id, array['owner','admin']::public.app_role[]));

create policy people_member_select on public.people for select to authenticated
using (public.user_has_site_role(site_id, array['owner','admin','editor','reviewer','viewer']::public.app_role[]));
create policy people_admin_write on public.people for all to authenticated
using (public.user_has_site_role(site_id, array['owner','admin']::public.app_role[]))
with check (public.user_has_site_role(site_id, array['owner','admin']::public.app_role[]));

create policy sources_member_select on public.article_sources for select to authenticated
using (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[])));
create policy sources_editor_write on public.article_sources for all to authenticated
using (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor']::public.app_role[])))
with check (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor']::public.app_role[])));

create policy links_member_select on public.internal_links for select to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]));
create policy links_editor_write on public.internal_links for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

create policy revisions_member_select on public.article_revisions for select to authenticated
using (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[])));
create policy revisions_editor_insert on public.article_revisions for insert to authenticated
with check (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor']::public.app_role[])));

create policy site_members_self_select on public.site_members for select to authenticated using (user_id=auth.uid());

create or replace function public.advance_article_status(p_article_id uuid, p_target public.content_status)
returns public.articles language plpgsql security definer set search_path=public as $$
declare a public.articles; gate_ok boolean;
begin
  select * into a from public.articles where id=p_article_id;
  if not found or not public.user_has_site_role(a.site_id,array['owner','admin','editor','reviewer']::public.app_role[]) then
    raise exception 'Not authorized';
  end if;
  if p_target='editorial_qa' and a.status <> 'draft' then raise exception 'Draft required'; end if;
  if p_target='technical_review' and a.status <> 'editorial_qa' then raise exception 'Editorial QA required'; end if;
  if p_target='ready' and a.status not in ('editorial_qa','technical_review') then raise exception 'Review required'; end if;
  if p_target='published' then
    select can_publish into gate_ok from public.article_publish_gate where id=p_article_id;
    if not coalesce(gate_ok,false) then raise exception 'Publish gate failed'; end if;
    perform public.snapshot_article_revision(p_article_id,'Published');
    update public.articles set status='published', published_at=now(),
      first_published_at=coalesce(first_published_at,now()), updated_by=auth.uid()
    where id=p_article_id returning * into a;
    insert into public.jobs(site_id,article_id,job_type,input)
    values(a.site_id,a.id,'post_publish',jsonb_build_object('actions',array['revalidate','sitemap','link_check']));
    return a;
  end if;
  update public.articles set status=p_target,
    editorial_checked_at=case when p_target='technical_review' then now() else editorial_checked_at end,
    reviewer_completed_at=case when p_target='ready' then now() else reviewer_completed_at end,
    updated_by=auth.uid() where id=p_article_id returning * into a;
  return a;
end $$;

grant execute on function public.advance_article_status(uuid,public.content_status) to authenticated;
grant execute on function public.snapshot_article_revision(uuid,text) to authenticated;
