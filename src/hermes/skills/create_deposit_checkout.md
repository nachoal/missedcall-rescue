# create_deposit_checkout

Prepare the checkout handoff once triage has enough booking details.

Preconditions:
- `nextAction` is `send_deposit`
- name, phone, address, and problem are present
- deposit amount is 4900 cents USD

Runtime contract:
- The Hermes decision layer does not create Stripe sessions directly.
- It returns the decision state that downstream payment services use to create the checkout.
- If details are incomplete, collect details before checkout.
