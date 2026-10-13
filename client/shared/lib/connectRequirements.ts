// Friendly labels for Stripe's `requirements.*` machine codes. Used by the
// banking pages to tell the owner exactly what Stripe needs ("Verify your
// ID") instead of leaking codes ("individual.verification.document").
//
// Keep adding rows as you see new codes in production logs — Stripe's full
// list is at https://docs.stripe.com/connect/required-verification-information

const REQUIREMENT_LABELS: Record<string, string> = {
  // Identity verification
  "individual.verification.document": "Upload your ID document",
  "individual.verification.additional_document": "Upload an additional ID document",
  "individual.id_number": "Add your ID/passport number",
  "individual.ssn_last_4": "Add the last 4 digits of your SSN",
  "individual.dob.day": "Confirm your date of birth",
  "individual.dob.month": "Confirm your date of birth",
  "individual.dob.year": "Confirm your date of birth",
  "individual.first_name": "Add your first name",
  "individual.last_name": "Add your last name",
  "individual.email": "Confirm your email",
  "individual.phone": "Add your phone number",
  "individual.address.line1": "Add your address",
  "individual.address.city": "Add your city",
  "individual.address.postal_code": "Add your postal code",
  // Banking
  external_account: "Add a payout bank account",
  // Business
  "business_profile.url": "Add your business website",
  "business_profile.mcc": "Set your business category",
  "business_profile.product_description": "Describe what your business does",
  business_type: "Confirm your business type",
  // Legal
  "tos_acceptance.date": "Accept Stripe's Terms of Service",
  "tos_acceptance.ip": "Accept Stripe's Terms of Service",
  // Company
  "company.tax_id": "Add your company tax ID",
  "company.address.line1": "Add your company address",
  "company.name": "Add your company name",
  "company.phone": "Add your company phone",
};

export function requirementLabel(code: string): string {
  if (REQUIREMENT_LABELS[code]) return REQUIREMENT_LABELS[code];
  // Fallback: turn `individual.verification.document` into
  // "individual · verification · document" so the owner sees something readable
  // even before we add a mapping.
  return code.replace(/_/g, " ").replace(/\./g, " · ");
}
