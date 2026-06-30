# collect_booking_details

Collect the minimum information required before asking for a diagnostic deposit.

Required fields:
- customer name
- caller phone
- service address
- HVAC problem summary

Useful optional fields:
- preferred appointment window
- customer email
- vulnerable-person signal
- access notes

If required fields are missing, Hermes must return `nextAction: "ask_followup"` and list the missing field names in `requiredFieldsMissing`.
