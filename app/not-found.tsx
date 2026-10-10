import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** 未知路由 404：不加载工作区，不用演示账号兜底 */
export default async function NotFound() {
  const t = await getTranslations("common");
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-[24px] font-semibold text-[#14213b]">404</h1>
      <p className="text-[13px] text-[#75849a]">{t("notFound.description")}</p>
      <Link href="/login" className="gp-link text-[12px]">{t("notFound.home")}</Link>
    </div>
  );
}
