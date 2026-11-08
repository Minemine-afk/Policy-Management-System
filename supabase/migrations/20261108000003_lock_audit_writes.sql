-- log_event writes to the audit log with the definer's rights. Only the database's own
-- functions may call it; signed-in users must not be able to add audit entries directly.
revoke execute on function public.log_event(text, text, text, jsonb) from public, anon, authenticated;
