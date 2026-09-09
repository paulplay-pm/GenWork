-- provider_keys v2 follow-up: recover the API protocol for CUSTOM rows that
-- predated the `protocol` column. 031 defaulted them to 'openai', which would
-- silently flip an existing Anthropic endpoint to the Bearer wire format on
-- upgrade. Built-ins are already seeded with the correct protocol, and
-- provider='gemini' custom rows cannot be expressed by the 2-value column
-- (openai|anthropic) — they are left as-is (documented upgrade caveat).
-- Plain SQL only (no DO blocks); the runner applies one `;`-statement at a time.
UPDATE provider_keys
SET protocol = 'anthropic'
WHERE provider = 'anthropic'
  AND protocol = 'openai'
  AND NOT is_builtin;
