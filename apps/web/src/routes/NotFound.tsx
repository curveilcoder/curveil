import { Link } from "@tanstack/react-router";
import { useT } from "../lib/i18n";

export function NotFound() {
  const t = useT();
  return (
    <div className="wrap page-head">
      <p className="eyebrow"><span className="eyebrow-n">404</span> {t("Not found", "页面不存在")}</p>
      <h1>{t("This page does not exist", "这个页面不存在")}</h1>
      <p className="lead">{t("The link may be old or mistyped.", "链接可能已过期或输入有误。")}</p>
      <div className="hero-actions"><Link to="/" className="btn btn-primary">{t("Go home", "返回首页")} <span aria-hidden="true">→</span></Link><Link to="/docs" className="btn">{t("Docs", "文档")}</Link></div>
    </div>
  );
}
