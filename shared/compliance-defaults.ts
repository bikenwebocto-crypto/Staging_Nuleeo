// Default compliance document content. Used as the initial seed when the
// Firestore `config/compliance` doc doesn't exist yet, and as a "Reset to
// Default" target in the admin editor. Shared between the Express server
// and the client bundles.
//
// All documents are baselined for a Cyprus-incorporated SaaS operating in
// the European Union. They reference the GDPR (Reg. 2016/679), the Cyprus
// Data Protection Law 125(I)/2018, the ePrivacy Directive (2002/58/EC) as
// implemented in Cyprus by Law 112(I)/2004, the EU Digital Services Act
// (Reg. 2022/2065), the EU AI Act (Reg. 2024/1689), the Consumer Rights
// Directive (2011/83/EU), the Unfair Contract Terms Directive (93/13/EEC),
// PSD2 (Dir. 2015/2366) as implemented by Cyprus Law 31(I)/2018, the
// Anti-Money Laundering and Counter-Terrorism Financing Law 188(I)/2007,
// the European Accessibility Act (Dir. 2019/882), the ODR Regulation
// (524/2013), and the Cyprus Rent Control Law (Cap. 23). Defaults are
// drafted to be defensible but admin-editable: every entity name, address,
// fee figure, or contact email should be reviewed by qualified Cyprus
// counsel before launch.

import type { ComplianceDocs } from "./firestore-schema";

export const DEFAULT_COMPLIANCE_DOCS: ComplianceDocs = {
  terms: `<h2>Terms of Use</h2>
<p><em>Last updated: June 17, 2026</em></p>

<h3>1. Who we are</h3>
<p>Olio Wallet ("<strong>Olio</strong>", "we", "us") is a software-as-a-service platform operated by Olio Wallet Ltd, a company registered in the Republic of Cyprus. Our registered office and contact details are published at <a href="https://oliowallet.com/contact">oliowallet.com/contact</a>. These Terms of Use ("<strong>Terms</strong>") form a legally binding agreement between you and Olio under the laws of the Republic of Cyprus and the European Union.</p>

<h3>2. What Olio is — and is not</h3>
<p>Olio is a technology platform that lets property owners, portfolio managers and tenants record properties and units, exchange messages, generate rental agreements, collect and remit rent through licensed payment providers, and access analytics. <strong>Olio is not a landlord, tenant, estate agent, lawyer, accountant, payment institution, or insurer.</strong> We do not provide legal, tax, financial, investment or real-estate advice. Agreements between owners and tenants are concluded directly between those parties; Olio is not a party to them.</p>

<h3>3. Eligibility and account</h3>
<p>You must be at least 18 years old and legally capable of entering into a binding contract under Cyprus law. You agree to provide accurate information at registration and to keep it current. You are responsible for safeguarding your credentials and for all activity under your account; notify us promptly at <strong>security@oliowallet.com</strong> if you suspect unauthorised use.</p>

<h3>4. Personas and persona-specific terms</h3>
<p>Your rights and obligations depend on the role you use Olio in. The following persona terms are incorporated by reference and form part of this agreement:</p>
<ul>
  <li><a href="/legal/owner-terms">Owner Terms</a> — for property owners and portfolio managers.</li>
  <li><a href="/legal/tenant-terms">Tenant Terms</a> — for tenants and household occupants.</li>
</ul>
<p>You may hold more than one role. Where persona terms conflict with these Terms, the persona terms control for activity in that role.</p>

<h3>5. Acceptable use</h3>
<p>You must comply with our <a href="/legal/aup">Acceptable Use Policy</a> and <a href="/legal/community-guidelines">Community Guidelines</a>. In particular, you must not use Olio to commit fraud, money laundering, discrimination, harassment, infringement of intellectual property, breach of tenancy or housing law, or any other unlawful conduct.</p>

<h3>6. Subscriptions, fees and payments</h3>
<p>Some features require a paid subscription. Subscription tiers, prices, billing cycles, taxes, refunds and the statutory 14-day right of withdrawal for consumers are governed by our <a href="/legal/payments-terms">Payments, Refunds &amp; Subscription Terms</a>. Rent and other tenant-to-owner payments are processed by Stripe Payments Europe, Ltd. ("<strong>Stripe</strong>") and are subject to Stripe's own terms.</p>

<h3>7. Content you submit</h3>
<p>You retain ownership of content you upload (text, images, documents). You grant Olio a worldwide, non-exclusive, royalty-free licence to host, copy, process and display that content solely to operate the service, comply with law, and provide it to the persons you direct (for example, the tenants associated with a unit). You warrant that you have the rights necessary to grant this licence and that the content does not infringe third-party rights or breach our <a href="/legal/aup">AUP</a>.</p>

<h3>8. AI features</h3>
<p>Some features, including "AskOlio", are powered by large language models. AI output may be incomplete, inaccurate, or out of date and must never be relied upon as legal, tax, financial or real-estate advice. See our <a href="/legal/ai-terms">AI Terms &amp; Transparency Notice</a> for the disclosures required by the EU AI Act.</p>

<h3>9. Third-party services</h3>
<p>Olio integrates with third parties (e.g. Stripe, OpenAI, Resend, OneSignal, OpenStreetMap, CARTO, Google, Cloudflare). Their services are governed by their own terms and privacy notices. Our <a href="/legal/subprocessors">Subprocessors</a> list identifies the providers we share data with.</p>

<h3>10. Suspension and termination</h3>
<p>We may suspend or terminate your account, immediately and without prior notice, if we reasonably believe you have materially breached these Terms, the AUP, or applicable law; if continued provision would expose Olio, other users, or third parties to legal, financial, security or reputational risk; or if required by a competent authority. Where the breach is curable and the risk to others permits, we will give you a reasonable opportunity to cure. You may close your account at any time from the <em>Privacy &amp; Terms → Delete Account</em> screen. Sections that by their nature should survive termination (including 7, 11, 12, 13, 14 and 16) will survive.</p>

<h3>11. Disclaimers</h3>
<p>To the maximum extent permitted by law, the service is provided "as is" and "as available". We do not warrant that the service will be uninterrupted, error-free, secure against every attack, or fit for any particular purpose. Nothing in this section excludes liability that cannot lawfully be excluded under EU consumer protection law or Cyprus law.</p>

<h3>12. Limitation of liability</h3>
<p>To the maximum extent permitted by law, Olio's aggregate liability arising out of or relating to these Terms or your use of the service, whether in contract, tort, breach of statutory duty or otherwise, is limited to the greater of (a) the fees you paid to Olio in the twelve (12) months immediately preceding the event giving rise to the claim, or (b) one hundred euro (€100). Olio is not liable for indirect, incidental, special, consequential or punitive damages, loss of profits, loss of rent, loss of data, loss of goodwill, or third-party claims. <strong>Nothing in these Terms limits liability for death or personal injury caused by negligence, fraud, fraudulent misrepresentation, or any other liability that cannot lawfully be excluded.</strong> Consumer rights under Cyprus and EU mandatory law are not affected.</p>

<h3>13. Indemnity</h3>
<p>Where you act as a business or in your role as a property owner or portfolio manager, you will indemnify Olio against any third-party claim arising from (a) content you submitted, (b) your breach of these Terms, persona terms, or the AUP, (c) your breach of housing, tenancy, tax, AML or data-protection law, or (d) your relationship with any tenant, owner or counterparty introduced through the platform. This indemnity does not apply where the claim is caused by Olio's own gross negligence or wilful misconduct, and does not apply to consumers using the service in a private capacity.</p>

<h3>14. Changes to the Terms</h3>
<p>We may revise these Terms to reflect changes in our service, the law, or our operating practices. Material changes will be notified at least 30 days in advance by in-app notice or email, and your continued use after the effective date constitutes acceptance. If you do not agree, you may close your account before the change takes effect.</p>

<h3>15. Complaints and dispute resolution</h3>
<p>If you have a complaint, please first contact us at <strong>support@oliowallet.com</strong>. See our <a href="/legal/complaints">Complaints &amp; Dispute Resolution Policy</a> for how we handle complaints, the EU Online Dispute Resolution platform (<a href="https://ec.europa.eu/consumers/odr" rel="noopener noreferrer">ec.europa.eu/consumers/odr</a>), and the Cyprus Consumer Protection Service.</p>

<h3>16. Governing law and jurisdiction</h3>
<p>These Terms are governed by the laws of the Republic of Cyprus, without regard to its conflict-of-law rules. Subject to mandatory consumer law that grants you the right to bring proceedings in your country of residence, the courts of Nicosia, Cyprus, have exclusive jurisdiction over any dispute arising out of or relating to these Terms.</p>

<h3>17. Contact</h3>
<p>Olio Wallet Ltd · Nicosia, Cyprus · <strong>legal@oliowallet.com</strong></p>`,

  privacy: `<h2>Privacy Policy</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This Privacy Policy explains how Olio Wallet Ltd ("<strong>Olio</strong>", "we") collects, uses, shares and protects personal data when you visit our websites and use the Olio platform. It is issued in accordance with the EU General Data Protection Regulation (Reg. 2016/679, the "<strong>GDPR</strong>") and the Cyprus Law providing for the Protection of Natural Persons with Regard to the Processing of Personal Data (Law 125(I)/2018).</p>

<h3>1. Data controller and contact</h3>
<p>The controller for personal data processed about you as a registered user is Olio Wallet Ltd, Nicosia, Cyprus. You can reach our privacy team at <strong>privacy@oliowallet.com</strong> and our Data Protection Officer at <strong>dpo@oliowallet.com</strong>.</p>
<p>Where you use Olio as a tenant of an owner who manages your tenancy through the platform, that owner is the controller of the tenancy-related personal data they collect about you, and Olio acts as their processor under our <a href="/legal/dpa">Data Processing Agreement</a>.</p>

<h3>2. Categories of personal data</h3>
<ul>
  <li><strong>Identity &amp; contact:</strong> name, email, phone, profile photo, role (owner/tenant/staff).</li>
  <li><strong>Account &amp; security:</strong> authentication identifiers, hashed credentials, device and login metadata, IP address, security logs.</li>
  <li><strong>Property &amp; tenancy:</strong> property address, unit details, lease dates, rent amount, agreements and uploaded documents (e.g. ID, proof of address) where the owner requests them.</li>
  <li><strong>Payments:</strong> billing address, payment-method tokens held by Stripe, transaction history, payout details for owners. Olio does not store full card numbers.</li>
  <li><strong>Communications:</strong> in-app messages, support tickets, email engagement metrics (opens, clicks), push-notification tokens.</li>
  <li><strong>Usage:</strong> pages visited, features used, approximate location (city-level) inferred from IP, error logs.</li>
  <li><strong>AI prompts:</strong> the text you enter into AskOlio and any context the platform attaches to your prompt.</li>
</ul>
<p>We do not knowingly collect special-category data (Art. 9 GDPR) such as health, religious or biometric data. If you upload such data inside an attached document, it is processed under contract or with your explicit consent.</p>

<h3>3. Purposes and legal bases</h3>
<table>
  <tr><th>Purpose</th><th>Legal basis</th></tr>
  <tr><td>Providing the platform, account, and persona features</td><td>Art. 6(1)(b) — performance of contract</td></tr>
  <tr><td>Processing payments, payouts and subscriptions</td><td>Art. 6(1)(b) — contract; Art. 6(1)(c) — legal obligation (tax, AML)</td></tr>
  <tr><td>Fraud prevention, security monitoring, abuse detection</td><td>Art. 6(1)(f) — legitimate interests (protecting users and the service)</td></tr>
  <tr><td>Transactional emails and push notifications</td><td>Art. 6(1)(b) — contract</td></tr>
  <tr><td>Marketing emails to users and prospects</td><td>Art. 6(1)(a) — consent (and the soft opt-in exception in the ePrivacy Directive, where applicable)</td></tr>
  <tr><td>Compliance with court orders, AML, tax and other legal duties</td><td>Art. 6(1)(c) — legal obligation</td></tr>
  <tr><td>Aggregated analytics and product improvement</td><td>Art. 6(1)(f) — legitimate interests</td></tr>
  <tr><td>AskOlio prompts and AI responses</td><td>Art. 6(1)(b) — contract; Art. 6(1)(a) — consent for optional improvement uses</td></tr>
</table>

<h3>4. Sharing and recipients</h3>
<p>We share personal data with: (a) the owner or tenant counterparty on the platform, as required to operate your tenancy or portfolio; (b) the subprocessors listed in our <a href="/legal/subprocessors">Subprocessors</a> page (Stripe, OpenAI, Resend, OneSignal, the OpenStreetMap Foundation, CARTO, Google Cloud, Cloudflare) under written data-processing agreements; (c) professional advisers, auditors and insurers bound by confidentiality; (d) competent authorities where required by law; (e) a buyer or successor in the event of a corporate transaction, under equivalent protections. <strong>We do not sell personal data.</strong></p>

<h3>5. International transfers</h3>
<p>Some subprocessors are located outside the European Economic Area, including the United States. Where personal data leaves the EEA, we rely on the European Commission's Standard Contractual Clauses (Implementing Decision 2021/914), the EU-US Data Privacy Framework where applicable, or another lawful transfer mechanism, and we carry out a transfer impact assessment. A copy of the transfer mechanism for a specific subprocessor is available on request.</p>

<h3>6. Retention</h3>
<p>We keep personal data for as long as needed for the purposes above and to meet legal retention obligations. Indicative periods:</p>
<ul>
  <li>Account profile: while your account is active, plus 12 months.</li>
  <li>Tenancy and agreement records: 6 years after the tenancy ends (Cyprus contract limitation period).</li>
  <li>Payment, invoice and tax records: 6 years (Cyprus Tax Department requirements).</li>
  <li>AML/KYC documentation collected by Stripe: 5 years after the end of the relationship (Cyprus AML Law 188(I)/2007).</li>
  <li>Security logs: up to 12 months.</li>
  <li>Marketing data: until you withdraw consent.</li>
</ul>

<h3>7. Your rights</h3>
<p>Subject to GDPR conditions, you may request: access, rectification, erasure, restriction of processing, portability, and objection to processing based on legitimate interests or direct marketing. You may also withdraw consent at any time without affecting the lawfulness of earlier processing. You can delete your account yourself from the <em>Privacy &amp; Terms → Delete Account</em> screen; for any other request, email <strong>privacy@oliowallet.com</strong>. We respond within one month, extendable by two further months for complex requests.</p>
<p>You have the right to lodge a complaint with the Office of the Commissioner for Personal Data Protection of the Republic of Cyprus (<a href="https://www.dataprotection.gov.cy" rel="noopener noreferrer">dataprotection.gov.cy</a>) or with your local EU/EEA supervisory authority.</p>

<h3>8. Cookies and tracking</h3>
<p>See our separate <a href="/legal/cookies">Cookie Policy</a> for the cookies and similar technologies we use.</p>

<h3>9. Security</h3>
<p>See our <a href="/legal/security">Security &amp; Incident Response</a> page for the technical and organisational measures we apply and our breach-notification commitments.</p>

<h3>10. Children</h3>
<p>Olio is not directed at children under 16. We do not knowingly process personal data of children. If you believe we have, contact <strong>privacy@oliowallet.com</strong> for prompt deletion.</p>

<h3>11. Automated decisions and profiling</h3>
<p>We do not make decisions producing legal or similarly significant effects about you based solely on automated processing within the meaning of Art. 22 GDPR. Fraud-prevention systems may flag transactions for human review.</p>

<h3>12. Changes</h3>
<p>We will notify you of material changes at least 30 days before they take effect. The current version is always available at <a href="/legal/privacy">/legal/privacy</a>.</p>`,

  gdpr: `<h2>GDPR Notice — Your Data Subject Rights</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This notice supplements our <a href="/legal/privacy">Privacy Policy</a> with the specific information required by Articles 13–22 of the EU General Data Protection Regulation (Reg. 2016/679) and the Cyprus Data Protection Law 125(I)/2018.</p>

<h3>1. Controller, representative and DPO</h3>
<p><strong>Controller:</strong> Olio Wallet Ltd, Nicosia, Cyprus.<br/>
<strong>Data Protection Officer:</strong> dpo@oliowallet.com.<br/>
<strong>Supervisory authority:</strong> Office of the Commissioner for Personal Data Protection of the Republic of Cyprus, 1 Iasonos Street, 1082 Nicosia (<a href="https://www.dataprotection.gov.cy" rel="noopener noreferrer">dataprotection.gov.cy</a>).</p>

<h3>2. Your rights</h3>
<ul>
  <li><strong>Right of access (Art. 15)</strong> — confirmation of whether we process your data and a copy of it.</li>
  <li><strong>Right to rectification (Art. 16)</strong> — correction of inaccurate or incomplete data.</li>
  <li><strong>Right to erasure / "right to be forgotten" (Art. 17)</strong> — deletion where one of the grounds applies and no exception is engaged.</li>
  <li><strong>Right to restriction (Art. 18)</strong> — temporary freeze of processing while a dispute is resolved.</li>
  <li><strong>Right to portability (Art. 20)</strong> — receive your data in a structured, machine-readable format and transmit it to another controller.</li>
  <li><strong>Right to object (Art. 21)</strong> — object to processing based on legitimate interests or to direct marketing at any time.</li>
  <li><strong>Right not to be subject to solely automated decision-making (Art. 22)</strong> — request human review of significant automated decisions.</li>
  <li><strong>Right to withdraw consent (Art. 7)</strong> — withdraw at any time without affecting prior lawful processing.</li>
  <li><strong>Right to lodge a complaint (Art. 77)</strong> — with the Cyprus Commissioner or your local EU supervisory authority.</li>
</ul>

<h3>3. How to exercise your rights</h3>
<p>You can delete your account yourself from the <em>Privacy &amp; Terms → Delete Account</em> screen, manage notification preferences in <em>Settings → Notifications</em>, and opt out of marketing emails using the unsubscribe link in any marketing email. To exercise any other right — access, rectification, portability, restriction or objection — email <strong>privacy@oliowallet.com</strong> and we will action your request manually. We respond within one month and may extend by two months for complex requests, informing you of the reason.</p>

<h3>4. Identity verification</h3>
<p>We may need to confirm your identity before acting on a request to prevent unauthorised disclosure. We will limit the verification data we ask for to what is strictly necessary.</p>

<h3>5. International transfers</h3>
<p>Where your data is transferred outside the EEA, we use the Commission's Standard Contractual Clauses (Implementing Decision 2021/914), the EU-US Data Privacy Framework, or another lawful mechanism, and supplement with technical safeguards such as encryption in transit and at rest.</p>

<h3>6. Personal data breaches</h3>
<p>If a personal data breach is likely to result in a risk to your rights and freedoms, we will notify the Cyprus Commissioner within 72 hours of becoming aware of it (Art. 33) and inform you without undue delay where the risk is high (Art. 34). See our <a href="/legal/security">Security &amp; Incident Response</a> page.</p>

<h3>7. Tenancy data — controller responsibilities</h3>
<p>When your owner manages tenancy data about you through Olio, the owner is the controller for that data and Olio is the processor. Direct access, deletion and portability requests for tenancy-specific records to your owner. Olio will assist owners in responding within the GDPR timelines under the <a href="/legal/dpa">Data Processing Agreement</a>.</p>`,

  "owner-terms": `<h2>Owner Terms</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>These Owner Terms apply when you use Olio as a property owner, landlord, portfolio manager, or agent acting on behalf of an owner. They supplement the general <a href="/legal/terms">Terms of Use</a>. Where the two conflict in respect of owner activity, these Owner Terms prevail.</p>

<h3>1. Owner eligibility and verification</h3>
<p>You represent and warrant that you are the lawful owner of each property and unit you list, or that you have express written authority from the owner to manage it on the platform. We may request documentary evidence (title deed, power of attorney, certificate of registration with the Cyprus Department of Lands and Surveys) at any time and may suspend listings pending verification.</p>

<h3>2. Compliance with housing law</h3>
<p>You are solely responsible for complying with the laws governing residential tenancies in the jurisdiction where each property is located, including in Cyprus: the Rent Control Law (Cap. 23) and amendments thereto, the Immovable Property (Tenure, Registration and Valuation) Law (Cap. 224), the Town and Country Planning Law, the Streets and Buildings Regulation Law, and any short-term let licensing rules administered by the Deputy Ministry of Tourism. For properties outside Cyprus, equivalent local law applies.</p>

<h3>3. Accuracy of listings</h3>
<p>Property and unit information you publish must be accurate, current, and not misleading (Unfair Commercial Practices Directive 2005/29/EC). You must disclose material defects that would influence a reasonable tenant's decision. Olio may remove listings that appear to mislead, discriminate, or breach the law.</p>

<h3>4. Non-discrimination</h3>
<p>You must not refuse a tenancy, terminate a tenancy, or set tenancy terms on the basis of race, ethnic or national origin, religion or belief, disability, age, sexual orientation, gender or gender identity, family status, pregnancy or maternity, or any other characteristic protected by EU or Cyprus equal-treatment law (including Law 42(I)/2004 and Law 58(I)/2004).</p>

<h3>5. Tenant invitations and onboarding</h3>
<p>Where you invite a tenant to Olio, you confirm you have a lawful basis to share their email and other contact details with us (typically Art. 6(1)(b) GDPR — performance of the rental contract — or Art. 6(1)(f) — legitimate interests). You must provide the tenant with our <a href="/legal/privacy">Privacy Policy</a> URL when you invite them.</p>

<h3>6. Rent collection and payouts</h3>
<p>Tenant-to-owner rent payments are processed by Stripe Payments Europe, Ltd. ("<strong>Stripe</strong>") under a Stripe Connect arrangement. By accepting rent through Olio you (a) agree to the Stripe Connected Account Agreement and Stripe Services Agreement, (b) authorise Olio to collect a platform fee disclosed at the time of each transaction in accordance with the <a href="/legal/payments-terms">Payments, Refunds &amp; Subscription Terms</a>, and (c) undertake to keep your Stripe payout method current. Olio does not hold client funds; payouts are subject to Stripe's settlement schedule.</p>

<h3>7. Data protection — owner as controller</h3>
<p>When you collect tenancy data about your tenant through Olio (identification documents, income evidence, lease, payment history), you are the data controller and Olio is your processor for that data. The terms of processing are governed by our <a href="/legal/dpa">Data Processing Agreement</a>, which is incorporated by reference. You are responsible for providing your tenants with a privacy notice, lawful basis for collecting their data, and a route to exercise their data-subject rights.</p>

<h3>8. AML and sanctions</h3>
<p>For higher-volume rent flows Stripe and Olio may carry out additional checks under the Cyprus Anti-Money Laundering and Counter-Terrorism Financing Law 188(I)/2007 and EU AML directives. See our <a href="/legal/aml-kyc">AML/KYC Notice</a>. You must not list properties owned by, or accept payments from, sanctioned persons.</p>

<h3>9. Plans and unit caps</h3>
<p>Each plan tier (Starter, Growth, Pro, Business) carries a maximum number of active units and a feature set shown in the in-app plan picker (profile → <em>Upgrade</em>). Exceeding the cap may auto-disable new listings until you upgrade or remove inactive units. Pricing, taxes and refund rights are governed by the <a href="/legal/payments-terms">Payments Terms</a>.</p>

<h3>10. Analytics and valuations</h3>
<p>Portfolio analytics, occupancy forecasts and indicative valuations are informational only. They are not financial, investment, tax or real-estate advice. You must verify any figure independently before acting on it.</p>

<h3>11. Termination and property transfer</h3>
<p>You may close your account from the <em>Privacy &amp; Terms → Delete Account</em> screen. To transfer a unit to a new owner, contact <strong>support@oliowallet.com</strong>. You remain responsible for obligations accrued before any transfer. If we terminate your account for cause, active tenancies will be flagged for orderly handover so tenants are not deprived of rent records.</p>

<h3>12. Indemnity</h3>
<p>You agree to indemnify Olio against third-party claims arising from your property, your tenancy, your compliance failures, your discriminatory acts, your tax position, or content you upload, except where the claim is caused by Olio's own gross negligence or wilful misconduct.</p>`,

  "tenant-terms": `<h2>Tenant Terms</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>These Tenant Terms apply when you use Olio as a tenant or co-occupant of a property managed on the platform. They supplement the general <a href="/legal/terms">Terms of Use</a>. Where the two conflict in respect of tenant activity, these Tenant Terms prevail. Where you use Olio as a consumer for purposes outside any trade, business, craft or profession, your rights under EU and Cyprus consumer protection law are not affected.</p>

<h3>1. Olio is a tool, not a landlord</h3>
<p>Olio does not own the property, set the rent, decide whether to grant or terminate your tenancy, or hold a deposit. The tenancy is between you and the owner. Olio provides the messaging, document storage, payment rails (through Stripe) and record-keeping that support the tenancy.</p>

<h3>2. Your invitation and account</h3>
<p>You will normally be invited to Olio by your owner. Accepting the invitation creates your account and links you to your tenancy. You must provide accurate information and keep your contact details current.</p>

<h3>3. Identity verification</h3>
<p>If your owner requests ID documents, proof of address, or other onboarding information, you provide it directly to the owner using the upload tools in Olio. The owner is the controller of that data; see Section 7 of our <a href="/legal/owner-terms">Owner Terms</a> and the <a href="/legal/dpa">DPA</a>. Olio does not use your ID documents for any purpose other than secure storage and delivery to the owner you select.</p>

<h3>4. Paying rent</h3>
<p>Where the owner has enabled in-platform rent collection, you can pay rent by debit card, credit card or supported bank methods through Stripe Payments Europe, Ltd. Payment authorisations, refund rights, dispute (chargeback) handling and strong customer authentication under PSD2 are described in our <a href="/legal/payments-terms">Payments Terms</a>. Olio does not store your full card number.</p>

<h3>5. Receipts and records</h3>
<p>Every successful rent payment is recorded and is visible in your tenant dashboard, where you can review your payment history. Tax treatment of rent payments is between you and your owner.</p>

<h3>6. Cyprus Rent Control Law</h3>
<p>If your tenancy is a statutory tenancy under the Cyprus Rent Control Law (Cap. 23), nothing in your owner's settings, your in-platform agreement, or these Tenant Terms reduces the protections that law grants you (including rent-increase limitations and recovery-of-possession rules). The Rent Control Court has jurisdiction over disputes that fall within Cap. 23.</p>

<h3>7. Messaging and notices</h3>
<p>Messages you send through Olio to your owner are stored as part of your tenancy record. Where the law requires formal notices in writing (e.g. notice to quit, statutory notices under Cap. 23), check whether your jurisdiction recognises electronic notice; Olio does not warrant that an in-app message satisfies a statutory notice requirement.</p>

<h3>8. Your rights</h3>
<p>You may at any time:</p>
<ul>
  <li>Review your tenancy and payment records in your dashboard, and request a copy of your personal data by emailing <strong>privacy@oliowallet.com</strong>.</li>
  <li>Opt out of marketing emails using the unsubscribe link in any such email, and manage notification preferences in <em>Settings → Notifications</em>.</li>
  <li>Close your account once your tenancy ends; payment and tenancy records are retained for the limitation period set in our <a href="/legal/privacy">Privacy Policy</a>.</li>
  <li>Make a complaint to your owner via the in-app channel and to Olio under our <a href="/legal/complaints">Complaints Policy</a>.</li>
  <li>Refer unresolved disputes to the EU Online Dispute Resolution platform at <a href="https://ec.europa.eu/consumers/odr" rel="noopener noreferrer">ec.europa.eu/consumers/odr</a> or to the Cyprus Consumer Protection Service.</li>
</ul>

<h3>9. Disputes with your owner</h3>
<p>Olio is not a party to your tenancy. Disputes about rent amount, repairs, deposit, eviction, or tenancy terms must be resolved with your owner, and ultimately by the competent Cyprus court (or court of the jurisdiction where the property is located). We may, on request from a competent authority, produce platform records.</p>

<h3>10. Prohibited use</h3>
<p>You must comply with our <a href="/legal/aup">Acceptable Use Policy</a> and <a href="/legal/community-guidelines">Community Guidelines</a>. In particular, do not use Olio to harass an owner, neighbour or staff member, to commit fraud, or to upload content infringing another person's rights.</p>`,

  cookies: `<h2>Cookie Policy</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This Cookie Policy explains how Olio Wallet Ltd uses cookies and similar technologies on oliowallet.com, app.oliowallet.com and platform.oliowallet.com (together, the "<strong>Sites</strong>"). It is issued under Article 5(3) of the ePrivacy Directive (2002/58/EC) as implemented in Cyprus by the Law on the Regulation of Electronic Communications and Postal Services (Law 112(I)/2004) and Article 7 GDPR.</p>

<h3>1. What is a cookie?</h3>
<p>A cookie is a small text file stored on your device when you visit a website. "Similar technologies" include localStorage, sessionStorage, pixels, SDK identifiers and the OneSignal push subscription token. We refer to all of these as "cookies" below.</p>

<h3>2. Consent</h3>
<p>When you first visit, we show a cookie banner where you can accept all cookies or choose essential only; your choice is stored on your device and you can change it at any time via the "Cookie preferences" link in the footer. Strictly-necessary items (such as your sign-in token) are exempt from consent under Article 5(3) of the ePrivacy Directive and are always active. We do not run third-party advertising or analytics cookies; functional items (such as your light/dark theme preference) are set only with your consent or when you choose them. We will ask for renewed consent before introducing any new non-essential cookies.</p>

<h3>3. Categories of cookies</h3>
<table>
  <tr><th>Category</th><th>Purpose</th><th>Legal basis</th><th>Examples</th></tr>
  <tr>
    <td><strong>Strictly necessary</strong></td>
    <td>Authentication, session keep-alive, security tokens, and load balancing.</td>
    <td>ePrivacy Art. 5(3) exemption (strictly necessary for the requested service)</td>
    <td>Firebase Authentication sign-in token; your cookie-consent choice.</td>
  </tr>
  <tr>
    <td><strong>Functional</strong></td>
    <td>Remember your display preference (light/dark theme).</td>
    <td>Consent</td>
    <td>Theme preference stored in localStorage.</td>
  </tr>
  <tr>
    <td><strong>Analytics</strong></td>
    <td>Aggregated usage metrics to improve the product.</td>
    <td>Consent</td>
    <td>Not currently used — Olio does not operate first-party or third-party analytics at this time.</td>
  </tr>
  <tr>
    <td><strong>Marketing</strong></td>
    <td>Email open/click tracking pixels (Resend) when you click a link in a marketing email.</td>
    <td>Consent (and ePrivacy soft opt-in where applicable)</td>
    <td>Resend tracking pixel.</td>
  </tr>
  <tr>
    <td><strong>Push notifications</strong></td>
    <td>Deliver in-app and browser push notifications.</td>
    <td>Browser-level consent + GDPR Art. 6(1)(a)</td>
    <td>OneSignal subscription token.</td>
  </tr>
</table>

<h3>4. Retention</h3>
<p>Session storage is cleared when you close your browser. Persistent items have lifetimes ranging from 24 hours to 12 months; you can clear them at any time through your browser's site-data controls.</p>

<h3>5. Withdrawing consent</h3>
<p>You can withdraw consent for any non-essential processing at any time — re-open the cookie banner via the "Cookie preferences" link in the footer to change your choice. Withdrawal does not affect the lawfulness of processing carried out beforehand. To remove locally-stored items such as your theme preference or sign-in token, clear your browser's site data for the relevant Olio domain. You can turn push notifications on or off from <em>Settings → Notifications</em> (or in your browser), and opt out of marketing emails using the unsubscribe link in any marketing email.</p>

<h3>6. Do Not Track</h3>
<p>Our Sites do not respond to "Do Not Track" browser signals because there is no common interpretation under EU law. To control optional processing, use the cookie banner (re-open via "Cookie preferences" in the footer), the push-notification toggle in <em>Settings → Notifications</em>, the unsubscribe link in marketing emails, or your browser's site-data controls.</p>

<h3>7. Third parties</h3>
<p>Cookies and similar identifiers set by third parties are governed by their own privacy notices. Our <a href="/legal/subprocessors">Subprocessors</a> page lists each provider.</p>`,

  aup: `<h2>Acceptable Use Policy</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This Acceptable Use Policy ("<strong>AUP</strong>") is part of the <a href="/legal/terms">Terms of Use</a> and is published to satisfy the transparency requirements of Article 14 of the EU Digital Services Act (Reg. 2022/2065).</p>

<h3>1. Prohibited content and conduct</h3>
<p>You must not use Olio to upload, store, transmit, generate or otherwise make available content, or carry out conduct, that:</p>
<ul>
  <li>infringes another person's intellectual-property, image, name or privacy rights;</li>
  <li>is unlawful, defamatory, threatening, harassing, hateful or discriminatory (including content prohibited by the EU Framework Decision 2008/913/JHA on racism and xenophobia);</li>
  <li>sexually exploits or endangers a minor (any such content will be reported to law enforcement);</li>
  <li>promotes terrorism (Reg. 2021/784 on terrorist content online);</li>
  <li>constitutes fraud, money laundering, sanctions evasion or tax evasion;</li>
  <li>misrepresents a property, unit, rent, occupancy status, or your identity;</li>
  <li>circumvents tenancy law (e.g. fictitious tenancies to avoid the Cyprus Rent Control Law, sham agreements, unlicensed short-term lets);</li>
  <li>installs malware, scrapes the platform, probes its security, or circumvents technical restrictions;</li>
  <li>creates fake accounts, impersonates another person, or aggregates platform data without authorisation;</li>
  <li>sends unsolicited marketing in breach of the ePrivacy Directive or local spam law;</li>
  <li>contains adult content not relevant to a property listing;</li>
  <li>discriminates against a tenant or applicant on a protected ground (see <a href="/legal/owner-terms">Owner Terms §4</a>);</li>
  <li>otherwise breaches applicable law in your jurisdiction or the jurisdiction of the property.</li>
</ul>

<h3>2. Use of the AI assistant (AskOlio)</h3>
<p>You must not use AskOlio to generate (a) content that breaches this AUP, (b) advice intended to circumvent tenancy or tax law, (c) deepfakes or impersonations, or (d) outputs sold or republished as professional legal, tax or financial advice.</p>

<h3>3. Reporting</h3>
<p>If you encounter content or conduct that breaches this AUP, report it by email to <strong>trust@oliowallet.com</strong>, or follow the procedure in our <a href="/legal/notice-takedown">Illegal Content / Notice &amp; Takedown</a> page.</p>

<h3>4. Enforcement</h3>
<p>Where we identify a breach, we may, depending on its nature and severity: (a) remove the content; (b) restrict visibility of a listing; (c) demote or suspend account features; (d) require remediation (e.g. corrected listing details, additional ID); (e) suspend or terminate the account; (f) refer the matter to competent authorities. We aim to apply measures proportionately and to give notice of the reason and an opportunity to appeal where practicable, in line with Article 17 DSA. Our internal complaint-handling process is set out in <a href="/legal/complaints">Complaints &amp; Dispute Resolution</a>.</p>

<h3>5. Repeat breaches</h3>
<p>Accounts that repeatedly breach this AUP — particularly listings that repeatedly mislead or discriminate, or accounts repeatedly used for fraud — will be permanently terminated.</p>`,

  dpa: `<h2>Data Processing Agreement</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This Data Processing Agreement ("<strong>DPA</strong>") supplements the <a href="/legal/terms">Terms of Use</a> and the <a href="/legal/owner-terms">Owner Terms</a>, and forms part of the contract between Olio Wallet Ltd ("<strong>Processor</strong>") and you as a property owner or portfolio manager using Olio to process personal data about tenants, applicants, household occupants or other natural persons ("<strong>Controller</strong>"). It is concluded under Article 28 of the GDPR (Reg. 2016/679) and is binding from the moment you enter personal data of any third party into the Olio platform.</p>

<h3>1. Subject-matter, duration and purpose</h3>
<p>Olio processes personal data on the Controller's behalf solely to provide the contracted services: property and unit management, tenancy onboarding, document storage, in-app messaging, payment-rail integration with Stripe, analytics, notifications, and AI-assisted productivity. Processing continues for as long as the Controller maintains an active account or until the data is deleted in accordance with this DPA.</p>

<h3>2. Nature of personal data and categories of data subjects</h3>
<p><strong>Data subjects:</strong> the Controller's tenants, applicants, co-occupants, contractors and counterparties. <strong>Categories of data:</strong> name, contact details, identification documents and proof-of-address where uploaded, lease and rent records, communications with the Controller, payment metadata held by Stripe on the Controller's behalf, and any other personal data the Controller chooses to enter.</p>

<h3>3. Processor obligations</h3>
<ol>
  <li>Process personal data only on documented instructions from the Controller, including with regard to transfers outside the EEA. The Controller's instructions are constituted by these terms, the platform settings, and any further written instruction.</li>
  <li>Ensure persons authorised to process personal data are bound by confidentiality.</li>
  <li>Implement and maintain appropriate technical and organisational measures (Art. 32 GDPR). The current measures are described in our <a href="/legal/security">Security &amp; Incident Response</a> page and include encryption in transit (TLS 1.2+) and at rest, role-based access control, audit logging, least-privilege engineering access, and vendor risk reviews.</li>
  <li>Engage subprocessors only under written terms imposing the same obligations as in this DPA. The current list is at <a href="/legal/subprocessors">/legal/subprocessors</a>. We provide at least 30 days' notice of new subprocessors via that page; the Controller may object on reasonable, GDPR-related grounds, in which case the parties will seek an alternative or the Controller may terminate.</li>
  <li>Assist the Controller, taking into account the nature of processing, in fulfilling its obligation to respond to data-subject requests (Arts. 12–22) and its obligations under Arts. 32–36 (security, breach notification, DPIA, prior consultation).</li>
  <li>Notify the Controller without undue delay, and in any event within 48 hours, after becoming aware of a personal data breach, providing the information required by Art. 33(3) to the extent then known.</li>
  <li>At the Controller's choice, delete or return all personal data after the end of the services and delete existing copies, unless EU or Member State law requires storage.</li>
  <li>Make available to the Controller all information necessary to demonstrate compliance with Art. 28, and contribute to audits, including inspections, conducted by the Controller or another auditor mandated by it. Audit requests must be reasonable in scope and frequency; we may charge a reasonable fee for resource-intensive audits.</li>
</ol>

<h3>4. International transfers</h3>
<p>Where personal data is transferred outside the EEA, Olio relies on the Commission's Standard Contractual Clauses (Implementing Decision 2021/914), supplementary measures where required by the Schrems II ruling, and adequacy decisions where they apply. The Controller is deemed to be the data exporter; Olio acts as importer where relevant.</p>

<h3>5. Liability and indemnity</h3>
<p>Each party is liable under the GDPR for damage caused by processing where it has not complied with its obligations. As between Olio and the Controller, liability is allocated in proportion to fault. The limitation of liability in the <a href="/legal/terms">Terms of Use</a> applies, except that statutory liability for damage caused to data subjects under Art. 82 GDPR cannot be excluded.</p>

<h3>6. Term</h3>
<p>This DPA enters into force when the Controller first enters tenancy data on the platform and terminates with the closure of the Controller's account, subject to surviving obligations on confidentiality, return/deletion, and statutory retention.</p>`,

  subprocessors: `<h2>Subprocessors</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>The table below lists the third parties that process personal data on Olio's behalf as subprocessors under our <a href="/legal/dpa">Data Processing Agreement</a> and the GDPR. We give at least 30 days' notice of changes on this page so controllers can exercise their right to object on reasonable GDPR-related grounds.</p>

<table>
  <tr>
    <th>Subprocessor</th>
    <th>Service</th>
    <th>Data categories</th>
    <th>Region</th>
    <th>Transfer mechanism (if outside EEA)</th>
  </tr>
  <tr>
    <td>Google Cloud / Firebase (Google Ireland Ltd)</td>
    <td>Hosting, authentication, Firestore database, file storage</td>
    <td>Account data, content, logs, files</td>
    <td>EU (europe-west1) primary; some Google control-plane services US</td>
    <td>SCCs (2021/914) + EU-US DPF where applicable</td>
  </tr>
  <tr>
    <td>Stripe Payments Europe, Ltd.</td>
    <td>Card processing, Connect payouts, subscriptions, fraud signals (Radar)</td>
    <td>Payment tokens, billing details, payout details, KYC/AML data</td>
    <td>Ireland (EEA); US for global services</td>
    <td>SCCs + EU-US DPF</td>
  </tr>
  <tr>
    <td>OpenAI Ireland Ltd</td>
    <td>AskOlio language-model API</td>
    <td>Prompt text + attached context</td>
    <td>EEA + US</td>
    <td>SCCs + EU-US DPF; zero-retention API mode where available</td>
  </tr>
  <tr>
    <td>Resend Inc.</td>
    <td>Transactional and marketing email delivery</td>
    <td>Email address, name, message content, delivery metrics</td>
    <td>US</td>
    <td>SCCs + EU-US DPF</td>
  </tr>
  <tr>
    <td>OneSignal Inc.</td>
    <td>Push and in-app notifications</td>
    <td>Device push token, notification payload, engagement events</td>
    <td>US</td>
    <td>SCCs + EU-US DPF</td>
  </tr>
  <tr>
    <td>OpenStreetMap Foundation (Nominatim)</td>
    <td>Address and city search (geocoding)</td>
    <td>IP address, search query text</td>
    <td>EEA / United Kingdom</td>
    <td>UK adequacy decision; within EEA otherwise</td>
  </tr>
  <tr>
    <td>CARTO (CartoDB)</td>
    <td>Map basemap tiles</td>
    <td>IP address, coordinates of the map area viewed</td>
    <td>EU / US</td>
    <td>SCCs</td>
  </tr>
  <tr>
    <td>Cloudflare, Inc.</td>
    <td>DNS &amp; TLS for our domains; public CDN (cdnjs) for map marker assets</td>
    <td>IP address, request metadata</td>
    <td>Global edge; data subject to Cloudflare's EU Data Localisation Suite where enabled</td>
    <td>SCCs + EU-US DPF</td>
  </tr>
</table>

<p>Each subprocessor is bound by written terms requiring at least the level of data protection set out in our DPA. A copy of the applicable transfer mechanism for any subprocessor is available on request at <strong>privacy@oliowallet.com</strong>.</p>

<h3>How to object to a new subprocessor</h3>
<p>Controllers may object on reasonable, GDPR-related grounds within 30 days of notice posted on this page by writing to <strong>privacy@oliowallet.com</strong>. We will seek a workaround; if none is possible, the Controller may terminate the affected service without penalty.</p>`,

  "ai-terms": `<h2>AI Terms &amp; Transparency Notice (AskOlio)</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This page describes the AI-assisted features of Olio, including "AskOlio". It is issued to satisfy the transparency obligations of Article 50 of the EU AI Act (Reg. 2024/1689) and to ensure that you can use AI features safely and lawfully.</p>

<h3>1. What AskOlio is</h3>
<p>AskOlio is an in-product assistant that uses third-party large language models (currently provided by OpenAI Ireland Ltd) to answer your questions about your portfolio, draft messages and summaries, and help you navigate the platform. It is a general-purpose AI system used within the Olio service; it is not a high-risk AI system under Annex III of the AI Act and is not used for biometric identification, employment, education, credit, or law enforcement decisions.</p>

<h3>2. You are interacting with an AI</h3>
<p>AskOlio responses are clearly labelled as AI-generated. AI output may be inaccurate, incomplete, biased or out of date. <strong>AskOlio is not your lawyer, accountant, real-estate agent or financial adviser, and its output is not legal, tax, financial or real-estate advice.</strong> Verify anything material with a qualified professional before acting on it.</p>

<h3>3. What data we send</h3>
<p>When you submit a prompt, we send to the AI provider the text of your prompt plus the in-product context you authorise the assistant to consider (for example, the unit you have open). We do not send other users' personal data unless that data appears in content you choose to share with the model. We do not use AskOlio prompts to train third-party foundation models; we use the zero-retention API option where the provider offers it.</p>

<h3>4. Lawful basis and consent</h3>
<p>Processing prompts to return an answer is necessary for the performance of the service (Art. 6(1)(b) GDPR). We do not use your AskOlio prompts to train third-party foundation models. Were we to introduce optional uses — such as sharing anonymised prompts to improve the assistant — they would be based on your consent (Art. 6(1)(a)) and withdrawable at any time; no such programme currently operates.</p>

<h3>5. Permitted uses</h3>
<p>You may use AskOlio for: portfolio summaries, drafting messages, explaining how the platform works, generating non-binding rent calculations, and similar productivity tasks. You may not use AskOlio for the conduct prohibited by our <a href="/legal/aup">AUP §2</a>, including generating tenancy or tax circumvention strategies, deepfakes, or content infringing third-party rights.</p>

<h3>6. Outputs you publish</h3>
<p>If you copy AskOlio output into messages to your tenants or counterparties, you are responsible for verifying its accuracy and for any consequences. Where the output could be mistaken for a human-authored statement of advice, you should disclose that it was AI-generated.</p>

<h3>7. Human oversight</h3>
<p>AskOlio is an optional assistant: you choose when to use it, and its availability depends on your plan. Olio engineers monitor for systemic failures (e.g. hallucinations, prompt-injection abuse) and may temporarily disable the assistant if safety requires.</p>

<h3>8. Logging and review</h3>
<p>We log prompts and outputs for security, abuse monitoring and dispute resolution. Logs are retained for up to 12 months and accessible only to a limited engineering and trust-and-safety team under role-based access control.</p>

<h3>9. Synthetic content</h3>
<p>Where AskOlio produces image, audio or video content, we follow Art. 50(2) AI Act and mark it as synthetic. Today AskOlio outputs text only.</p>

<h3>10. Reporting AI harms</h3>
<p>If you believe an AskOlio output caused or could cause harm, report it to <strong>ai-safety@oliowallet.com</strong>.</p>`,

  "payments-terms": `<h2>Payments, Refunds &amp; Subscription Terms</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>These Payments Terms govern (a) the subscriptions you purchase from Olio Wallet Ltd, and (b) the rent and other tenant-to-owner payments processed through Olio. They are issued in accordance with the Consumer Rights Directive 2011/83/EU (as amended), the Unfair Contract Terms Directive 93/13/EEC, the Payment Services Directive (PSD2 — Dir. 2015/2366) as implemented in Cyprus by Law 31(I)/2018, and the Cyprus Sale of Goods Law (Cap. 267) as it applies to digital services.</p>

<h3>1. Who provides what</h3>
<p>Olio sells subscriptions to its software-as-a-service platform. <strong>Olio is not a payment institution and does not hold client funds.</strong> Card processing, Connect payouts to owners, and the rent flow itself are provided by Stripe Payments Europe, Ltd., authorised by the Central Bank of Ireland. Subscriptions are billed by Stripe under the Olio merchant account.</p>

<h3>2. Subscription plans</h3>
<p>Plan tiers (Starter, Growth, Pro, Business), feature gates and unit caps are shown in the in-app plan picker (open your profile and choose <em>Upgrade</em>) and at <a href="https://oliowallet.com/pricing">oliowallet.com/pricing</a>. Plans renew automatically each billing cycle until cancelled.</p>

<h3>3. Prices and taxes</h3>
<p>Prices are shown in euro (EUR) and include VAT where applicable. For business customers, valid VAT identification triggers a reverse-charge invoice under the EU VAT rules. Olio reserves the right to update pricing on at least 30 days' notice; price changes apply at the next renewal.</p>

<h3>4. Right of withdrawal (consumers)</h3>
<p>If you are a consumer resident in the EU, you have a 14-day right of withdrawal from the contract for a paid subscription (Art. 9 Consumer Rights Directive). To exercise it, contact <strong>billing@oliowallet.com</strong> within 14 days of purchase. <strong>By starting to use a paid feature within the 14-day window you expressly request immediate performance and acknowledge that you lose the right of withdrawal once the service is fully performed.</strong> If you withdraw before full performance, we will refund the proportional amount unused.</p>

<h3>5. Cancellation and refunds — subscriptions</h3>
<p>You can cancel at any time from the plan screen (open your profile and choose <em>Upgrade → Manage billing</em>), which opens our payment provider's secure billing portal. Cancellation takes effect at the end of the current billing cycle; we do not give pro-rated refunds for the unused part of a paid period, except (a) where the law requires, or (b) where Olio is in material breach unresolved for 30 days after notice.</p>

<h3>6. Failed and disputed subscription charges</h3>
<p>If a subscription charge fails, our payment provider (Stripe) will automatically retry it according to its standard schedule. If the charge remains unpaid, the subscription lapses and the account reverts to Starter, pausing premium features until billing is restored. You may dispute a charge with your card issuer (chargeback); fraudulent chargebacks may lead to account suspension.</p>

<h3>7. Rent and tenant-to-owner payments</h3>
<p>Where an owner has enabled in-platform rent collection, the tenant authorises Stripe to debit the chosen method and remit the amount, less Stripe processing fees and any Olio platform fee, to the owner's Stripe Connected Account. Strong Customer Authentication (PSD2 Art. 97) applies where required.</p>
<ul>
  <li><strong>Authorisation:</strong> the tenant authorises each rent payment individually; payments are taken one-off through our payment provider's checkout, and there is no stored card-on-file or recurring direct-debit mandate.</li>
  <li><strong>Receipts:</strong> each successful payment is recorded and visible in the tenant and owner dashboards; card-payment receipts are issued by Stripe.</li>
  <li><strong>Refunds:</strong> refunds and reversals between owner and tenant are at the owner's discretion. Olio can facilitate refunds initiated by the owner via Stripe; we will not unilaterally refund tenants except where required by law or by a chargeback decision.</li>
  <li><strong>Chargebacks:</strong> if a tenant initiates a chargeback, Stripe will handle the dispute; the owner is responsible for substantiating the charge.</li>
  <li><strong>Late payments:</strong> Olio does not impose late fees. Any late-payment terms are between owner and tenant under the tenancy contract and applicable law (e.g. Cyprus Rent Control Law Cap. 23 for protected tenancies).</li>
</ul>

<h3>8. Platform fees</h3>
<p>Olio may charge a platform fee on rent transactions, disclosed to the owner before they enable in-platform collection and shown on every transaction. The fee that applies to your plan is displayed during payout setup.</p>

<h3>9. Currency and FX</h3>
<p>Payments are processed in euro. If the underlying payment method is denominated in another currency, the issuer's FX rate and fees apply.</p>

<h3>10. Statutory consumer protections</h3>
<p>Nothing in these Payments Terms limits a consumer's mandatory rights under EU law or Cyprus law, including the right to conformity remedies under Directive (EU) 2019/770 on digital content and digital services, the right to lodge a complaint with the Cyprus Consumer Protection Service, and the right to use the EU ODR platform at <a href="https://ec.europa.eu/consumers/odr" rel="noopener noreferrer">ec.europa.eu/consumers/odr</a>.</p>`,

  "aml-kyc": `<h2>Anti-Money Laundering &amp; KYC Notice</h2>
<p><em>Last updated: May 21, 2026</em></p>

<p>This page explains how Olio Wallet Ltd ("<strong>Olio</strong>") and our payment partner Stripe Payments Europe, Ltd. ("<strong>Stripe</strong>") implement anti-money laundering ("<strong>AML</strong>"), counter-terrorism financing ("<strong>CTF</strong>") and "Know Your Customer" ("<strong>KYC</strong>") obligations.</p>

<h3>1. Legal framework</h3>
<p>The platform operates in compliance with the Cyprus Prevention and Suppression of Money Laundering and Terrorist Financing Law 188(I)/2007 (as amended) and the EU AML directives, including the 5th AML Directive (Reg. 2018/843) and the 6th AML Directive (Reg. 2018/1673), as well as the EU AML Authority Regulation (Reg. 2024/1620).</p>

<h3>2. Olio's role</h3>
<p>Olio is not itself a financial or payment institution. Card processing, Connect onboarding and payouts are handled by Stripe, which is authorised by the Central Bank of Ireland and is the obliged entity for AML/CTF purposes on the payment rail. Olio assists Stripe by collecting business details, sanctions screening signals, and adverse-media flags where required.</p>

<h3>3. KYC for property owners</h3>
<p>Before activating in-platform rent collection, an owner must complete Stripe Connect onboarding. Stripe will collect, depending on entity type and volume:</p>
<ul>
  <li>full legal name, date of birth, residential address, nationality, and a government-issued ID for the owner and any ultimate beneficial owner (≥25% threshold);</li>
  <li>company registration number, registered address, and structure for company owners;</li>
  <li>tax identification number;</li>
  <li>bank account details for payouts.</li>
</ul>
<p>Stripe retains KYC documents for at least 5 years after the end of the relationship in line with Art. 68 Law 188(I)/2007.</p>

<h3>4. Sanctions screening</h3>
<p>Owners and beneficial owners are screened against EU consolidated sanctions, UN sanctions and OFAC lists. Olio and Stripe may refuse onboarding or suspend payouts if a screening hit is unresolved.</p>

<h3>5. Tenant payments</h3>
<p>Tenant payments are processed under PSD2 strong customer authentication. Stripe applies risk-based monitoring; Olio does not perform KYC on tenants unless required by a competent authority or by Stripe escalation.</p>

<h3>6. Suspicious activity reporting</h3>
<p>If Olio or Stripe forms a reasonable suspicion of money laundering, terrorism financing, sanctions evasion or other financial crime, a report will be filed with MOKAS (the Cyprus Unit for Combating Money Laundering) or the equivalent authority in another Member State, and we may freeze the relevant account pending investigation. We will not, by law, disclose the existence of such a report (tipping-off prohibition, Art. 48 Law 188(I)/2007).</p>

<h3>7. Refusals and de-banking</h3>
<p>Stripe or Olio may decline onboarding, request additional documentation, or terminate a payments relationship where AML/CTF risk cannot be adequately managed. We aim to provide reasons where lawfully permissible, but in some cases the law restricts what we can disclose.</p>

<h3>8. Data retention</h3>
<p>AML/KYC documents are retained by Stripe for 5 years after the end of the business relationship. Olio holds only minimal references (e.g. Stripe account ID, status).</p>`,

  "community-guidelines": `<h2>Community Guidelines</h2>
<p><em>Last updated: May 21, 2026</em></p>

<p>Olio is used by owners and tenants to manage real-world tenancies. Tone and accuracy matter. These Community Guidelines explain what we expect of every user and complement the <a href="/legal/aup">Acceptable Use Policy</a>.</p>

<h3>1. Be honest about properties and units</h3>
<p>Owners: post truthful photos, accurate floor area, accurate rent, and material defects (damp, planning restrictions, short-let licensing status). Misleading listings breach the Unfair Commercial Practices Directive and our AUP.</p>

<h3>2. Be honest in onboarding</h3>
<p>Tenants: provide genuine identification documents and proof of address. Submitting forged documents may be a criminal offence and will result in account termination.</p>

<h3>3. Respect each other</h3>
<p>No harassment, threats, hate speech, discrimination, stalking, or attempts to intimidate. This applies to messages between owners and tenants and to any review or feedback you post.</p>

<h3>4. No discrimination</h3>
<p>Refusing a tenancy, charging a different rent, or treating someone less favourably on the basis of race, ethnic or national origin, religion or belief, disability, age, sexual orientation, gender or gender identity, family status, pregnancy or maternity, or any other characteristic protected by EU or Cyprus law (Law 42(I)/2004; Law 58(I)/2004), is prohibited.</p>

<h3>5. Protect privacy</h3>
<p>Do not share another person's personal data, ID document, financial information or location without their consent. Do not record calls or screenshots and publish them without consent.</p>

<h3>6. Use AskOlio responsibly</h3>
<p>AskOlio is for productivity, not for evading the law. Do not use it to generate threatening messages, defamatory reviews, or content that would breach the AUP if you wrote it yourself.</p>

<h3>7. Keep platform safe</h3>
<p>Do not probe, scan or attempt to break Olio's security. Report vulnerabilities to <strong>security@oliowallet.com</strong>; we operate a responsible-disclosure programme described in our <a href="/legal/security">Security policy</a>.</p>

<h3>8. Enforcement</h3>
<p>Breaches are handled under the AUP §4 (proportionate measures, notice, and the right to appeal). Severe or repeated breaches lead to termination.</p>`,

  "notice-takedown": `<h2>Illegal Content — Notice &amp; Takedown</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This page sets out how to notify Olio of illegal content under Article 16 of the EU Digital Services Act (Reg. 2022/2065) and how we will handle your notice.</p>

<h3>1. Who can file a notice</h3>
<p>Anyone — user or non-user — can file a notice. Trusted flaggers awarded that status by the Cyprus Digital Services Coordinator under DSA Art. 22 are given priority.</p>

<h3>2. What to include</h3>
<p>To enable us to act, your notice should contain:</p>
<ul>
  <li>a sufficiently substantiated explanation of why the content or activity is illegal under EU law or the law of a Member State;</li>
  <li>a clear indication of the exact electronic location of the content (URL, listing ID, message ID, screenshots);</li>
  <li>your name and email address (anonymous notices are accepted for content that may constitute a criminal offence against a minor);</li>
  <li>a statement confirming your good-faith belief that the information is accurate and complete.</li>
</ul>

<h3>3. How to file</h3>
<ul>
  <li>By email: <strong>trust@oliowallet.com</strong>.</li>
  <li>By post: Olio Wallet Ltd, Trust &amp; Safety, Nicosia, Cyprus.</li>
</ul>

<h3>4. Our process</h3>
<p>We acknowledge receipt of every notice and assess it timely and diligently (DSA Art. 16(6)). We may:</p>
<ul>
  <li>leave the content in place where the notice is unfounded;</li>
  <li>restrict visibility (e.g. demote, geo-fence);</li>
  <li>remove or disable access to the content;</li>
  <li>suspend or terminate the account that posted it;</li>
  <li>notify law enforcement where the content suggests a serious criminal offence threatening the life or safety of persons (DSA Art. 18).</li>
</ul>
<p>We notify the user who posted the content of the decision and the reasons, and we notify the complainant of the outcome. Both parties have the right to appeal through our <a href="/legal/complaints">Complaints &amp; Dispute Resolution</a> process and to seek out-of-court dispute settlement under DSA Art. 21.</p>

<h3>5. Bad-faith notices</h3>
<p>Submitting manifestly unfounded notices or counter-notices in bad faith may lead to restrictions on your ability to use the reporting channel (DSA Art. 23).</p>

<h3>6. Statement of reasons</h3>
<p>Where we restrict or remove content for any reason — illegal content, AUP breach, or platform safety — we provide a statement of reasons that meets DSA Art. 17 (the legal or contractual ground relied on, the territorial scope, the duration, and the redress available).</p>

<h3>7. Mandatory data-retention orders</h3>
<p>Where a competent EU/EEA authority issues an order to act against illegal content (DSA Art. 9) or to provide information (DSA Art. 10), we comply within the legally required period and inform affected users where permitted.</p>`,

  complaints: `<h2>Complaints &amp; Dispute Resolution</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>We take complaints seriously. This page explains how to make one and how we resolve it. Consumer rights granted by EU and Cyprus law to use out-of-court bodies and the courts are not affected.</p>

<h3>1. First contact</h3>
<p>Email <strong>support@oliowallet.com</strong> with: (a) what happened, (b) when, (c) the people, listings or transactions involved, and (d) what outcome you want. We confirm receipt within 2 business days.</p>

<h3>2. Investigation</h3>
<p>A complaint is reviewed by support, escalated to trust-and-safety, billing, privacy or engineering as appropriate. We aim to resolve within 14 days. Where a complaint is complex (multi-party tenancy dispute, payment investigation) we extend in 14-day blocks and inform you of the reason.</p>

<h3>3. Internal complaint-handling system (DSA Art. 20)</h3>
<p>For decisions to remove content, suspend listings, suspend accounts, or restrict your use of the platform, we operate a free internal complaint-handling system available for at least 6 months from the decision. To use it, email <strong>appeals@oliowallet.com</strong>. Appeals are reviewed by staff not involved in the original decision.</p>

<h3>4. Out-of-court dispute settlement (DSA Art. 21)</h3>
<p>If your appeal is unsuccessful, you may select a certified out-of-court dispute-settlement body in Cyprus or another Member State.</p>

<h3>5. Consumer ADR and ODR</h3>
<p>Where you act as a consumer:</p>
<ul>
  <li><strong>Cyprus Consumer Protection Service</strong> — Ministry of Energy, Commerce and Industry (<a href="https://meci.gov.cy" rel="noopener noreferrer">meci.gov.cy</a>).</li>
  <li><strong>EU Online Dispute Resolution platform</strong> — <a href="https://ec.europa.eu/consumers/odr" rel="noopener noreferrer">ec.europa.eu/consumers/odr</a>.</li>
  <li><strong>Certified ADR bodies</strong> under the ADR Directive 2013/11/EU.</li>
</ul>

<h3>6. Data protection complaints</h3>
<p>For data protection complaints, contact our DPO at <strong>dpo@oliowallet.com</strong> first, then the Office of the Commissioner for Personal Data Protection of the Republic of Cyprus (<a href="https://www.dataprotection.gov.cy" rel="noopener noreferrer">dataprotection.gov.cy</a>) or your local EU supervisory authority.</p>

<h3>7. Payments complaints</h3>
<p>For payment processing issues, contact us first. Unresolved complaints may be escalated to Stripe Payments Europe, Ltd. under PSD2 complaint-handling rules and ultimately to the Central Bank of Ireland, Stripe's home supervisor.</p>

<h3>8. Courts</h3>
<p>The District Courts of Nicosia, Cyprus, have jurisdiction over disputes against Olio, subject to mandatory consumer rights to bring proceedings in your country of residence. Tenancy disputes covered by Cap. 23 fall within the Cyprus Rent Control Court.</p>`,

  accessibility: `<h2>Accessibility Statement</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>Olio Wallet Ltd is committed to making its services accessible to as many people as possible. This statement is issued in accordance with the European Accessibility Act (Dir. (EU) 2019/882) as transposed in Cyprus and, where applicable, the Web Accessibility Directive (Dir. (EU) 2016/2102).</p>

<h3>1. Scope</h3>
<p>This statement applies to the websites oliowallet.com, app.oliowallet.com, and platform.oliowallet.com, and to the in-app experience delivered through those sites. Native mobile applications, when released, will be covered by separate statements.</p>

<h3>2. Compliance status</h3>
<p>Olio targets conformance with the Web Content Accessibility Guidelines (WCAG) 2.2 at Level AA, and aligns with the EN 301 549 standard referenced by the European Accessibility Act. We declare current conformance as <strong>partially compliant</strong>; known gaps are listed below.</p>

<h3>3. What we have done</h3>
<ul>
  <li>ARIA roles and accessible labels on interactive primitives such as dialogs, menus and form controls.</li>
  <li>Keyboard operability and visible focus indicators on interactive controls.</li>
  <li>A skip-to-content link and a single <code>main</code> landmark on every screen — the public marketing site and the tenant, owner and administrator applications — so keyboard and screen-reader users can bypass the navigation.</li>
  <li>Focus is moved to the main content region on each in-app navigation, so it is not stranded on the previous page.</li>
  <li>Modal dialogs — including the marketing site's mobile navigation menu — trap keyboard focus while open, close on the Escape key, hide the rest of the page from assistive technology, and return focus to the control that opened them when dismissed.</li>
  <li>A minimum 4.5:1 contrast target for body text, in both light and dark themes.</li>
  <li>Text that resizes without loss of content.</li>
  <li>Form controls with associated labels and descriptive error messages.</li>
</ul>

<h3>4. Known gaps</h3>
<ul>
  <li>Some PDFs uploaded by owners (leases, building plans) are not tagged for screen readers; we provide an in-app preview as an alternative.</li>
  <li>Map components rely on visual interaction; a list-view alternative is provided.</li>
  <li>Some legacy admin tables do not yet meet WCAG 2.2 in full; we are migrating them.</li>
</ul>

<h3>5. Feedback and contact</h3>
<p>If you encounter accessibility barriers, please contact <strong>accessibility@oliowallet.com</strong> with the page or screen and the difficulty you experienced. We respond within 7 days and aim to remediate within 30 days. If you are dissatisfied with our response, you may complain to the competent enforcement body in Cyprus.</p>

<h3>6. Enforcement and assistive procedures</h3>
<p>The European Accessibility Act is enforced in Cyprus by the Deputy Ministry of Research, Innovation and Digital Policy and the Department of Social Inclusion of Persons with Disabilities. Where a barrier amounts to discrimination, the Office of the Commissioner for Administration (Ombudsman) has jurisdiction under the Equal Treatment Law 42(I)/2004.</p>

<h3>7. Method of evaluation</h3>
<p>We assess accessibility through manual review during development. We are introducing automated accessibility testing (e.g. axe-core), structured screen-reader testing (NVDA, VoiceOver), and periodic third-party audits as part of our accessibility roadmap.</p>`,

  security: `<h2>Security &amp; Incident Response</h2>
<p><em>Last updated: June 17, 2026</em></p>

<p>This page describes the technical and organisational measures Olio Wallet Ltd applies to protect personal data (Art. 32 GDPR), and how we handle security incidents and personal data breaches (Arts. 33–34 GDPR).</p>

<h3>1. Architecture</h3>
<p>Olio runs on Google Cloud and Firebase. Data is hosted in the European Union: Firestore in an EU multi-region, with Cloud Functions and file storage in europe-west1 (Belgium). User data is encrypted in transit (TLS 1.2+) and at rest (Google's default AES-256 envelope encryption). File storage uses signed-URL gateways: clients never have direct write privileges to Cloud Storage.</p>

<h3>2. Access control</h3>
<p>Role-based access control with least-privilege engineering grants. Production data access is gated behind SSO with hardware-key MFA and is audit-logged. Customer-support staff access is scoped to the minimum necessary to resolve a ticket.</p>

<h3>3. Application security</h3>
<ul>
  <li>Admin-authored HTML is sanitised (DOMPurify) before it is rendered to any visitor, stripping scripts, event handlers and javascript: URLs.</li>
  <li>Cross-site request forgery defences on all state-changing endpoints.</li>
  <li>Content Security Policy and HTTP Strict Transport Security on all subdomains.</li>
  <li>Rate limiting on sensitive and authentication-adjacent endpoints; sign-in and sign-up are handled by Firebase Authentication.</li>
  <li>Dependency vulnerability scanning in CI; automated dependency upgrades.</li>
</ul>

<h3>4. Payment security</h3>
<p>Card data is handled by Stripe, which is PCI-DSS Level 1. Olio never sees full card numbers. Strong Customer Authentication (PSD2 Art. 97) is applied where required.</p>

<h3>5. Backups and continuity</h3>
<p>Production data is stored in Firestore (Google Cloud), encrypted at rest and replicated across a European multi-region. Point-in-time recovery (a 7-day continuous recovery window) and daily and weekly managed backups are enabled. Recently-deleted files in Cloud Storage are additionally recoverable for a limited window. Formal disaster-recovery drills remain part of our ongoing resilience programme.</p>

<h3>6. Personnel</h3>
<p>Engineering staff sign confidentiality undertakings, complete security and GDPR training on hire and annually thereafter, and lose access promptly upon offboarding.</p>

<h3>7. Vendor risk</h3>
<p>Subprocessors are reviewed before onboarding and re-reviewed annually. Each is bound by a written DPA. The list is published at <a href="/legal/subprocessors">/legal/subprocessors</a>.</p>

<h3>8. Incident response</h3>
<p>Our incident process covers identification, containment, eradication, recovery, and post-mortem. If a personal data breach is likely to result in a risk to data subjects, we notify the Cyprus Commissioner for Personal Data Protection within 72 hours (Art. 33 GDPR) and affected users without undue delay where the risk is high (Art. 34). Owners receive breach notifications for events affecting their tenancy data so they can fulfil their own obligations as controllers.</p>

<h3>9. Responsible disclosure</h3>
<p>If you believe you have discovered a vulnerability, email <strong>security@oliowallet.com</strong> with a description and reproduction steps. We will acknowledge within 2 business days, work with you on remediation, and credit you publicly (if you wish) once the issue is fixed. Please do not access data you are not entitled to, disrupt the service, or publish details before a fix is deployed.</p>`,

  "ip-policy": `<h2>Intellectual Property Policy</h2>
<p><em>Last updated: May 21, 2026</em></p>

<p>Olio respects intellectual-property rights. This policy explains how to report copyright, trademark, image and design infringement, and how we handle reports.</p>

<h3>1. Our rights</h3>
<p>The "Olio" name, the Olio wordmark, the Olio symbol, the user interface, the underlying source code and the structured content of the platform are owned by Olio Wallet Ltd or its licensors and are protected by Cyprus, EU and international intellectual-property law, including Directive (EU) 2019/790 on Copyright in the Digital Single Market.</p>

<h3>2. Your rights in your content</h3>
<p>You retain copyright and other intellectual-property rights in content you upload (photos, plans, documents, messages). You grant Olio the licence described in <a href="/legal/terms">Terms of Use §7</a> to host and process that content.</p>

<h3>3. Notice of infringement</h3>
<p>To notify us of infringement, send the following to <strong>ip@oliowallet.com</strong>:</p>
<ul>
  <li>your contact details (name, email, postal address);</li>
  <li>identification of the right you believe has been infringed (e.g. a copyrighted photograph, a registered trademark with its number);</li>
  <li>identification of the alleged infringing content (URL, listing ID);</li>
  <li>a statement of good-faith belief that the use is unauthorised and not protected by an exception (such as quotation, parody, or news reporting under Directive 2001/29/EC);</li>
  <li>a statement that the information is accurate and that, under penalty of perjury, you are authorised to act on behalf of the right-holder;</li>
  <li>your electronic signature.</li>
</ul>

<h3>4. Counter-notice</h3>
<p>If you believe your content was removed in error, send a counter-notice to the same address with the same content elements and an explanation of why your use is lawful (licence, fair quotation, exception). We may restore content if the original notifier does not pursue the matter in court within 14 days, in line with general EU intermediary-liability principles.</p>

<h3>5. Repeat infringers</h3>
<p>Accounts that repeatedly post infringing content may be suspended or terminated.</p>

<h3>6. Brand and press use</h3>
<p>You may refer to "Olio" or "Olio Wallet" in factual statements (e.g. press, integration documentation). You may not use our marks in a way that suggests endorsement, in a domain name, or in a manner that may confuse users. The brand guidelines are at <a href="https://oliowallet.com/brand">oliowallet.com/brand</a>.</p>`,
};
