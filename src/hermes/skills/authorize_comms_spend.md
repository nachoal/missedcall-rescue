# authorize_comms_spend

Authorize only small customer communication spend.

Allowed:
- vendor `comms_confirmations`
- purpose `customer_confirmation_sms`
- USD amount at or below 1000 cents

Denied:
- ads
- unlisted vendors
- marketing spend
- amounts above the policy limit

The Hermes proof pack should record the policy decision and rule id from the spend authorization service.
