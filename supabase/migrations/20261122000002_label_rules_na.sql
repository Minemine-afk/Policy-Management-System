-- PI reader learning, step 3 (22 Nov 2026): ops' NAs are remembered per plan ('na': no such rider, no cash value, no
-- campaign), so the next PI of that plan fills them; accidental death and campaigns can be remembered as NA too.
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
