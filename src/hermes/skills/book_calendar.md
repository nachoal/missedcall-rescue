# book_calendar

Book the HVAC diagnostic visit after the deposit succeeds.

Inputs:
- paid call record
- service address
- problem summary
- preferred or recommended window
- customer contact fields

Rules:
- Use emergency windows for emergency triage.
- Use same-day windows when requested and available.
- If no preferred window exists, use the recommended window from triage.
- Do not mark a call booked until the payment step has succeeded.
