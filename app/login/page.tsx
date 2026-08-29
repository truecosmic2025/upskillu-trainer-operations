import { getBranding } from "../../lib/settings";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const branding = await getBranding();
  return <main className="login-page"><section className="login-card"><div className="brand login-brand">{branding.hasLogo?<img className="brand-logo" src="/api/settings/logo" alt={`${branding.orgName} logo`}/>:<span className="brand-mark">TC</span>}<div><b>{branding.orgName}</b><small>Trainer operations</small></div></div><p className="eyebrow">PRIVATE OPERATIONS PORTAL</p><h1>Welcome back</h1><p>Enter your administrator password to continue.</p><form method="post" action="/api/auth/login"><label>Password<input name="password" type="password" autoComplete="current-password" required autoFocus/></label>{error && <p className="login-error">That password was not recognised.</p>}<button className="primary" type="submit">Sign in securely</button></form></section></main>;
}
