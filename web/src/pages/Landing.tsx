import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ShieldCheck,
  FlaskConical,
  Boxes,
  Webhook,
  KeyRound,
  RefreshCcw,
  Gauge,
  CheckCircle2,
  Lock,
  GitBranch,
  ExternalLink,
  Zap,
  Menu,
  X,
  Users,
} from "lucide-react";
import { CodeBlock } from "../components/CodeBlock";
import { useHealth } from "../lib/useHealth";

const API_DOCS_URL = "http://localhost:4000/docs";

function StatusPill() {
  const online = useHealth();
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm">
      <span
        className={`h-2 w-2 rounded-full ${
          online === null ? "bg-slate-300" : online ? "bg-emerald-500" : "bg-rose-500"
        }`}
      />
      {online === null ? "Checking sandbox status…" : online ? "Sandbox API online" : "Sandbox API unreachable"}
    </div>
  );
}

const FEATURES = [
  {
    icon: GitBranch,
    title: "API Design",
    body:
      "One canonical, provider-neutral contract. Merchants integrate once against payment intents, never against a provider's raw format.",
  },
  {
    icon: Boxes,
    title: "Sandbox",
    body:
      "Every transaction is synthetic. No real bank, processor, or wallet is ever reachable from this codebase — by construction, not by policy.",
  },
  {
    icon: ShieldCheck,
    title: "Security",
    body:
      "Hashed API keys, HMAC-signed webhooks, database-enforced idempotency and replay protection, rate limiting — all provable live.",
  },
  {
    icon: FlaskConical,
    title: "Simulation",
    body:
      "Two providers with genuinely different behavior — one synchronous, one async-with-webhook — normalized into a single state machine.",
  },
];

const TEAM = [
  { name: "Jaber", photo: "/team/jaber.jpg" },
  { name: "Ahmed", photo: "/team/ahmed.jpeg" },
  { name: "hawra", photo: "/team/hawra.jpeg" },
  { name: "Mohamed", photo: "/team/mo.jpeg" },
  { name: "Moayed", photo: "/team/moayed.jpeg", link: "https://momo.ly/" },
];

const SECURITY_CHECKLIST = [
  { icon: KeyRound, label: "API keys hashed with salted scrypt, never stored in plaintext" },
  { icon: Webhook, label: "Webhooks signed with HMAC-SHA256, verified with a timing-safe comparison" },
  { icon: RefreshCcw, label: "Replay protection enforced by a database primary-key constraint" },
  { icon: Lock, label: "Idempotency enforced by a database unique constraint, safe under concurrency" },
  { icon: Gauge, label: "Fixed-window rate limiting, 429 with Retry-After once exceeded" },
  { icon: CheckCircle2, label: "Every external input validated with Zod before it reaches business logic" },
];

const REQUEST_SNIPPET = `POST /api/v1/payment-intents
Authorization: Bearer fb_test_...
Idempotency-Key: demo-order-1001
Content-Type: application/json

{
  "amount": 15000,
  "currency": "USD",
  "provider": "sim_provider_a",
  "scenario": "success"
}`;

const RESPONSE_A_SNIPPET = `HTTP/1.1 201 Created

{
  "data": {
    "id": "pi_test_ab12cd34ef56",
    "status": "succeeded",
    "provider": "sim_provider_a",
    "amount": 15000,
    "currency": "USD",
    "sandbox": true
  },
  "request_id": "req_test_a1b2c3d4"
}`;

const RESPONSE_B_SNIPPET = `HTTP/1.1 201 Created

{
  "data": {
    "id": "pi_test_9f8e7d6c5b4a",
    "status": "processing",
    "provider": "sim_provider_b",
    "amount": 98000,
    "currency": "USD",
    "sandbox": true
  },
  "request_id": "req_test_e5f6g7h8"
}

// ...settles moments later via a signed webhook`;

function Nav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <span className="text-sm font-bold text-slate-900">FinBridge</span>
        </a>
        
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#features" className="hover:text-slate-900">Features</a>
          <a href="#interop" className="hover:text-slate-900">Interoperability</a>
          <a href="#security" className="hover:text-slate-900">Security</a>
          <a href="#team" className="hover:text-slate-900">Team</a>
          <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-slate-900">
            API Reference <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </nav>
        
        <div className="flex items-center gap-3">
          <Link to="/console" className="hidden fb-btn-primary !px-4 !py-2 text-sm sm:inline-flex">
            Open Console <ArrowRight className="h-4 w-4" />
          </Link>
          <button
            className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-200 bg-white py-4 px-4">
          <nav className="flex flex-col gap-2">
            <a href="#features" className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg" onClick={() => setMobileMenuOpen(false)}>
              Features
            </a>
            <a href="#interop" className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg" onClick={() => setMobileMenuOpen(false)}>
              Interoperability
            </a>
            <a href="#security" className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg" onClick={() => setMobileMenuOpen(false)}>
              Security
            </a>
            <a href="#team" className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg" onClick={() => setMobileMenuOpen(false)}>
              Team
            </a>
            <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg flex items-center gap-2" onClick={() => setMobileMenuOpen(false)}>
              API Reference <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <Link to="/console" className="fb-btn-primary !px-4 !py-2.5 text-sm mt-2 w-full text-center" onClick={() => setMobileMenuOpen(false)}>
              Open Console <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-bold text-slate-900">FinBridge</span>
            </div>
            <p className="mt-2 max-w-sm text-xs leading-relaxed text-slate-500">
              A secure, sandboxed API for simulated FinTech payment flows. Built for the US-Libya
              Global Innovation Bridge Hackathon 2026 — Entrepreneurship track, Sandbox FinTech / APIs.
            </p>
          </div>
          <div className="flex gap-10 text-sm">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Product</div>
              <ul className="space-y-1.5 text-slate-600">
                <li><Link to="/console" className="hover:text-brand-600">Console</Link></li>
                <li><a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="hover:text-brand-600">API Reference</a></li>
              </ul>
            </div>
          </div>
        </div>
        <div className="mt-8 border-t border-slate-100 pt-6 text-xs font-medium text-slate-400">
          SANDBOX ONLY — NO REAL MONEY. No real bank, processor, or wallet is ever connected.
        </div>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div id="top" className="bg-white">
      <Nav />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px]"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, rgba(52,102,246,0.10) 0%, rgba(52,102,246,0) 100%)",
          }}
        />
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-[11px] font-bold tracking-wide text-white">
              <Zap className="h-3 w-3 text-emerald-400" />
              SANDBOX ONLY — NO REAL MONEY
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
              Secure FinTech interoperability,
              <br className="hidden sm:block" /> without the risk.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
              Integrate once. Test against multiple simulated financial providers through one
              secure, standardized API — before you ever touch real financial infrastructure.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/console" className="fb-btn-primary w-full !px-5 !py-2.5 text-sm sm:w-auto">
                Open Console <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href={API_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="fb-btn-secondary w-full !px-5 !py-2.5 text-sm sm:w-auto"
              >
                View API Reference <ExternalLink className="h-4 w-4" />
              </a>
            </div>
            <div className="mt-6 flex justify-center">
              <StatusPill />
            </div>
          </div>

          <div className="mx-auto mt-14 max-w-3xl">
            <CodeBlock title="POST /api/v1/payment-intents">{REQUEST_SNIPPET}</CodeBlock>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-slate-100 bg-slate-50/60 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
              Four pillars, one demonstrable sandbox
            </h2>
            <p className="mt-3 text-sm text-slate-600 sm:text-base">
              Financial APIs are inconsistent and integration testing can be risky. FinBridge is
              where you rehearse both problems safely.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="fb-card p-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-sm font-bold text-slate-900">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Interoperability */}
      <section id="interop" className="py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">Same API. Different providers.</h2>
            <p className="mt-3 text-sm text-slate-600 sm:text-base">
              SimProviderA answers synchronously. SimProviderB answers asynchronously, via a
              signed webhook. The merchant's request never changes.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center gap-2">
                <span className="fb-badge bg-brand-50 text-brand-700">Synchronous</span>
                <span className="text-sm font-bold text-slate-900">SimProviderA</span>
              </div>
              <CodeBlock title="201 · immediate">{RESPONSE_A_SNIPPET}</CodeBlock>
            </div>
            <div>
              <div className="mb-3 flex items-center gap-2">
                <span className="fb-badge bg-amber-50 text-amber-700">Asynchronous</span>
                <span className="text-sm font-bold text-slate-900">SimProviderB</span>
              </div>
              <CodeBlock title="201 · settles later">{RESPONSE_B_SNIPPET}</CodeBlock>
            </div>
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-slate-500">
            Both normalize into the same canonical state machine —{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">created → processing → succeeded / failed / cancelled</code>{" "}
            — so nothing provider-specific ever leaks into a merchant's integration.
          </p>
        </div>
      </section>

      {/* Security */}
      <section id="security" className="border-t border-slate-100 bg-slate-50/60 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
                Security you can watch happen, live.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-slate-600 sm:text-base">
                Every control below is load-bearing, not decorative — tamper a webhook and it's
                rejected for a real cryptographic reason. Replay one and the database itself
                refuses the duplicate. It's all visible on the Console's Security feed, with a
                request id you can trace end to end.
              </p>
              <Link to="/console/security" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline">
                View the Security feed <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="fb-card divide-y divide-slate-100 p-1">
              {SECURITY_CHECKLIST.map((item) => (
                <div key={item.label} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <span className="text-sm text-slate-700">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Team */}
      <section id="team" className="py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <Users className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-2xl font-bold text-slate-900 sm:text-3xl">Meet the team</h2>
            <p className="mt-3 text-sm text-slate-600 sm:text-base">
              US-Libya Global Innovation Bridge Hackathon 2026 — Entrepreneurship track.
            </p>
          </div>
          <div className="mt-14 flex flex-col items-center gap-10 sm:gap-16">
            <div className="flex justify-center gap-8 sm:gap-16">
              {TEAM.slice(0, 3).map((member) => (
                <div key={member.name} className="flex w-24 flex-col items-center text-center sm:w-40">
                  <img
                    src={member.photo}
                    alt={member.name}
                    className="h-24 w-24 rounded-full object-cover sm:h-40 sm:w-40"
                  />
                  <span className="mt-4 text-sm font-semibold text-slate-900">{member.name}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-center gap-8 sm:gap-16">
              {TEAM.slice(3, 5).map((member) => (
                <div key={member.name} className="flex w-24 flex-col items-center text-center sm:w-40">
                  <img
                    src={member.photo}
                    alt={member.name}
                    className="h-24 w-24 rounded-full object-cover sm:h-40 sm:w-40"
                  />
                  {member.link ? (
                    <a
                      href={member.link}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-slate-900 underline"
                    >
                      {member.name}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="mt-4 text-sm font-semibold text-slate-900">{member.name}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-slate-100 bg-slate-50/60 py-20">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
          <div className="fb-card bg-ink p-10 text-white sm:p-14">
            <h2 className="text-2xl font-bold sm:text-3xl">See the full lifecycle in one sitting</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-slate-300 sm:text-base">
              Create a payment, settle it with a signed webhook, replay it, tamper it, hit the
              rate limit — every step verified live, right in the console.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/console" className="fb-btn-primary w-full !bg-white !text-ink hover:!bg-slate-100 sm:w-auto">
                Open Console <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href={API_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="fb-btn-secondary w-full !border-slate-600 !bg-transparent !text-white hover:!bg-white/10 sm:w-auto"
              >
                View API Reference <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
