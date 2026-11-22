-- OPTIONAL sample Knowledge Bank products, made up (fictional insurers, marked "(sample)"), so the term product
-- comparison on the PI request form can be tried before real products are added. Run after 1p-upgrade.sql.
-- Remove later with 4c-remove-sample-products.sql. Safe to run again (it replaces the samples).
begin;
delete from public.kb_products where is_sample;
do $$
declare
  p record; d_ps uuid; d_rs uuid; f jsonb; k uuid; fx jsonb;
begin
  for p in select * from (values
    -- insurer, name, dpi, jurisdiction, currencies, age min, age max, residency, sa min, sa max, tpd, ci, status, version, base rate, ci rate, PS version, PS effective (days ago), RS valid (days ahead)
    ('Harbour Life (sample)', 'Harbour Term Secure', false, 'Onshore', '{SGD,USD}'::text[], 18, 65,
       '{Singapore citizen,Singapore PR,Foreigner living in Singapore}'::text[], 100000, 5000000, true, true, 'verified', 4, 0.72, 0.90, 'v4.1', 140, 120,
       '{"guaranteed":"Level, not guaranteed (reviewable)","premTerm":"Same as policy term","modes":"Annual, half-yearly, quarterly, monthly","coverTo":"Age 65, 75 or 85; or 10 to 30 years","death":"Yes","ti":"Included","tpd":"Included up to age 70","ci":"Optional rider (37 critical illnesses)","eci":"Optional rider (early to advanced stage)","ad":"","conversion":"Convert to whole life up to age 60, no medical","renew":"Not renewable","inc":"Increase cover at marriage or birth of a child, no medical (once each)","cash":"None","dist":"35% to 40% of total premiums","fees":"None","freelook":"14 days","grace":"30 days (60 for monthly)","reinstate":"Within 2 years of lapse","excl":"Suicide in the first year; pre-existing conditions","uw":"Full medical above S$2m; simplified up to S$500k for age 45 and below","special":"Premium waiver on CI rider claim","consider":"Premiums may be revised. No surrender value. Cover ends at expiry with nothing paid back."}'::jsonb),
    ('Straits Assurance (sample)', 'Straits LifeGuard Term', false, 'Onshore', '{SGD}'::text[], 17, 60,
       '{Singapore citizen,Singapore PR,Foreigner living in Singapore}'::text[], 50000, 3000000, true, true, 'verified', 2, 0.68, 0.85, 'v2.3', 250, 40,
       '{"guaranteed":"Guaranteed for the first 10 years","premTerm":"Same as policy term, or pay to age 65","modes":"Annual, monthly","coverTo":"Age 70, 85 or 99","death":"Yes","ti":"Included","tpd":"Included up to age 65","ci":"Optional rider (53 critical illnesses)","eci":"","ad":"Optional rider (extra 100% of sum assured)","conversion":"","renew":"Renewable once to age 85, no medical","inc":"","cash":"None","dist":"30% to 38% of total premiums","fees":"None","freelook":"14 days","grace":"30 days","reinstate":"Within 2 years of lapse","excl":"Suicide in the first year; self-inflicted injury","uw":"Full medical above S$1.5m","special":"Free cover of up to S$50k during underwriting (accidental death)","consider":"Only SGD. Guarantee on premiums ends after year 10."}'::jsonb),
    ('Orchid Life (sample)', 'Orchid Essential Term', true, 'Onshore', '{SGD}'::text[], 19, 50,
       '{Singapore citizen,Singapore PR}'::text[], 50000, 400000, false, false, 'verified', 1, 0.55, null, 'v1.8', 80, 90,
       '{"guaranteed":"Not guaranteed (reviewable)","premTerm":"Same as policy term","modes":"Annual, monthly","coverTo":"5 to 20 years, or to age 65","death":"Yes","ti":"Included","tpd":"","ci":"","eci":"","ad":"","conversion":"","renew":"Renewable to age 65 at the premium rate then","inc":"","cash":"None","dist":"0% (direct purchase)","fees":"None","freelook":"14 days","grace":"30 days","reinstate":"Within 1 year of lapse","excl":"Suicide in the first year; pre-existing conditions","uw":"Health questions only, no medical check","special":"Direct Purchase Insurance: standard features set by MAS","consider":"Lower maximum cover (S$400k). Singapore citizens and PRs only."}'::jsonb),
    ('Bayfront Life (sample)', 'Bayfront Global Term', false, 'Offshore', '{USD}'::text[], 18, 70,
       '{Singapore citizen,Singapore PR,Foreigner living in Singapore,Non-resident}'::text[], 1000000, 25000000, false, false, 'verified', 3, 0.84, null, 'v3.0', 200, 60,
       '{"guaranteed":"Guaranteed level for the whole term","premTerm":"10 years, 20 years, or to age 65","modes":"Annual only","coverTo":"Age 80 or 100","death":"Yes","ti":"Included","tpd":"","ci":"","eci":"","ad":"","conversion":"","renew":"Not renewable","inc":"","cash":"None","dist":"20% to 25% of total premiums","fees":"Policy fee US$300 a year","freelook":"30 days","grace":"31 days","reinstate":"Within 1 year of lapse","excl":"Suicide in the first year; war","uw":"Full medical and financial underwriting for all","special":"Policy may be held in a trust; premium financing allowed","consider":"Minimum cover US$1m. Annual premiums only. Offshore insurer: not covered by the SDIC Policy Owners'' Protection Scheme."}'::jsonb),
    ('Kallang Mutual (sample)', 'Kallang FamilyTerm', false, 'Onshore', '{SGD,USD}'::text[], 18, 64,
       '{Singapore citizen,Singapore PR,Foreigner living in Singapore}'::text[], 100000, 10000000, true, true, 'verified', 5, 0.79, 0.95, 'v5.0', 290, 39,
       '{"guaranteed":"Level, not guaranteed (reviewable)","premTerm":"Same as policy term, or 5-pay / 10-pay","modes":"Annual, half-yearly, quarterly, monthly","coverTo":"Age 65 to 99 (any age)","death":"Yes","ti":"Included","tpd":"Included up to age 70","ci":"Optional rider (44 critical illnesses)","eci":"Optional rider (multi-claim)","ad":"Optional rider (extra 100% of sum assured)","conversion":"Convert to whole life up to age 65","renew":"Not renewable","inc":"Increase at life events, no medical (up to 3 times)","cash":"None","dist":"33% to 40% of total premiums","fees":"None","freelook":"14 days","grace":"30 days","reinstate":"Within 2 years of lapse","excl":"Suicide in the first year; pre-existing conditions","uw":"Full medical above S$3m","special":"20% premium discount for the first year when bought with CI rider (campaign until 31 Dec 2026)","consider":"Campaign discount is for the first year only."}'::jsonb),
    ('Lion Gate Assurance (sample)', 'LionGate Term Plus', false, 'Onshore', '{SGD}'::text[], 18, 60,
       '{Singapore citizen,Singapore PR}'::text[], 100000, 2000000, true, true, 'draft', 1, 0.70, 0.88, 'v1.2', 50, 150,
       '{"guaranteed":"Not guaranteed","premTerm":"Same as policy term","modes":"Annual, monthly","coverTo":"Age 75 or 85","death":"Yes","ti":"Included","tpd":"Included up to age 65","ci":"Optional rider","freelook":"14 days","grace":"30 days","excl":"Suicide in the first year","uw":"Full medical above S$1m"}'::jsonb)
  ) as t(insurer, name, dpi, juris, curs, amin, amax, res, samin, samax, tpd, ci, status, ver, rate, cirate, psv, ps_days, rs_days, info)
  loop
    insert into public.kb_products (insurer, name, dpi, jurisdiction, currencies, entry_age_min, entry_age_max, residency,
        sa_min, sa_max, has_tpd, has_ci, status, version, is_sample, verified_at)
    values (p.insurer, p.name, p.dpi, p.juris, p.curs, p.amin, p.amax, p.res, p.samin, p.samax, p.tpd, p.ci, p.status, p.ver, true,
        case when p.status = 'verified' then now() end)
    returning id into k;
    insert into public.kb_documents (product_id, insurer, title, doc_type, version, effective_from, valid_until, status, is_sample)
    values (k, p.insurer, 'Product Summary ' || p.psv, 'Product Summary', p.psv, current_date - p.ps_days, current_date + 365, 'checked', true)
    returning id into d_ps;
    insert into public.kb_documents (product_id, insurer, title, doc_type, version, effective_from, valid_until, status, is_sample)
    values (k, p.insurer, 'Rate sheet ' || to_char(current_date - 30, 'Mon YYYY'), 'Rate sheet', '', current_date - 30, current_date + p.rs_days, 'checked', true)
    returning id into d_rs;
    -- Each fact names the Product Summary and a page (sample pages).
    fx := '{}';
    for f in select jsonb_build_object('k', key, 'v', value) from jsonb_each_text(p.info) loop
      fx := fx || jsonb_build_object(f ->> 'k', jsonb_build_object('v', f ->> 'v', 'doc', d_ps, 'page',
        case f ->> 'k' when 'uw' then 6 when 'guaranteed' then 3 when 'premTerm' then 3 when 'modes' then 3 when 'coverTo' then 2
          when 'death' then 4 when 'ti' then 4 when 'tpd' then 4 when 'ci' then 5 when 'eci' then 5 when 'ad' then 5
          when 'conversion' then 7 when 'renew' then 7 when 'inc' then 7 when 'cash' then 8 when 'dist' then 9 when 'fees' then 9
          when 'freelook' then 10 when 'grace' then 10 when 'reinstate' then 10 when 'excl' then 11 else 12 end));
    end loop;
    update public.kb_products set facts = fx || jsonb_build_object('_ps', jsonb_build_object('doc', d_ps), '_rs', jsonb_build_object('doc', d_rs)) where id = k;
    -- Rates: rise about 7.5% a year of age from age 35; women about 18% lower; smokers 60% higher.
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select k, a, g, s,
           round((p.rate * power(1.075, a - 35) * (case when g = 'Female' then 0.82 else 1 end) * (case when s then 1.6 else 1 end))::numeric, 4),
           case when p.cirate is not null then round((p.cirate * power(1.06, a - 35) * (case when s then 1.4 else 1 end))::numeric, 4) end
      from generate_series(p.amin, p.amax) a, unnest(array['Male', 'Female']) g, unnest(array[false, true]) s;
  end loop;
end $$;
commit;
select insurer, name, status, (select count(*) from public.kb_rates r where r.product_id = p.id) as rates
  from public.kb_products p where is_sample order by insurer;
