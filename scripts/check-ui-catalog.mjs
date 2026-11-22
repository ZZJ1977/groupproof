// Every Chinese UI string in features/, components/ and lib/ must have an English and a
// Traditional Chinese entry in lib/i18n/catalog (see lib/i18n/tr.ts). Run: npm run check:ui-catalog
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HAN = /[㐀-鿿]/;
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
};
const files = ["features", "components", "lib"].flatMap((d) => walk(path.join(root, d))).filter((f) => !f.includes(`${path.sep}lib${path.sep}i18n${path.sep}`));
const loadCatalog = (name) => {
  const text = fs.readFileSync(path.join(root, "lib/i18n/catalog", `${name}.ts`), "utf8");
  return JSON.parse(text.slice(text.indexOf("= {") + 2, text.lastIndexOf("};") + 1));
};
const en = loadCatalog("en");
const cleanJsxText = (raw) => {
  const lines = raw.split(/\r\n|\n|\r/);
  let out = "";
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, " ");
    if (i !== 0) l = l.replace(/^[ ]+/, "");
    if (i !== lines.length - 1) l = l.replace(/[ ]+$/, "");
    if (l) { if (out && i !== 0) out += " "; out += l; }
  });
  return out;
};
const inConsole = (node) => { for (let p = node.parent; p; p = p.parent) if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) return true; return false; };
const missing = [];
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const check = (text, node) => {
    const key = text.trim();
    if (!HAN.test(key) || key in en) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    missing.push(`${path.relative(root, file)}:${line + 1}  ${key}`);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !inConsole(node)) check(node.text, node);
    if (ts.isJsxText(node)) check(cleanJsxText(node.text), node);
    if (ts.isTemplateExpression(node) && HAN.test(node.getText(source)) && !inConsole(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      missing.push(`${path.relative(root, file)}:${line + 1}  template literal with Chinese text; wrap it with tr("…{0}…", { 0: value })`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
// A few developer-only messages are intentionally left untranslated (identical in every language).
const allowed = new Set(Object.entries(en).filter(([k, v]) => k === v).map(([k]) => k));
const real = missing.filter((m) => !allowed.has(m.split("  ").slice(1).join("  ")));
if (real.length) {
  console.error(`UI 文案缺少英文/繁体翻译（${real.length} 处）。请把它们加入 lib/i18n/catalog/en.ts 与 zh-Hant.ts：`);
  for (const m of real) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`UI 文案目录完整：${Object.keys(en).length} 条英文词条覆盖全部中文界面文字。`);
