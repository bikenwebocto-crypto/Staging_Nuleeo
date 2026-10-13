import { useMemo, useState } from "react";
import { Search, BookOpen, ChevronRight } from "lucide-react";
import { cn } from "@ui/lib/utils";

type Section = {
  key: string;
  label: string;
  blurb: string;
  groups: Group[];
};

type Group = {
  title: string;
  body: string;
  bullets?: string[];
  flow?: string[];
};

const SECTIONS: Section[] = [
  {
    key: "overview",
    label: "Overview",
    blurb: "How the three Olio subdomains fit together and where each persona lives.",
    groups: [
      {
        title: "Three subdomains",
        body: "Olio is split across three apps that share one Firebase backend.",
        bullets: [
          "oliowallet.com — public landing site. Marketing pages, pricing, sign-up entry point.",
          "app.oliowallet.com — the user app. Owners and tenants live here. Owners can also switch into a tenant view they belong to.",
          "platform.oliowallet.com — the admin app you are in right now. Used only by staff (admin / superadmin).",
        ],
      },
      {
        title: "Who sees what",
        body: "Roles drive the UI. A single user document can carry multiple roles.",
        bullets: [
          "tenant — lives in unit(s); pays rent; signs lease agreements.",
          "owner — runs one or more portfolios of properties; assigns access; collects rent.",
          "admin — staff who run the platform. Filtered by the privilege matrix.",
          "superadmin — full access to every privilege and every settings tab.",
        ],
      },
      {
        title: "Plans (owners)",
        body: "Four owner tiers. The internal keys (basic / advance / pro / business) are stable and never editable; the labels, descriptions, and unit caps are editable per-plan in Settings → Owner Plans (which also sets each plan's rent commission). Prices are FIXED in code and shown read-only — admins cannot change them. A user's current plan is read from the Stripe-derived stripeRole custom claim, never from the User document — no claim means the free Starter tier. See the Plans & Billing section for the full lifecycle.",
        bullets: [
          "Starter (basic) — free default tier. Default cap 2 properties; core features.",
          "Growth (advance) — paid Stripe product. Default cap 5; adds rent, documents, contracts, briefings, Ask Olio.",
          "Pro (pro) — paid Stripe product. Default cap 20; adds advanced analytics.",
          "Business (business) — sales-led; NO Stripe product. Default unlimited cap; granted as a complimentary plan, never bought self-serve.",
          "Pricing is yearly only and FIXED in code — not admin-editable (Starter free, Growth €69/yr, Pro €290/yr, Business custom quote). Per-plan commission lives in config/platformFees and defaults to 0% until an admin sets it.",
        ],
      },
    ],
  },
  {
    key: "plans-billing",
    label: "Plans & Billing",
    blurb:
      "How the four owner plans work end-to-end: where they are defined, how a user's plan is decided, and the real activate / cancel / upgrade / downgrade / comp-grant mechanics. Subscriptions are owned by the Firebase 'Run Payments with Stripe' extension, not by Olio's own API.",
    groups: [
      {
        title: "The four plans",
        body: "There are four owner plans. Their internal keys — basic, advance, pro, business — are hard-coded and never editable. Prices (the yearly price + the Growth→Pro upgrade price) are also FIXED in code and never admin-editable. Only the human-facing labels (default Starter / Growth / Pro / Business), descriptions, unit cap, and per-plan rent commission are editable, on Settings → Owner Plans.",
        bullets: [
          "Internal key → default label: basic → Starter, advance → Growth, pro → Pro, business → Business. The keys are stable; the labels are just display copy admins can change.",
          "Free / default tier is basic (Starter): yearly price 0, default unit cap 2. Anyone with no subscription lands here automatically.",
          "Yearly prices (EUR), FIXED in code (DEFAULT_PLAN_LABELS): Starter free, Growth 69, Pro 290, Business custom quote. Yearly amount only — there is no monthly tier. The public landing page renders it as '€<n>/yr' (showing 'Free' for 0 and 'Quote' for a custom plan); the in-app Pricing modal shows a derived '/mo' figure (yearly ÷ 12), 'Free', or 'Custom'. In both places the figure is the fixed code price, never a live Stripe price — the Stripe price is used only to start checkout, and is the authoritative charge for Growth / Pro.",
          "Default unit caps: Starter 2, Growth 5, Pro 20, Business unlimited. The cap actually counts PROPERTIES (one property = one billable 'unit' in the owner model — owner-created properties have no separate unit docs) and is enforced when an owner adds a property. The label and the over-cap error still say 'unit(s)'.",
          "Labels, descriptions, and unit cap live in the public-read Firestore doc config/planLabels (edited via PUT /api/admin/plan-labels). The yearly price and the Growth→Pro upgrade price are FIXED in code (DEFAULT_PLAN_LABELS): every reader overlays them via withFixedPlanPrices() and the PUT ignores any submitted price, so a stale or hand-edited doc can never change them. Button / CTA copy also lives there with shipped defaults but has no editor field in the UI. Per-plan commission lives in a SEPARATE doc config/platformFees (PUT /api/admin/platform-fees), edited on the same tab; it defaults to 0% for all tiers until an admin sets a rate.",
          "Only Growth and Pro are real Stripe products (provisioned with firebaseRole = advance / pro). Starter is free; Business is sales-led with NO Stripe product — it is granted directly as a complimentary plan.",
          "Editor location: Settings → Owner Plans (the link /admin/owner-plans redirects to /admin/settings?tab=Owner Plans). The same tab also hosts the owner-plan privilege matrix (which premium features each tier unlocks). The tab only renders with platform.viewSettings; saving labels / caps / commission needs platform.modifySettings (prices are fixed and read-only), while saving the privilege matrix is superadmin-only.",
        ],
      },
      {
        title: "How a plan is resolved",
        body: "A user's plan is read from the Firebase Auth stripeRole custom claim — NOT from a field on the User document. A missing or unknown claim resolves to basic everywhere. The Stripe Payments extension sets this claim on paid subscriptions; the admin comp-plan endpoint sets it directly for Business and free grants.",
        bullets: [
          "Client: usePlan() reads the stripeRole claim, defaulting to basic. It only updates on token refresh, so after checkout the app force-refreshes the ID token to show the new plan immediately.",
          "Server: resolveOwnerPlan() reads the same claim from the Auth user and validates it against basic / advance / pro / business, defaulting to basic on a missing, unknown, or errored claim.",
          "Per-portfolio, not per-caller: feature gates use the ACTIVE PORTFOLIO owner's plan. A manager or accountant invited into a paid owner's portfolio inherits that owner's tier (useActivePortfolioPlan on the client, hasOwnerPlanPrivilege on the server).",
          "Gating is enforced server-side, not just in the UI. Premium owner-plan features return 402 'Upgrade required' when the plan is too low; per-role portfolio reads return 403 — these are two separate checks.",
          "Unit caps come from config/planLabels, but the units.unlimited owner-plan privilege overrides any numeric cap — a tier that has that privilege (default: Business) is unlimited regardless of the configured number.",
        ],
      },
      {
        title: "Activate (first-time subscribe)",
        body: "First-time activation does NOT go through any Olio API endpoint — there is no /api/checkout/session. It uses the Firebase Stripe extension's Firestore handshake: the app writes a checkout-session request document, the extension fills in a Stripe Checkout URL, and the app redirects there. Only a move FROM Starter to a paid tier (Growth or Pro) goes through Checkout.",
        flow: [
          "Owner picks a paid tier in the Pricing modal (opened from the profile drawer's Upgrade button or a paywall). Only the portfolio owner can do this; granted contacts see it read-only.",
          "The app writes a document to customers/{uid}/checkout_sessions (price, success and cancel URLs, promo codes allowed) and watches it for up to 30 seconds.",
          "The Firebase Stripe Payments extension creates the Stripe Checkout Session and writes a url back onto that document; the app redirects the owner to it.",
          "The owner completes payment on Stripe's hosted page.",
          "The EXTENSION (via its own Stripe webhook) sets the stripeRole custom claim from the Stripe product's firebaseRole metadata (advance or pro). Olio's own /api/webhooks/stripe handler does NOT set this claim.",
          "The owner returns to ?checkout=success; CheckoutReturnHandler force-refreshes the Firebase ID token so the new plan appears immediately, then strips the query param so a reload doesn't re-trigger it.",
        ],
      },
      {
        title: "Cancel",
        body: "Cancellation happens entirely in the Stripe-hosted Customer Portal — there is no Olio cancel endpoint. The app opens the portal via the extension's createPortalLink callable and the owner cancels there. Cancellation is NOT immediate.",
        flow: [
          "Owner opens the Pricing modal and chooses to manage or cancel. Any existing paid subscriber is routed to the portal (including a downgrade back to Starter).",
          "The app calls the extension callable ext-firestore-stripe-payments-createPortalLink and redirects to the returned Stripe Customer Portal URL.",
          "The owner cancels in the portal. Stripe sets cancel_at_period_end — the subscription STAYS active (and the plan stays paid) until the paid period ends. Plans are annual, so this can be up to a year away.",
          "At period end the extension removes or changes the stripeRole claim. usePlan() then sees no claim and falls back to basic (Starter) automatically — no Olio code resets the claim.",
          "Reactivation is possible before period end via the same Customer Portal, since the subscription is still active until that boundary.",
        ],
      },
      {
        title: "Upgrade (move up a tier)",
        body: "Moving up while already on a paid plan also goes through the Stripe Customer Portal (not Checkout, and not any Olio route). Only a first subscription from free Starter uses Checkout. Proration and timing are configured in Stripe, not in Olio.",
        flow: [
          "Owner picks the higher tier in the Pricing modal. From Starter (no paid sub) this is the Checkout path; already-paid owners go to the Customer Portal.",
          "The subscription-item swap happens on Stripe's hosted surface; proration (e.g. charging the difference immediately) is whatever the Stripe dashboard is configured to do — there is no proration logic in Olio.",
          "The extension updates the stripeRole claim to the new tier.",
          "Upgrades take effect immediately once the claim flips — Olio adds no delay or cleanup on an upgrade (the downgrade reconcile explicitly does nothing on an upgrade or a lateral move). The owner force-refreshes their token on return, or picks up the change on the next token refresh.",
          "Upgrading to Business is the exception: it is sales-led (opens an email to support), not self-serve, and is granted as a complimentary plan.",
        ],
      },
      {
        title: "Downgrade (move down a tier)",
        body: "Downgrading also runs through the Stripe Customer Portal. The important part is the SIDE EFFECTS Olio runs after a real tier drop — these are destructive, and they fire at the renewal / period boundary, not the moment the owner clicks downgrade.",
        flow: [
          "Owner picks a lower tier (or Starter) in the Pricing modal → routed to the Stripe Customer Portal to make the change.",
          "Because plans are annual, Stripe enacts the lower plan at renewal and then fires customer.subscription.updated; Olio's webhook reconcile acts only when the subscription's PRODUCT actually changed (a real tier drop), not on a plain cancel toggle.",
          "On a real drop, reconcileAfterPlanChange enforces the new unit cap by HARD-DELETING excess properties to fit (vacant first, newest-first, then occupied) — this cascades to units, documents, tenants, agreements, and storage photos. Over-cap data is deleted, not hidden.",
          "If the new lower plan loses the rent.collectStripe privilege, ALL active agreements for the owner are terminated and those tenancies expired, with push notifications to the tenants and owner — independent of any property deletion.",
          "Going forward, the new cap is enforced when ADDING properties: POST /api/properties returns 402 if the owner is at or over cap (re-checked inside a transaction to prevent races). Property transfers re-check the recipient's cap too.",
        ],
      },
      {
        title: "Complimentary & admin grants",
        body: "Complimentary plans are a free, Stripe-free perk. The sidebar's Complimentary Advance / Complimentary PRO actions both call POST /api/admin/users/:id/comp-plan, which writes the stripeRole claim directly — no Stripe subscription, product, or price is created. Admins cannot otherwise set a plan when inviting or editing a user; paid plans are managed in the Stripe dashboard.",
        bullets: [
          "Grant: POST /api/admin/users/:id/comp-plan with plan = advance, pro, or business. It sets the stripeRole claim, auto-promotes the user to the owner role if needed (revoking refresh tokens so it takes effect), and saves an audit doc in complimentaryPlans with a 12-month expiry. Gated by admin / superadmin + users.assignRoles.",
          "Business (sales-led, no Stripe product) can ONLY become active via a comp grant. The desktop sidebar exposes Advance and PRO only; a Business comp is reachable via the API but not surfaced in the create menu.",
          "Refused (409) if the user already has an active or trialing real subscription — checked against the Stripe customers/{uid}/subscriptions mirror, NOT the stripeRole claim (a comp grant sets the claim too, so it would be an unreliable signal).",
          "A comp Pro and a paid Pro look identical via usePlan() — the complimentaryPlans audit doc is the only way to tell them apart.",
          "Two comp-removal paths strip the claim, revoke tokens, and run the downgrade reconcile to basic: the admin DELETE /api/admin/users/:id/comp-plan, and the daily expireComplimentaryPlans cron (03:00 Europe/Athens) at the expiry date. Both skip stripping the claim if the user has since bought a real subscription, so a paying customer is never demoted. (A real Stripe downgrade is separate: its webhook lets the Payments extension own the claim and reconciles to the actual new tier — it doesn't touch the comp doc or revoke tokens.)",
          "Removal is destructive, not just a label flip: dropping to basic runs the same downgrade reconcile (over-cap property deletion, and agreement termination if basic lacks rent.collectStripe).",
        ],
      },
    ],
  },
  {
    key: "admin-pages",
    label: "Admin Pages",
    blurb: "Every page on platform.oliowallet.com, in sidebar order, with what each one does.",
    groups: [
      {
        title: "Dashboard (/admin)",
        body: "Landing page after sign-in. Headline counters (users, owners, tenants, agreements, MRR), recent activity feed, banner carousel (configurable in Appearance), and quick links to the busiest workflows.",
      },
      {
        title: "Users (/admin/users)",
        body: "Master list of every account on the platform.",
        bullets: [
          "Search bar — filters by name or email.",
          "Filter chips — All / Owners / Tenants / Admins.",
          "Row actions — open profile, impersonate, edit roles, send password reset, send email verification, suspend.",
          "+ New User (sidebar create button) — invite a user by email; choose role + plan; system sends a Firebase invite email through the branded /auth/action handler.",
        ],
      },
      {
        title: "Units (/admin/units)",
        body: "Every physical unit across the platform, grouped by property.",
        bullets: [
          "Search by address, owner, or tenant.",
          "Status chip — Vacant / Rented / Listed.",
          "Row click — opens the unit drawer with photos, lease, tenant, rent history.",
          "+ New Unit (sidebar) — create a unit on behalf of an owner. Requires an existing property; otherwise creates the property in the same step.",
        ],
      },
      {
        title: "Portfolios (/admin/portfolios)",
        body: "All owner portfolios. A portfolio is a bucket an owner uses to group properties (e.g. by city or LLC).",
        bullets: [
          "Counters — units, occupied, vacant, MRR per portfolio.",
          "Access — see who else (managers, accountants) has been invited into the portfolio.",
        ],
      },
      {
        title: "Agreements (/admin/agreements)",
        body: "Every lease / rental contract on the platform.",
        bullets: [
          "Status — Draft, Pending Tenant, Active, Ended, Cancelled.",
          "Row click — opens the contract preview drawer with signatures, dates, and rent terms.",
          "Filter — by owner, property, status, date range.",
        ],
      },
      {
        title: "Partners (/admin/partners)",
        body: "Business partners (contractors, service providers, insurers) Olio surfaces inside the owner Network page.",
        bullets: [
          "Status — Active / Paused.",
          "+ New Partner (sidebar) — name, type, contact, email, phone.",
        ],
      },
      {
        title: "Marketplace (/admin/marketplace)",
        body: "Listings shown in the user-side Marketplace tab — properties for sale, units for rent, services.",
        bullets: [
          "+ New Listing (sidebar) — full listing form with photo upload (signed-URL gateway).",
          "Toggle — Show / hide listing without deleting it.",
        ],
      },
      {
        title: "Investment Leads (/admin/investment-leads)",
        body: "Inbound leads from the landing site's 'Become an investor' form. Layout matches Partners.",
        bullets: [
          "Status — New, Contacted, Qualified, Closed.",
          "Notes — internal notes saved against each lead.",
        ],
      },
      {
        title: "Transaction History (/admin/transactions)",
        body: "Real Stripe payments only — tenant rent paid via Stripe Connect and owner subscription invoices paid via Stripe Billing. Offline and owner-recorded ledger entries are excluded; a refunded rent payment shows its refunded amount and net.",
        bullets: [
          "Filter by Rent payments / Subscriptions, and search by ID, user, or property.",
          "Row click — opens a printable invoice for the payment.",
          "Payouts and chargebacks are managed in the Stripe Dashboard, not listed here.",
        ],
      },
      {
        title: "Activity Log (/admin/activity-log)",
        body: "Immutable audit log of platform-side actions (admin sign-ins, role changes, impersonation, plan grants, etc.).",
      },
      {
        title: "Email Marketing (/admin/email-marketing)",
        body: "Compose and send campaigns through Resend.",
        bullets: [
          "List view matches Investment Leads layout for consistency.",
          "Compose — subject, body (HTML), audience segment, schedule.",
          "Live status — open / click / unsubscribe counters per campaign (Resend webhooks).",
          "Requires Resend secrets — verify in Settings → Integrations.",
        ],
      },
      {
        title: "Notification Marketing (/admin/notification-marketing)",
        body: "OneSignal push campaigns to app.oliowallet.com.",
        bullets: [
          "Compose — title, body, deep-link path, audience segment.",
          "Owner filters — plan, portfolio count, property count, units rented, people in network.",
          "Send Test — sends only to one target email so you can preview without spamming users.",
          "Branded icon — uses the Olio symbol.",
        ],
      },
      {
        title: "Social Media (/admin/social-media)",
        body: "Library of canned social posts and brand assets staff can reuse externally.",
      },
      {
        title: "Settings (/admin/settings)",
        body: "Everything that used to be its own admin page now lives here as a tab. See the Settings Tabs section below for the full tab list.",
      },
    ],
  },
  {
    key: "settings-tabs",
    label: "Settings Tabs",
    blurb:
      "What each tab on the Settings page does, and who can see it. (Appearance and your personal Profile now live on their own Profile Settings page — see below.)",
    groups: [
      {
        title: "System",
        body: "Platform-wide toggles. Visible to every admin.",
        bullets: [
          "Platform Notifications — show / hide alert toasts for platform events.",
          "Maintenance Mode — flips config/system.maintenanceMode.enabled. When ON, every non-superadmin sees the MaintenanceScreen on app.oliowallet.com. Toggling requires password re-auth.",
        ],
      },
      {
        title: "Integrations",
        body: "Status of every third-party we depend on. Gated by privilege comm.email.",
        bullets: [
          "Resend (email) — connected / API key / from / webhook / unsubscribe secret chips.",
          "OneSignal (push) — App ID + REST API Key, plus a Send Test push form.",
          "Owner Plans live status — quick view of Stripe price IDs vs. plan keys.",
        ],
      },
      {
        title: "Portfolio Roles",
        body: "Privilege matrix for portfolio-side roles (manager, accountant, viewer). Toggle a checkbox to change what each role can do inside an owner's portfolio. Gated by platform.viewSettings.",
      },
      {
        title: "Platform Roles",
        body: "Privilege matrix for platform-side roles (admin, support, marketing, etc.). Drives what each admin sees in the sidebar and what API endpoints they can call. Gated by platform.viewSettings.",
      },
      {
        title: "Owner Plans",
        body: "Editable labels, descriptions, unit caps, and per-plan rent commission for the four owner tiers (Starter / Growth / Pro / Business); prices are fixed in code and shown read-only. The tab also hosts the owner-plan privilege matrix (which premium features each tier unlocks). Internal keys (basic/advance/pro/business) are stable and not editable. Tab visibility needs platform.viewSettings; saving labels / caps / commission needs platform.modifySettings, while editing the privilege matrix is superadmin-only. See the Plans & Billing section for lifecycle behaviour.",
      },
      {
        title: "Compliance",
        body: "HTML editor + live preview for Terms of Use, Privacy Policy, GDPR, and Owner Terms. Saves to config/compliance; user app reads from there at runtime. Gated by legal.compliance.",
      },
      {
        title: "Documentation",
        body: "This tab. Read-only reference to every page, button, form, and flow in Olio. Visible to every admin.",
      },
    ],
  },
  {
    key: "profile-settings",
    label: "Profile Settings",
    blurb:
      "Your personal account page (/admin/profile). Opened from the avatar menu, top-right. Holds the Profile and Appearance tabs that used to live inside Settings.",
    groups: [
      {
        title: "Profile",
        body: "Your own admin profile. First name, last name, email (read-only), phone, location. Save Changes requires re-auth with your password. Includes Change Password, Change Email, and Log Out.",
      },
      {
        title: "Appearance",
        body: "Personal display preferences. Visible to every admin.",
        bullets: [
          "Theme — Light / Dark / System. Persisted in localStorage.",
          "Banner Wallpaper — pick which images cycle in the Dashboard hero carousel.",
          "Accent Color — highlight color used across cards, switches, and active states.",
        ],
      },
    ],
  },
  {
    key: "owner-pages",
    label: "Owner Pages (app.oliowallet.com)",
    blurb: "What an owner sees once they sign in and pick the owner view.",
    groups: [
      {
        title: "Dashboard (/owner)",
        body: "Owner home. Welcome card, portfolio totals (units, occupancy, monthly rent), banner carousel, recent activity, and the AI briefing card.",
      },
      {
        title: "Properties (/properties)",
        body: "All properties + their units, grouped under whichever portfolio is active in the top-right portfolio switcher.",
        bullets: [
          "+ Add Unit — opens AdminAddUnitDrawer (search/pick owner, address, type, photos, financials).",
          "Property row — click into /properties/:id for the full property detail (photos, units, lease status, documents).",
        ],
      },
      {
        title: "Tenants (/tenants)",
        body: "Every tenant across the active portfolio. Lease status, rent due, contact info, in-app message.",
      },
      {
        title: "Agreements (/owner/agreements)",
        body: "Lease agreements the owner has created or co-signed. Create New Agreement → pick property, unit, tenant, terms, rent, sign and send to tenant.",
      },
      {
        title: "Olio Insights (/insights)",
        body: "Portfolio analytics — occupancy trend, rent collected vs. expected, cash flow, expenses. Server-gated by owner plan (Pro / Business get the full export). Formerly Analytics; /analytics redirects here.",
      },
      {
        title: "Portfolio Access (/portfolio-access)",
        body: "Invite people into the portfolio with a portfolio role (manager / accountant / viewer). Privileges come from the Portfolio Roles matrix in Settings.",
      },
      {
        title: "Banking (/banking)",
        body: "Linked bank accounts and payout settings. Used for rent payouts and platform fees.",
      },
      {
        title: "Owner Settings (/owner/settings)",
        body: "Owner-side settings: profile, plan & billing (Stripe portal), notification preferences, payment channels.",
      },
      {
        title: "Owner Onboarding (/owner-onboarding)",
        body: "First-run wizard a new owner sees right after sign-up. Collects business name, portfolio name, first property, plan choice. Lives outside the AppLayout so it has its own fullscreen design.",
      },
    ],
  },
  {
    key: "tenant-pages",
    label: "Tenant Pages (app.oliowallet.com)",
    blurb: "Tenants get a deliberately small set of pages.",
    groups: [
      {
        title: "Dashboard (/tenant)",
        body: "Tenant home. Rent due card, lease summary, recent payments, quick links to messages and agreements.",
      },
      {
        title: "Agreements (/tenant/agreements)",
        body: "Lease agreements the tenant has signed or has pending. Sign Now button opens the agreement preview + signature flow.",
      },
      {
        title: "Activity (/tenant/activity)",
        body: "Tenant-side activity feed — payments, notices, messages, lease events.",
      },
      {
        title: "Tenant Profile (/tenant-profile)",
        body: "Tenant's profile (name, photo, contact). Editable.",
      },
      {
        title: "Tenant Settings (/tenant/settings)",
        body: "Tenant-side settings: profile, payment methods, notification preferences.",
      },
    ],
  },
  {
    key: "common-pages",
    label: "Shared Pages",
    blurb: "Pages used by both owners and tenants — same URL, same content.",
    groups: [
      {
        title: "Network (/network)",
        body: "Curated directory of partners (contractors, lenders, agents). Powered by the admin Partners list. Server-gated by owner plan for premium categories.",
      },
      {
        title: "Marketplace (/marketplace)",
        body: "Public listings — properties, rentals, services. Filter by type, price, location.",
      },
      {
        title: "Ask Olio (/ask)",
        body: "AI assistant. Conversational chat for property / lease / market questions. Server-gated by owner plan.",
      },
      {
        title: "Smart Calculator (/calculator)",
        body: "ROI / cash-flow / mortgage calculator. Inputs are auto-filled from the user's portfolio when possible.",
      },
      {
        title: "Messages (/owner/messages, /tenant/messages)",
        body: "In-app messaging between owners and tenants on the same lease.",
      },
      {
        title: "Activity (/owner/activity, /tenant/activity)",
        body: "Per-persona activity feed.",
      },
      {
        title: "Expert (/expert)",
        body: "Concierge / book a property expert call.",
      },
      {
        title: "Payment Channels (/payment-channels)",
        body: "Manage how rent flows — Stripe, bank transfer, etc.",
      },
      {
        title: "Profile (/profile)",
        body: "Read-only profile snapshot with sub-pages for Settings, Portfolio Access, FAQ, Privacy.",
      },
      {
        title: "FAQ (/profile/faq)",
        body: "Static frequently-asked-questions list.",
      },
      {
        title: "Privacy / Terms (/privacy, /terms)",
        body: "Public legal pages. Content comes from config/compliance, edited under Settings → Compliance.",
      },
      {
        title: "Auth (/auth, /auth/action, /auth/impersonate)",
        body: "/auth — sign-in + sign-up. /auth/action — branded handler for Firebase email links (verify email, reset password, change email). /auth/impersonate — superadmin-only entry into a target user's session for support.",
      },
    ],
  },
  {
    key: "buttons-forms",
    label: "Buttons & Forms",
    blurb: "Reusable controls that show up across the admin app.",
    groups: [
      {
        title: "Sidebar — Create menu (purple + button)",
        body: "Top of the desktop sidebar. Opens a drawer with quick-create options. What you see depends on your privileges.",
        bullets: [
          "New User — invite by email, pick role + plan.",
          "New Unit — create a unit on behalf of an owner.",
          "New Partner — name, type, contact, email, phone.",
          "New Listing — full marketplace listing form.",
          "Complimentary Advance — grant Growth plan for free.",
          "Complimentary PRO — grant Pro plan for free.",
        ],
      },
      {
        title: "User search (sidebar)",
        body: "Type 2+ characters in the sidebar search to find any user by name or email. Pick a result to open their profile drawer (impersonate, edit, message).",
      },
      {
        title: "Portfolio switcher (top-right)",
        body: "Owner pages only. Switches the entire app context (Properties, Tenants, Agreements) to the selected portfolio.",
      },
      {
        title: "Confirm-and-Save dialog",
        body: "Sensitive saves (profile, maintenance toggle, plan grants) require typing your password again. Google-only admins skip this — Google already provides strong auth.",
      },
      {
        title: "Send Test push (Settings → Integrations)",
        body: "Type a target email, hit Send. Push goes only to that user, even if their device is offline (queued by OneSignal). Returns notification ID + recipient count.",
      },
      {
        title: "Reset to defaults (Settings → Compliance)",
        body: "Reverts the active tab's HTML doc back to the shipped default. Saves immediately — there is no separate undo.",
      },
    ],
  },
  {
    key: "flows",
    label: "Expected Flows",
    blurb: "Step-by-step paths through common end-to-end workflows.",
    groups: [
      {
        title: "Onboard a new owner",
        body: "From landing site to first property.",
        flow: [
          "User signs up on oliowallet.com or app.oliowallet.com/auth.",
          "Firebase sends a verify-email link → user clicks → branded /auth/action handler verifies.",
          "User lands on /owner-onboarding (full-screen wizard).",
          "Wizard collects business name, first portfolio, first property, optional plan upgrade.",
          "On completion → redirect to /owner. Activity log records the onboarding.",
        ],
      },
      {
        title: "Owner upgrades plan",
        body: "The Firebase 'Run Payments with Stripe' extension owns the subscription — there is NO /api/checkout/session endpoint. A first subscription from Starter uses the extension's Firestore handshake; any change while already on a paid plan goes through the Stripe Customer Portal. (See the Plans & Billing section for cancel / downgrade.)",
        flow: [
          "Owner clicks Upgrade in the profile drawer (or a paywall) → the Pricing modal opens. Only the portfolio owner can change billing.",
          "First subscription from Starter: the app writes a doc to customers/{uid}/checkout_sessions; the extension fills in a Stripe Checkout URL and the app redirects there. (Already-paid owners are instead sent to the Stripe Customer Portal via the createPortalLink extension callable; Business opens an email to sales.)",
          "Owner completes payment on Stripe's hosted page.",
          "The Stripe extension (its own webhook) sets the stripeRole custom claim from the product's firebaseRole metadata. Olio's /api/webhooks/stripe does NOT set this claim — it only runs downgrade cleanup after the fact.",
          "Owner returns to app.oliowallet.com/?checkout=success → CheckoutReturnHandler force-refreshes the auth token so the new plan shows immediately.",
        ],
      },
      {
        title: "Sign a lease (owner side)",
        body: "Create + send + countersign.",
        flow: [
          "Owner opens Agreements → Create New Agreement.",
          "Picks property + unit + tenant from the dropdowns.",
          "Fills rent, security deposit, start / end dates.",
          "Reviews preview → signs → sends to tenant.",
          "Tenant gets an email + push notification. Status moves to Pending Tenant.",
          "Tenant signs → status moves to Active. Both parties get a confirmation.",
        ],
      },
      {
        title: "Send a marketing email",
        body: "Through Resend.",
        flow: [
          "Admin opens /admin/email-marketing → New Campaign.",
          "Fills subject + HTML body + audience filter.",
          "Saves Draft (optional) or hits Send Now.",
          "Resend ships the email. Webhook fires back delivery / open / click events.",
          "Status counters on the campaign row update in realtime.",
        ],
      },
      {
        title: "Send a marketing push",
        body: "Through OneSignal.",
        flow: [
          "Admin opens /admin/notification-marketing → New Push.",
          "Fills title + body + deep-link path + audience filter (plan, portfolio count, etc.).",
          "Optional Send Test to one email first.",
          "Send Now → OneSignal queues the push to every matching subscription.",
          "Status counters update once OneSignal reports back.",
        ],
      },
      {
        title: "Flip maintenance mode",
        body: "Lock the user app for everyone except superadmins.",
        flow: [
          "Admin opens Settings → System → toggle Maintenance Mode.",
          "Password dialog appears (skipped for Google-only admins).",
          "On confirm → config/system.maintenanceMode.enabled writes true.",
          "Every connected user app sees the MaintenanceScreen within ~1s (onSnapshot).",
          "Superadmins + the /auth/action path stay unblocked.",
        ],
      },
      {
        title: "Upload a photo / document",
        body: "Signed-URL gateway pattern (used by avatars, property photos, listing photos, documents).",
        flow: [
          "Client requests a signed URL from /api/storage/sign with file metadata.",
          "Server validates size + mime + caller's role, returns a short-lived signed URL.",
          "Client PUTs the file directly to the URL.",
          "Client calls /api/storage/finalize to record the upload in Firestore.",
          "Storage rules deny direct writes — only signed URLs work.",
        ],
      },
    ],
  },
  {
    key: "integrations",
    label: "Integrations",
    blurb: "Every external service Olio depends on, and where it is configured.",
    groups: [
      {
        title: "Firebase",
        body: "Auth, Firestore, Storage, Functions (2nd gen), Hosting (3 sites). Project: olio-wallet (#616442647680). Region for Storage: europe-west1.",
      },
      {
        title: "Stripe",
        body: "Subscriptions for owner plans, plus Connect for payouts. The official 'Run Payments with Stripe' Firebase Extension owns subscription state — read plan via usePlan() (stripeRole claim), NEVER off User.plan.",
      },
      {
        title: "Resend (email)",
        body: "Transactional + marketing email. Secrets — RESEND_API_KEY, RESEND_FROM, RESEND_WEBHOOK_SECRET, UNSUBSCRIBE_SECRET. Live status in Settings → Integrations.",
      },
      {
        title: "OneSignal (push)",
        body: "Web push for app.oliowallet.com. Secrets — ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY. SDK boots in App.tsx via OneSignalBridge; subscription is tied to firebaseUser.uid as external_id.",
      },
      {
        title: "OpenAI",
        body: "Powers Ask Olio, AI briefings, and the agreements summarizer.",
      },
      {
        title: "Cloudflare",
        body: "DNS for oliowallet.com (apex + app + platform subdomains). SSL handled by Cloudflare; Firebase Hosting reads the custom domain.",
      },
      {
        title: "Mapbox",
        body: "Property map rendering on the user-side property detail pages and analytics.",
      },
      {
        title: "Google Search Console",
        body: "Verifies the public landing site and tracks indexing.",
      },
    ],
  },
  {
    key: "roles",
    label: "Roles & Privileges",
    blurb: "How role-based access works in Olio.",
    groups: [
      {
        title: "Three privilege matrices",
        body: "Privileges live in config/privileges and are read by usePrivileges() on every client.",
        bullets: [
          "Platform Roles — what staff (admin, support, marketing, etc.) can see in the admin app.",
          "Portfolio Roles — what people invited into an owner's portfolio can do (manager, accountant, viewer).",
          "Owner Plans — which premium features are gated to which paid tier.",
        ],
      },
      {
        title: "How gating works",
        body: "Both sides — UI and API — check the same matrix.",
        bullets: [
          "UI — sidebar items, tabs, and buttons hide automatically when the user lacks the privilege.",
          "API — Express routes call requirePrivilege() before responding. A user with a hacked frontend still cannot call a privileged endpoint.",
          "Live — flipping a checkbox in the matrix updates every connected client within seconds (onSnapshot).",
        ],
      },
      {
        title: "Unified users table",
        body: "Every persona (tenant, owner, admin, superadmin) lives in the single users collection. Roles are an array. Never propose a separate collection for new persona types — extend User.roles + platformRole instead.",
      },
    ],
  },
];

export function PlatformDocumentation() {
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string>(SECTIONS[0].key);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.map((section) => {
      const groups = section.groups.filter((g) => {
        const hay = [g.title, g.body, ...(g.bullets ?? []), ...(g.flow ?? [])]
          .join("\n")
          .toLowerCase();
        return hay.includes(q) || section.label.toLowerCase().includes(q);
      });
      return groups.length ? { ...section, groups } : null;
    }).filter((s): s is Section => s !== null);
  }, [query]);

  const active = filtered.find((s) => s.key === activeKey) ?? filtered[0];

  return (
    <div className="space-y-4">
      <div className="bg-card p-4 rounded-xl border border-border shadow-sm space-y-4">
        <div className="relative w-full">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documentation..."
            className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto hide-scrollbar">
          {filtered.map((section) => (
            <button
              key={section.key}
              onClick={() => setActiveKey(section.key)}
              className={cn(
                "px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all",
                active?.key === section.key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {section.label}
            </button>
          ))}
        </div>
      </div>

      {!active && (
        <div className="bg-card p-8 rounded-xl border border-border shadow-sm text-center">
          <BookOpen size={24} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            No matches for &ldquo;{query}&rdquo;. Try a different keyword.
          </p>
        </div>
      )}

      {active && (
        <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
          <div className="flex items-start gap-3 mb-5 pb-4 border-b border-border">
            <div className="bg-muted p-2.5 rounded-lg shrink-0">
              <BookOpen size={18} className="text-foreground" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">{active.label}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{active.blurb}</p>
            </div>
          </div>

          <div className="space-y-6">
            {active.groups.map((group) => (
              <div key={group.title} className="space-y-2">
                <h4 className="text-sm font-semibold text-foreground">{group.title}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{group.body}</p>
                {group.bullets && group.bullets.length > 0 && (
                  <ul className="space-y-1.5 mt-2">
                    {group.bullets.map((b, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-sm text-muted-foreground leading-relaxed"
                      >
                        <ChevronRight
                          size={14}
                          className="mt-1 shrink-0 text-muted-foreground/60"
                        />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {group.flow && group.flow.length > 0 && (
                  <ol className="space-y-1.5 mt-2">
                    {group.flow.map((step, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-3 text-sm text-muted-foreground leading-relaxed"
                      >
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted text-[10px] font-semibold text-foreground shrink-0 mt-0.5">
                          {i + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
