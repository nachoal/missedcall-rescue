# hvac_triage

Classify a missed HVAC call into emergency, same-day, or routine service.

Inputs:
- Call transcript
- Caller phone number
- Any known customer fields

Decision rules:
- Emergency when the caller reports no cooling during unsafe heat, a vulnerable person is present, or the caller asks for urgent help.
- Same-day when AC is not cooling, leaking, or unavailable today but no vulnerable-person signal is present.
- Routine for non-urgent diagnostics, thermostat questions, maintenance, or unclear HVAC issues.
- Escalate to a human for gas smell, carbon monoxide, smoke, fire, sparking, or electrical hazards.

Output evidence:
- urgency
- reasons
- recommended dispatch window
- customer problem summary
