-- UPGRADE for a project that already ran 1n-upgrade.sql. Paste the whole file into SQL Editor and Run once.
-- Deletes nothing; places already learned are kept. Safe to run again.
-- 22 Nov 2026: the PI reader remembers the NAs ops set per plan (no rider, no cash value, no campaign).

begin;
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_how_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_how_check check (how in ('beside', 'under', 'row', 'na'));
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_field_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_field_check check (field in ('insured_name', 'date_of_birth',
  'gender', 'residency', 'underwriting_class', 'cover_age', 'insurer', 'policy_name', 'policy_term', 'premium_term',
  'annual_premium', 'total_premium', 'death_sa', 'accidental_death', 'base_premium', 'tpd_sa', 'tpd_premium', 'ci_sa',
  'ci_premium', 'cash_value', 'campaigns'));
-- An NA place is only "na" and always names its plan.
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_na_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_na_check check (how <> 'na' or (label = 'na' and length(btrim(plan)) > 0));

commit;
