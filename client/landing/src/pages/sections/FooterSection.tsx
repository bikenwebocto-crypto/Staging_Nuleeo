import { Logo } from "@ui/components/Logo";
import { SOCIAL_PLATFORM_KEYS, SOCIAL_PLATFORM_META } from "@shared/firestore-schema";
import { SOCIAL_ICONS } from "@ui/components/SocialIcons";
import { useSocialLinks } from "@/lib/socialPublic";
import { appUrl } from "@/lib/appUrl";
import { reopenCookieConsent } from "@ui/lib/cookieConsent";

// Footer link columns. Only real, reachable destinations — dead "#" hrefs and
// pages we haven't built yet (About, Blog, Careers, Press, Partners, Help
// Center, Contact) are intentionally omitted so users don't click into the
// void. Add an entry here only when the destination exists.
type FooterLink = { label: string; href: string; external?: boolean };
const columns: Array<{ title: string; links: FooterLink[] }> = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    title: "Support",
    links: [
      { label: "FAQ", href: appUrl("/profile/faq"), external: true },
      { label: "Complaints & Disputes", href: appUrl("/legal/complaints"), external: true },
      { label: "Accessibility", href: appUrl("/legal/accessibility"), external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms of Use", href: appUrl("/legal/terms"), external: true },
      { label: "Privacy Policy", href: appUrl("/legal/privacy"), external: true },
      { label: "Cookie Policy", href: appUrl("/legal/cookies"), external: true },
      { label: "Acceptable Use", href: appUrl("/legal/aup"), external: true },
      { label: "GDPR & DPA", href: appUrl("/legal/gdpr"), external: true },
      { label: "Subprocessors", href: appUrl("/legal/subprocessors"), external: true },
      { label: "All legal documents", href: appUrl("/legal"), external: true },
    ],
  },
];

export default function FooterSection() {
  const socialLinks = useSocialLinks();
  const activeSocials = SOCIAL_PLATFORM_KEYS.filter(
    (k) => (socialLinks[k] ?? "").trim().length > 0,
  );

  return (
    <footer className="bg-black text-white">
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-8">
          {/* Brand */}
          <div>
            <Logo variant="wordmark" color="white" className="h-7 w-auto mb-4" />
            <p className="text-white/60 text-sm leading-relaxed">
              Your real estate wallet. Manage, track, and grow your property portfolio.
            </p>
            {activeSocials.length > 0 && (
              <div className="flex gap-3 mt-5 flex-wrap">
                {activeSocials.map((key) => {
                  const { Icon } = SOCIAL_ICONS[key];
                  const meta = SOCIAL_PLATFORM_META[key];
                  return (
                    <a
                      key={key}
                      href={socialLinks[key]}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={meta.label}
                      className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white/60 hover:bg-white/20 hover:text-white transition"
                    >
                      <Icon className="w-4 h-4" />
                    </a>
                  );
                })}
              </div>
            )}
          </div>

          {/* Link columns */}
          {columns.map((col) => (
            <div key={col.title}>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-white mb-4">
                {col.title}
              </h3>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      // External links (cross-subdomain to app.oliowallet.com)
                      // open in a new tab so the marketing site stays open.
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="text-white/60 hover:text-white text-sm transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col items-center gap-2 text-center">
          <p className="text-white/60 text-sm">
            © {new Date().getFullYear()} Olio Wallet · All rights reserved
          </p>
          <p className="text-white/60 text-sm">Developed by LiveNow Strategic Business Systems</p>
          <button
            type="button"
            onClick={reopenCookieConsent}
            className="text-white/60 text-sm underline underline-offset-2 hover:text-white transition"
          >
            Cookie preferences
          </button>
        </div>
      </div>
    </footer>
  );
}
