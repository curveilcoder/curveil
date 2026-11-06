import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <div className="wrap page-head">
      <p className="eyebrow"><span className="eyebrow-n">404</span> Not found</p>
      <h1>This page does not exist</h1>
      <p className="lead">The link may be old or mistyped.</p>
      <div className="hero-actions"><Link to="/" className="btn btn-primary">Go home <span aria-hidden="true">→</span></Link><Link to="/docs" className="btn">Docs</Link></div>
    </div>
  );
}
